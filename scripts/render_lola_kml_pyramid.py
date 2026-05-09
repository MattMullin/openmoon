from __future__ import annotations

import argparse
import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from xml.sax.saxutils import escape

import numpy as np
import rasterio
from PIL import Image, ImageDraw
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

PROJECT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = PROJECT_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from tile_index import Tile, build_tile_index, find_intersecting_tiles  # noqa: E402


MOON_RADIUS_M = 1_737_400.0
ROOT_KML_NAME = "OpenMoon_LOLA_Relief.kml"


def normalize_lon_360(lon: float) -> float:
    value = lon % 360.0
    return 0.0 if value == 360.0 else value


def level_shape(level: int) -> tuple[int, int]:
    return 2 ** (level + 1), 2**level


def tile_bounds(level: int, x: int, y: int) -> tuple[float, float, float, float]:
    x_tiles, y_tiles = level_shape(level)
    lon_width = 360.0 / x_tiles
    lat_height = 180.0 / y_tiles
    west = -180.0 + x * lon_width
    east = west + lon_width
    north = 90.0 - y * lat_height
    south = north - lat_height
    return west, south, east, north


def display_lon_segments(west: float, east: float) -> list[tuple[float, float, float, float]]:
    width = east - west
    if width >= 360.0:
        return [(0.0, 360.0, 0.0, 360.0)]

    target_start = normalize_lon_360(west)
    target_end = target_start + width
    if target_end <= 360.0:
        return [(target_start, target_end, target_start, target_end)]

    return [
        (target_start, 360.0, target_start, 360.0),
        (0.0, target_end - 360.0, 360.0, target_end),
    ]


def read_dem_interval(
    tiles: list[Tile],
    min_lat: float,
    max_lat: float,
    lon_min: float,
    lon_max: float,
    width: int,
    height: int,
) -> np.ndarray:
    mosaic = np.full((height, width), np.nan, dtype=np.float32)

    for tile in find_intersecting_tiles(tiles, min_lat, max_lat, lon_min, lon_max):
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


def read_tile_dem(
    tiles: list[Tile],
    west: float,
    south: float,
    east: float,
    north: float,
    tile_size: int,
) -> np.ndarray:
    target_start = normalize_lon_360(west)
    target_end = target_start + (east - west)
    mosaic = np.full((tile_size, tile_size), np.nan, dtype=np.float32)

    for lon_min, lon_max, draw_min, draw_max in display_lon_segments(west, east):
        if lon_min >= lon_max:
            continue
        col_start = max(0, min(tile_size - 1, round((draw_min - target_start) / (target_end - target_start) * tile_size)))
        col_end = max(col_start + 1, min(tile_size, round((draw_max - target_start) / (target_end - target_start) * tile_size)))
        segment = read_dem_interval(tiles, south, north, lon_min, lon_max, col_end - col_start, tile_size)
        mosaic[:, col_start:col_end] = segment

    return mosaic


def colorize_dem(height_m: np.ndarray, min_height: float, max_height: float, style: str) -> Image.Image:
    finite = np.isfinite(height_m)
    if not np.any(finite):
        return Image.new("RGB", (height_m.shape[1], height_m.shape[0]), "#303744")

    filled = height_m.copy()
    filled[~finite] = np.nanmedian(filled[finite])
    normalized = np.clip((filled - min_height) / max(1.0, max_height - min_height), 0.0, 1.0)

    if style == "gray":
        rgb = np.repeat(normalized[..., None], 3, axis=-1)
    else:
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
        red = np.interp(normalized, stops[:, 0], stops[:, 1])
        green = np.interp(normalized, stops[:, 0], stops[:, 2])
        blue = np.interp(normalized, stops[:, 0], stops[:, 3])
        rgb = np.stack([red, green, blue], axis=-1)

    if style in {"relief", "hypsometric"}:
        gradient_y, gradient_x = np.gradient(filled)
        relief = (-0.55 * gradient_x) + (0.75 * gradient_y)
        scale = np.nanpercentile(np.abs(relief[finite]), 96)
        if not np.isfinite(scale) or scale <= 0:
            scale = 1.0
        shade = 0.76 + 0.34 * np.clip(relief / scale, -1.0, 1.0)
        rgb = np.clip(rgb * shade[..., None], 0.0, 1.0)

    rgb[~finite] = np.array([0.18, 0.22, 0.27], dtype=np.float32)
    return Image.fromarray((rgb * 255).astype(np.uint8), mode="RGB")


def kml_header(name: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<kml xmlns="http://www.opengis.net/kml/2.2">\n'
        "<Document>\n"
        f"  <name>{escape(name)}</name>\n"
    )


def kml_footer() -> str:
    return "</Document>\n</kml>\n"


def lat_lon_box(west: float, south: float, east: float, north: float, indent: str = "    ") -> str:
    return (
        f"{indent}<LatLonAltBox>\n"
        f"{indent}  <north>{north:.10f}</north><south>{south:.10f}</south>\n"
        f"{indent}  <east>{east:.10f}</east><west>{west:.10f}</west>\n"
        f"{indent}</LatLonAltBox>\n"
    )


def ground_overlay_kml(west: float, south: float, east: float, north: float, image_name: str) -> str:
    return (
        "  <GroundOverlay>\n"
        "    <drawOrder>1</drawOrder>\n"
        f"    <Icon><href>{escape(image_name)}</href></Icon>\n"
        "    <LatLonBox>\n"
        f"      <north>{north:.10f}</north><south>{south:.10f}</south>\n"
        f"      <east>{east:.10f}</east><west>{west:.10f}</west>\n"
        "    </LatLonBox>\n"
        "  </GroundOverlay>\n"
    )


def network_link_kml(level: int, x: int, y: int, current_level: Optional[int], max_lod: int) -> str:
    west, south, east, north = tile_bounds(level, x, y)
    if current_level is None:
        href = f"{level}/{y}/{x}.kml"
    else:
        href = f"../../{level}/{y}/{x}.kml"

    return (
        "  <NetworkLink>\n"
        f"    <name>L{level}_{x}_{y}</name>\n"
        "    <Region>\n"
        f"{lat_lon_box(west, south, east, north, '      ')}"
        f"      <Lod><minLodPixels>128</minLodPixels><maxLodPixels>{max_lod}</maxLodPixels></Lod>\n"
        "    </Region>\n"
        "    <Link>\n"
        f"      <href>{escape(href)}</href>\n"
        "      <viewRefreshMode>onRegion</viewRefreshMode>\n"
        "    </Link>\n"
        "  </NetworkLink>\n"
    )


def write_root_kml(root: Path, name: str) -> None:
    x_tiles, y_tiles = level_shape(0)
    parts = [kml_header(name)]
    parts.append("  <open>1</open>\n")
    for y in range(y_tiles):
        for x in range(x_tiles):
            parts.append(network_link_kml(0, x, y, None, -1))
    parts.append(kml_footer())
    (root / ROOT_KML_NAME).write_text("".join(parts), encoding="utf-8")


def write_tile_kml(root: Path, name: str, level: int, x: int, y: int, max_level: int) -> None:
    west, south, east, north = tile_bounds(level, x, y)
    parts = [kml_header(f"{name} L{level} {x},{y}")]
    parts.append("  <Region>\n")
    parts.append(lat_lon_box(west, south, east, north))
    parts.append("    <Lod><minLodPixels>128</minLodPixels><maxLodPixels>2048</maxLodPixels></Lod>\n")
    parts.append("  </Region>\n")
    parts.append(ground_overlay_kml(west, south, east, north, f"{x}.jpg"))

    if level < max_level:
        child_level = level + 1
        for child_y in (y * 2, y * 2 + 1):
            for child_x in (x * 2, x * 2 + 1):
                parts.append(network_link_kml(child_level, child_x, child_y, level, -1))

    parts.append(kml_footer())
    tile_dir = root / str(level) / str(y)
    tile_dir.mkdir(parents=True, exist_ok=True)
    (tile_dir / f"{x}.kml").write_text("".join(parts), encoding="utf-8")


def write_legend(root: Path, min_height: float, max_height: float, style: str) -> None:
    height = 512
    gradient = np.linspace(max_height, min_height, height, dtype=np.float32)[:, None]
    image = colorize_dem(np.repeat(gradient, 48, axis=1), min_height, max_height, style)
    canvas = Image.new("RGB", (160, height), "#101722")
    canvas.paste(image, (0, 0))
    draw = ImageDraw.Draw(canvas)
    for fraction in (0.0, 0.25, 0.5, 0.75, 1.0):
        y = int(fraction * (height - 1))
        value = max_height - fraction * (max_height - min_height)
        draw.line((48, y, 58, y), fill=(255, 255, 255))
        draw.text((64, max(0, y - 8)), f"{value:,.0f} m", fill=(255, 255, 255))
    canvas.save(root / "legend.png")


def render_one_tile(
    tiles: list[Tile],
    root: Path,
    name: str,
    level: int,
    x: int,
    y: int,
    max_level: int,
    tile_size: int,
    min_height: float,
    max_height: float,
    style: str,
    quality: int,
    skip_existing: bool,
) -> str:
    tile_dir = root / str(level) / str(y)
    image_path = tile_dir / f"{x}.jpg"
    kml_path = tile_dir / f"{x}.kml"

    if skip_existing and image_path.exists() and kml_path.exists():
        return "skipped"

    west, south, east, north = tile_bounds(level, x, y)
    tile_dir.mkdir(parents=True, exist_ok=True)
    height_m = read_tile_dem(tiles, west, south, east, north, tile_size)
    image = colorize_dem(height_m, min_height, max_height, style)
    temp_image = image_path.with_suffix(f".{image_path.suffix[1:]}.tmp")
    image.save(temp_image, format="JPEG", quality=quality, optimize=True)
    temp_image.replace(image_path)
    write_tile_kml(root, name, level, x, y, max_level)
    return "rendered"


def iter_tile_coords(max_level: int) -> list[tuple[int, int, int]]:
    coords: list[tuple[int, int, int]] = []
    for level in range(max_level + 1):
        x_tiles, y_tiles = level_shape(level)
        for y in range(y_tiles):
            for x in range(x_tiles):
                coords.append((level, x, y))
    return coords


def write_manifest(root: Path, args: argparse.Namespace, tiles: list[Tile], rendered: int, skipped: int) -> None:
    manifest = {
        "name": args.name,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "source": "LOLA ldem_1024 JP2 DEM tiles",
        "tile_count": len(tiles),
        "rendered_tiles": rendered,
        "skipped_tiles": skipped,
        "settings": {
            "max_level": args.max_level,
            "tile_size": args.tile_size,
            "min_height": args.min_height,
            "max_height": args.max_height,
            "style": args.style,
            "quality": args.quality,
        },
        "dem_tiles": [
            {
                **asdict(tile),
                "path": str(tile.path),
            }
            for tile in tiles
        ],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render an Open Moon KML/JPG relief pyramid from local LOLA ldem_1024 JP2 DEM tiles.")
    parser.add_argument("--dem-dir", type=Path, default=PROJECT_DIR / "lola_dems")
    parser.add_argument("--output-dir", type=Path, default=PROJECT_DIR / "Lunar_DEM_LOLA_shaded_relief_openmoon")
    parser.add_argument("--name", default="Open Moon LOLA Relief")
    parser.add_argument("--max-level", type=int, default=5, help="5 is quick-ish; 7+ is much sharper and much slower.")
    parser.add_argument("--tile-size", type=int, default=512)
    parser.add_argument("--min-height", type=float, default=-8000.0)
    parser.add_argument("--max-height", type=float, default=8000.0)
    parser.add_argument("--style", choices=["relief", "hypsometric", "gray"], default="relief")
    parser.add_argument("--quality", type=int, default=90)
    parser.add_argument("--workers", type=int, default=max(1, min(4, os.cpu_count() or 1)))
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.max_level < 0:
        raise SystemExit("--max-level must be 0 or greater.")
    if args.tile_size < 64:
        raise SystemExit("--tile-size must be at least 64.")

    tiles = build_tile_index(args.dem_dir)
    if not tiles:
        raise SystemExit(f"No ldem_1024 JP2 files found in {args.dem_dir}.")

    root = args.output_dir / "tiles_banded_stereo"
    coords = iter_tile_coords(args.max_level)
    total_pixels = len(coords) * args.tile_size * args.tile_size
    estimated_jpg_gb = total_pixels * 0.8 / 1_000_000_000

    print(f"DEM tiles: {len(tiles)}")
    print(f"Output: {root}")
    print(f"KML root: {root / ROOT_KML_NAME}")
    print(f"Tiles to render: {len(coords):,}")
    print(f"Approx JPG footprint: {estimated_jpg_gb:.2f} GB before filesystem overhead")
    if args.dry_run:
        return

    root.mkdir(parents=True, exist_ok=True)
    write_root_kml(root, args.name)
    write_legend(root, args.min_height, args.max_height, args.style)

    rendered = 0
    skipped = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(
                render_one_tile,
                tiles,
                root,
                args.name,
                level,
                x,
                y,
                args.max_level,
                args.tile_size,
                args.min_height,
                args.max_height,
                args.style,
                args.quality,
                args.skip_existing,
            )
            for level, x, y in coords
        ]

        for index, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            if result == "skipped":
                skipped += 1
            else:
                rendered += 1
            if index == 1 or index % 25 == 0 or index == len(coords):
                print(f"{index:,}/{len(coords):,} done ({rendered:,} rendered, {skipped:,} skipped)")

    write_manifest(root, args, tiles, rendered, skipped)
    print("Done.")


if __name__ == "__main__":
    main()
