import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const API_BASE = "http://localhost:8000";
const moonEllipsoid = Cesium.Ellipsoid.MOON;

let viewer;
let handler;
let selectedPoints = [];
let markerEntities = [];
let demTileEntities = [];
let landmarkEntities = [];
let selectionShapeEntity = null;
let selectionLineEntity = null;
let currentBounds = null;
let currentExportInfo = null;
let selectionMode = "rectangle";
let circleSelection = null;
let rectanglePolygon = null;
let polygonFinished = false;
let draggingPointIndex = null;
let suppressNextClick = false;
let demTilesVisible = false;
let validationRun = 0;
let previewOpen = false;
let previewGeneration = 0;
let previewBlob = null;
let previewFilename = "open-moon-terrain-preview.stl";
let previewScene = null;
let previewCamera = null;
let previewRenderer = null;
let previewControls = null;
let previewMesh = null;
let previewResizeObserver = null;
let opticalLayer = null;
let reliefLayer = null;
let moonLayerMode = "hybrid";
let landmarksVisible = true;
let landmarkCatalog = [];
let lastScaleBarUpdate = 0;
const selectionHeight = 22000;
const demCoverageHeight = 36000;
const MOON_RADIUS_M = 1737400;
const PREFETCH_LEVELS = [7, 6, 5];
const PREFETCH_TILE_LIMIT = 72;
const PREFETCH_IMMEDIATE_IMAGE_LIMIT = 32;
const PREFETCH_DEBOUNCE_MS = 260;
const WHEEL_ZOOM_FRACTION = 0.035;
const WHEEL_ZOOM_DAMPING = 0.82;
const POLAR_RECTANGLE_LATITUDE = 84;
const HIDDEN_LAYER_ALPHA = 0.001;
const texturePrefetchCache = new Set();
const textureWarmRequestCache = new Set();
let texturePrefetchTimer = null;
let smoothWheelVelocity = 0;
let smoothWheelFrame = null;
const TILE_LEVELS = [
  { level: 0, xTiles: 1, yTiles: 1 },
  { level: 1, xTiles: 4, yTiles: 2 },
  { level: 2, xTiles: 12, yTiles: 6 },
  { level: 3, xTiles: 36, yTiles: 18 },
  { level: 4, xTiles: 180, yTiles: 90 },
  { level: 5, xTiles: 360, yTiles: 180 },
];

const els = {
  tokenStatus: document.getElementById("tokenStatus"),
  kmlStatus: document.getElementById("kmlStatus"),
  minLat: document.getElementById("minLat"),
  maxLat: document.getElementById("maxLat"),
  minLon: document.getElementById("minLon"),
  maxLon: document.getElementById("maxLon"),
  lolaMinLon: document.getElementById("lolaMinLon"),
  lolaMaxLon: document.getElementById("lolaMaxLon"),
  downsample: document.getElementById("downsample"),
  zExaggeration: document.getElementById("zExaggeration"),
  baseThickness: document.getElementById("baseThickness"),
  previewModal: document.getElementById("previewModal"),
  previewStatus: document.getElementById("previewStatus"),
  stlPreviewViewport: document.getElementById("stlPreviewViewport"),
  previewDownsample: document.getElementById("previewDownsample"),
  previewZExaggeration: document.getElementById("previewZExaggeration"),
  previewBaseThickness: document.getElementById("previewBaseThickness"),
  closePreview: document.getElementById("closePreview"),
  refreshPreview: document.getElementById("refreshPreview"),
  downloadPreviewStl: document.getElementById("downloadPreviewStl"),
  modeRectangle: document.getElementById("modeRectangle"),
  modeCircle: document.getElementById("modeCircle"),
  modePolygon: document.getElementById("modePolygon"),
  layerOptical: document.getElementById("layerOptical"),
  layerHybrid: document.getElementById("layerHybrid"),
  layerRelief: document.getElementById("layerRelief"),
  landmarkCategory: document.getElementById("landmarkCategory"),
  landmarkSelect: document.getElementById("landmarkSelect"),
  toggleLandmarks: document.getElementById("toggleLandmarks"),
  scaleBar: document.getElementById("scaleBar"),
  scaleBarLabel: document.getElementById("scaleBarLabel"),
  scaleBarLine: document.getElementById("scaleBarLine"),
  resetView: document.getElementById("resetView"),
  toggleDemTiles: document.getElementById("toggleDemTiles"),
  finishShape: document.getElementById("finishShape"),
  clearSelection: document.getElementById("clearSelection"),
  previewStl: document.getElementById("previewStl"),
  exportStl: document.getElementById("exportStl"),
  message: document.getElementById("message"),
};

const FALLBACK_LANDMARKS = [
  { name: "Apollo 11 - Tranquility Base", type: "Landing site", lat: 0.674, lon: 23.473, range: 180000 },
  { name: "Apollo 12 - Ocean of Storms", type: "Landing site", lat: -3.012, lon: -23.422, range: 160000 },
  { name: "Apollo 14 - Fra Mauro", type: "Landing site", lat: -3.645, lon: -17.471, range: 160000 },
  { name: "Apollo 15 - Hadley Rille", type: "Landing site", lat: 26.132, lon: 3.634, range: 160000 },
  { name: "Apollo 16 - Descartes Highlands", type: "Landing site", lat: -8.973, lon: 15.501, range: 160000 },
  { name: "Apollo 17 - Taurus-Littrow", type: "Landing site", lat: 20.191, lon: 30.772, range: 160000 },
  { name: "Tycho", type: "Ray crater", lat: -43.31, lon: -11.36, range: 420000 },
  { name: "Copernicus", type: "Crater", lat: 9.62, lon: -20.08, range: 380000 },
  { name: "Aristarchus", type: "Bright crater", lat: 23.73, lon: -47.49, range: 300000 },
  { name: "Plato", type: "Crater", lat: 51.62, lon: -9.3, range: 320000 },
  { name: "Clavius", type: "Crater", lat: -58.4, lon: -14.4, range: 450000 },
  { name: "Shackleton", type: "South pole crater", lat: -89.67, lon: 129.78, range: 95000 },
  { name: "Mare Imbrium", type: "Mare basin", lat: 32.8, lon: -15.6, range: 1200000 },
  { name: "Mare Crisium", type: "Mare basin", lat: 17.0, lon: 59.1, range: 850000 },
  { name: "Orientale Basin", type: "Impact basin", lat: -19.4, lon: -92.8, range: 900000 },
  { name: "South Pole-Aitken Basin", type: "Impact basin", lat: -53.0, lon: -169.0, range: 1600000 },
  { name: "Tsiolkovskiy", type: "Far side crater", lat: -20.4, lon: 129.1, range: 420000 },
  { name: "Humboldtianum Basin", type: "Impact basin", lat: 56.8, lon: 81.5, range: 780000 },
  { name: "Rupes Recta", type: "Fault scarp", lat: -22.1, lon: -7.8, range: 220000 },
  { name: "Carroll", type: "Artemis II named crater", lat: 18.842, lon: -86.53, range: 120000 },
  { name: "Integrity", type: "Artemis II named crater", lat: 2.675, lon: -104.928, range: 120000 },
];

const FEATURED_LANDMARK_NAMES = new Set(
  FALLBACK_LANDMARKS.map((landmark) => landmark.name.toLowerCase()).concat([
    "apollo 11",
    "apollo 12",
    "apollo 14",
    "apollo 15",
    "apollo 16",
    "apollo 17",
    "south pole-aitken basin",
  ]),
);

function normalizeLon(lon) {
  return lon < 0 ? lon + 360 : lon;
}

function formatDegrees(value) {
  return Number.isFinite(value) ? value.toFixed(6) : "--";
}

function setMessage(message, isError = false) {
  els.message.textContent = message;
  els.message.classList.toggle("message--error", isError);
}

function setPreviewStatus(message, isError = false) {
  els.previewStatus.textContent = message;
  els.previewStatus.classList.toggle("message--error", isError);
}

function angularDistanceRadians(a, b) {
  const lat1 = Cesium.Math.toRadians(a.lat);
  const lat2 = Cesium.Math.toRadians(b.lat);
  const dLat = lat2 - lat1;
  const dLon = Cesium.Math.toRadians(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function toDisplayLon(lon) {
  const normalized = normalizeLon(lon);
  return normalized > 180 ? normalized - 360 : normalized;
}

function unwrappedLonNear(lon, reference) {
  let value = lon;
  while (value - reference > 180) {
    value -= 360;
  }
  while (reference - value > 180) {
    value += 360;
  }
  return value;
}

function circleFromDiameter(a, b) {
  const lonB = unwrappedLonNear(b.lon, a.lon);
  const center = {
    lat: (a.lat + b.lat) / 2,
    lon: toDisplayLon((a.lon + lonB) / 2),
  };
  return {
    center,
    radiusMeters: angularDistanceRadians(center, a) * MOON_RADIUS_M,
  };
}

function circleBoundsFromSelection(circle) {
  const radiusRadians = circle.radiusMeters / MOON_RADIUS_M;
  const radiusDegrees = Cesium.Math.toDegrees(radiusRadians);
  const minLat = Math.max(-90, circle.center.lat - radiusDegrees);
  const maxLat = Math.min(90, circle.center.lat + radiusDegrees);
  const latScale = Math.max(0.001, Math.abs(Math.cos(Cesium.Math.toRadians(circle.center.lat))));
  const lonDegrees = Math.min(180, radiusDegrees / latScale);

  if (lonDegrees >= 179.999) {
    return {
      minLat,
      maxLat,
      minLon: -180,
      maxLon: 180,
      lolaMinLon: 0,
      lolaMaxLon: 360,
    };
  }

  return calculateBounds([
    { lat: minLat, lon: circle.center.lon },
    { lat: maxLat, lon: circle.center.lon },
    { lat: circle.center.lat, lon: circle.center.lon - lonDegrees },
    { lat: circle.center.lat, lon: circle.center.lon + lonDegrees },
  ]);
}

function lolaPoint(point) {
  return {
    lat: point.lat,
    lon: normalizeLon(point.lon),
  };
}

function requestPayload(overrides = {}) {
  if (!currentBounds) {
    return null;
  }
  if (selectionMode === "circle" && !circleSelection) {
    return null;
  }
  if (selectionMode === "polygon" && (!polygonFinished || selectedPoints.length < 3)) {
    return null;
  }

  const payload = {
    min_lat: currentBounds.minLat,
    max_lat: currentBounds.maxLat,
    min_lon: currentBounds.lolaMinLon,
    max_lon: currentBounds.lolaMaxLon,
    downsample: Number(els.downsample.value || 16),
    z_exaggeration: Number(els.zExaggeration.value || 1),
    base_thickness: Number(els.baseThickness.value || 1500),
    selection_type: selectionMode,
    ...overrides,
  };

  if (selectionMode === "rectangle" && rectanglePolygon) {
    payload.selection_type = "polygon";
    payload.polygon = rectanglePolygon.map(lolaPoint);
  }

  if (selectionMode === "circle" && circleSelection) {
    payload.circle_center_lat = circleSelection.center.lat;
    payload.circle_center_lon = normalizeLon(circleSelection.center.lon);
    payload.circle_radius_m = circleSelection.radiusMeters;
  }

  if (selectionMode === "polygon") {
    payload.polygon = selectedPoints.map(lolaPoint);
  }

  return payload;
}

class LolaTilingScheme {
  constructor() {
    this.ellipsoid = moonEllipsoid;
    this.rectangle = Cesium.Rectangle.MAX_VALUE;
    this.projection = new Cesium.GeographicProjection(moonEllipsoid);
  }

  getNumberOfXTilesAtLevel(level) {
    return TILE_LEVELS[Math.min(level, TILE_LEVELS.length - 1)].xTiles;
  }

  getNumberOfYTilesAtLevel(level) {
    return TILE_LEVELS[Math.min(level, TILE_LEVELS.length - 1)].yTiles;
  }

  rectangleToNativeRectangle(rectangle, result = new Cesium.Rectangle()) {
    return Cesium.Rectangle.clone(rectangle, result);
  }

  tileXYToNativeRectangle(x, y, level, result = new Cesium.Rectangle()) {
    return this.tileXYToRectangle(x, y, level, result);
  }

  tileXYToRectangle(x, y, level, result = new Cesium.Rectangle()) {
    if (level === 0) {
      result.west = Cesium.Math.toRadians(-180);
      result.east = Cesium.Math.toRadians(180);
      result.south = Cesium.Math.toRadians(-90);
      result.north = Cesium.Math.toRadians(90);
      return result;
    }

    const xTiles = this.getNumberOfXTilesAtLevel(level);
    const yTiles = this.getNumberOfYTilesAtLevel(level);
    const lonWidth = 360 / xTiles;
    const latHeight = 180 / yTiles;
    const west = -180 + x * lonWidth;
    const east = west + lonWidth;
    const north = 90 - y * latHeight;
    const south = north - latHeight;

    result.west = Cesium.Math.toRadians(west);
    result.east = Cesium.Math.toRadians(east);
    result.south = Cesium.Math.toRadians(south);
    result.north = Cesium.Math.toRadians(north);
    return result;
  }

  positionToTileXY(position, level, result = new Cesium.Cartesian2()) {
    const xTiles = this.getNumberOfXTilesAtLevel(level);
    const yTiles = this.getNumberOfYTilesAtLevel(level);
    const lon = Cesium.Math.toDegrees(position.longitude);
    const lat = Cesium.Math.toDegrees(position.latitude);
    result.x = Math.min(xTiles - 1, Math.max(0, Math.floor(((lon + 180) / 360) * xTiles)));
    result.y = Math.min(yTiles - 1, Math.max(0, Math.floor(((90 - lat) / 180) * yTiles)));
    return result;
  }
}

class LolaPyramidImageryProvider {
  constructor(baseUrl, metadata) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.metadata = metadata;
    this.tileCache = new Map();
    this.sourceCache = new Map();
    this.tileWidth = 512;
    this.tileHeight = 512;
    this.minimumLevel = 0;
    this.maximumLevel = TILE_LEVELS.length - 1;
    this.tilingScheme = new LolaTilingScheme();
    this.rectangle = Cesium.Rectangle.MAX_VALUE;
    this.ready = true;
    this.readyPromise = Promise.resolve(true);
    this.credit = new Cesium.Credit("LOLA shaded relief");
    this.errorEvent = new Cesium.Event();
    this.hasAlphaChannel = false;
  }

  getTileCredits() {
    return undefined;
  }

  pickFeatures() {
    return undefined;
  }

  requestImage(x, y, level) {
    const tileKey = `${level}/${y}/${x}`;
    if (this.tileCache.has(tileKey)) {
      return this.tileCache.get(tileKey);
    }

    const levelInfo = this.metadata.levels?.[String(level)];
    const rowCount = levelInfo?.rows?.[String(y)] || this.tilingScheme.getNumberOfXTilesAtLevel(level);
    const xTiles = this.tilingScheme.getNumberOfXTilesAtLevel(level);
    const groupSize = Math.max(1, xTiles / rowCount);
    const kmlOrderedX = (x + xTiles / 2) % xTiles;
    const sourceX = Math.min(rowCount - 1, Math.floor(kmlOrderedX / groupSize));
    const sourceOffset = kmlOrderedX - sourceX * groupSize;
    const url = `${this.baseUrl}/${level}/${y}/${sourceX}.jpg`;

    const tilePromise = this.loadSourceImage(url)
      .then((image) => (groupSize === 1 ? image : this.cropTile(image, sourceOffset, groupSize)))
      .catch(() => this.parentTile(x, y, level));

    this.remember(this.tileCache, tileKey, tilePromise, 900);
    return tilePromise;
  }

  loadSourceImage(url) {
    if (this.sourceCache.has(url)) {
      return this.sourceCache.get(url);
    }

    const imagePromise = new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });

    this.remember(this.sourceCache, url, imagePromise, 600);
    return imagePromise;
  }

  remember(cache, key, value, maxEntries) {
    if (cache.size >= maxEntries) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(key, value);
  }

  cropTile(image, sourceOffset, groupSize) {
    const canvas = document.createElement("canvas");
    canvas.width = this.tileWidth;
    canvas.height = this.tileHeight;
    const context = canvas.getContext("2d");
    const cropWidth = image.width / groupSize;
    context.drawImage(
      image,
      sourceOffset * cropWidth,
      0,
      cropWidth,
      image.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas;
  }

  parentTile(x, y, level) {
    if (level <= 0) {
      return this.emptyTile();
    }

    const childXTiles = this.tilingScheme.getNumberOfXTilesAtLevel(level);
    const childYTiles = this.tilingScheme.getNumberOfYTilesAtLevel(level);
    const parentLevel = level - 1;
    const parentXTiles = this.tilingScheme.getNumberOfXTilesAtLevel(parentLevel);
    const parentYTiles = this.tilingScheme.getNumberOfYTilesAtLevel(parentLevel);
    const parentX = Math.min(parentXTiles - 1, Math.floor((x / childXTiles) * parentXTiles));
    const parentY = Math.min(parentYTiles - 1, Math.floor((y / childYTiles) * parentYTiles));
    return this.requestImage(parentX, parentY, parentLevel);
  }

  emptyTile() {
    const canvas = document.createElement("canvas");
    canvas.width = this.tileWidth;
    canvas.height = this.tileHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = "#303744";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }
}

async function loadCesiumToken() {
  const response = await fetch(`${API_BASE}/cesium-token`);
  if (!response.ok) {
    throw new Error("Backend did not return a Cesium token.");
  }

  const data = await response.json();
  Cesium.Ion.defaultAccessToken = data.token || "";
  els.tokenStatus.textContent = data.token ? "Token loaded from backend" : "No token found";
}

function createViewer() {
  Cesium.Ellipsoid.default = moonEllipsoid;
  Cesium.RequestScheduler.maximumRequests = 96;
  Cesium.RequestScheduler.maximumRequestsPerServer = 24;

  viewer = new Cesium.Viewer("cesiumContainer", {
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    imageryProvider: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider({ ellipsoid: moonEllipsoid }),
    globe: new Cesium.Globe(moonEllipsoid),
    mapProjection: new Cesium.GeographicProjection(moonEllipsoid),
  });

  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#303744");
  viewer.scene.globe.show = true;
  viewer.scene.globe.enableLighting = false;
  viewer.scene.globe.loadingDescendantLimit = 12;
  viewer.scene.globe.maximumScreenSpaceError = 0.85;
  viewer.scene.globe.preloadAncestors = true;
  viewer.scene.globe.preloadSiblings = true;
  viewer.scene.globe.tileCacheSize = 3200;
  viewer.scene.highDynamicRange = false;
  viewer.scene.backgroundColor = Cesium.Color.BLACK;
  viewer.scene.skyAtmosphere = undefined;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 500;
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = 12000000;
  viewer.scene.screenSpaceCameraController.inertiaZoom = 0.86;
  viewer.scene.screenSpaceCameraController.inertiaTranslate = 0.88;
  viewer.scene.screenSpaceCameraController.inertiaSpin = 0.82;
  viewer.scene.screenSpaceCameraController.zoomEventTypes = [
    Cesium.CameraEventType.RIGHT_DRAG,
    Cesium.CameraEventType.PINCH,
  ];

  addReferenceMoon();
  resetCamera();
  installSmoothWheelZoom();
  viewer.scene.postRender.addEventListener(updateScaleBar);
}

function resetCamera() {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(15, -82, 4200000, moonEllipsoid),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
  });
}

function cameraSurfaceHeight() {
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC, moonEllipsoid);
  return Math.max(500, cartographic.height || 500);
}

function applySmoothWheelZoom() {
  smoothWheelFrame = null;

  if (Math.abs(smoothWheelVelocity) < 0.5) {
    smoothWheelVelocity = 0;
    scheduleTexturePrefetch();
    return;
  }

  const distance = Math.min(Math.abs(smoothWheelVelocity), cameraSurfaceHeight() * 0.18);
  if (smoothWheelVelocity > 0) {
    viewer.camera.zoomOut(distance);
  } else {
    viewer.camera.zoomIn(distance);
  }

  smoothWheelVelocity *= WHEEL_ZOOM_DAMPING;
  smoothWheelFrame = requestAnimationFrame(applySmoothWheelZoom);
}

function installSmoothWheelZoom() {
  viewer.scene.canvas.addEventListener(
    "wheel",
    (event) => {
      if (previewOpen || event.ctrlKey) {
        return;
      }

      event.preventDefault();
      const normalizedDelta = Math.max(-1, Math.min(1, event.deltaY / 100));
      smoothWheelVelocity += normalizedDelta * cameraSurfaceHeight() * WHEEL_ZOOM_FRACTION;

      if (!smoothWheelFrame) {
        smoothWheelFrame = requestAnimationFrame(applySmoothWheelZoom);
      }
    },
    { passive: false },
  );
}

function surfacePositionsForLatitude(lat, height = 2500) {
  const positions = [];
  for (let lon = -180; lon <= 180; lon += 4) {
    positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, height, moonEllipsoid));
  }
  return positions;
}

function surfacePositionsForLongitude(lon, height = 2500) {
  const positions = [];
  for (let lat = -90; lat <= 90; lat += 3) {
    positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, height, moonEllipsoid));
  }
  return positions;
}

function selectionPosition(lon, lat) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, selectionHeight, moonEllipsoid);
}

function landmarkPosition(landmark, height = 8000) {
  return Cesium.Cartesian3.fromDegrees(landmark.lon, landmark.lat, height, moonEllipsoid);
}

function addReferenceMoon() {
  for (let lat = -75; lat <= 75; lat += 15) {
    viewer.entities.add({
      name: `Latitude ${lat}`,
      polyline: {
        positions: surfacePositionsForLatitude(lat),
        width: lat === 0 ? 1.2 : 0.8,
        material: Cesium.Color.WHITE.withAlpha(lat === 0 ? 0.18 : 0.08),
      },
    });
  }

  for (let lon = -180; lon < 180; lon += 30) {
    viewer.entities.add({
      name: `Longitude ${lon}`,
      polyline: {
        positions: surfacePositionsForLongitude(lon),
        width: lon === 0 ? 1.2 : 0.8,
        material: Cesium.Color.CYAN.withAlpha(lon === 0 ? 0.18 : 0.07),
      },
    });
  }
}

function setLandmarksVisible(visible) {
  landmarksVisible = visible;
  landmarkEntities.forEach((entity) => {
    entity.show = visible;
  });
  els.toggleLandmarks.classList.toggle("is-active", visible);
  els.toggleLandmarks.textContent = visible ? "Hide Marks" : "Marks";
}

async function loadLandmarkCatalog() {
  try {
    const response = await fetch("./landmarks.json?v=gazetteer-scale-1");
    if (!response.ok) {
      throw new Error("Landmark catalog not available.");
    }

    const catalog = await response.json();
    landmarkCatalog = catalog.filter(
      (landmark) =>
        landmark?.name &&
        Number.isFinite(landmark.lat) &&
        Number.isFinite(landmark.lon),
    );
  } catch (error) {
    console.warn("Landmark catalog failed:", error);
    landmarkCatalog = FALLBACK_LANDMARKS.map((landmark) => ({
      ...landmark,
      category: landmark.type,
      source: "Fallback",
    }));
  }
}

function landmarkMatchesCategory(landmark, category) {
  if (category === "All") {
    return true;
  }

  if (category === "Featured") {
    return (
      FEATURED_LANDMARK_NAMES.has(landmark.name.toLowerCase()) ||
      landmark.category === "Apollo" ||
      landmark.category === "Artemis"
    );
  }

  return landmark.category === category;
}

function populateLandmarkOptions() {
  const category = els.landmarkCategory.value || "Featured";
  const matches = landmarkCatalog
    .map((landmark, index) => ({ landmark, index }))
    .filter(({ landmark }) => landmarkMatchesCategory(landmark, category))
    .sort((a, b) => a.landmark.name.localeCompare(b.landmark.name));

  els.landmarkSelect.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = matches.length
    ? `Fly to ${category.toLowerCase()} landmark...`
    : "No landmarks in this category";
  els.landmarkSelect.appendChild(defaultOption);

  matches.forEach(({ landmark, index }) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = landmark.diameter_km
      ? `${landmark.name} (${Number(landmark.diameter_km).toFixed(1)} km)`
      : landmark.name;
    els.landmarkSelect.appendChild(option);
  });
}

function flyToLandmark(index) {
  const landmark = landmarkCatalog[index];
  if (!landmark) {
    return;
  }

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      landmark.lon,
      landmark.lat,
      landmark.range || 260000,
      moonEllipsoid,
    ),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
    duration: 1.2,
  });
  setMessage(`${landmark.name} (${landmark.type})`);
  scheduleTexturePrefetch();
}

function addLandmarks() {
  landmarkEntities.forEach((entity) => viewer.entities.remove(entity));
  landmarkEntities = [];
  populateLandmarkOptions();

  landmarkCatalog.forEach((landmark, index) => {
    const isFeatured = landmarkMatchesCategory(landmark, "Featured");
    const entity = viewer.entities.add({
      name: landmark.name,
      position: landmarkPosition(landmark),
      show: landmarksVisible,
      point: {
        color: isFeatured
          ? Cesium.Color.fromCssColorString("#f6d365")
          : Cesium.Color.fromCssColorString("#70d7ff").withAlpha(0.86),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.72),
        outlineWidth: 2,
        pixelSize: isFeatured ? 10 : 7,
        heightReference: Cesium.HeightReference.NONE,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, isFeatured ? 2400000 : 900000),
      },
      label: {
        text: landmark.name,
        font: "12px Inter, sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.42),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, isFeatured ? 1800000 : 260000),
      },
      description: [
        landmark.type || landmark.category || "Lunar feature",
        landmark.diameter_km ? `Diameter ${Number(landmark.diameter_km).toFixed(1)} km` : "",
        `Lat ${landmark.lat.toFixed(3)}, Lon ${landmark.lon.toFixed(3)}`,
        landmark.source ? `Source ${landmark.source}` : "",
      ]
        .filter(Boolean)
        .join("<br>"),
    });
    entity.landmarkIndex = index;
    landmarkEntities.push(entity);
  });
}

function lolaTileRectangles(tile) {
  const minLon = tile.min_lon;
  const maxLon = tile.max_lon;

  if (maxLon <= 180) {
    return [[minLon, tile.min_lat, maxLon, tile.max_lat]];
  }

  if (minLon >= 180) {
    return [[minLon - 360, tile.min_lat, maxLon - 360, tile.max_lat]];
  }

  return [
    [minLon, tile.min_lat, 180, tile.max_lat],
    [-180, tile.min_lat, maxLon - 360, tile.max_lat],
  ];
}

async function loadDemCoverage() {
  try {
    const response = await fetch(`${API_BASE}/tiles`);
    if (!response.ok) {
      throw new Error("DEM tile index endpoint failed");
    }

    const data = await response.json();
    data.tiles.forEach((tile) => {
      lolaTileRectangles(tile).forEach(([west, south, east, north]) => {
        demTileEntities.push(
          viewer.entities.add({
            name: `Local DEM ${tile.name}`,
            show: demTilesVisible,
            rectangle: {
              coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
              height: demCoverageHeight,
              material: Cesium.Color.fromCssColorString("#f6d365").withAlpha(0.035),
              outline: true,
              outlineColor: Cesium.Color.fromCssColorString("#f6d365").withAlpha(0.78),
            },
          }),
        );
      });
    });
  } catch (error) {
    console.warn("DEM coverage failed:", error);
  }
}

function setDemTilesVisible(visible) {
  demTilesVisible = visible;
  demTileEntities.forEach((entity) => {
    entity.show = visible;
  });
  els.toggleDemTiles.classList.toggle("is-active", visible);
  els.toggleDemTiles.textContent = visible ? "Hide DEM Tiles" : "DEM Tiles";
}

function clampLat(lat) {
  return Math.max(-89.999, Math.min(89.999, lat));
}

function xyzTileForLonLat(lon, lat, level) {
  const xTiles = 2 ** (level + 1);
  const yTiles = 2**level;
  const wrappedLon = ((lon + 180) % 360 + 360) % 360 - 180;
  const x = Math.min(xTiles - 1, Math.max(0, Math.floor(((wrappedLon + 180) / 360) * xTiles)));
  const y = Math.min(yTiles - 1, Math.max(0, Math.floor(((90 - clampLat(lat)) / 180) * yTiles)));
  return { x, y, xTiles, yTiles };
}

function tileRangesForLonInterval(west, east, south, north, level) {
  const westTile = xyzTileForLonLat(west, north, level);
  const eastTile = xyzTileForLonLat(east, south, level);
  const yMin = Math.min(westTile.y, eastTile.y);
  const yMax = Math.max(westTile.y, eastTile.y);
  let xRanges;

  if (west <= east) {
    xRanges = [[westTile.x, eastTile.x]];
  } else {
    xRanges = [
      [westTile.x, westTile.xTiles - 1],
      [0, eastTile.x],
    ];
  }

  return xRanges.map(([xMin, xMax]) => ({
    xMin: Math.max(0, Math.min(xMin, xMax)),
    xMax: Math.min(westTile.xTiles - 1, Math.max(xMin, xMax)),
    yMin,
    yMax,
  }));
}

function textureTileKey(tile) {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function textureTileUrl(tile) {
  return `${API_BASE}/lola-xyz/${tile.z}/${tile.x}/${tile.y}.jpg`;
}

function shortestLonDelta(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function textureTilesForRectangle(rectangle) {
  if (!rectangle) {
    return [];
  }

  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  const south = clampLat(Cesium.Math.toDegrees(rectangle.south));
  const north = clampLat(Cesium.Math.toDegrees(rectangle.north));
  const centerLat = (south + north) / 2;
  const centerLon = Cesium.Math.negativePiToPi((rectangle.west + rectangle.east) / 2);
  const centerLonDeg = Cesium.Math.toDegrees(centerLon);
  const tiles = [];

  for (const level of PREFETCH_LEVELS) {
    for (const range of tileRangesForLonInterval(west, east, south, north, level)) {
      for (let y = range.yMin; y <= range.yMax; y += 1) {
        for (let x = range.xMin; x <= range.xMax; x += 1) {
          tiles.push({ z: level, x, y });
        }
      }
    }
  }

  return tiles
    .sort((a, b) => {
      if (a.z !== b.z) {
        return b.z - a.z;
      }

      const aLonWidth = 360 / 2 ** (a.z + 1);
      const bLonWidth = 360 / 2 ** (b.z + 1);
      const aLatHeight = 180 / 2 ** a.z;
      const bLatHeight = 180 / 2 ** b.z;
      const aLon = -180 + (a.x + 0.5) * aLonWidth;
      const bLon = -180 + (b.x + 0.5) * bLonWidth;
      const aLat = 90 - (a.y + 0.5) * aLatHeight;
      const bLat = 90 - (b.y + 0.5) * bLatHeight;
      const aDistance = shortestLonDelta(aLon, centerLonDeg) ** 2 + (aLat - centerLat) ** 2;
      const bDistance = shortestLonDelta(bLon, centerLonDeg) ** 2 + (bLat - centerLat) ** 2;
      return aDistance - bDistance;
    })
    .slice(0, PREFETCH_TILE_LIMIT);
}

function prefetchTextureImages(tiles) {
  tiles.forEach((tile) => {
    const key = textureTileKey(tile);
    if (texturePrefetchCache.has(key)) {
      return;
    }

    texturePrefetchCache.add(key);
    const image = new Image();
    image.decoding = "async";
    image.loading = "eager";
    image.src = textureTileUrl(tile);
  });
}

async function warmBackendTextureTiles(tiles) {
  const tilesToWarm = tiles.filter((tile) => {
    const key = textureTileKey(tile);
    if (textureWarmRequestCache.has(key)) {
      return false;
    }

    textureWarmRequestCache.add(key);
    return true;
  });

  if (tilesToWarm.length === 0) {
    return;
  }

  try {
    await fetch(`${API_BASE}/prefetch-lola-tiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tiles: tilesToWarm }),
    });
  } catch (error) {
    console.warn("LOLA tile prewarm failed:", error);
  }
}

function prefetchCurrentTextureView() {
  const rectangle = viewer.camera.computeViewRectangle(moonEllipsoid);
  const tiles = textureTilesForRectangle(rectangle);
  warmBackendTextureTiles(tiles);
  prefetchTextureImages(tiles.slice(0, PREFETCH_IMMEDIATE_IMAGE_LIMIT));
  if (tiles.length > 0) {
    els.kmlStatus.textContent = "LOLA eager";
  }
}

function scheduleTexturePrefetch() {
  clearTimeout(texturePrefetchTimer);
  texturePrefetchTimer = setTimeout(prefetchCurrentTextureView, PREFETCH_DEBOUNCE_MS);
}

function applyMoonLayerMode(mode) {
  moonLayerMode = mode;
  [els.layerOptical, els.layerHybrid, els.layerRelief].forEach((button) => {
    button.classList.remove("is-active");
  });

  if (mode === "optical") {
    els.layerOptical.classList.add("is-active");
    if (opticalLayer) {
      opticalLayer.show = true;
      opticalLayer.alpha = 1;
    }
    if (reliefLayer) {
      reliefLayer.show = true;
      reliefLayer.alpha = HIDDEN_LAYER_ALPHA;
    }
    els.kmlStatus.textContent = "LROC optical";
  } else if (mode === "relief") {
    els.layerRelief.classList.add("is-active");
    if (opticalLayer) {
      opticalLayer.show = true;
      opticalLayer.alpha = HIDDEN_LAYER_ALPHA;
    }
    if (reliefLayer) {
      reliefLayer.show = true;
      reliefLayer.alpha = 1;
    }
    els.kmlStatus.textContent = "LOLA relief";
  } else {
    els.layerHybrid.classList.add("is-active");
    if (opticalLayer) {
      opticalLayer.show = true;
      opticalLayer.alpha = 1;
    }
    if (reliefLayer) {
      reliefLayer.show = true;
      reliefLayer.alpha = 0.58;
    }
    els.kmlStatus.textContent = "LROC + LOLA";
  }
  scheduleTexturePrefetch();
}

async function loadPreviewOverlay() {
  try {
    viewer.dataSources.removeAll();
    viewer.imageryLayers.removeAll();
    const opticalProvider = new Cesium.UrlTemplateImageryProvider({
      url: `${API_BASE}/optical-xyz/{z}/{x}/{y}.jpg`,
      hasAlphaChannel: false,
      tilingScheme: new Cesium.GeographicTilingScheme({
        ellipsoid: moonEllipsoid,
        numberOfLevelZeroTilesX: 2,
        numberOfLevelZeroTilesY: 1,
      }),
      minimumLevel: 0,
      maximumLevel: 7,
      tileWidth: 512,
      tileHeight: 512,
      credit: "LRO LROC WAC global mosaic",
    });
    opticalLayer = viewer.imageryLayers.addImageryProvider(opticalProvider);
    opticalLayer.maximumAnisotropy = 16;

    const provider = new Cesium.UrlTemplateImageryProvider({
      url: `${API_BASE}/lola-xyz/{z}/{x}/{y}.jpg`,
      hasAlphaChannel: false,
      tilingScheme: new Cesium.GeographicTilingScheme({
        ellipsoid: moonEllipsoid,
        numberOfLevelZeroTilesX: 2,
        numberOfLevelZeroTilesY: 1,
      }),
      minimumLevel: 0,
      maximumLevel: 7,
      tileWidth: 512,
      tileHeight: 512,
      hasAlphaChannel: false,
      credit: "LOLA shaded relief",
    });
    reliefLayer = viewer.imageryLayers.addImageryProvider(provider);
    reliefLayer.maximumAnisotropy = 16;
    reliefLayer.contrast = 1.12;
    reliefLayer.saturation = 1.08;
    if (Cesium.TextureMagnificationFilter?.NEAREST) {
      reliefLayer.magnificationFilter = Cesium.TextureMagnificationFilter.NEAREST;
    }
    applyMoonLayerMode(moonLayerMode);
    scheduleTexturePrefetch();
  } catch (error) {
    console.warn("LOLA XYZ failed, trying root JPG:", error);

    try {
      const response = await fetch(`${API_BASE}/preview-image`);
      if (!response.ok) {
        throw new Error("LOLA preview image endpoint failed");
      }

      const data = await response.json();
      if (!data.url) {
        throw new Error("No LOLA preview image found");
      }

      viewer.imageryLayers.removeAll();
      opticalLayer = null;
      reliefLayer = null;
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(data.url, {
        rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
      });
      viewer.imageryLayers.addImageryProvider(provider);
      els.kmlStatus.textContent = "LOLA JPG";
    } catch (fallbackError) {
      console.warn("LOLA JPG failed:", fallbackError);
      els.kmlStatus.textContent = "Cesium only";
    }
  }
}

function pickMoonPosition(screenPosition) {
  let cartesian;

  if (viewer.scene.pickPositionSupported) {
    cartesian = viewer.scene.pickPosition(screenPosition);
  }

  if (!Cesium.defined(cartesian)) {
    cartesian = viewer.camera.pickEllipsoid(screenPosition, moonEllipsoid);
  }

  if (!Cesium.defined(cartesian)) {
    return null;
  }

  const cartographic = Cesium.Cartographic.fromCartesian(cartesian, moonEllipsoid);
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
    cartesian,
  };
}

function moonSurfacePointFromScreen(screenPosition) {
  const cartesian = viewer.camera.pickEllipsoid(screenPosition, moonEllipsoid);
  if (!Cesium.defined(cartesian)) {
    return null;
  }

  const cartographic = Cesium.Cartographic.fromCartesian(cartesian, moonEllipsoid);
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
  };
}

function niceScaleDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) {
    return null;
  }

  const exponent = Math.floor(Math.log10(meters));
  const base = 10 ** exponent;
  const candidates = [5 * base, 2 * base, base, 0.5 * base, 0.2 * base, 0.1 * base];
  return candidates.find((candidate) => candidate <= meters) || base;
}

function formatScaleDistance(meters) {
  if (meters >= 1000) {
    return `${Number((meters / 1000).toPrecision(2))} km`;
  }

  return `${Math.max(1, Math.round(meters))} m`;
}

function updateScaleBar() {
  const now = performance.now();
  if (now - lastScaleBarUpdate < 160) {
    return;
  }
  lastScaleBarUpdate = now;

  const canvas = viewer.scene.canvas;
  const sampleWidth = Math.min(180, Math.max(96, canvas.clientWidth * 0.12));
  const y = Math.max(60, canvas.clientHeight - 92);
  const x = canvas.clientWidth - 98;
  const left = moonSurfacePointFromScreen(new Cesium.Cartesian2(x - sampleWidth, y));
  const right = moonSurfacePointFromScreen(new Cesium.Cartesian2(x, y));

  if (!left || !right) {
    els.scaleBar.style.display = "none";
    return;
  }

  const sampledMeters = angularDistanceRadians(left, right) * MOON_RADIUS_M;
  const niceMeters = niceScaleDistance(sampledMeters);
  if (!niceMeters) {
    els.scaleBar.style.display = "none";
    return;
  }

  const width = Math.max(42, Math.min(180, (sampleWidth * niceMeters) / sampledMeters));
  els.scaleBarLine.style.width = `${width}px`;
  els.scaleBarLabel.textContent = formatScaleDistance(niceMeters);
  els.scaleBar.style.display = "block";
}

function calculateBounds(points) {
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const normalized = lons.map(normalizeLon).sort((a, b) => a - b);

  let lolaMinLon = normalized[0] ?? 0;
  let lolaMaxLon = normalized[0] ?? 0;
  if (normalized.length > 1) {
    let largestGap = -1;
    let gapIndex = 0;

    for (let index = 0; index < normalized.length; index += 1) {
      const current = normalized[index];
      const next = index === normalized.length - 1 ? normalized[0] + 360 : normalized[index + 1];
      const gap = next - current;
      if (gap > largestGap) {
        largestGap = gap;
        gapIndex = index;
      }
    }

    lolaMinLon = normalized[(gapIndex + 1) % normalized.length];
    lolaMaxLon = normalized[gapIndex];
    if (Math.abs(lolaMaxLon - lolaMinLon) < 1e-9) {
      lolaMinLon = Math.min(...normalized);
      lolaMaxLon = Math.max(...normalized);
    }
  } else {
    lolaMinLon = Math.min(...normalized);
    lolaMaxLon = Math.max(...normalized);
  }

  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
    lolaMinLon,
    lolaMaxLon,
  };
}

function pointFromCartesian(cartesian) {
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian, moonEllipsoid);
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: toDisplayLon(Cesium.Math.toDegrees(cartographic.longitude)),
    cartesian,
  };
}

function tangentVector(vector, up, fallback) {
  const projected = Cesium.Cartesian3.subtract(
    vector,
    Cesium.Cartesian3.multiplyByScalar(up, Cesium.Cartesian3.dot(vector, up), new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.magnitudeSquared(projected) < 1e-8) {
    return Cesium.Cartesian3.clone(fallback, projected);
  }
  return Cesium.Cartesian3.normalize(projected, projected);
}

function localRectangleFromPoints(points) {
  if (points.length !== 2) {
    return null;
  }

  const maxAbsLat = Math.max(...points.map((point) => Math.abs(point.lat)));
  if (maxAbsLat < POLAR_RECTANGLE_LATITUDE) {
    return null;
  }

  const p0 = moonEllipsoid.scaleToGeodeticSurface(points[0].cartesian);
  const p1 = moonEllipsoid.scaleToGeodeticSurface(points[1].cartesian);
  if (!p0 || !p1) {
    return null;
  }

  const centerDirection = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.add(p0, p1, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const center = Cesium.Cartesian3.multiplyByScalar(centerDirection, MOON_RADIUS_M, new Cesium.Cartesian3());
  const xAxis = tangentVector(viewer.camera.right, centerDirection, Cesium.Cartesian3.UNIT_X);
  const yAxis = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(centerDirection, xAxis, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const cameraUpOnPlane = tangentVector(viewer.camera.up, centerDirection, yAxis);
  if (Cesium.Cartesian3.dot(cameraUpOnPlane, yAxis) < 0) {
    Cesium.Cartesian3.negate(yAxis, yAxis);
  }

  const toPlane = (cartesian) => {
    const offset = Cesium.Cartesian3.subtract(cartesian, center, new Cesium.Cartesian3());
    return {
      x: Cesium.Cartesian3.dot(offset, xAxis),
      y: Cesium.Cartesian3.dot(offset, yAxis),
    };
  };
  const a = toPlane(p0);
  const b = toPlane(p1);
  const xMin = Math.min(a.x, b.x);
  const xMax = Math.max(a.x, b.x);
  const yMin = Math.min(a.y, b.y);
  const yMax = Math.max(a.y, b.y);

  const corners = [
    [xMin, yMin],
    [xMax, yMin],
    [xMax, yMax],
    [xMin, yMax],
  ];

  return corners
    .map(([x, y]) => {
      const tangentPoint = Cesium.Cartesian3.add(
        center,
        Cesium.Cartesian3.add(
          Cesium.Cartesian3.multiplyByScalar(xAxis, x, new Cesium.Cartesian3()),
          Cesium.Cartesian3.multiplyByScalar(yAxis, y, new Cesium.Cartesian3()),
          new Cesium.Cartesian3(),
        ),
        new Cesium.Cartesian3(),
      );
      const surfacePoint = moonEllipsoid.scaleToGeodeticSurface(tangentPoint);
      return surfacePoint ? pointFromCartesian(surfacePoint) : null;
    })
    .filter(Boolean);
}

function updateBoundsDisplay(bounds) {
  els.minLat.textContent = formatDegrees(bounds?.minLat);
  els.maxLat.textContent = formatDegrees(bounds?.maxLat);
  els.minLon.textContent = formatDegrees(bounds?.minLon);
  els.maxLon.textContent = formatDegrees(bounds?.maxLon);
  els.lolaMinLon.textContent = formatDegrees(bounds?.lolaMinLon);
  els.lolaMaxLon.textContent = formatDegrees(bounds?.lolaMaxLon);
}

function clearEntities() {
  markerEntities.forEach((entity) => viewer.entities.remove(entity));
  markerEntities = [];

  if (selectionShapeEntity) {
    viewer.entities.remove(selectionShapeEntity);
    selectionShapeEntity = null;
  }

  if (selectionLineEntity) {
    viewer.entities.remove(selectionLineEntity);
    selectionLineEntity = null;
  }
}

function drawSelection() {
  clearEntities();

  selectedPoints.forEach((point, index) => {
    const entity = viewer.entities.add({
        name: `Selection point ${index + 1}`,
        position: selectionPosition(point.lon, point.lat),
        point: {
          color: Cesium.Color.CYAN,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          pixelSize: selectionMode === "circle" ? 15 : 13,
          heightReference: Cesium.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    entity.selectionPointIndex = index;
    markerEntities.push(entity);
  });

  if (!currentBounds) {
    if (selectionMode === "polygon" && selectedPoints.length > 1) {
      selectionLineEntity = viewer.entities.add({
        name: "Freeform selection preview",
        polyline: {
          positions: selectedPoints.map((point) => selectionPosition(point.lon, point.lat)),
          width: 2,
          material: Cesium.Color.CYAN,
        },
      });
    }
    return;
  }

  if (selectionMode === "circle" && circleSelection) {
    selectionLineEntity = viewer.entities.add({
      name: "Circle diameter",
      polyline: {
        positions: selectedPoints.map((point) => selectionPosition(point.lon, point.lat)),
        width: 2,
        material: Cesium.Color.fromCssColorString("#f6d365"),
      },
    });
    selectionShapeEntity = viewer.entities.add({
      name: "Circular export bounds",
      position: selectionPosition(circleSelection.center.lon, circleSelection.center.lat),
      ellipse: {
        semiMajorAxis: circleSelection.radiusMeters,
        semiMinorAxis: circleSelection.radiusMeters,
        height: selectionHeight,
        material: Cesium.Color.CYAN.withAlpha(0.14),
        outline: true,
        outlineColor: Cesium.Color.CYAN,
      },
    });
    return;
  }

  if (selectionMode === "polygon") {
    const positions = selectedPoints.map((point) => selectionPosition(point.lon, point.lat));
    selectionShapeEntity = viewer.entities.add({
      name: "Freeform export bounds",
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        perPositionHeight: true,
        material: Cesium.Color.CYAN.withAlpha(0.14),
        outline: true,
        outlineColor: Cesium.Color.CYAN,
      },
    });
    selectionLineEntity = viewer.entities.add({
      name: "Freeform selection outline",
      polyline: {
        positions: [...positions, positions[0]],
        width: 2,
        material: Cesium.Color.CYAN,
      },
    });
    return;
  }

  if (selectionMode === "rectangle") {
    const corners = rectanglePolygon
      ? rectanglePolygon.map((point) => [point.lon, point.lat])
      : [
          [currentBounds.minLon, currentBounds.minLat],
          [currentBounds.minLon, currentBounds.maxLat],
          [currentBounds.maxLon, currentBounds.minLat],
          [currentBounds.maxLon, currentBounds.maxLat],
        ];

    corners.forEach(([lon, lat]) => {
      markerEntities.push(
        viewer.entities.add({
          name: "Selection corner",
          position: selectionPosition(lon, lat),
          point: {
            color: Cesium.Color.fromCssColorString("#f6d365"),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
            pixelSize: 9,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    });

    if (rectanglePolygon) {
      const positions = rectanglePolygon.map((point) => selectionPosition(point.lon, point.lat));
      selectionShapeEntity = viewer.entities.add({
        name: "Polar export bounds",
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          perPositionHeight: true,
          material: Cesium.Color.CYAN.withAlpha(0.14),
          outline: true,
          outlineColor: Cesium.Color.CYAN,
        },
      });
      selectionLineEntity = viewer.entities.add({
        name: "Polar export bounds outline",
        polyline: {
          positions: [...positions, positions[0]],
          width: 2,
          material: Cesium.Color.CYAN,
        },
      });
    } else {
      selectionShapeEntity = viewer.entities.add({
        name: "Selected export bounds",
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(
            currentBounds.minLon,
            currentBounds.minLat,
            currentBounds.maxLon,
            currentBounds.maxLat,
          ),
          material: Cesium.Color.CYAN.withAlpha(0.14),
          outline: true,
          outlineColor: Cesium.Color.CYAN,
          height: selectionHeight,
        },
      });
    }
  }
}

function modePrompt() {
  if (selectionMode === "circle") {
    return "Click the first diameter point, then drag out the second point.";
  }
  if (selectionMode === "polygon") {
    return "Click freeform boundary points, then Finish Shape.";
  }
  return "Click two lunar surface points to define a rectangle.";
}

function clearSelection(message = modePrompt()) {
  clearPreviewForSelectionChange();
  selectedPoints = [];
  currentBounds = null;
  currentExportInfo = null;
  circleSelection = null;
  rectanglePolygon = null;
  polygonFinished = false;
  clearEntities();
  updateBoundsDisplay(null);
  els.previewStl.disabled = true;
  els.exportStl.disabled = true;
  els.finishShape.disabled = selectionMode !== "polygon" || selectedPoints.length < 3;
  setMessage(message);
}

async function validateSelection() {
  const payload = requestPayload();
  currentExportInfo = null;

  if (!payload) {
    els.previewStl.disabled = true;
    els.exportStl.disabled = true;
    return;
  }

  const runId = ++validationRun;
  els.previewStl.disabled = true;
  els.exportStl.disabled = true;
  setMessage("Checking local DEM coverage...");

  try {
    const response = await fetch(`${API_BASE}/export-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = { ok: false, reason: await response.text() };
    }

    if (runId !== validationRun) {
      return;
    }

    if (!response.ok) {
      throw new Error(data.detail || data.reason || "Could not check export coverage.");
    }

    currentExportInfo = data;
    els.previewStl.disabled = !data.ok;
    els.exportStl.disabled = !data.ok;

    if (data.ok) {
      setMessage(data.reason);
      if (previewOpen) {
        setPreviewStatus("Selection ready. Press Refresh Preview to generate this area.");
      }
    } else {
      setMessage(`${data.reason} Turn on DEM Tiles to see exportable regions.`, true);
      setDemTilesVisible(true);
    }
  } catch (error) {
    if (runId !== validationRun) {
      return;
    }

    els.previewStl.disabled = true;
    els.exportStl.disabled = true;
    setMessage(error.message, true);
  }
}

function recomputeSelection(validate = false) {
  clearPreviewForSelectionChange();
  currentExportInfo = null;
  els.previewStl.disabled = true;
  els.exportStl.disabled = true;

  if (selectionMode === "rectangle") {
    if (selectedPoints.length === 2) {
      rectanglePolygon = localRectangleFromPoints(selectedPoints);
      currentBounds = calculateBounds(rectanglePolygon || selectedPoints);
    } else {
      rectanglePolygon = null;
      currentBounds = null;
    }
  } else if (selectionMode === "circle") {
    rectanglePolygon = null;
    if (selectedPoints.length === 2) {
      circleSelection = circleFromDiameter(selectedPoints[0], selectedPoints[1]);
      currentBounds = circleBoundsFromSelection(circleSelection);
    } else {
      circleSelection = null;
      currentBounds = null;
    }
  } else {
    rectanglePolygon = null;
    currentBounds = selectedPoints.length >= 3 ? calculateBounds(selectedPoints) : null;
    els.finishShape.disabled = selectedPoints.length < 3;
  }

  updateBoundsDisplay(currentBounds);
  drawSelection();

  if (validate && requestPayload()) {
    validateSelection();
  }
}

function handleMapClick(movement) {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }

  const pickedEntity = viewer.scene.pick(movement.position);
  if (pickedEntity?.id && Number.isInteger(pickedEntity.id.landmarkIndex)) {
    flyToLandmark(pickedEntity.id.landmarkIndex);
    return;
  }

  const picked = pickMoonPosition(movement.position);
  if (!picked) {
    setMessage("No lunar surface position found for that click.", true);
    return;
  }

  if (selectionMode === "rectangle") {
    if (selectedPoints.length >= 2) {
      clearSelection("Started a new rectangle.");
    }

    selectedPoints.push(picked);

    if (selectedPoints.length === 2) {
      recomputeSelection(true);
    } else {
      setMessage("First point set. Click a second point.");
      drawSelection();
    }
    return;
  }

  if (selectionMode === "circle") {
    if (selectedPoints.length >= 2) {
      clearSelection("Started a new circle.");
    }

    selectedPoints.push(picked);

    if (selectedPoints.length === 2) {
      recomputeSelection(true);
    } else {
      setMessage("First diameter point set. Drag out the second point.");
      drawSelection();
    }
    return;
  }

  if (polygonFinished) {
    clearSelection("Started a new freeform shape.");
  }

  selectedPoints.push(picked);
  els.finishShape.disabled = selectedPoints.length < 3;
  setMessage(selectedPoints.length >= 3 ? "Freeform shape can be finished or extended." : "Add at least 3 boundary points.");
  recomputeSelection(false);
}

function finishShape() {
  if (selectionMode !== "polygon" || selectedPoints.length < 3) {
    return;
  }

  clearPreviewForSelectionChange();
  polygonFinished = true;
  currentBounds = calculateBounds(selectedPoints);
  updateBoundsDisplay(currentBounds);
  drawSelection();
  validateSelection();
}

function setSelectionMode(mode) {
  selectionMode = mode;
  [els.modeRectangle, els.modeCircle, els.modePolygon].forEach((button) => {
    button.classList.remove("is-active");
  });
  if (mode === "circle") {
    els.modeCircle.classList.add("is-active");
  } else if (mode === "polygon") {
    els.modePolygon.classList.add("is-active");
  } else {
    els.modeRectangle.classList.add("is-active");
  }
  clearSelection(modePrompt());
}

function beginPointDrag(index) {
  draggingPointIndex = index;
  suppressNextClick = true;
  viewer.scene.screenSpaceCameraController.enableRotate = false;
  viewer.scene.screenSpaceCameraController.enableTranslate = false;
  viewer.scene.screenSpaceCameraController.enableTilt = false;
  viewer.scene.screenSpaceCameraController.enableLook = false;
}

function endPointDrag() {
  if (draggingPointIndex === null) {
    return;
  }

  draggingPointIndex = null;
  viewer.scene.screenSpaceCameraController.enableRotate = true;
  viewer.scene.screenSpaceCameraController.enableTranslate = true;
  viewer.scene.screenSpaceCameraController.enableTilt = true;
  viewer.scene.screenSpaceCameraController.enableLook = true;
  recomputeSelection(true);
}

function handlePointerDown(movement) {
  const picked = viewer.scene.pick(movement.position);
  if (picked?.id && Number.isInteger(picked.id.selectionPointIndex)) {
    beginPointDrag(picked.id.selectionPointIndex);
    return;
  }

  if (selectionMode === "circle" && selectedPoints.length === 1) {
    const point = pickMoonPosition(movement.position);
    if (!point) {
      return;
    }

    selectedPoints[1] = point;
    beginPointDrag(1);
    recomputeSelection(false);
  }
}

function handlePointerMove(movement) {
  if (draggingPointIndex === null) {
    return;
  }

  const point = pickMoonPosition(movement.endPosition);
  if (!point) {
    return;
  }

  selectedPoints[draggingPointIndex] = point;
  if (selectionMode === "polygon" && polygonFinished) {
    setMessage("Resizing freeform shape...");
  } else if (selectionMode === "circle") {
    setMessage("Resizing circle...");
  } else if (selectionMode === "rectangle") {
    setMessage("Resizing rectangle...");
  }
  recomputeSelection(false);
}

function parseFilename(response) {
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/i);
  return match ? match[1] : "open-moon-terrain.stl";
}

function syncPreviewInputsFromMain() {
  els.previewDownsample.value = els.downsample.value;
  els.previewZExaggeration.value = els.zExaggeration.value;
  els.previewBaseThickness.value = els.baseThickness.value;
}

function syncMainInputsFromPreview() {
  els.downsample.value = els.previewDownsample.value;
  els.zExaggeration.value = els.previewZExaggeration.value;
  els.baseThickness.value = els.previewBaseThickness.value;
}

function previewPayload() {
  return requestPayload({
    downsample: Number(els.previewDownsample.value || 16),
    z_exaggeration: Number(els.previewZExaggeration.value || 1),
    base_thickness: Number(els.previewBaseThickness.value || 1500),
  });
}

function initPreviewRenderer() {
  if (previewRenderer) {
    return;
  }

  previewScene = new THREE.Scene();
  previewScene.background = new THREE.Color(0x080b12);

  previewCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000000);
  previewRenderer = new THREE.WebGLRenderer({ antialias: true });
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  els.stlPreviewViewport.appendChild(previewRenderer.domElement);

  previewControls = new OrbitControls(previewCamera, previewRenderer.domElement);
  previewControls.enableDamping = true;

  previewScene.add(new THREE.HemisphereLight(0xffffff, 0x1b2130, 2.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(1, -1.4, 1.8);
  previewScene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x7fdff0, 0.8);
  fillLight.position.set(-1.6, 1.2, 0.8);
  previewScene.add(fillLight);

  previewResizeObserver = new ResizeObserver(resizePreviewRenderer);
  previewResizeObserver.observe(els.stlPreviewViewport);
  resizePreviewRenderer();
  animatePreview();
}

function resizePreviewRenderer() {
  if (!previewRenderer || !previewCamera) {
    return;
  }

  const rect = els.stlPreviewViewport.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  previewRenderer.setSize(width, height, false);
  previewCamera.aspect = width / height;
  previewCamera.updateProjectionMatrix();
}

function animatePreview() {
  requestAnimationFrame(animatePreview);
  if (!previewRenderer || !previewScene || !previewCamera) {
    return;
  }
  previewControls?.update();
  previewRenderer.render(previewScene, previewCamera);
}

function clearPreviewMesh() {
  if (!previewMesh) {
    return;
  }

  previewScene.remove(previewMesh);
  previewMesh.geometry.dispose();
  previewMesh.material.dispose();
  previewMesh = null;
}

function clearPreviewForSelectionChange() {
  previewGeneration += 1;
  previewBlob = null;
  clearTimeout(previewInputTimer);
  els.downloadPreviewStl.disabled = true;
  clearPreviewMesh();
  if (previewOpen) {
    setPreviewStatus("Selection changed. Press Refresh Preview to generate this area.");
  }
}

function fitPreviewCamera(mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(previewCamera.fov) / 2));

  previewControls.target.copy(center);
  previewCamera.position.set(
    center.x + distance * 0.82,
    center.y - distance * 1.15,
    center.z + distance * 0.68,
  );
  previewCamera.near = Math.max(0.1, distance / 1000);
  previewCamera.far = distance * 1000;
  previewCamera.updateProjectionMatrix();
  previewControls.update();
}

function showPreviewBlob(blob) {
  initPreviewRenderer();
  clearPreviewMesh();

  return blob.arrayBuffer().then((buffer) => {
    const geometry = new STLLoader().parse(buffer);
    geometry.computeVertexNormals();
    geometry.center();

    const material = new THREE.MeshStandardMaterial({
      color: 0x9ca3a9,
      roughness: 0.82,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    previewMesh = new THREE.Mesh(geometry, material);
    previewScene.add(previewMesh);
    fitPreviewCamera(previewMesh);
  });
}

async function generatePreview() {
  const payload = previewPayload();
  if (!payload) {
    setPreviewStatus("Finish a valid selection before previewing.", true);
    return;
  }

  const generation = ++previewGeneration;
  previewBlob = null;
  els.downloadPreviewStl.disabled = true;
  clearPreviewMesh();
  setPreviewStatus("Generating STL preview...");

  try {
    syncMainInputsFromPreview();
    const response = await fetch(`${API_BASE}/preview-stl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let detail = "STL preview failed.";
      try {
        const error = await response.json();
        detail = error.detail || detail;
      } catch {
        detail = await response.text();
      }
      throw new Error(detail);
    }

    if (generation !== previewGeneration) {
      return;
    }

    previewBlob = await response.blob();
    previewFilename = `open_moon_preview_${Date.now()}_base_${Math.round(payload.base_thickness)}.stl`;
    await showPreviewBlob(previewBlob);
    if (generation !== previewGeneration) {
      clearPreviewMesh();
      return;
    }
    els.downloadPreviewStl.disabled = false;
    setPreviewStatus("Preview ready. Drag to orbit, scroll to zoom.");
  } catch (error) {
    if (generation !== previewGeneration) {
      return;
    }
    els.downloadPreviewStl.disabled = true;
    setPreviewStatus(error.message, true);
  }
}

function openPreviewModal(autoGenerate = true) {
  previewOpen = true;
  els.previewModal.classList.add("is-open");
  els.previewModal.setAttribute("aria-hidden", "false");
  syncPreviewInputsFromMain();
  initPreviewRenderer();
  resizePreviewRenderer();

  if (autoGenerate) {
    generatePreview();
  }
}

function closePreviewModal() {
  previewOpen = false;
  els.previewModal.classList.remove("is-open");
  els.previewModal.setAttribute("aria-hidden", "true");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

let previewInputTimer = null;
function schedulePreviewRegeneration() {
  syncMainInputsFromPreview();
  clearTimeout(previewInputTimer);
  previewInputTimer = setTimeout(generatePreview, 450);
}

function previewStl() {
  if (!currentExportInfo?.ok) {
    validateSelection();
    return;
  }

  openPreviewModal(true);
}

async function exportStl() {
  const payload = requestPayload();
  if (!payload || !currentExportInfo?.ok) {
    validateSelection();
    return;
  }

  els.previewStl.disabled = true;
  els.exportStl.disabled = true;
  setMessage("Exporting STL...");

  try {
    const response = await fetch(`${API_BASE}/export-stl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let detail = "STL export failed.";
      try {
        const error = await response.json();
        detail = error.detail || detail;
      } catch {
        detail = await response.text();
      }
      throw new Error(detail);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = parseFilename(response);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage("STL export complete.");
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    const ready = Boolean(currentBounds && currentExportInfo?.ok);
    els.previewStl.disabled = !ready;
    els.exportStl.disabled = !ready;
  }
}

async function init() {
  try {
    await loadCesiumToken();
  } catch (error) {
    console.warn(error);
    els.tokenStatus.textContent = "Token unavailable; viewer will still start";
  }

  createViewer();
  await loadLandmarkCatalog();
  addLandmarks();
  await loadPreviewOverlay();
  await loadDemCoverage();
  updateScaleBar();

  handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(handlePointerDown, Cesium.ScreenSpaceEventType.LEFT_DOWN);
  handler.setInputAction(handlePointerMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(endPointDrag, Cesium.ScreenSpaceEventType.LEFT_UP);
  handler.setInputAction(handleMapClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(finishShape, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  viewer.camera.moveEnd.addEventListener(scheduleTexturePrefetch);

  els.modeRectangle.addEventListener("click", () => setSelectionMode("rectangle"));
  els.modeCircle.addEventListener("click", () => setSelectionMode("circle"));
  els.modePolygon.addEventListener("click", () => setSelectionMode("polygon"));
  els.layerOptical.addEventListener("click", () => applyMoonLayerMode("optical"));
  els.layerHybrid.addEventListener("click", () => applyMoonLayerMode("hybrid"));
  els.layerRelief.addEventListener("click", () => applyMoonLayerMode("relief"));
  els.landmarkCategory.addEventListener("change", populateLandmarkOptions);
  els.landmarkSelect.addEventListener("change", () => {
    if (els.landmarkSelect.value === "") {
      return;
    }
    flyToLandmark(Number(els.landmarkSelect.value));
  });
  els.toggleLandmarks.addEventListener("click", () => setLandmarksVisible(!landmarksVisible));
  els.resetView.addEventListener("click", () => {
    resetCamera();
    updateScaleBar();
  });
  els.toggleDemTiles.addEventListener("click", () => setDemTilesVisible(!demTilesVisible));
  els.finishShape.addEventListener("click", finishShape);
  els.clearSelection.addEventListener("click", () => clearSelection());
  els.previewStl.addEventListener("click", previewStl);
  els.exportStl.addEventListener("click", exportStl);
  els.downsample.addEventListener("change", validateSelection);
  els.zExaggeration.addEventListener("change", validateSelection);
  els.baseThickness.addEventListener("change", validateSelection);
  els.closePreview.addEventListener("click", closePreviewModal);
  els.refreshPreview.addEventListener("click", generatePreview);
  els.downloadPreviewStl.addEventListener("click", exportStl);
  [els.previewDownsample, els.previewZExaggeration, els.previewBaseThickness].forEach((input) => {
    input.addEventListener("change", generatePreview);
    input.addEventListener("input", schedulePreviewRegeneration);
  });
}

init();
