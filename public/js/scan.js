// Biometric enrollment: find the face with MediaPipe's Face Landmarker (runs
// entirely in the browser via WebAssembly), crop a square portrait around it
// and normalise the 478 landmarks to that crop.
const REMOTE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const CROP = 512;

let landmarkerPromise = null;

export function loadLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      let modelAssetPath = '/models/face_landmarker.task';
      try {
        const r = await fetch(modelAssetPath, { method: 'HEAD' });
        if (!r.ok) throw new Error('no local model');
      } catch { modelAssetPath = REMOTE_MODEL; }
      let lastErr;
      for (const delegate of ['GPU', 'CPU']) {
        try {
          return await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath, delegate },
            runningMode: 'IMAGE',
            numFaces: 1,
          });
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

export function fileToCanvas(file, max = 1600) {
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

export async function detect(canvas) {
  const lm = await loadLandmarker();
  const res = lm.detect(canvas);
  return res.faceLandmarks?.[0] || null;
}

// Square crop around the face (with room for hair and chin); landmarks are
// re-expressed in crop space. z scales with x, per MediaPipe's convention.
export function cropToFace(src, points) {
  const W = src.width, H = src.height;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x * W); x1 = Math.max(x1, p.x * W);
    y0 = Math.min(y0, p.y * H); y1 = Math.max(y1, p.y * H);
  }
  const side = Math.max(x1 - x0, y1 - y0) * 1.55;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 - (y1 - y0) * 0.06;
  const sx = cx - side / 2, sy = cy - side / 2;
  const out = paint(src, sx, sy, side);
  const landmarks = [];
  for (const p of points) {
    landmarks.push(
      round((p.x * W - sx) / side),
      round((p.y * H - sy) / side),
      round((p.z * W) / side),
    );
  }
  return { canvas: out, landmarks };
}

export function centreCrop(src) {
  const side = Math.min(src.width, src.height);
  return { canvas: paint(src, (src.width - side) / 2, Math.max(0, (src.height - side) * 0.3), side), landmarks: null };
}

function paint(src, sx, sy, side) {
  const c = document.createElement('canvas');
  c.width = c.height = CROP;
  const x = c.getContext('2d');
  x.fillStyle = '#111';
  x.fillRect(0, 0, CROP, CROP);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, sx, sy, side, side, 0, 0, CROP, CROP);
  return c;
}

const round = (v) => Math.round(v * 1e4) / 1e4;

export const toJpeg = (canvas) => canvas.toDataURL('image/jpeg', 0.88);

// Webcam capture. Resolves with a canvas, or rejects if the camera is unavailable.
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

// Draws the "scan" overlay: landmarks appearing top to bottom, then the mesh.
export function animateLandmarks(overlay, landmarks, lines, { color = '#86b8ff', duration = 1400 } = {}) {
  const ctx = overlay.getContext('2d');
  const S = overlay.width;
  const n = Math.min(468, landmarks.length / 3);
  const order = [...Array(n).keys()].sort((a, b) => landmarks[a * 3 + 1] - landmarks[b * 3 + 1]);
  const start = performance.now();
  return new Promise((resolve) => {
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      ctx.clearRect(0, 0, S, S);
      const shown = Math.floor(order.length * Math.min(1, p * 1.4));
      const vis = new Uint8Array(n);
      for (let i = 0; i < shown; i++) vis[order[i]] = 1;
      const lp = Math.max(0, (p - 0.35) / 0.65);
      if (lp > 0) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35 * lp;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < lines.length; i += 2) {
          const a = lines[i], b = lines[i + 1];
          if (a >= n || b >= n || !vis[a] || !vis[b]) continue;
          ctx.moveTo(landmarks[a * 3] * S, landmarks[a * 3 + 1] * S);
          ctx.lineTo(landmarks[b * 3] * S, landmarks[b * 3 + 1] * S);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      for (let i = 0; i < shown; i++) {
        const k = order[i];
        ctx.fillRect(landmarks[k * 3] * S - 1.2, landmarks[k * 3 + 1] * S - 1.2, 2.4, 2.4);
      }
      if (p < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}
