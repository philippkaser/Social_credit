// Downloads MediaPipe's face landmarker model so the site can self-host it.
// Optional: if it is missing, the browser falls back to Google's CDN.
import fs from 'node:fs';
import path from 'node:path';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const dest = path.join(import.meta.dir, '..', 'models', 'face_landmarker.task');

const existing = Bun.file(dest);
if ((await existing.exists()) && existing.size > 1e6) {
  console.log('face model already present');
  process.exit(0);
}

try {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await Bun.write(tmp, res);
  fs.renameSync(tmp, dest);
  console.log('face model saved to models/');
} catch (e) {
  console.warn(`could not fetch face model (${e.message}); the browser will use the CDN copy`);
}
