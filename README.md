# Open Moon

Local Cesium + FastAPI tool for browsing lunar terrain, finding named lunar features, selecting printable regions, previewing the result, and exporting an STL from local LOLA `ldem_1024` DEM tiles.

## Setup

Install the backend dependencies in your Python environment:

```powershell
pip install fastapi uvicorn rasterio numpy trimesh
```

Keep these folders at the project root:

```text
cesium_key.txt
Lunar_DEM_LOLA_shaded_relief_1.52GB/
lola_dems/
LRO LROC/
```

`cesium_key.txt` is read only by the backend endpoint `/cesium-token`; the token is not hardcoded into frontend code.

## Run

Start the backend:

```powershell
cd backend
uvicorn app:app --reload --port 8000
```

Start the frontend in another terminal:

```powershell
cd frontend
python -m http.server 8080
```

Open:

```text
http://localhost:8080
```

## Workflow

1. The frontend fetches the Cesium Ion token from `http://localhost:8000/cesium-token`.
2. Cesium starts with `Cesium.Ellipsoid.MOON` near the lunar south pole.
3. Choose `Rectangle`, `Circle`, or `Freeform`.
4. Use the landmark category picker to fly to Apollo sites, Artemis reference craters, or named Gazetteer features.
5. Click on the Moon to define the selected shape. Rectangle uses two corner clicks, circle uses two diameter handles, and freeform uses boundary points followed by `Finish Shape`. Selection handles can be dragged afterward to resize the shape.
6. The panel shows raw Cesium longitude, plus LOLA-normalized longitude in the `0..360` domain.
7. The frontend calls `http://localhost:8000/export-info` to verify that the selection overlaps local JP2 DEM coverage and stays under the triangle limit.
8. Click `DEM Tiles` to show the local exportable JP2 tile footprints on the Moon.
9. Click `Preview STL` when you want to inspect the generated STL and adjust simplification, z exaggeration, and thickness.
10. Click `Download STL` in the preview modal, or `Export STL` from the main panel.
11. The backend finds intersecting local `ldem_1024*.jp2` files, reads only intersecting raster windows, mosaics the selected area, masks circle/freeform selections to the chosen shape, applies `pixel_value * 0.5 - 1737400`, normalizes minimum height to zero, applies z exaggeration, adds a flat base plus side walls using `Base thickness (m)`, writes an STL into `backend/exports/`, and returns it as a download.

## Imagery layers

The app has three display modes:

- `Optical` uses the local LRO LROC WAC mosaic from `LRO LROC/`.
- `Relief` uses the local LOLA shaded-relief pyramid from `Lunar_DEM_LOLA_shaded_relief_1.52GB/`.
- `Hybrid` blends optical imagery above the shaded relief so surface color and relief remain visible together.

The scale bar in the lower-right corner is computed from the current Cesium camera view against `Cesium.Ellipsoid.MOON`.

## Landmarks

`frontend/landmarks.json` contains the browsable landmark catalog. It is generated from the USGS/IAU Gazetteer of Planetary Nomenclature Moon center-point download, with a few curated Apollo/Artemis entries kept at the top of the catalog.

Source:

```text
https://planetarynames.wr.usgs.gov/GIS_Downloads
```

## KML shaded relief

The backend mounts the shaded-relief folder at:

```text
http://localhost:8000/kml/
```

`/kml-root` returns the first root KML. For the current dataset, that is expected to be:

```text
http://localhost:8000/kml/tiles_banded_stereo/LunarTopoRelief_banded_stereo.kml
```

Do not load the app directly from `file://`; browsers will block or misresolve many KML/JPG network links. Serve the frontend on `http://localhost:8080` and the backend on `http://localhost:8000` so KML relative links like `0/0/0.kml` and JPG overlays can resolve through the backend static mount.

Cesium KML ground overlays were originally designed for Earth-style KML and local NetworkLink pyramids can be picky on `Cesium.Ellipsoid.MOON`. The backend now serves the shaded-relief JPG pyramid through `http://localhost:8000/lola-xyz/{z}/{x}/{y}.jpg`, which the frontend consumes as a normal Cesium imagery layer. The selection/export workflow uses the true elevation JP2 DEM tiles from `lola_dems/`, not the shaded-relief imagery.

The app also checks:

```text
http://localhost:8000/preview-image
```

That endpoint points to the root shaded-relief JPG for debugging or future imagery-provider work.

The frontend uses Cesium XYZ imagery from:

```text
http://localhost:8000/lola-xyz/{z}/{x}/{y}.jpg
```

The app keeps Cesium in an eager-detail mode and prefetches high-detail LOLA tiles around the current camera view after navigation settles. Loading the entire Moon at maximum detail up front would require thousands of 512px tiles, so the practical path is local viewport prefetch plus the backend disk cache in `backend/tile_cache/`.

### Render your own LOLA KML relief pyramid

If you want a fresh Open Moon-generated KML/JPG relief pyramid from your local `lola_dems/` JP2 files, use:

```powershell
python scripts/render_lola_kml_pyramid.py --dry-run
```

That prints the planned tile count and approximate JPG footprint without rendering. A starter render is:

```powershell
python scripts/render_lola_kml_pyramid.py --max-level 5 --workers 4 --skip-existing
```

The output goes to:

```text
Lunar_DEM_LOLA_shaded_relief_openmoon/tiles_banded_stereo/OpenMoon_LOLA_Relief.kml
```

Higher `--max-level` values add more zoom detail but grow quickly:

```text
level 5:  2,730 tiles
level 6: 10,922 tiles
level 7: 43,690 tiles
level 8: 174,762 tiles
```

Use `--skip-existing` to resume an interrupted render. Useful knobs:

```powershell
python scripts/render_lola_kml_pyramid.py `
  --max-level 7 `
  --tile-size 512 `
  --style relief `
  --quality 90 `
  --workers 4 `
  --skip-existing
```

To make the backend mount this generated pyramid instead of the provided one, start the backend with:

```powershell
$env:OPEN_MOON_KML_DIR="C:\Users\matwm\Documents\moon_mold\Lunar_DEM_LOLA_shaded_relief_openmoon"
cd backend
uvicorn app:app --reload --port 8000
```

The renderer uses the same LOLA elevation scaling as STL export:

```text
height_m = pixel_value * 0.5 - 1737400
```

## Acknowledgements

Open Moon uses data and imagery from NASA Lunar Reconnaissance Orbiter, the LOLA instrument team, the LROC team, PDS Geosciences Node, USGS Astrogeology, and Arizona State University. Thanks also to Dr. Casey Handmer for help formatting the KML tile files used for local lunar browsing.

## Notes

- Only files beginning with `ldem_1024` are indexed.
- Filename bounds such as `ldem_1024_90s_75s_150_180.jp2` are parsed as latitude `-90..-75` and longitude `150..180`.
- The backend does not load all DEM tiles at startup; it builds a filename index and opens only intersecting tiles during export.
- Requests estimated above 5 million triangles are rejected. Increase `downsample` or select a smaller region.
- STL exports are closed solids for 3D printing. `Base thickness (m)` is in the same source-scale units as the STL; after scaling the model in your slicer, the base thickness scales with the width and height.
- Circle and freeform exports are clipped from a rectangular DEM read window, then closed with side walls along the clipped boundary.
- `/preview-stl` returns the same generated STL as a browser preview without writing it into `backend/exports/`; `/export-stl` writes the final downloaded file.
- Longitude selections that cross `0` are represented with `min_lon > max_lon`; the backend splits them into `min..360` and `0..max` intervals.

## GitHub and deployment notes

The repo should keep app code, README, and small generated metadata such as `frontend/landmarks.json`. Do not commit local tokens, exported STL files, caches, JP2 DEM tiles, KML/JPG pyramids, or the LROC GeoTIFF mosaic.

### Deploy to `openmoon.app`

Open Moon is not a static-only app: STL export, LOLA DEM reads, LROC/LOLA tile serving, previews, and caches all run through FastAPI. The recommended first public deployment is a VPS with Docker Compose and the data folders mounted on disk.

On the server, install Docker and clone the repo:

```bash
git clone https://github.com/MattMullin/openmoon.git
cd openmoon
```

Copy or mount these private data folders/files at the repo root on the server:

```text
cesium_key.txt
lola_dems/
Lunar_DEM_LOLA_shaded_relief_1.52GB/
LRO LROC/
```

Point the domain DNS to the VPS:

```text
A     openmoon.app      <server IPv4>
AAAA  openmoon.app      <server IPv6, optional>
```

Then start the app:

```bash
docker compose up -d --build
```

Caddy listens on ports `80` and `443`, obtains TLS certificates automatically, and proxies `https://openmoon.app` to the Open Moon FastAPI app. The FastAPI app serves both the frontend and the API on the same origin in production.

For large public use, the next step after the VPS MVP is moving imagery tiles to object storage/CDN and running STL generation behind a worker queue so large exports do not tie up web requests.
