from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


TILE_RE = re.compile(
    r"^ldem_1024_(?P<lat_a>\d{2}[ns])_(?P<lat_b>\d{2}[ns])_"
    r"(?P<lon_a>\d{3})_(?P<lon_b>\d{3})\.jp2$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Tile:
    path: Path
    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float


def parse_lat(token: str) -> float:
    value = float(token[:2])
    suffix = token[2].lower()
    return -value if suffix == "s" else value


def parse_tile(path: Path) -> Tile | None:
    match = TILE_RE.match(path.name)
    if not match:
        return None

    lat_a = parse_lat(match.group("lat_a"))
    lat_b = parse_lat(match.group("lat_b"))
    lon_a = float(match.group("lon_a"))
    lon_b = float(match.group("lon_b"))

    return Tile(
        path=path,
        min_lat=min(lat_a, lat_b),
        max_lat=max(lat_a, lat_b),
        min_lon=min(lon_a, lon_b),
        max_lon=max(lon_a, lon_b),
    )


def build_tile_index(dem_dir: Path) -> list[Tile]:
    tiles: list[Tile] = []
    if not dem_dir.exists():
        return tiles

    for path in dem_dir.glob("ldem_1024*.jp2"):
        tile = parse_tile(path)
        if tile:
            tiles.append(tile)

    return sorted(tiles, key=lambda tile: (tile.min_lat, tile.min_lon, tile.path.name))


def normalize_lon(lon: float) -> float:
    value = lon % 360.0
    return 0.0 if value == 360.0 else value


def longitude_intervals(min_lon: float, max_lon: float) -> list[tuple[float, float]]:
    min_norm = normalize_lon(min_lon)
    max_norm = normalize_lon(max_lon)

    if abs(max_lon - min_lon) >= 360:
        return [(0.0, 360.0)]

    if min_norm <= max_norm:
        return [(min_norm, max_norm)]

    return [(min_norm, 360.0), (0.0, max_norm)]


def intersects(tile: Tile, min_lat: float, max_lat: float, lon_min: float, lon_max: float) -> bool:
    lat_overlap = tile.min_lat < max_lat and tile.max_lat > min_lat
    lon_overlap = tile.min_lon < lon_max and tile.max_lon > lon_min
    return lat_overlap and lon_overlap


def find_intersecting_tiles(
    tiles: list[Tile],
    min_lat: float,
    max_lat: float,
    min_lon: float,
    max_lon: float,
) -> list[Tile]:
    found: list[Tile] = []
    for lon_min, lon_max in longitude_intervals(min_lon, max_lon):
        found.extend(
            tile
            for tile in tiles
            if intersects(tile, min_lat, max_lat, lon_min, lon_max) and tile not in found
        )
    return sorted(found, key=lambda tile: (tile.min_lat, tile.min_lon, tile.path.name))
