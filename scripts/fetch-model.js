// Downloads the MediaPipe models so the site can self-host them:
//   face_landmarker.task     478-point face landmarks (3.7 MB)
//   selfie_segmenter.tflite  person segmentation (250 KB)
// Optional: anything missing is fetched by the browser from Google's CDN.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://storage.googleapis.com/mediapipe-models';
const MODELS = [
  ['face_landmarker.task', `${BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`, 1e6],
  ['selfie_segmenter.tflite', `${BASE}/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`, 1e5],
];
const dir = path.join(import.meta.dir, '..', 'models');
fs.mkdirSync(dir, { recursive: true });

for (const [name, url, minSize] of MODELS) {
  const dest = path.join(dir, name);
  const existing = Bun.file(dest);
  if ((await existing.exists()) && existing.size > minSize) {
    console.log(`${name} already present`);
    continue;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await Bun.write(`${dest}.part`, res);
    fs.renameSync(`${dest}.part`, dest);
    console.log(`${name} saved to models/`);
  } catch (e) {
    console.warn(`could not fetch ${name} (${e.message}); the browser will use the CDN copy`);
  }
}
