// Portrait capture, entirely on-device via MediaPipe (WebAssembly):
//  1. Face Landmarker finds 478 3D landmarks.
//  2. Selfie Segmenter separates the person from the background.
// We then crop a head-and-shoulders portrait, express the landmarks in crop
// space, and produce a tight avatar thumbnail. Only those results are uploaded.
import { GRID } from './splats.js';

const REMOTE = 'https://storage.googleapis.com/mediapipe-models';
const MODELS = {
  face: ['/models/face_landmarker.task', `${REMOTE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`],
  segment: ['/models/selfie_segmenter.tflite', `${REMOTE}/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`],
};
const PORTRAIT = 768;
const AVATAR = 256;

let visionPromise = null;
const cache = {};

function vision() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const mod = await import('@mediapipe/tasks-vision');
      const fileset = await mod.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      return { mod, fileset };
    })();
    visionPromise.catch(() => { visionPromise = null; });
  }
  return visionPromise;
}

async function modelPath([local, remote]) {
  try {
    const r = await fetch(local, { method: 'HEAD' });
    if (r.ok) return local;
  } catch { /* fall through */ }
  return remote;
}

function load(kind, create) {
  if (!cache[kind]) {
    cache[kind] = (async () => {
      const { mod, fileset } = await vision();
      const modelAssetPath = await modelPath(MODELS[kind]);
      let lastErr;
      for (const delegate of ['GPU', 'CPU']) {
        try { return await create(mod, fileset, { modelAssetPath, delegate }); } catch (e) { lastErr = e; }
      }
      throw lastErr;
    })();
    cache[kind].catch(() => { delete cache[kind]; });
  }
  return cache[kind];
}

export const loadLandmarker = () => load('face', (mod, fs, baseOptions) =>
  mod.FaceLandmarker.createFromOptions(fs, { baseOptions, runningMode: 'IMAGE', numFaces: 1 }));

export const loadSegmenter = () => load('segment', (mod, fs, baseOptions) =>
  mod.ImageSegmenter.createFromOptions(fs, { baseOptions, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false }));

export function warmUp() {
  loadLandmarker().catch(() => {});
  loadSegmenter().catch(() => {});
}

export function fileToCanvas(file, max = 1800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image the Bureau can read.')); };
    img.src = url;
  });
}

export async function detectFace(canvas) {
  const lm = await loadLandmarker();
  return lm.detect(canvas).faceLandmarks?.[0] || null;
}

// Person mask as a GRID×GRID greyscale canvas (white = person).
export async function segment(canvas) {
  const seg = await loadSegmenter();
  const res = seg.segment(canvas);
  try {
    const m = res.confidenceMasks?.[0];
    if (!m) return null;
    const f = m.getAsFloat32Array();
    const src = document.createElement('canvas');
    src.width = m.width; src.height = m.height;
    const sx = src.getContext('2d');
    const img = sx.createImageData(m.width, m.height);
    for (let i = 0; i < f.length; i++) {
      const v = Math.round(Math.min(1, Math.max(0, f[i])) * 255);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    sx.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = out.height = GRID;
    const ox = out.getContext('2d');
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(src, 0, 0, GRID, GRID);
    return out;
  } finally {
    res.close?.();
  }
}

function faceBox(src, points) {
  const W = src.width, H = src.height;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x * W); x1 = Math.max(x1, p.x * W);
    y0 = Math.min(y0, p.y * H); y1 = Math.max(y1, p.y * H);
  }
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

// Head-and-shoulders crop, landmarks re-expressed in crop space (z scales with x).
export function cropPortrait(src, points) {
  const b = faceBox(src, points);
  const side = Math.max(b.w, b.h) * 2.5;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2 + b.h * 0.3;
  const sx = cx - side / 2, sy = cy - side / 2;
  const canvas = paint(src, sx, sy, side, PORTRAIT);
  const landmarks = [];
  for (const p of points) {
    landmarks.push(round((p.x * src.width - sx) / side), round((p.y * src.height - sy) / side), round((p.z * src.width) / side));
  }
  return { canvas, landmarks };
}

export function cropAvatar(src, points) {
  const b = faceBox(src, points);
  const side = Math.max(b.w, b.h) * 1.45;
  return paint(src, (b.x0 + b.x1) / 2 - side / 2, (b.y0 + b.y1) / 2 - side / 2 - b.h * 0.04, side, AVATAR);
}

export function centreCrop(src, size = PORTRAIT) {
  const side = Math.min(src.width, src.height);
  return paint(src, (src.width - side) / 2, Math.max(0, (src.height - side) * 0.3), side, size);
}

function paint(src, sx, sy, side, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  x.fillStyle = '#111';
  x.fillRect(0, 0, size, size);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, sx, sy, side, side, 0, 0, size, size);
  return c;
}

const round = (v) => Math.round(v * 1e4) / 1e4;

export const toJpeg = (canvas, q = 0.9) => canvas.toDataURL('image/jpeg', q);
export const toPng = (canvas) => canvas.toDataURL('image/png');

// Webcam capture. Resolves with a controller, or rejects if no camera is available.
export async function openCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
  video.srcObject = stream;
  await video.play();
  return {
    capture() {
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      const x = c.getContext('2d');
      x.translate(c.width, 0);
      x.scale(-1, 1); // keep the mirror image people expect from a selfie
      x.drawImage(video, 0, 0);
      return c;
    },
    stop() { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; },
  };
}
