from __future__ import annotations

import io
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from functools import lru_cache
from math import ceil, cos, pi
from pathlib import Path
from typing import Annotated, Optional
from uuid import uuid4

import numpy as np
import rasterio
import trimesh
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field, model_validator
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from starlette.background import BackgroundTask

from tile_index import Tile, build_tile_index, find_intersecting_tiles, longitude_intervals


PROJECT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = Path(__file__).resolve().parent
DEM_DIR = PROJECT_DIR / "lola_dems"
KML_DIR = PROJECT_DIR / "Lunar_DEM_LOLA_shaded_relief_1.52GB"
OPTICAL_DIR = PROJECT_DIR / "LRO LROC"
TOKEN_PATH = PROJECT_DIR / "cesium_key.txt"
EXPORT_DIR = BACKEND_DIR / "exports"
PREVIEW_DIR = BACKEND_DIR / "preview_cache"
TILE_CACHE_DIR = BACKEND_DIR / "tile_cache"
DEM_TEXTURE_CACHE_DIR = BACKEND_DIR / "dem_texture_cache"
OPTICAL_TILE_CACHE_DIR = BACKEND_DIR / "optical_tile_cache"
FRONTEND_DIR = PROJECT_DIR / "frontend"

MOON_RADIUS_M = 1_737_400.0
LOLA_PIXELS_PER_DEGREE = 1024
MAX_TRIANGLES = 20_000_000
MAX_PREVIEW_TRIANGLES = 250_000

EXPORT_DIR.mkdir(parents=True, exist_ok=True)
PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
TILE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
DEM_TEXTURE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
OPTICAL_TILE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

PUBLIC_URL = os.environ.get("OPEN_MOON_PUBLIC_URL", "http://localhost:8000").rstrip("/")
CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "OPEN_MOON_CORS_ORIGINS",
        "http://localhost:8080,http://127.0.0.1:8080",
    ).split(",")
    if origin.strip()
]

app = FastAPI(title="Open Moon STL Export")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

if KML_DIR.exists():
    app.mount("/kml", StaticFiles(directory=KML_DIR), name="kml")

TILES = build_tile_index(DEM_DIR)

Image.MAX_IMAGE_PIXELS = None


def public_url(path: str) -> str:
    return f"{PUBLIC_URL}{path}"


class ShapePoint(BaseModel):
    lat: Annotated[float, Field(ge=-90, le=90)]
    lon: float


class ExportRequest(BaseModel):
    min_lat: Annotated[float, Field(ge=-90, le=90)]
    max_lat: Annotated[float, Field(ge=-90, le=90)]
    min_lon: float
    max_lon: float
    downsample: Annotated[int, Field(ge=1, le=2048)] = 16
    z_exaggeration: Annotated[float, Field(gt=0, le=100)] = 1.0
    base_thickness: Annotated[float, Field(ge=0, le=100_000)] = 1500.0
    selection_type: Annotated[str, Field(pattern="^(rectangle|circle|polygon)$")] = "rectangle"
    circle_center_lat: Annotated[Optional[float], Field(ge=-90, le=90)] = None
    circle_center_lon: Optional[float] = None
    circle_radius_m: Annotated[Optional[float], Field(gt=0)] = None
    polygon: Optional[list[ShapePoint]] = None

    @model_validator(mode="after")
    def validate_bounds(self) -> "ExportRequest":
        if self.min_lat >= self.max_lat:
            raise ValueError("min_lat must be less than max_lat")
        if self.selection_type == "circle":
            if self.circle_center_lat is None or self.circle_center_lon is None or self.circle_radius_m is None:
                raise ValueError("circle selections require circle_center_lat, circle_center_lon, and circle_radius_m")
        if self.selection_type == "polygon" and (self.polygon is None or len(self.polygon) < 3):
            raise ValueError("polygon selections require at least 3 polygon points")
        return self


class ExportInfo(BaseModel):
    ok: bool
    reason: str
    tile_count: int
    estimated_width: int
    estimated_height: int
    estimated_triangles: int
    estimated_stl_bytes: int
    tiles: list[dict[str, object]]


class TextureTileRequest(BaseModel):
    z: Annotated[int, Field(ge=0, le=12)]
    x: Annotated[int, Field(ge=0)]
    y: Annotated[int, Field(ge=0)]


class TexturePrefetchRequest(BaseModel):
    tiles: Annotated[list[TextureTileRequest], Field(max_length=256)]


@app.get("/cesium-token")
def cesium_token() -> dict[str, str]:
    if not TOKEN_PATH.exists():
        return {"token": ""}
    return {"token": TOKEN_PATH.read_text(encoding="utf-8").strip()}


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "dem_dir": str(DEM_DIR),
        "tile_count": len(TILES),
        "exports_dir": str(EXPORT_DIR),
    }


@app.get("/kml-root")
def kml_root() -> dict[str, Optional[str]]:
    if not KML_DIR.exists():
        return {"url": None}

    preferred = KML_DIR / "tiles_banded_stereo" / "LunarTopoRelief_banded_stereo.kml"
    if preferred.exists():
        rel = preferred.relative_to(KML_DIR).as_posix()
        return {"url": public_url(f"/kml/{rel}")}

    first = next(KML_DIR.rglob("*.kml"), None)
    if first:
        rel = first.relative_to(KML_DIR).as_posix()
        return {"url": public_url(f"/kml/{rel}")}

    return {"url": None}


@app.get("/preview-image")
def preview_image() -> dict[str, Optional[str]]:
    preview = KML_DIR / "tiles_banded_stereo" / "0" / "0" / "0.jpg"
    if preview.exists():
        rel = preview.relative_to(KML_DIR).as_posix()
        return {"url": public_url(f"/kml/{rel}")}
    return {"url": None}


@app.get("/pyramid-metadata")
def pyramid_metadata() -> dict[str, object]:
    root = KML_DIR / "tiles_banded_stereo"
    levels: dict[str, object] = {}

    if not root.exists():
        return {"levels": levels}

    for level_dir in sorted(
        (path for path in root.iterdir() if path.is_dir() and path.name.isdigit()),
        key=lambda path: int(path.name),
    ):
        rows: dict[str, int] = {}
        for row_dir in sorted(
            (path for path in level_dir.iterdir() if path.is_dir() and path.name.isdigit()),
            key=lambda path: int(path.name),
        ):
            rows[row_dir.name] = len(list(row_dir.glob("*.jpg")))

        if rows:
            levels[level_dir.name] = {
                "row_count": len(rows),
                "max_x_tiles": max(rows.values()),
                "rows": rows,
            }

    return {"levels": levels}


def normalize_lon_360(lon: float) -> float:
    value = lon % 360.0
    return 0.0 if value == 360.0 else value


@lru_cache(maxsize=8)
def get_pyramid_rows(level: int) -> dict[int, int]:
    root = KML_DIR / "tiles_banded_stereo" / str(level)
    rows: dict[int, int] = {}
    if not root.exists():
        return rows

    for row_dir in root.iterdir():
        if row_dir.is_dir() and row_dir.name.isdigit():
            rows[int(row_dir.name)] = len(list(row_dir.glob("*.jpg")))
    return rows


@lru_cache(maxsize=768)
def cached_source_image(path_text: str) -> Image.Image:
    with Image.open(path_text) as image:
        return image.convert("RGB").copy()


def source_level_for_xyz(z: int) -> int:
    return max(0, min(5, z + 1))


def xyz_cache_path(z: int, x: int, y: int) -> Path:
    return TILE_CACHE_DIR / str(z) / str(x) / f"{y}.jpg"


def dem_xyz_cache_path(z: int, x: int, y: int) -> Path:
    return DEM_TEXTURE_CACHE_DIR / str(z) / str(x) / f"{y}.jpg"


def optical_xyz_cache_path(z: int, x: int, y: int) -> Path:
    return OPTICAL_TILE_CACHE_DIR / str(z) / str(x) / f"{y}.jpg"


def optical_mosaic_path() -> Path | None:
    if not OPTICAL_DIR.exists():
        return None
    preferred = OPTICAL_DIR / "Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif"
    if preferred.exists():
        return preferred
    return next(OPTICAL_DIR.glob("*.tif"), None)


def render_lola_xyz_tile(z: int, x: int, y: int) -> bytes:
    x_tiles = 2 ** (z + 1)
    y_tiles = 2**z
    if z < 0 or x < 0 or y < 0 or x >= x_tiles or y >= y_tiles:
        raise HTTPException(status_code=404, detail="Tile coordinate out of range.")

    cache_path = xyz_cache_path(z, x, y)
    if cache_path.exists():
        return cache_path.read_bytes()

    lon_width = 360.0 / x_tiles
    lat_height = 180.0 / y_tiles
    west = -180.0 + x * lon_width
    east = west + lon_width
    north = 90.0 - y * lat_height
    south = north - lat_height

    target_west = normalize_lon_360(west)
    target_east = normalize_lon_360(east)
    if target_east <= target_west:
        target_east += 360.0

    source_level = source_level_for_xyz(z)
    rows = get_pyramid_rows(source_level)
    if not rows:
        raise HTTPException(status_code=404, detail="LOLA imagery pyramid is unavailable.")

    source_row_count = max(rows.keys()) + 1
    source_lat_height = 180.0 / source_row_count
    row_start = max(0, int((90.0 - north) // source_lat_height))
    row_end = min(source_row_count - 1, int((90.0 - south - 1e-9) // source_lat_height))

    output = Image.new("RGB", (512, 512), "#303744")

    for source_y in range(row_start, row_end + 1):
        source_cols = rows.get(source_y)
        if not source_cols:
            continue

        source_north = 90.0 - source_y * source_lat_height
        source_south = source_north - source_lat_height
        overlap_north = min(north, source_north)
        overlap_south = max(south, source_south)
        if overlap_south >= overlap_north:
            continue

        source_lon_width = 360.0 / source_cols
        col_start = max(0, int(target_west // source_lon_width))
        col_end = min(source_cols - 1, int((target_east - 1e-9) // source_lon_width))

        for source_x in range(col_start, col_end + 1):
            source_west = source_x * source_lon_width
            source_east = source_west + source_lon_width
            overlap_west = max(target_west, source_west)
            overlap_east = min(target_east, source_east)
            if overlap_west >= overlap_east:
                continue

            image_path = KML_DIR / "tiles_banded_stereo" / str(source_level) / str(source_y) / f"{source_x}.jpg"
            if not image_path.exists():
                continue

            source_image = cached_source_image(str(image_path))
            src_left = int(round(((overlap_west - source_west) / source_lon_width) * source_image.width))
            src_right = int(round(((overlap_east - source_west) / source_lon_width) * source_image.width))
            src_top = int(round(((source_north - overlap_north) / source_lat_height) * source_image.height))
            src_bottom = int(round(((source_north - overlap_south) / source_lat_height) * source_image.height))

            dst_left = int(round(((overlap_west - target_west) / (target_east - target_west)) * 512))
            dst_right = int(round(((overlap_east - target_west) / (target_east - target_west)) * 512))
            dst_top = int(round(((north - overlap_north) / (north - south)) * 512))
            dst_bottom = int(round(((north - overlap_south) / (north - south)) * 512))

            if src_right <= src_left or src_bottom <= src_top or dst_right <= dst_left or dst_bottom <= dst_top:
                continue

            patch = source_image.crop((src_left, src_top, src_right, src_bottom))
            patch = patch.resize((dst_right - dst_left, dst_bottom - dst_top), Image.Resampling.BICUBIC)
            output.paste(patch, (dst_left, dst_top))

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    output.save(buffer, format="JPEG", quality=88)
    data = buffer.getvalue()
    temp_path = cache_path.with_name(f"{cache_path.name}.{uuid4().hex}.tmp")
    temp_path.write_bytes(data)
    temp_path.replace(cache_path)
    return data


def read_dem_texture_interval(
    min_lat: float,
    max_lat: float,
    lon_min: float,
    lon_max: float,
    width: int,
    height: int,
) -> np.ndarray:
    mosaic = np.full((height, width), np.nan, dtype=np.float32)
    tiles = find_intersecting_tiles(TILES, min_lat, max_lat, lon_min, lon_max)

    for tile in tiles:
        left = max(lon_min, tile.min_lon)
        right = min(lon_max, tile.max_lon)
        bottom = max(min_lat, tile.min_lat)
        top = min(max_lat, tile.max_lat)

        if left >= right or bottom >= top:
            continue

        col_start = max(0, min(width - 1, round((left - lon_min) / (lon_max - lon_min) * width)))
        col_end = max(col_start + 1, min(width, round((right - lon_min) / (lon_max - lon_min) * width)))
        row_start = max(0, min(height - 1, round((max_lat - top) / (max_lat - min_lat) * height)))
        row_end = max(row_start + 1, min(height, round((max_lat - bottom) / (max_lat - min_lat) * height)))

        out_height = row_end - row_start
        out_width = col_end - col_start
        if out_height <= 0 or out_width <= 0:
            continue

        with rasterio.open(tile.path) as dataset:
            window = from_bounds(left, bottom, right, top, transform=dataset.transform)
            data = dataset.read(
                1,
                window=window,
                out_shape=(out_height, out_width),
                resampling=Resampling.bilinear,
                masked=True,
            ).astype(np.float32)

        if np.ma.is_masked(data):
            values = np.asarray(data.filled(np.nan), dtype=np.float32)
        else:
            values = np.asarray(data, dtype=np.float32)

        mosaic[row_start:row_end, col_start:col_end] = values * 0.5 - MOON_RADIUS_M

    return mosaic


def colorize_dem_texture(height_m: np.ndarray) -> Image.Image:
    finite = np.isfinite(height_m)
    if not np.any(finite):
        return Image.new("RGB", (height_m.shape[1], height_m.shape[0]), "#303744")

    filled = height_m.copy()
    filled[~finite] = np.nanmedian(filled[finite])

    stops = np.array(
        [
            [0.00, 0.02, 0.14, 0.48],
            [0.28, 0.00, 0.44, 0.70],
            [0.46, 0.08, 0.64, 0.72],
            [0.58, 0.50, 0.78, 0.70],
            [0.72, 0.84, 0.80, 0.40],
            [1.00, 0.86, 0.34, 0.12],
        ],
        dtype=np.float32,
    )
    normalized = np.clip((filled + 7000.0) / 14000.0, 0.0, 1.0)
    red = np.interp(normalized, stops[:, 0], stops[:, 1])
    green = np.interp(normalized, stops[:, 0], stops[:, 2])
    blue = np.interp(normalized, stops[:, 0], stops[:, 3])
    rgb = np.stack([red, green, blue], axis=-1)

    gradient_y, gradient_x = np.gradient(filled)
    relief = (-0.55 * gradient_x) + (0.75 * gradient_y)
    scale = np.nanpercentile(np.abs(relief[finite]), 96)
    if not np.isfinite(scale) or scale <= 0:
        scale = 1.0
    shade = 0.76 + 0.34 * np.clip(relief / scale, -1.0, 1.0)
    rgb = np.clip(rgb * shade[..., None], 0.0, 1.0)
    rgb[~finite] = np.array([0.18, 0.22, 0.27], dtype=np.float32)

    return Image.fromarray((rgb * 255).astype(np.uint8), mode="RGB")


def render_dem_xyz_tile(z: int, x: int, y: int) -> bytes:
    x_tiles = 2 ** (z + 1)
    y_tiles = 2**z
    if z < 0 or x < 0 or y < 0 or x >= x_tiles or y >= y_tiles:
        raise HTTPException(status_code=404, detail="Tile coordinate out of range.")

    cache_path = dem_xyz_cache_path(z, x, y)
    if cache_path.exists():
        return cache_path.read_bytes()

    lon_width = 360.0 / x_tiles
    lat_height = 180.0 / y_tiles
    west = -180.0 + x * lon_width
    east = west + lon_width
    north = 90.0 - y * lat_height
    south = north - lat_height

    target_west = normalize_lon_360(west)
    target_east = normalize_lon_360(east)
    unwrapped_east = target_east
    if unwrapped_east <= target_west:
        unwrapped_east += 360.0

    mosaic = np.full((512, 512), np.nan, dtype=np.float32)
    segments: list[tuple[float, float, float, float]] = []
    if target_east <= target_west:
        segments.append((target_west, 360.0, target_west, unwrapped_east))
        segments.append((0.0, target_east, 360.0, unwrapped_east))
    else:
        segments.append((target_west, target_east, target_west, unwrapped_east))

    for lon_min, lon_max, draw_min, draw_max in segments:
        if lon_min >= lon_max:
            continue

        col_start = max(0, min(511, round((draw_min - target_west) / (unwrapped_east - target_west) * 512)))
        col_end = max(col_start + 1, min(512, round((draw_max - target_west) / (unwrapped_east - target_west) * 512)))
        segment = read_dem_texture_interval(south, north, lon_min, lon_max, col_end - col_start, 512)
        mosaic[:, col_start:col_end] = segment

    image = colorize_dem_texture(mosaic)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=90)
    data = buffer.getvalue()
    temp_path = cache_path.with_name(f"{cache_path.name}.{uuid4().hex}.tmp")
    temp_path.write_bytes(data)
    temp_path.replace(cache_path)
    return data


def render_optical_xyz_tile(z: int, x: int, y: int) -> bytes:
    x_tiles = 2 ** (z + 1)
    y_tiles = 2**z
    if z < 0 or x < 0 or y < 0 or x >= x_tiles or y >= y_tiles:
        raise HTTPException(status_code=404, detail="Tile coordinate out of range.")

    mosaic_path = optical_mosaic_path()
    if not mosaic_path:
        raise HTTPException(status_code=404, detail=f"No optical mosaic GeoTIFF found in {OPTICAL_DIR}.")

    cache_path = optical_xyz_cache_path(z, x, y)
    if cache_path.exists():
        return cache_path.read_bytes()

    lon_width = 360.0 / x_tiles
    lat_height = 180.0 / y_tiles
    west = -180.0 + x * lon_width
    east = west + lon_width
    north = 90.0 - y * lat_height
    south = north - lat_height

    meters_per_radian = MOON_RADIUS_M
    left = meters_per_radian * (west * pi / 180.0)
    right = meters_per_radian * (east * pi / 180.0)
    bottom = meters_per_radian * (south * pi / 180.0)
    top = meters_per_radian * (north * pi / 180.0)

    with rasterio.open(mosaic_path) as dataset:
        window = from_bounds(left, bottom, right, top, transform=dataset.transform)
        data = dataset.read(
            1,
            window=window,
            out_shape=(512, 512),
            resampling=Resampling.bilinear,
            boundless=True,
            fill_value=0,
        )

    image = Image.fromarray(data.astype(np.uint8), mode="L").convert("RGB")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=92)
    payload = buffer.getvalue()
    temp_path = cache_path.with_name(f"{cache_path.name}.{uuid4().hex}.tmp")
    temp_path.write_bytes(payload)
    temp_path.replace(cache_path)
    return payload


@app.get("/lola-xyz/{z}/{x}/{y}.jpg")
def lola_xyz_tile(z: int, x: int, y: int) -> Response:
    data = render_lola_xyz_tile(z, x, y)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.get("/dem-xyz/{z}/{x}/{y}.jpg")
def dem_xyz_tile(z: int, x: int, y: int) -> Response:
    data = render_dem_xyz_tile(z, x, y)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.get("/optical-xyz/{z}/{x}/{y}.jpg")
def optical_xyz_tile(z: int, x: int, y: int) -> Response:
    data = render_optical_xyz_tile(z, x, y)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


def prefetch_tiles(
    request: TexturePrefetchRequest,
    cache_path_for_tile,
    render_tile,
) -> dict[str, object]:
    generated = 0
    cached = 0
    failed: list[dict[str, object]] = []

    def warm_tile(tile: TextureTileRequest):
        cache_path = cache_path_for_tile(tile.z, tile.x, tile.y)
        if cache_path.exists():
            return "cached"

        try:
            render_tile(tile.z, tile.x, tile.y)
            return "generated"
        except HTTPException as exc:
            return {"z": tile.z, "x": tile.x, "y": tile.y, "reason": exc.detail}

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(warm_tile, tile) for tile in request.tiles]
        for future in as_completed(futures):
            result = future.result()
            if result == "cached":
                cached += 1
            elif result == "generated":
                generated += 1
            else:
                failed.append(result)

    return {
        "requested": len(request.tiles),
        "cached": cached,
        "generated": generated,
        "failed": failed[:20],
    }


@app.post("/prefetch-lola-tiles")
def prefetch_lola_tiles(request: TexturePrefetchRequest) -> dict[str, object]:
    return prefetch_tiles(request, xyz_cache_path, render_lola_xyz_tile)


@app.post("/prefetch-dem-tiles")
def prefetch_dem_tiles(request: TexturePrefetchRequest) -> dict[str, object]:
    return prefetch_tiles(request, dem_xyz_cache_path, render_dem_xyz_tile)


@app.post("/prefetch-optical-tiles")
def prefetch_optical_tiles(request: TexturePrefetchRequest) -> dict[str, object]:
    return prefetch_tiles(request, optical_xyz_cache_path, render_optical_xyz_tile)


@app.get("/tiles")
def tiles() -> dict[str, object]:
    return {
        "count": len(TILES),
        "tiles": [
            {
                "name": tile.path.name,
                "min_lat": tile.min_lat,
                "max_lat": tile.max_lat,
                "min_lon": tile.min_lon,
                "max_lon": tile.max_lon,
            }
            for tile in TILES
        ],
    }


def estimate_shape(min_lat: float, max_lat: float, intervals: list[tuple[float, float]], downsample: int) -> tuple[int, int]:
    res_deg = downsample / LOLA_PIXELS_PER_DEGREE
    lon_span = sum(lon_max - lon_min for lon_min, lon_max in intervals)
    width = max(2, ceil(lon_span / res_deg) + 1)
    height = max(2, ceil((max_lat - min_lat) / res_deg) + 1)
    return height, width


def estimate_solid_triangles(height: int, width: int) -> int:
    top_cells = (height - 1) * (width - 1)
    edge_cells = 2 * (height - 1) + 2 * (width - 1)
    return (top_cells * 4) + (edge_cells * 2)


def estimate_binary_stl_bytes(triangles: int) -> int:
    return 84 + (50 * triangles)


def format_bytes(size: int) -> str:
    units = ("B", "KB", "MB", "GB", "TB")
    value = float(size)
    for unit in units:
        if value < 1000 or unit == units[-1]:
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1000
    return f"{value:.1f} TB"


def unwrap_lon_to_reference(lon: float, reference: float) -> float:
    value = normalize_lon_360(lon)
    while value - reference > 180.0:
        value -= 360.0
    while reference - value > 180.0:
        value += 360.0
    return value


def export_request_info(request: ExportRequest) -> ExportInfo:
    intervals = longitude_intervals(request.min_lon, request.max_lon)
    estimated_height, estimated_width = estimate_shape(
        request.min_lat,
        request.max_lat,
        intervals,
        request.downsample,
    )
    estimated_triangles = estimate_solid_triangles(estimated_height, estimated_width)
    estimated_stl_bytes = estimate_binary_stl_bytes(estimated_triangles)
    tiles = find_intersecting_tiles(TILES, request.min_lat, request.max_lat, request.min_lon, request.max_lon)
    tile_payload = [
        {
            "name": tile.path.name,
            "min_lat": tile.min_lat,
            "max_lat": tile.max_lat,
            "min_lon": tile.min_lon,
            "max_lon": tile.max_lon,
        }
        for tile in tiles
    ]

    if not TILES:
        reason = f"No ldem_1024 JP2 tiles found in {DEM_DIR}."
        ok = False
    elif estimated_triangles > MAX_TRIANGLES:
        reason = (
            f"Requested grid would produce about {estimated_triangles:,} triangles "
            f"(~{format_bytes(estimated_stl_bytes)} binary STL). "
            "Increase downsample or select a smaller region."
        )
        ok = False
    elif not tiles:
        reason = "No local LOLA DEM tiles intersect the selected bounds."
        ok = False
    else:
        reason = (
            f"Ready: {len(tiles)} local DEM tile(s), about {estimated_triangles:,} triangles, "
            f"~{format_bytes(estimated_stl_bytes)} binary STL."
        )
        ok = True

    return ExportInfo(
        ok=ok,
        reason=reason,
        tile_count=len(tiles),
        estimated_width=estimated_width,
        estimated_height=estimated_height,
        estimated_triangles=estimated_triangles,
        estimated_stl_bytes=estimated_stl_bytes,
        tiles=tile_payload,
    )


@app.post("/export-info")
def export_info(request: ExportRequest) -> ExportInfo:
    return export_request_info(request)


def read_interval(
    tiles: list[Tile],
    min_lat: float,
    max_lat: float,
    lon_min: float,
    lon_max: float,
    downsample: int,
) -> np.ndarray:
    res_deg = downsample / LOLA_PIXELS_PER_DEGREE
    width = max(2, ceil((lon_max - lon_min) / res_deg) + 1)
    height = max(2, ceil((max_lat - min_lat) / res_deg) + 1)
    mosaic = np.full((height, width), np.nan, dtype=np.float32)

    for tile in tiles:
        if not (tile.min_lat < max_lat and tile.max_lat > min_lat and tile.min_lon < lon_max and tile.max_lon > lon_min):
            continue

        left = max(lon_min, tile.min_lon)
        right = min(lon_max, tile.max_lon)
        bottom = max(min_lat, tile.min_lat)
        top = min(max_lat, tile.max_lat)

        col_start = max(0, min(width - 1, round((left - lon_min) / res_deg)))
        col_end = max(col_start + 1, min(width, round((right - lon_min) / res_deg) + 1))
        row_start = max(0, min(height - 1, round((max_lat - top) / res_deg)))
        row_end = max(row_start + 1, min(height, round((max_lat - bottom) / res_deg) + 1))

        out_height = row_end - row_start
        out_width = col_end - col_start
        if out_height <= 0 or out_width <= 0:
            continue

        with rasterio.open(tile.path) as dataset:
            window = from_bounds(left, bottom, right, top, transform=dataset.transform)
            data = dataset.read(
                1,
                window=window,
                out_shape=(out_height, out_width),
                resampling=Resampling.bilinear,
            ).astype(np.float32)

        height_m = data * 0.5 - MOON_RADIUS_M
        mosaic[row_start:row_end, col_start:col_end] = height_m

    return mosaic


def read_selection(request: ExportRequest, tiles: list[Tile]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    intervals = longitude_intervals(request.min_lon, request.max_lon)
    grids: list[np.ndarray] = []
    lon_vectors: list[np.ndarray] = []
    unwrap_offset = 0.0

    for index, (lon_min, lon_max) in enumerate(intervals):
        if index > 0 and intervals[index - 1][1] == 360.0:
            unwrap_offset = 360.0

        grid = read_interval(tiles, request.min_lat, request.max_lat, lon_min, lon_max, request.downsample)
        grids.append(grid)
        lon_vectors.append(np.linspace(lon_min + unwrap_offset, lon_max + unwrap_offset, grid.shape[1], dtype=np.float64))

    if not grids:
        raise HTTPException(status_code=404, detail="No longitude interval could be built for this selection.")

    first_height = grids[0].shape[0]
    if any(grid.shape[0] != first_height for grid in grids):
        raise HTTPException(status_code=500, detail="Mosaic interval heights did not match.")

    height_grid = np.hstack(grids) if len(grids) > 1 else grids[0]
    lons = np.concatenate(lon_vectors)
    lats = np.linspace(request.max_lat, request.min_lat, height_grid.shape[0], dtype=np.float64)
    return height_grid, lons, lats


def projected_grid(
    lons: np.ndarray,
    lats: np.ndarray,
    lat0: float,
    lon0: float,
) -> tuple[np.ndarray, np.ndarray]:
    meters_per_degree = MOON_RADIUS_M * pi / 180.0
    unwrapped_lons = np.array([unwrap_lon_to_reference(float(lon), lon0) for lon in lons], dtype=np.float64)
    xs = (unwrapped_lons - lon0) * meters_per_degree * cos(lat0 * pi / 180.0)
    ys = (lats - lat0) * meters_per_degree
    return np.meshgrid(xs, ys)


def spherical_circle_mask(
    lons: np.ndarray,
    lats: np.ndarray,
    center_lat: float,
    center_lon: float,
    radius_m: float,
) -> np.ndarray:
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    lat0 = center_lat * pi / 180.0
    lat_grid_rad = np.deg2rad(lat_grid)
    dlat = lat_grid_rad - lat0
    dlon = np.deg2rad(((lon_grid - normalize_lon_360(center_lon) + 180.0) % 360.0) - 180.0)
    haversine = (
        np.sin(dlat / 2.0) ** 2
        + cos(lat0) * np.cos(lat_grid_rad) * np.sin(dlon / 2.0) ** 2
    )
    radius_angle = radius_m / MOON_RADIUS_M
    return haversine <= (np.sin(radius_angle / 2.0) ** 2)


def unit_vectors_from_lon_lat(lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
    lon_rad = np.deg2rad(lons)
    lat_rad = np.deg2rad(lats)
    cos_lat = np.cos(lat_rad)
    return np.stack(
        (
            cos_lat * np.cos(lon_rad),
            cos_lat * np.sin(lon_rad),
            np.sin(lat_rad),
        ),
        axis=-1,
    )


def normalize_vector(vector: np.ndarray, fallback: np.ndarray) -> np.ndarray:
    magnitude = float(np.linalg.norm(vector))
    if magnitude < 1e-12:
        return fallback.astype(np.float64)
    return vector / magnitude


def tangent_basis(center_vector: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    reference = np.array([0.0, 0.0, 1.0], dtype=np.float64)
    if abs(float(np.dot(center_vector, reference))) > 0.92:
        reference = np.array([1.0, 0.0, 0.0], dtype=np.float64)

    east = normalize_vector(np.cross(reference, center_vector), np.array([1.0, 0.0, 0.0], dtype=np.float64))
    north = normalize_vector(np.cross(center_vector, east), np.array([0.0, 1.0, 0.0], dtype=np.float64))
    return east, north


def tangent_grid_from_vector(
    lons: np.ndarray,
    lats: np.ndarray,
    center_vector: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    east, north = tangent_basis(center_vector)
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    grid_vectors = unit_vectors_from_lon_lat(lon_grid, lat_grid)
    grid_offsets = (grid_vectors - center_vector) * MOON_RADIUS_M
    xv = np.tensordot(grid_offsets, east, axes=([-1], [0]))
    yv = np.tensordot(grid_offsets, north, axes=([-1], [0]))
    return xv, yv


def tangent_projected_grid(
    lons: np.ndarray,
    lats: np.ndarray,
    polygon_lons: list[float],
    polygon_lats: list[float],
) -> tuple[np.ndarray, np.ndarray, list[tuple[float, float]]]:
    polygon_vectors = unit_vectors_from_lon_lat(np.array(polygon_lons), np.array(polygon_lats))
    center_vector = normalize_vector(np.sum(polygon_vectors, axis=0), polygon_vectors[0])
    east, north = tangent_basis(center_vector)
    xv, yv = tangent_grid_from_vector(lons, lats, center_vector)

    polygon_offsets = (polygon_vectors - center_vector) * MOON_RADIUS_M
    polygon_xy = [
        (float(np.dot(offset, east)), float(np.dot(offset, north)))
        for offset in polygon_offsets
    ]
    return xv, yv, polygon_xy


def points_in_polygon(x: np.ndarray, y: np.ndarray, polygon_xy: list[tuple[float, float]]) -> np.ndarray:
    inside = np.zeros(x.shape, dtype=bool)
    xj, yj = polygon_xy[-1]
    for xi, yi in polygon_xy:
        crosses = ((yi > y) != (yj > y)) & (x < ((xj - xi) * (y - yi) / ((yj - yi) + 1e-12) + xi))
        inside ^= crosses
        xj, yj = xi, yi
    return inside


def apply_selection_mask(
    request: ExportRequest,
    height_grid: np.ndarray,
    lons: np.ndarray,
    lats: np.ndarray,
) -> np.ndarray:
    if request.selection_type == "rectangle":
        return height_grid

    masked = height_grid.copy()

    if request.selection_type == "circle":
        assert request.circle_center_lat is not None
        assert request.circle_center_lon is not None
        assert request.circle_radius_m is not None
        inside = spherical_circle_mask(
            lons,
            lats,
            request.circle_center_lat,
            request.circle_center_lon,
            request.circle_radius_m,
        )
    else:
        assert request.polygon is not None
        reference_lon = float(np.mean(lons))
        polygon_lons = [unwrap_lon_to_reference(point.lon, reference_lon) for point in request.polygon]
        polygon_lats = [point.lat for point in request.polygon]
        xv, yv, polygon_xy = tangent_projected_grid(lons, lats, polygon_lons, polygon_lats)
        inside = points_in_polygon(xv, yv, polygon_xy)

    masked[~inside] = np.nan
    return masked


def request_center_vector(request: ExportRequest, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
    if request.selection_type == "circle":
        assert request.circle_center_lat is not None
        assert request.circle_center_lon is not None
        return unit_vectors_from_lon_lat(
            np.array([request.circle_center_lon], dtype=np.float64),
            np.array([request.circle_center_lat], dtype=np.float64),
        )[0]

    if request.selection_type == "polygon" and request.polygon:
        polygon_vectors = unit_vectors_from_lon_lat(
            np.array([point.lon for point in request.polygon], dtype=np.float64),
            np.array([point.lat for point in request.polygon], dtype=np.float64),
        )
        fallback_index = int(np.argmax(np.abs([point.lat for point in request.polygon])))
        return normalize_vector(np.sum(polygon_vectors, axis=0), polygon_vectors[fallback_index])

    center_lat = float((request.min_lat + request.max_lat) / 2.0)
    center_lon = float((lons.min() + lons.max()) / 2.0)
    return unit_vectors_from_lon_lat(
        np.array([center_lon], dtype=np.float64),
        np.array([center_lat], dtype=np.float64),
    )[0]


def should_use_tangent_mesh(request: ExportRequest, lons: np.ndarray) -> bool:
    max_abs_lat = max(abs(request.min_lat), abs(request.max_lat))
    lon_span = float(lons.max() - lons.min()) if lons.size else 0.0
    return request.selection_type != "rectangle" or max_abs_lat >= 75.0 or lon_span >= 180.0


def mesh_xy_grid(request: ExportRequest, lons: np.ndarray, lats: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if should_use_tangent_mesh(request, lons):
        center_vector = request_center_vector(request, lons, lats)
        return tangent_grid_from_vector(lons, lats, center_vector)

    lat0 = float((lats.min() + lats.max()) / 2.0)
    lon0 = float((lons.min() + lons.max()) / 2.0)
    return projected_grid(lons, lats, lat0, lon0)


def build_mesh(
    height_grid: np.ndarray,
    lons: np.ndarray,
    lats: np.ndarray,
    z_exaggeration: float,
    base_thickness: float,
    request: ExportRequest,
) -> trimesh.Trimesh:
    finite = np.isfinite(height_grid)
    if not np.any(finite):
        raise HTTPException(status_code=422, detail="Selected tiles produced no valid elevation samples.")

    z = (height_grid - np.nanmin(height_grid)) * z_exaggeration
    xv, yv = mesh_xy_grid(request, lons, lats)

    top_vertex_ids = np.full(height_grid.shape, -1, dtype=np.int64)
    bottom_vertex_ids = np.full(height_grid.shape, -1, dtype=np.int64)
    top_vertex_ids[finite] = np.arange(int(finite.sum()), dtype=np.int64)
    bottom_vertex_ids[finite] = top_vertex_ids[finite] + int(finite.sum())

    top_vertices = np.column_stack((xv[finite], yv[finite], z[finite]))
    bottom_vertices = np.column_stack((xv[finite], yv[finite], np.full(int(finite.sum()), -base_thickness)))
    vertices = np.vstack((top_vertices, bottom_vertices)).astype(np.float32)

    valid_cells = finite[:-1, :-1] & finite[1:, :-1] & finite[:-1, 1:] & finite[1:, 1:]
    if not np.any(valid_cells):
        raise HTTPException(status_code=422, detail="Selected area did not contain enough valid samples to form triangles.")

    top_left = top_vertex_ids[:-1, :-1][valid_cells]
    bottom_left = top_vertex_ids[1:, :-1][valid_cells]
    top_right = top_vertex_ids[:-1, 1:][valid_cells]
    bottom_right = top_vertex_ids[1:, 1:][valid_cells]

    base_top_left = bottom_vertex_ids[:-1, :-1][valid_cells]
    base_bottom_left = bottom_vertex_ids[1:, :-1][valid_cells]
    base_top_right = bottom_vertex_ids[:-1, 1:][valid_cells]
    base_bottom_right = bottom_vertex_ids[1:, 1:][valid_cells]

    face_parts = [
        np.column_stack((top_left, bottom_left, top_right)),
        np.column_stack((top_right, bottom_left, bottom_right)),
        np.column_stack((base_top_right, base_bottom_left, base_top_left)),
        np.column_stack((base_bottom_right, base_bottom_left, base_top_right)),
    ]

    # Boundary walls close rectangular, circular, and polygon masks into printable solids.
    north = valid_cells.copy()
    north[1:, :] &= ~valid_cells[:-1, :]
    if np.any(north):
        a = top_vertex_ids[:-1, :-1][north]
        b = top_vertex_ids[:-1, 1:][north]
        c = bottom_vertex_ids[:-1, :-1][north]
        d = bottom_vertex_ids[:-1, 1:][north]
        face_parts.extend((np.column_stack((a, b, c)), np.column_stack((b, d, c))))

    south = valid_cells.copy()
    south[:-1, :] &= ~valid_cells[1:, :]
    if np.any(south):
        a = top_vertex_ids[1:, :-1][south]
        b = top_vertex_ids[1:, 1:][south]
        c = bottom_vertex_ids[1:, :-1][south]
        d = bottom_vertex_ids[1:, 1:][south]
        face_parts.extend((np.column_stack((b, a, d)), np.column_stack((a, c, d))))

    west = valid_cells.copy()
    west[:, 1:] &= ~valid_cells[:, :-1]
    if np.any(west):
        a = top_vertex_ids[:-1, :-1][west]
        b = top_vertex_ids[1:, :-1][west]
        c = bottom_vertex_ids[:-1, :-1][west]
        d = bottom_vertex_ids[1:, :-1][west]
        face_parts.extend((np.column_stack((b, a, d)), np.column_stack((a, c, d))))

    east = valid_cells.copy()
    east[:, :-1] &= ~valid_cells[:, 1:]
    if np.any(east):
        a = top_vertex_ids[:-1, 1:][east]
        b = top_vertex_ids[1:, 1:][east]
        c = bottom_vertex_ids[:-1, 1:][east]
        d = bottom_vertex_ids[1:, 1:][east]
        face_parts.extend((np.column_stack((a, b, c)), np.column_stack((b, d, c))))

    faces = np.vstack(face_parts).astype(np.int64)

    if faces.shape[0] > MAX_TRIANGLES:
        raise HTTPException(
            status_code=413,
            detail=f"STL would contain {faces.shape[0]:,} triangles; increase downsample or select a smaller region.",
        )

    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def export_filename(request: ExportRequest) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stem = (
        f"moon_{timestamp}_lat_{request.min_lat:.3f}_{request.max_lat:.3f}_"
        f"lon_{request.min_lon:.3f}_{request.max_lon:.3f}_base_{request.base_thickness:.0f}"
    ).replace("-", "m").replace(".", "p")
    return f"{stem}.stl"


def mesh_from_request(request: ExportRequest) -> trimesh.Trimesh:
    info = export_request_info(request)
    if not info.ok:
        status_code = 413 if info.estimated_triangles > MAX_TRIANGLES else 404
        raise HTTPException(status_code=status_code, detail=info.reason)

    tiles = find_intersecting_tiles(TILES, request.min_lat, request.max_lat, request.min_lon, request.max_lon)
    height_grid, lons, lats = read_selection(request, tiles)
    height_grid = apply_selection_mask(request, height_grid, lons, lats)
    return build_mesh(height_grid, lons, lats, request.z_exaggeration, request.base_thickness, request)


def estimate_triangles_for_downsample(request: ExportRequest, downsample: int) -> int:
    intervals = longitude_intervals(request.min_lon, request.max_lon)
    estimated_height, estimated_width = estimate_shape(
        request.min_lat,
        request.max_lat,
        intervals,
        downsample,
    )
    return estimate_solid_triangles(estimated_height, estimated_width)


def preview_request_for_limit(request: ExportRequest) -> tuple[ExportRequest, int]:
    downsample = request.downsample
    estimated_triangles = estimate_triangles_for_downsample(request, downsample)

    while estimated_triangles > MAX_PREVIEW_TRIANGLES and downsample < 2048:
        scale = (estimated_triangles / MAX_PREVIEW_TRIANGLES) ** 0.5
        downsample = min(2048, max(downsample + 1, ceil(downsample * scale)))
        estimated_triangles = estimate_triangles_for_downsample(request, downsample)

    return request.model_copy(update={"downsample": downsample}), estimated_triangles


@app.post("/preview-stl")
def preview_stl(request: ExportRequest) -> FileResponse:
    try:
        preview_request, preview_triangles = preview_request_for_limit(request)
        mesh = mesh_from_request(preview_request)
        preview_triangles = int(len(mesh.faces))
        filename = f"open_moon_preview_{uuid4().hex}.stl"
        path = PREVIEW_DIR / filename
        mesh.export(path)
        preview_bytes = path.stat().st_size
        return FileResponse(
            path,
            media_type="model/stl",
            filename=filename,
            headers={
                "X-Open-Moon-Preview-Downsample": str(preview_request.downsample),
                "X-Open-Moon-Preview-Triangles": str(preview_triangles),
                "X-Open-Moon-Preview-Bytes": str(preview_bytes),
            },
            background=BackgroundTask(path.unlink, missing_ok=True),
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Preview failed: {type(exc).__name__}: {exc}") from exc


@app.post("/export-stl")
def export_stl(request: ExportRequest) -> FileResponse:
    try:
        mesh = mesh_from_request(request)
        filename = export_filename(request)
        path = EXPORT_DIR / filename
        mesh.export(path)

        return FileResponse(path, media_type="model/stl", filename=filename)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Export failed: {type(exc).__name__}: {exc}") from exc


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
