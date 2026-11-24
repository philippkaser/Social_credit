// Downloads MediaPipe's face landmarker model so the site can self-host it.
// Optional: if it is missing, the browser falls back to Google's CDN.
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const dest = path.join(__dirname, '..', 'models', 'face_landmarker.task');

if (fs.existsSync(dest) && fs.statSync(dest).size > 1e6) {
  console.log('face model already present');
  process.exit(0);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
const tmp = dest + '.part';
https.get(URL, (res) => {
  if (res.statusCode !== 200) {
    console.warn(`could not fetch face model (HTTP ${res.statusCode}); the browser will use the CDN copy`);
    res.resume();
    return;
  }
  const out = fs.createWriteStream(tmp);
  res.pipe(out);
  out.on('finish', () => { out.close(); fs.renameSync(tmp, dest); console.log('face model saved to models/'); });
}).on('error', (e) => console.warn(`could not fetch face model (${e.message}); the browser will use the CDN copy`));
