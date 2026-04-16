/* ════════════════════════════════════════════════════════
   Laser Pointer — Presenter View
   ════════════════════════════════════════════════════════ */

'use strict';

const STORAGE_KEY = 'laserPointer_v1';

// ── State ───────────────────────────────────────────────
const state = {
  settings: {
    redThreshold: 150,
    minPixelCount: 3,
    debounceFocusMs: 400,
    debounceSwitchMs: 1500,
    debounceMessageMs: 3000
  },
  zones: [],
  currentZoneId: null,
  pendingZoneId: null,
  pendingTimer: null,
  pendingStart: null,
  stream: null,
  videoReady: false,
  animFrameId: null
};

// ── DOM refs ────────────────────────────────────────────
const dom = {
  frame: document.getElementById('presenter-frame'),
  empty: document.getElementById('presenter-empty'),
  bar: document.getElementById('presenter-bar'),
  barLabel: document.getElementById('bar-label'),
  barFill: document.getElementById('bar-fill'),
  barCancel: document.getElementById('bar-cancel')
};

// Off-screen canvases
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d');

// Hidden video element for webcam
const videoEl = document.createElement('video');
videoEl.autoplay = true;
videoEl.muted = true;
videoEl.playsInline = true;
videoEl.style.display = 'none';
document.body.appendChild(videoEl);

// ── Storage ─────────────────────────────────────────────
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.settings) Object.assign(state.settings, data.settings);
    if (data.zones) state.zones = data.zones;
  } catch (e) { /* ignore */ }
}

// Re-load settings when the editor updates them
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    loadSettings();
    renderMask();
  }
});

// ── BroadcastChannel (receive zone from editor tab) ──────
let channel = null;
function initChannel() {
  try {
    channel = new BroadcastChannel('laserPointer');
    channel.onmessage = (e) => {
      if (e.data && e.data.type === 'zone') {
        handleZoneDetection(e.data.zoneId, e.data.zoneName);
      }
    };
  } catch (err) { /* BroadcastChannel not supported, run standalone */ }
}

// ── Color helpers ───────────────────────────────────────
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

function rgbMatch(r, g, b, hex, tolerance = 8) {
  const c = hexToRgb(hex);
  if (!c) return false;
  return Math.abs(r - c.r) < tolerance && Math.abs(g - c.g) < tolerance && Math.abs(b - c.b) < tolerance;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Mask rendering ──────────────────────────────────────
function fromNorm(nx, ny, w, h) {
  return { x: nx * w, y: ny * h };
}

function drawShape(ctx, shape, cw, ch) {
  ctx.beginPath();
  if (shape.type === 'rect') {
    const { x, y } = fromNorm(shape.x, shape.y, cw, ch);
    const { x: x2, y: y2 } = fromNorm(shape.x + shape.w, shape.y + shape.h, cw, ch);
    ctx.rect(x, y, x2 - x, y2 - y);
  } else if (shape.type === 'ellipse') {
    const { x: cx, y: cy } = fromNorm(shape.cx, shape.cy, cw, ch);
    ctx.ellipse(cx, cy, Math.abs(shape.rx * cw), Math.abs(shape.ry * ch), 0, 0, Math.PI * 2);
  } else if (shape.type === 'polygon' || shape.type === 'brush') {
    if (!shape.points || shape.points.length < 2) return;
    shape.points.forEach((p, i) => {
      const { x, y } = fromNorm(p.x, p.y, cw, ch);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fill();
}

function renderMask() {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  maskCtx.clearRect(0, 0, w, h);
  state.zones.forEach(zone => {
    maskCtx.fillStyle = zone.color;
    zone.shapes.forEach(s => drawShape(maskCtx, s, w, h));
  });
}

function getZoneAtPoint(vx, vy) {
  if (!state.zones.length) return null;
  const x = Math.round(clamp(vx, 0, maskCanvas.width - 1));
  const y = Math.round(clamp(vy, 0, maskCanvas.height - 1));
  const px = maskCtx.getImageData(x, y, 1, 1).data;
  if (px[3] < 128) return null;
  return state.zones.find(z => rgbMatch(px[0], px[1], px[2], z.color)) || null;
}

// ── Camera & detection ───────────────────────────────────
async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    videoEl.srcObject = state.stream;
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      state.videoReady = true;
      captureCanvas.width = videoEl.videoWidth;
      captureCanvas.height = videoEl.videoHeight;
      maskCanvas.width = videoEl.videoWidth;
      maskCanvas.height = videoEl.videoHeight;
      renderMask();
      requestAnimationFrame(detectLoop);
    };
  } catch (err) {
    // Camera unavailable — we rely solely on BroadcastChannel from editor
    console.warn('Presenter: camera unavailable, listening to editor broadcasts only.', err.message);
  }
}

let lastDetect = 0;

function detectLaserInFrame() {
  captureCtx.drawImage(videoEl, 0, 0, captureCanvas.width, captureCanvas.height);
  const data = captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height).data;
  const thr = state.settings.redThreshold;
  const w = captureCanvas.width;
  let sumX = 0, sumY = 0, count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > thr && r - g > 40 && r - b > 40) {
      const idx = i / 4;
      sumX += idx % w;
      sumY += Math.floor(idx / w);
      count++;
    }
  }
  if (count < state.settings.minPixelCount) return null;
  return { x: sumX / count, y: sumY / count };
}

function detectLoop(ts) {
  if (!state.videoReady) return;
  state.animFrameId = requestAnimationFrame(detectLoop);

  if (ts - lastDetect < 33) return;  // cap at ~30fps
  lastDetect = ts;

  const pt = detectLaserInFrame();
  if (pt) {
    const zone = getZoneAtPoint(pt.x, pt.y);
    if (zone) {
      handleZoneDetection(zone.id, zone.name);
      return;
    }
  }
  // No laser found — cancel pending
  if (state.pendingZoneId) cancelPending();
}

// ── Zone navigation with debounce ───────────────────────
let messageHideTimer = null;

function handleZoneDetection(zoneId, zoneName) {
  // Already showing this zone — nothing to do
  if (state.currentZoneId === zoneId && !state.pendingZoneId) return;

  // Already pending this zone — just keep counting
  if (state.pendingZoneId === zoneId) return;

  // New zone: start debounce
  cancelPending();

  // Instant switch if same zone was already pending focus (first detection)
  const debounceDuration = state.currentZoneId === null
    ? state.settings.debounceFocusMs
    : state.settings.debounceSwitchMs;

  state.pendingZoneId = zoneId;
  state.pendingStart = performance.now();

  const zone = state.zones.find(z => z.id === zoneId);
  const label = zone ? zone.name : (zoneName || 'Zone');

  showBar(label, debounceDuration);

  state.pendingTimer = setInterval(() => {
    const elapsed = performance.now() - state.pendingStart;
    const progress = Math.min(elapsed / debounceDuration, 1);
    dom.barFill.style.width = (progress * 100) + '%';

    if (progress >= 1) {
      clearInterval(state.pendingTimer);
      commitZone(zoneId);
    }
  }, 50);
}

function commitZone(zoneId) {
  const zone = state.zones.find(z => z.id === zoneId);
  state.currentZoneId = zoneId;
  state.pendingZoneId = null;

  hideBar();

  if (zone && zone.url) {
    dom.frame.src = zone.url;
    dom.frame.classList.remove('hidden');
    dom.empty.style.display = 'none';
  }
}

function cancelPending() {
  if (state.pendingTimer) clearInterval(state.pendingTimer);
  state.pendingTimer = null;
  state.pendingZoneId = null;
  state.pendingStart = null;
  dom.barFill.style.width = '0%';
  if (!messageHideTimer) hideBar();
}

// ── Notification bar ─────────────────────────────────────
function showBar(zoneName, debounceMs) {
  dom.barLabel.textContent = `Navigating to "${zoneName}" — keep pointing`;
  dom.barFill.style.width = '0%';
  dom.bar.classList.add('visible');

  clearTimeout(messageHideTimer);
  messageHideTimer = null;
}

function hideBar() {
  // Show "gone" message for debounceMessageMs, then hide
  if (state.pendingZoneId) return;  // don't hide while pending
  clearTimeout(messageHideTimer);
  messageHideTimer = setTimeout(() => {
    dom.bar.classList.remove('visible');
    messageHideTimer = null;
  }, state.settings.debounceMessageMs);
}

dom.barCancel.addEventListener('click', () => {
  cancelPending();
  hideBar();
});

// ── Init ────────────────────────────────────────────────
loadSettings();
initChannel();
startCamera();

// Keyboard: F for fullscreen
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  }
  if (e.key === 'Escape') {
    cancelPending();
    hideBar();
  }
});
