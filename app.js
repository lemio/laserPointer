/* ════════════════════════════════════════════════════════
   Laser Pointer — Editor Application
   ════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ──────────────────────────────────────────
const ZONE_COLORS = [
  '#e63946', '#2a9d8f', '#e9c46a', '#457b9d',
  '#e76f51', '#a8dadc', '#f4a261', '#264653',
  '#6a4c93', '#52b788', '#ff6b6b', '#4ecdc4'
];

const STORAGE_KEY = 'laserPointer_v1';

// ── State ──────────────────────────────────────────────
const state = {
  // Camera
  stream: null,
  videoReady: false,
  referenceData: null,       // ImageData for background subtraction

  // Detection
  detectActive: false,
  animFrameId: null,
  lastFrameTime: 0,
  fps: 0,
  fpsSamples: [],
  lastDetectedZone: null,

  // Drawing
  activeTool: 'select',
  isDrawing: false,
  drawStart: null,            // {x, y} normalized
  currentPoints: [],          // polygon points [{x,y} normalized]
  brushStroke: [],            // brush points [{x,y} normalized]
  pendingShape: null,         // shape object not yet committed

  // Zones
  zones: [],
  selectedZoneId: null,
  nextZoneIndex: 1,

  // UI
  canvasWidth: 0,
  canvasHeight: 0,

  // Settings
  settings: {
    redThreshold: 150,
    minPixelCount: 3,
    debounceFocusMs: 400,
    debounceSwitchMs: 1500,
    debounceMessageMs: 3000,
    detectionMode: 'laser',  // 'laser' | 'finger'
    handSide: 'right'        // 'left' | 'right'
  }
};

// ── DOM refs ────────────────────────────────────────────
const dom = {
  video: document.getElementById('video-el'),
  overlayCanvas: document.getElementById('overlay-canvas'),
  laserCanvas: document.getElementById('laser-canvas'),
  noCamera: document.getElementById('no-camera'),
  videoWrapper: document.getElementById('video-wrapper'),
  polygonHint: document.getElementById('polygon-hint'),
  activeZoneLabel: document.getElementById('active-zone-label'),

  btnCamera: document.getElementById('btn-camera'),
  btnCaptureRef: document.getElementById('btn-capture-ref'),
  btnDetect: document.getElementById('btn-detect'),
  btnPresent: document.getElementById('btn-present'),
  btnExport: document.getElementById('btn-export'),
  btnAddZone: document.getElementById('btn-add-zone'),
  btnDeleteZone: document.getElementById('btn-delete-zone'),

  zonesList: document.getElementById('zones-list'),
  zoneEditorSection: document.getElementById('zone-editor-section'),
  inputZoneName: document.getElementById('input-zone-name'),
  inputZoneUrl: document.getElementById('input-zone-url'),
  zoneUrlFeedback: document.getElementById('zone-url-feedback'),
  colorSwatches: document.getElementById('color-swatches'),
  btnApplyZone: document.getElementById('btn-apply-zone'),

  detectionDot: document.getElementById('detection-dot'),
  statusDetection: document.getElementById('status-detection'),
  statusFps: document.getElementById('status-fps'),
  statusZone: document.getElementById('status-zone'),

  sbTool: document.getElementById('sb-tool'),
  sbZones: document.getElementById('sb-zones'),
  sbPos: document.getElementById('sb-pos'),
  sbPwa: document.getElementById('sb-pwa'),

  sliderRedThreshold: document.getElementById('slider-red-threshold'),
  valRedThreshold: document.getElementById('val-red-threshold'),
  sliderMinPixels: document.getElementById('slider-min-pixels'),
  valMinPixels: document.getElementById('val-min-pixels'),
  sliderDebounceFocus: document.getElementById('slider-debounce-focus'),
  valDebounceFocus: document.getElementById('val-debounce-focus'),
  sliderDebounceSwitch: document.getElementById('slider-debounce-switch'),
  valDebounceSwitch: document.getElementById('val-debounce-switch'),
  sliderDebounceMsg: document.getElementById('slider-debounce-msg'),
  valDebounceMsg: document.getElementById('val-debounce-msg'),

  selectDetectionMode: document.getElementById('select-detection-mode'),
  selectHandSide: document.getElementById('select-hand-side'),
  settingHandSide: document.getElementById('setting-hand-side'),
  laserSettings: document.getElementById('laser-settings'),

  zoneModal: document.getElementById('zone-modal'),
  modalClose: document.getElementById('modal-close'),
  modalCancel: document.getElementById('modal-cancel'),
  modalConfirm: document.getElementById('modal-confirm'),
  modalZoneName: document.getElementById('modal-zone-name'),
  modalZoneUrl: document.getElementById('modal-zone-url'),
  modalUrlFeedback: document.getElementById('modal-url-feedback'),
  modalColorSwatches: document.getElementById('modal-color-swatches'),

  toast: document.getElementById('toast'),
  panelResizer: document.getElementById('panel-resizer'),
  sidePanel: document.getElementById('side-panel')
};

// Canvases
const overlayCtx = dom.overlayCanvas.getContext('2d');
const laserCtx = dom.laserCanvas.getContext('2d');

// Off-screen mask canvas for zone hit-testing
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d');

// Off-screen capture canvas for frame analysis
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

// ── Hand tracking state ──────────────────────────────────
let handsInstance = null;
let lastFingerTip = null;   // {x, y} in video pixel coords, or null
let handTrackingBusy = false;

// ── Utilities ───────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Convert display-space event coords to normalized [0,1] coords */
function toNorm(clientX, clientY) {
  const rect = dom.overlayCanvas.getBoundingClientRect();
  return {
    x: clamp((clientX - rect.left) / rect.width, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1)
  };
}

/** Convert normalized coords to canvas pixel coords */
function fromNorm(nx, ny, w, h) {
  return { x: nx * w, y: ny * h };
}

function showToast(msg, duration = 2500) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('visible');
  clearTimeout(dom.toast._timer);
  dom.toast._timer = setTimeout(() => dom.toast.classList.remove('visible'), duration);
}

// ── Color helpers ───────────────────────────────────────
function nextColor() {
  const used = state.zones.map(z => z.color);
  return ZONE_COLORS.find(c => !used.includes(c)) || ZONE_COLORS[state.zones.length % ZONE_COLORS.length];
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

function rgbMatch(r, g, b, hex, tolerance = 8) {
  const c = hexToRgb(hex);
  if (!c) return false;
  return Math.abs(r - c.r) < tolerance && Math.abs(g - c.g) < tolerance && Math.abs(b - c.b) < tolerance;
}

// ── URL helpers ─────────────────────────────────────────
// Matches any valid URL scheme (e.g. http://, https://, ftp://)
const URL_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;
const URL_CHECK_TIMEOUT_MS = 8000;
const URL_DEBOUNCE_MS = 600;

function normalizeUrl(url) {
  const s = url.trim();
  if (!s) return s;
  if (!URL_PROTOCOL_RE.test(s)) return 'http://' + s;
  return s;
}

async function runUrlCheck(inputEl, feedbackEl) {
  const raw = inputEl.value.trim();
  if (!raw) { feedbackEl.textContent = ''; feedbackEl.className = 'url-feedback'; return; }
  const url = normalizeUrl(raw);
  if (url !== raw) inputEl.value = url;
  try { new URL(url); } catch {
    feedbackEl.textContent = 'Invalid URL format';
    feedbackEl.className = 'url-feedback error';
    return;
  }
  feedbackEl.textContent = 'Checking…';
  feedbackEl.className = 'url-feedback checking';
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), URL_CHECK_TIMEOUT_MS);
  try {
    await fetch(url, { mode: 'no-cors', signal: controller.signal });
    clearTimeout(tid);
    feedbackEl.textContent = '✓ Reachable';
    feedbackEl.className = 'url-feedback ok';
  } catch (err) {
    clearTimeout(tid);
    feedbackEl.textContent = err.name === 'AbortError' ? '⚠ Timed out' : '✗ Not reachable';
    feedbackEl.className = 'url-feedback ' + (err.name === 'AbortError' ? 'warn' : 'error');
  }
}

function setupUrlChecker(inputEl, feedbackEl) {
  let timer = null;
  inputEl.addEventListener('input', () => {
    feedbackEl.textContent = '';
    feedbackEl.className = 'url-feedback';
    clearTimeout(timer);
    if (!inputEl.value.trim()) return;
    timer = setTimeout(() => runUrlCheck(inputEl, feedbackEl), URL_DEBOUNCE_MS);
  });
  inputEl.addEventListener('blur', () => {
    clearTimeout(timer);
    const normalized = normalizeUrl(inputEl.value);
    if (normalized !== inputEl.value) inputEl.value = normalized;
    if (inputEl.value.trim()) runUrlCheck(inputEl, feedbackEl);
  });
}

// ── Hand tracking helpers ────────────────────────────────
// Distance ratio thresholds for pointing gesture detection
const INDEX_EXTENSION_THRESHOLD = 1.2; // index tip must be ≥ this × PIP dist from wrist
const FINGER_CURL_THRESHOLD = 1.1;     // other finger tips must be < this × PIP dist from wrist

function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isIndexPointing(landmarks) {
  const w = landmarks[0]; // wrist
  const indexExtended = dist2D(landmarks[8], w) > dist2D(landmarks[6], w) * INDEX_EXTENSION_THRESHOLD;
  const middleCurled  = dist2D(landmarks[12], w) < dist2D(landmarks[10], w) * FINGER_CURL_THRESHOLD;
  const ringCurled    = dist2D(landmarks[16], w) < dist2D(landmarks[14], w) * FINGER_CURL_THRESHOLD;
  const pinkyCurled   = dist2D(landmarks[20], w) < dist2D(landmarks[18], w) * FINGER_CURL_THRESHOLD;
  return indexExtended && middleCurled && ringCurled && pinkyCurled;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

const MEDIAPIPE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/hands.js';

async function initHandTracking() {
  if (handsInstance) return;
  showToast('Loading hand tracking model…', 6000);
  try {
    if (typeof Hands === 'undefined') await loadScript(MEDIAPIPE_CDN);
  } catch (err) {
    showToast('Failed to load hand tracking — check internet connection');
    state.settings.detectionMode = 'laser';
    dom.selectDetectionMode.value = 'laser';
    updateDetectionModeUI();
    return;
  }
  handsInstance = new Hands({ // eslint-disable-line no-undef
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`
  });
  handsInstance.setOptions({
    maxNumHands: 1,
    modelComplexity: 0,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.5
  });
  handsInstance.onResults((results) => {
    handTrackingBusy = false;
    lastFingerTip = null;
    if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) return;
    let handIdx = 0;
    if (results.multiHandedness && results.multiHandedness.length > 1) {
      const wanted = state.settings.handSide;
      const idx = results.multiHandedness.findIndex(h => h.label.toLowerCase() === wanted);
      if (idx !== -1) handIdx = idx;
    }
    const landmarks = results.multiHandLandmarks[handIdx];
    if (!isIndexPointing(landmarks)) return;
    const tip = landmarks[8];
    lastFingerTip = { x: tip.x * captureCanvas.width, y: tip.y * captureCanvas.height };
  });
  showToast('Hand tracking ready');
}

function cleanupHandTracking() {
  if (handsInstance) {
    try { handsInstance.close(); } catch (e) { /* ignore */ }
    handsInstance = null;
  }
  handTrackingBusy = false;
  lastFingerTip = null;
}

function updateDetectionModeUI() {
  const isFinger = state.settings.detectionMode === 'finger';
  dom.settingHandSide.style.display = isFinger ? '' : 'none';
  dom.laserSettings.style.display = isFinger ? 'none' : '';
}

// ── Storage ─────────────────────────────────────────────
function saveState() {
  try {
    const data = {
      zones: state.zones,
      settings: state.settings,
      nextZoneIndex: state.nextZoneIndex
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) { /* storage full or unavailable */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.zones) state.zones = data.zones;
    if (data.settings) Object.assign(state.settings, data.settings);
    if (data.nextZoneIndex) state.nextZoneIndex = data.nextZoneIndex;
  } catch (e) { /* ignore */ }
}

// ── Camera ──────────────────────────────────────────────
async function startCamera() {
  try {
    const constraints = {
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
      audio: false
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    dom.video.srcObject = state.stream;
    dom.video.onloadedmetadata = () => {
      dom.video.play();
      dom.noCamera.style.display = 'none';
      dom.video.style.display = 'block';
      state.videoReady = true;
      syncCanvasSizes();
      dom.btnCaptureRef.disabled = false;
      dom.btnDetect.disabled = false;
      dom.btnCamera.textContent = 'Stop Camera';
      showToast('Camera active');
    };
  } catch (err) {
    showToast('Camera access denied: ' + err.message);
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  dom.video.srcObject = null;
  dom.video.style.display = 'none';
  dom.noCamera.style.display = '';
  state.videoReady = false;
  state.referenceData = null;
  dom.btnCaptureRef.disabled = true;
  dom.btnDetect.disabled = true;
  dom.btnCamera.textContent = 'Start Camera';
  if (state.detectActive) toggleDetection();
}

function syncCanvasSizes() {
  const vw = dom.video.videoWidth || dom.video.clientWidth;
  const vh = dom.video.videoHeight || dom.video.clientHeight;
  if (!vw || !vh) return;

  state.canvasWidth = vw;
  state.canvasHeight = vh;

  // Display canvases match the video element's CSS dimensions
  const cw = dom.video.clientWidth;
  const ch = dom.video.clientHeight;
  dom.overlayCanvas.width = cw;
  dom.overlayCanvas.height = ch;
  dom.laserCanvas.width = cw;
  dom.laserCanvas.height = ch;

  maskCanvas.width = vw;
  maskCanvas.height = vh;
  captureCanvas.width = vw;
  captureCanvas.height = vh;

  renderOverlay();
  renderMask();
}

// ── Reference frame capture ─────────────────────────────
function captureReference() {
  if (!state.videoReady) return;
  captureCtx.drawImage(dom.video, 0, 0, captureCanvas.width, captureCanvas.height);
  state.referenceData = captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
  showToast('Reference frame captured');
  dom.btnCaptureRef.textContent = 'Recapture Reference';
}

// ── Laser detection ─────────────────────────────────────
function detectLaserInFrame() {
  if (!state.videoReady) return null;

  captureCtx.drawImage(dom.video, 0, 0, captureCanvas.width, captureCanvas.height);
  const frame = captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
  const data = frame.data;
  const ref = state.referenceData ? state.referenceData.data : null;
  const thr = state.settings.redThreshold;
  const w = captureCanvas.width;

  let sumX = 0, sumY = 0, count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Primary condition: dominant red channel
    const isDominantRed = r > thr && r - g > 40 && r - b > 40;

    if (!isDominantRed) continue;

    // Optional background subtraction: the red channel should be significantly
    // brighter than the reference frame to reject ambient red objects
    if (ref) {
      const ri = data[i] - ref[i];
      if (ri < 60) continue;
    }

    const idx = i / 4;
    sumX += idx % w;
    sumY += Math.floor(idx / w);
    count++;
  }

  if (count < state.settings.minPixelCount) return null;
  return { x: sumX / count, y: sumY / count };
}

// ── Zone hit testing ────────────────────────────────────
function getZoneAtPoint(vx, vy) {
  if (!state.zones.length) return null;
  const x = Math.round(clamp(vx, 0, maskCanvas.width - 1));
  const y = Math.round(clamp(vy, 0, maskCanvas.height - 1));
  const pixel = maskCtx.getImageData(x, y, 1, 1).data;
  const r = pixel[0], g = pixel[1], b = pixel[2], a = pixel[3];
  if (a < 128) return null;
  return state.zones.find(z => rgbMatch(r, g, b, z.color)) || null;
}

// ── Detection loop ──────────────────────────────────────
let detectionCooldown = 0;

function detectionLoop(ts) {
  if (!state.detectActive) return;

  const dt = ts - state.lastFrameTime;
  state.lastFrameTime = ts;

  // FPS
  state.fpsSamples.push(dt);
  if (state.fpsSamples.length > 20) state.fpsSamples.shift();
  const averageFrameTime = state.fpsSamples.reduce((a, b) => a + b, 0) / state.fpsSamples.length;
  state.fps = Math.round(1000 / averageFrameTime);
  dom.statusFps.textContent = state.fps + ' fps';

  // Detect every ~30ms (≈33fps ceiling)
  detectionCooldown += dt;
  if (detectionCooldown >= 30) {
    detectionCooldown = 0;

    let pt;
    if (state.settings.detectionMode === 'finger') {
      if (handsInstance && !handTrackingBusy) {
        handTrackingBusy = true;
        handsInstance.send({ image: dom.video }).catch(() => { handTrackingBusy = false; });
      }
      pt = lastFingerTip;
    } else {
      pt = detectLaserInFrame();
    }

    laserCtx.clearRect(0, 0, dom.laserCanvas.width, dom.laserCanvas.height);

    if (pt) {
      // Convert video coords to overlay canvas coords
      const cx = (pt.x / captureCanvas.width) * dom.laserCanvas.width;
      const cy = (pt.y / captureCanvas.height) * dom.laserCanvas.height;

      // Draw pointer indicator
      laserCtx.save();
      if (state.settings.detectionMode === 'finger') {
        laserCtx.strokeStyle = 'rgba(45,125,210,0.9)';
        laserCtx.lineWidth = 2;
        laserCtx.beginPath();
        laserCtx.arc(cx, cy, 12, 0, Math.PI * 2);
        laserCtx.stroke();
        laserCtx.strokeStyle = 'rgba(45,125,210,0.4)';
        laserCtx.beginPath();
        laserCtx.arc(cx, cy, 20, 0, Math.PI * 2);
        laserCtx.stroke();
      } else {
        laserCtx.strokeStyle = 'rgba(255,60,60,0.9)';
        laserCtx.lineWidth = 1.5;
        laserCtx.beginPath();
        laserCtx.arc(cx, cy, 10, 0, Math.PI * 2);
        laserCtx.stroke();
        laserCtx.strokeStyle = 'rgba(255,60,60,0.5)';
        laserCtx.beginPath();
        laserCtx.arc(cx, cy, 18, 0, Math.PI * 2);
        laserCtx.stroke();
      }
      laserCtx.restore();

      // Hit test
      const zone = getZoneAtPoint(pt.x, pt.y);
      dom.detectionDot.classList.add('active');
      const label = state.settings.detectionMode === 'finger' ? 'Finger' : 'Laser';
      dom.statusDetection.textContent = `${label} at (${Math.round(pt.x)}, ${Math.round(pt.y)})`;

      if (zone) {
        dom.statusZone.textContent = zone.name;
        if (dom.activeZoneLabel) {
          dom.activeZoneLabel.textContent = zone.name;
          dom.activeZoneLabel.classList.remove('hidden');
        }
        state.lastDetectedZone = zone.id;
        broadcastZone(zone);
      } else {
        dom.statusZone.textContent = '—';
        if (dom.activeZoneLabel) dom.activeZoneLabel.classList.add('hidden');
      }
    } else {
      dom.detectionDot.classList.remove('active');
      dom.statusDetection.textContent = state.settings.detectionMode === 'finger'
        ? 'No pointing gesture detected'
        : 'No laser detected';
      dom.statusZone.textContent = '—';
      if (dom.activeZoneLabel) dom.activeZoneLabel.classList.add('hidden');
    }
  }

  state.animFrameId = requestAnimationFrame(detectionLoop);
}

// BroadcastChannel to communicate with presenter view
let presenterChannel = null;
function broadcastZone(zone) {
  if (!presenterChannel) {
    try { presenterChannel = new BroadcastChannel('laserPointer'); } catch (e) { return; }
  }
  presenterChannel.postMessage({ type: 'zone', zoneId: zone.id, zoneName: zone.name, url: zone.url });
}

function toggleDetection() {
  state.detectActive = !state.detectActive;
  if (state.detectActive) {
    state.lastFrameTime = performance.now();
    state.fpsSamples = [];
    if (state.settings.detectionMode === 'finger') initHandTracking();
    state.animFrameId = requestAnimationFrame(detectionLoop);
    dom.btnDetect.textContent = 'Detection On';
    dom.btnDetect.classList.add('active');
  } else {
    cancelAnimationFrame(state.animFrameId);
    if (state.settings.detectionMode === 'finger') cleanupHandTracking();
    laserCtx.clearRect(0, 0, dom.laserCanvas.width, dom.laserCanvas.height);
    dom.detectionDot.classList.remove('active');
    dom.statusDetection.textContent = 'Detection off';
    dom.statusFps.textContent = '0 fps';
    dom.statusZone.textContent = '—';
    if (dom.activeZoneLabel) dom.activeZoneLabel.classList.add('hidden');
    dom.btnDetect.textContent = 'Detection Off';
    dom.btnDetect.classList.remove('active');
  }
}

// ── Zone management ─────────────────────────────────────
function createZone({ name, url, color, shapes = [] }) {
  const zone = {
    id: uid(),
    name: name || 'Zone ' + state.nextZoneIndex,
    url: url || '',
    color: color || nextColor(),
    shapes
  };
  state.nextZoneIndex++;
  state.zones.push(zone);
  saveState();
  renderMask();
  renderOverlay();
  renderZonesList();
  dom.sbZones.textContent = state.zones.length;
  return zone;
}

function updateZone(id, updates) {
  const zone = state.zones.find(z => z.id === id);
  if (!zone) return;
  Object.assign(zone, updates);
  saveState();
  renderMask();
  renderOverlay();
  renderZonesList();
}

function deleteZone(id) {
  state.zones = state.zones.filter(z => z.id !== id);
  if (state.selectedZoneId === id) {
    state.selectedZoneId = null;
    dom.zoneEditorSection.style.display = 'none';
    dom.btnDeleteZone.disabled = true;
  }
  saveState();
  renderMask();
  renderOverlay();
  renderZonesList();
  dom.sbZones.textContent = state.zones.length;
}

function selectZone(id) {
  state.selectedZoneId = id;
  dom.btnDeleteZone.disabled = !id;
  renderZonesList();

  if (id) {
    const zone = state.zones.find(z => z.id === id);
    if (zone) {
      dom.inputZoneName.value = zone.name;
      dom.inputZoneUrl.value = zone.url;
      dom.zoneUrlFeedback.textContent = '';
      dom.zoneUrlFeedback.className = 'url-feedback';
      renderColorSwatches(dom.colorSwatches, zone.color, () => {});
      dom.zoneEditorSection.style.display = '';
    }
  } else {
    dom.zoneEditorSection.style.display = 'none';
  }
  renderOverlay();
}

// ── Rendering ───────────────────────────────────────────
function renderColorSwatches(container, selectedColor, onChange) {
  container.innerHTML = '';
  ZONE_COLORS.forEach(color => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch-btn';
    btn.style.background = color;
    btn.dataset.color = color;
    if (color === selectedColor) btn.classList.add('selected');
    btn.addEventListener('click', () => {
      container.querySelectorAll('.color-swatch-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onChange(color);
    });
    container.appendChild(btn);
  });
}

function renderZonesList() {
  const list = dom.zonesList;
  list.innerHTML = '';

  if (!state.zones.length) {
    list.innerHTML = '<div class="empty-state">No zones defined.<br>Draw a shape or click + to add.</div>';
    return;
  }

  state.zones.forEach(zone => {
    const item = document.createElement('div');
    item.className = 'zone-item' + (zone.id === state.selectedZoneId ? ' selected' : '');
    item.innerHTML = `
      <div class="zone-swatch" style="background:${zone.color}"></div>
      <div class="zone-info">
        <div class="zone-name">${escHtml(zone.name)}</div>
        <div class="zone-url">${escHtml(zone.url || 'No URL set')}</div>
      </div>
      <div class="zone-actions">
        <button class="icon-btn btn-zone-del" data-id="${zone.id}" title="Delete">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 1l9 9M10 1L1 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
      </div>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-zone-del')) return;
      selectZone(zone.id);
    });
    item.querySelector('.btn-zone-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteZone(zone.id);
    });
    list.appendChild(item);
  });
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Render zone shapes to an off-screen mask canvas (solid zone colors)
function renderMask() {
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  state.zones.forEach(zone => {
    maskCtx.fillStyle = zone.color;
    zone.shapes.forEach(shape => drawShape(maskCtx, shape, maskCanvas.width, maskCanvas.height, 'fill'));
  });
}

// Render zone overlays on the visible canvas
function renderOverlay() {
  const cw = dom.overlayCanvas.width;
  const ch = dom.overlayCanvas.height;
  overlayCtx.clearRect(0, 0, cw, ch);

  state.zones.forEach(zone => {
    const rgb = hexToRgb(zone.color);
    const fill = `rgba(${rgb.r},${rgb.g},${rgb.b},0.18)`;
    const stroke = zone.id === state.selectedZoneId ? zone.color : `rgba(${rgb.r},${rgb.g},${rgb.b},0.7)`;

    overlayCtx.save();
    overlayCtx.fillStyle = fill;
    overlayCtx.strokeStyle = stroke;
    overlayCtx.lineWidth = zone.id === state.selectedZoneId ? 2.5 : 1.5;
    if (zone.id === state.selectedZoneId) {
      overlayCtx.setLineDash([5, 3]);
    }
    zone.shapes.forEach(shape => drawShape(overlayCtx, shape, cw, ch, 'both'));
    overlayCtx.restore();
  });

  // Draw pending shape (in-progress)
  if (state.pendingShape) {
    const col = pendingColor();
    const rgb = hexToRgb(col) || { r: 255, g: 255, b: 255 };
    overlayCtx.save();
    overlayCtx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.15)`;
    overlayCtx.strokeStyle = col;
    overlayCtx.lineWidth = 1.5;
    overlayCtx.setLineDash([4, 3]);
    drawShape(overlayCtx, state.pendingShape, cw, ch, 'both');
    overlayCtx.restore();
  }

  // Polygon in-progress points
  if (state.activeTool === 'polygon' && state.currentPoints.length > 0) {
    const col = pendingColor();
    overlayCtx.save();
    overlayCtx.strokeStyle = col;
    overlayCtx.fillStyle = `rgba(255,255,255,0.8)`;
    overlayCtx.lineWidth = 1.5;
    overlayCtx.setLineDash([4, 3]);
    overlayCtx.beginPath();
    state.currentPoints.forEach((p, i) => {
      const { x, y } = fromNorm(p.x, p.y, cw, ch);
      if (i === 0) overlayCtx.moveTo(x, y); else overlayCtx.lineTo(x, y);
    });
    overlayCtx.stroke();
    state.currentPoints.forEach(p => {
      const { x, y } = fromNorm(p.x, p.y, cw, ch);
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, 3, 0, Math.PI * 2);
      overlayCtx.fill();
    });
    overlayCtx.restore();
  }
}

function pendingColor() {
  return nextColor();
}

// Draw a single shape on a given context
// mode: 'fill' | 'stroke' | 'both'
function drawShape(ctx, shape, cw, ch, mode) {
  ctx.beginPath();

  if (shape.type === 'rect') {
    const { x, y } = fromNorm(shape.x, shape.y, cw, ch);
    const { x: x2, y: y2 } = fromNorm(shape.x + shape.w, shape.y + shape.h, cw, ch);
    ctx.rect(x, y, x2 - x, y2 - y);

  } else if (shape.type === 'ellipse') {
    const { x: cx, y: cy } = fromNorm(shape.cx, shape.cy, cw, ch);
    const rx = shape.rx * cw;
    const ry = shape.ry * ch;
    ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);

  } else if (shape.type === 'polygon' || shape.type === 'brush') {
    if (!shape.points || shape.points.length < 2) return;
    shape.points.forEach((p, i) => {
      const { x, y } = fromNorm(p.x, p.y, cw, ch);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();

  } else {
    return;
  }

  if (mode === 'fill' || mode === 'both') ctx.fill();
  if (mode === 'stroke' || mode === 'both') ctx.stroke();
}

// ── Drawing tools ───────────────────────────────────────
function setActiveTool(tool) {
  state.activeTool = tool;
  state.isDrawing = false;
  state.currentPoints = [];
  state.pendingShape = null;
  dom.polygonHint.classList.toggle('hidden', tool !== 'polygon');

  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });

  dom.overlayCanvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  dom.sbTool.textContent = tool.charAt(0).toUpperCase() + tool.slice(1);
  renderOverlay();
}

// Mouse/touch event handlers on overlay canvas
dom.overlayCanvas.addEventListener('mousedown', onDrawStart);
dom.overlayCanvas.addEventListener('mousemove', onDrawMove);
dom.overlayCanvas.addEventListener('mouseup', onDrawEnd);
dom.overlayCanvas.addEventListener('dblclick', onDrawDoubleClick);
dom.overlayCanvas.addEventListener('mousemove', (e) => {
  const rect = dom.overlayCanvas.getBoundingClientRect();
  const normalizedX = (e.clientX - rect.left) / rect.width;
  const normalizedY = (e.clientY - rect.top) / rect.height;
  dom.sbPos.textContent = `${(normalizedX * 100).toFixed(0)}%, ${(normalizedY * 100).toFixed(0)}%`;
});

function onDrawStart(e) {
  if (e.button !== 0) return;
  const norm = toNorm(e.clientX, e.clientY);

  if (state.activeTool === 'select') {
    // Hit test zones in overlay space
    const cw = dom.overlayCanvas.width;
    const ch = dom.overlayCanvas.height;
    const vx = norm.x * state.canvasWidth;
    const vy = norm.y * state.canvasHeight;
    const hit = getZoneAtPoint(vx, vy);
    selectZone(hit ? hit.id : null);
    return;
  }

  if (state.activeTool === 'polygon') {
    state.currentPoints.push(norm);
    renderOverlay();
    return;
  }

  state.isDrawing = true;
  state.drawStart = norm;

  if (state.activeTool === 'brush') {
    state.brushStroke = [norm];
    state.pendingShape = { type: 'brush', points: [norm] };
  }
}

function onDrawMove(e) {
  if (!state.isDrawing) return;
  const norm = toNorm(e.clientX, e.clientY);

  if (state.activeTool === 'rect') {
    const s = state.drawStart;
    const w = norm.x - s.x;
    const h = norm.y - s.y;
    state.pendingShape = {
      type: 'rect',
      x: w >= 0 ? s.x : norm.x,
      y: h >= 0 ? s.y : norm.y,
      w: Math.abs(w),
      h: Math.abs(h)
    };

  } else if (state.activeTool === 'ellipse') {
    const s = state.drawStart;
    state.pendingShape = {
      type: 'ellipse',
      cx: (s.x + norm.x) / 2,
      cy: (s.y + norm.y) / 2,
      rx: Math.abs(norm.x - s.x) / 2,
      ry: Math.abs(norm.y - s.y) / 2
    };

  } else if (state.activeTool === 'brush') {
    state.brushStroke.push(norm);
    state.pendingShape = { type: 'brush', points: [...state.brushStroke] };
  }

  renderOverlay();
}

function onDrawEnd(e) {
  if (!state.isDrawing) return;
  state.isDrawing = false;

  if (state.activeTool === 'brush' && state.brushStroke.length >= 3) {
    commitPendingShape();
  } else if (state.pendingShape && (state.activeTool === 'rect' || state.activeTool === 'ellipse')) {
    const s = state.pendingShape;
    const valid = s.type === 'rect'
      ? (s.w > 0.01 && s.h > 0.01)
      : (s.rx > 0.01 && s.ry > 0.01);
    if (valid) commitPendingShape();
  }

  state.drawStart = null;
  state.brushStroke = [];
  state.pendingShape = null;
  renderOverlay();
}

function onDrawDoubleClick(e) {
  if (state.activeTool !== 'polygon') return;
  if (state.currentPoints.length >= 3) {
    state.pendingShape = { type: 'polygon', points: [...state.currentPoints] };
    commitPendingShape();
  }
  state.currentPoints = [];
  renderOverlay();
}

function commitPendingShape() {
  const shape = state.pendingShape || (state.activeTool === 'polygon' && state.currentPoints.length >= 3
    ? { type: 'polygon', points: [...state.currentPoints] }
    : null);
  if (!shape) return;

  // If no zones exist or we want a new zone, show modal
  openZoneModal(shape);
}

// ── Zone modal ──────────────────────────────────────────
let pendingShapeForModal = null;
let modalSelectedColor = null;

function openZoneModal(shape) {
  pendingShapeForModal = shape;
  modalSelectedColor = nextColor();
  dom.modalZoneName.value = 'Zone ' + state.nextZoneIndex;
  dom.modalZoneUrl.value = '';
  dom.modalUrlFeedback.textContent = '';
  dom.modalUrlFeedback.className = 'url-feedback';
  renderColorSwatches(dom.modalColorSwatches, modalSelectedColor, (c) => { modalSelectedColor = c; });
  dom.zoneModal.classList.remove('hidden');
  dom.modalZoneName.focus();
  dom.modalZoneName.select();
}

function closeZoneModal() {
  dom.zoneModal.classList.add('hidden');
  pendingShapeForModal = null;
  state.pendingShape = null;
  state.currentPoints = [];
  renderOverlay();
}

dom.modalClose.addEventListener('click', closeZoneModal);
dom.modalCancel.addEventListener('click', closeZoneModal);
dom.zoneModal.addEventListener('click', (e) => { if (e.target === dom.zoneModal) closeZoneModal(); });

dom.modalConfirm.addEventListener('click', () => {
  if (!pendingShapeForModal) return;
  const rawUrl = dom.modalZoneUrl.value.trim();
  const url = normalizeUrl(rawUrl);
  if (url !== rawUrl) dom.modalZoneUrl.value = url;
  const zone = createZone({
    name: dom.modalZoneName.value.trim() || 'Zone ' + state.nextZoneIndex,
    url: url,
    color: modalSelectedColor,
    shapes: [pendingShapeForModal]
  });
  state.pendingShape = null;
  state.currentPoints = [];
  closeZoneModal();
  selectZone(zone.id);
});

dom.modalZoneName.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.modalConfirm.click(); });

// ── Zone editor (side panel) ────────────────────────────
dom.btnApplyZone.addEventListener('click', () => {
  if (!state.selectedZoneId) return;
  const zone = state.zones.find(z => z.id === state.selectedZoneId);
  if (!zone) return;
  const newColor = dom.colorSwatches.querySelector('.color-swatch-btn.selected')?.dataset.color || zone.color;
  const rawUrl = dom.inputZoneUrl.value.trim();
  const url = normalizeUrl(rawUrl);
  if (url !== rawUrl) dom.inputZoneUrl.value = url;
  updateZone(state.selectedZoneId, {
    name: dom.inputZoneName.value.trim() || zone.name,
    url: url,
    color: newColor
  });
  showToast('Zone updated');
});

// ── Export to ZIP ────────────────────────────────────────
async function exportZip() {
  if (typeof JSZip === 'undefined') {
    showToast('JSZip not loaded — check internet connection');
    return;
  }

  const zip = new JSZip();
  const now = new Date();
  const exportTimestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // config.json
  const config = {
    version: '1.0',
    exported: now.toISOString(),
    calibration: { ...state.settings },
    zones: state.zones.map(z => ({
      id: z.id,
      name: z.name,
      url: z.url,
      maskColor: z.color,
      shapes: z.shapes
    }))
  };
  zip.file('config.json', JSON.stringify(config, null, 2));

  // README
  zip.file('README.txt', [
    'Laser Pointer Export',
    '====================',
    '',
    'mask.png      - Zone mask. Each zone is painted with its maskColor.',
    '                Compare maskColor in config.json to identify zones.',
    'reference.jpg - Webcam still at time of export (if available).',
    'config.json   - Zone definitions and calibration settings.',
    '',
    'Calibration fields:',
    '  redThreshold    - Minimum red channel value to consider a laser pixel.',
    '  minPixelCount   - Minimum cluster size to register a detection.',
    '  debounceFocusMs - Delay before confirming initial focus.',
    '  debounceSwitchMs- Delay before switching to a new zone.',
    '  debounceMessageMs - How long the notification bar stays visible.',
    '',
    `Exported: ${now.toLocaleString()}`,
    `Zones: ${state.zones.length}`
  ].join('\n'));

  // mask.png — render all zones at video resolution
  const mw = state.canvasWidth || 1280;
  const mh = state.canvasHeight || 720;
  const offMask = document.createElement('canvas');
  offMask.width = mw; offMask.height = mh;
  const offCtx = offMask.getContext('2d');
  offCtx.clearRect(0, 0, mw, mh);
  state.zones.forEach(zone => {
    offCtx.fillStyle = zone.color;
    offCtx.strokeStyle = zone.color;
    zone.shapes.forEach(shape => drawShape(offCtx, shape, mw, mh, 'fill'));
  });
  const maskBlob = await new Promise(res => offMask.toBlob(res, 'image/png'));
  if (maskBlob) zip.file('mask.png', maskBlob);

  // reference.jpg — latest webcam frame
  if (state.videoReady) {
    const refCanvas = document.createElement('canvas');
    refCanvas.width = state.canvasWidth;
    refCanvas.height = state.canvasHeight;
    const rCtx = refCanvas.getContext('2d');
    rCtx.drawImage(dom.video, 0, 0);
    const refBlob = await new Promise(res => refCanvas.toBlob(res, 'image/jpeg', 0.88));
    if (refBlob) zip.file('reference.jpg', refBlob);
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `laserpointer-${exportTimestamp}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Export complete');
}

// ── Resizable side panel ────────────────────────────────
(function initResizer() {
  let dragging = false;
  let startX = 0, startW = 0;

  dom.panelResizer.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = dom.sidePanel.offsetWidth;
    dom.panelResizer.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    const newW = clamp(startW + delta, 220, 420);
    dom.sidePanel.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    dom.panelResizer.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
})();

// ── Event bindings ──────────────────────────────────────
dom.btnCamera.addEventListener('click', () => {
  state.stream ? stopCamera() : startCamera();
});

dom.btnCaptureRef.addEventListener('click', captureReference);

dom.btnDetect.addEventListener('click', () => {
  if (!state.videoReady) return;
  toggleDetection();
});

dom.btnPresent.addEventListener('click', () => {
  saveState();
  window.open('present.html', 'laserPointerPresenter',
    'width=1280,height=720,toolbar=0,menubar=0,location=0');
});

dom.btnExport.addEventListener('click', exportZip);

dom.btnAddZone.addEventListener('click', () => {
  const shape = { type: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
  openZoneModal(shape);
});

dom.btnDeleteZone.addEventListener('click', () => {
  if (state.selectedZoneId) deleteZone(state.selectedZoneId);
});

document.querySelectorAll('[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
});

// Settings sliders
function bindSlider(slider, valueEl, settingKey, transform) {
  slider.addEventListener('input', () => {
    const val = transform ? transform(+slider.value) : +slider.value;
    state.settings[settingKey] = val;
    valueEl.textContent = val;
    saveState();
  });
}

bindSlider(dom.sliderRedThreshold, dom.valRedThreshold, 'redThreshold');
bindSlider(dom.sliderMinPixels, dom.valMinPixels, 'minPixelCount');
bindSlider(dom.sliderDebounceFocus, dom.valDebounceFocus, 'debounceFocusMs');
bindSlider(dom.sliderDebounceSwitch, dom.valDebounceSwitch, 'debounceSwitchMs');
bindSlider(dom.sliderDebounceMsg, dom.valDebounceMsg, 'debounceMessageMs');

// Detection mode & hand side selects
dom.selectDetectionMode.addEventListener('change', () => {
  state.settings.detectionMode = dom.selectDetectionMode.value;
  updateDetectionModeUI();
  saveState();
  if (state.detectActive) {
    if (state.settings.detectionMode === 'finger') {
      initHandTracking();
    } else {
      cleanupHandTracking();
    }
  }
});

dom.selectHandSide.addEventListener('change', () => {
  state.settings.handSide = dom.selectHandSide.value;
  saveState();
});

// URL checkers for modal and zone editor
setupUrlChecker(dom.modalZoneUrl, dom.modalUrlFeedback);
setupUrlChecker(dom.inputZoneUrl, dom.zoneUrlFeedback);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const map = { 'v': 'select', 'r': 'rect', 'e': 'ellipse', 'p': 'polygon', 'b': 'brush' };
  if (map[e.key]) setActiveTool(map[e.key]);
  if (e.key === 'Escape') {
    state.currentPoints = [];
    state.pendingShape = null;
    state.isDrawing = false;
    renderOverlay();
    closeZoneModal();
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedZoneId) {
    deleteZone(state.selectedZoneId);
  }
});

// Resize observer to keep canvas in sync with layout changes
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => syncCanvasSizes());
  ro.observe(dom.videoWrapper);
}
window.addEventListener('resize', syncCanvasSizes);

// ── Init ────────────────────────────────────────────────
function init() {
  loadState();

  // Apply loaded settings to sliders
  dom.sliderRedThreshold.value = state.settings.redThreshold;
  dom.valRedThreshold.textContent = state.settings.redThreshold;
  dom.sliderMinPixels.value = state.settings.minPixelCount;
  dom.valMinPixels.textContent = state.settings.minPixelCount;
  dom.sliderDebounceFocus.value = state.settings.debounceFocusMs;
  dom.valDebounceFocus.textContent = state.settings.debounceFocusMs;
  dom.sliderDebounceSwitch.value = state.settings.debounceSwitchMs;
  dom.valDebounceSwitch.textContent = state.settings.debounceSwitchMs;
  dom.sliderDebounceMsg.value = state.settings.debounceMessageMs;
  dom.valDebounceMsg.textContent = state.settings.debounceMessageMs;

  // Apply loaded settings to detection mode controls
  dom.selectDetectionMode.value = state.settings.detectionMode;
  dom.selectHandSide.value = state.settings.handSide;
  updateDetectionModeUI();

  renderZonesList();
  dom.sbZones.textContent = state.zones.length;
  setActiveTool('select');

  // PWA service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => {
      dom.sbPwa.textContent = 'ready';
    }).catch(() => {
      dom.sbPwa.textContent = 'offline unavailable';
    });
  } else {
    dom.sbPwa.textContent = 'not supported';
  }
}

init();
