// Portrait → 3D Gaussian splats.
//
// Inputs: a square portrait crop, MediaPipe's 478 face landmarks (normalised to
// that crop) and a person-segmentation mask. We estimate a depth map: the face
// mesh where we have it, a fitted head ellipsoid for hair and ears, and a gently
// curved torso for neck and shoulders. Then we emit flattened gaussians lying on
// that surface: dense on the face, coarser elsewhere, like a real capture.
//
// Generation is deterministic (seeded), so every visitor sees the same splats.
import { TRIANGLES, HOLES, FACE_OVAL, VERT_COUNT, BASE_VERTS } from './face-topology.js';

const G = 448; // analysis grid resolution
export const GRID = G;
const DEPTH = 1.1; // MediaPipe depth reads slightly shallow on screen

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function imagePixels(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, w, h);
  return x.getImageData(0, 0, w, h).data;
}

// Separable box blur, applied twice ≈ gaussian.
function blur(src, r) {
  const a = Float32Array.from(src); // result (horizontal pass reads it, vertical pass writes it)
  const b = new Float32Array(src.length);
  const w = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < G; y++) {
      const row = y * G;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + clamp(x, 0, G - 1)];
      for (let x = 0; x < G; x++) {
        b[row + x] = acc / w;
        acc += a[row + clamp(x + r + 1, 0, G - 1)] - a[row + clamp(x - r, 0, G - 1)];
      }
    }
    for (let x = 0; x < G; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[clamp(y, 0, G - 1) * G + x];
      for (let y = 0; y < G; y++) {
        a[y * G + x] = acc / w;
        acc += b[clamp(y + r + 1, 0, G - 1) * G + x] - b[clamp(y - r, 0, G - 1) * G + x];
      }
    }
  }
  return a;
}

function bilinear(map, u, v) {
  const x = clamp(u * G - 0.5, 0, G - 1.001), y = clamp(v * G - 0.5, 0, G - 1.001);
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i = y0 * G + x0;
  return (map[i] * (1 - fx) + map[i + 1] * fx) * (1 - fy) + (map[i + G] * (1 - fx) + map[i + G + 1] * fx) * fy;
}

function samplePhoto(px, P, u, v, out) {
  const x = clamp(u * P - 0.5, 0, P - 1.001), y = clamp(v * P - 0.5, 0, P - 1.001);
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i00 = (y0 * P + x0) * 4, i10 = i00 + 4, i01 = i00 + P * 4, i11 = i01 + 4;
  for (let c = 0; c < 3; c++) {
    out[c] = (px[i00 + c] * (1 - fx) + px[i10 + c] * fx) * (1 - fy) + (px[i01 + c] * (1 - fx) + px[i11 + c] * fx) * fy;
  }
}

// Rasterise the face mesh into a depth buffer (z toward the camera is positive).
function rasterFace(L, zbuf) {
  const n = L.length / 3;
  const vx = new Float32Array(VERT_COUNT), vy = new Float32Array(VERT_COUNT), vz = new Float32Array(VERT_COUNT);
  for (let i = 0; i < BASE_VERTS; i++) {
    const k = i < n ? i : 0;
    vx[i] = L[k * 3] * G; vy[i] = L[k * 3 + 1] * G; vz[i] = -L[k * 3 + 2];
  }
  for (const h of HOLES) {
    let x = 0, y = 0, z = 0;
    for (const v of h.loop) { x += vx[v]; y += vy[v]; z += vz[v]; }
    x /= h.loop.length; y /= h.loop.length; z /= h.loop.length;
    if (h.iris != null && h.iris < n) { x = L[h.iris * 3] * G; y = L[h.iris * 3 + 1] * G; }
    vx[h.centre] = x; vy[h.centre] = y; vz[h.centre] = z;
  }
  for (let t = 0; t < TRIANGLES.length; t += 3) {
    const a = TRIANGLES[t], b = TRIANGLES[t + 1], c = TRIANGLES[t + 2];
    const ax = vx[a], ay = vy[a], bx = vx[b], by = vy[b], cx = vx[c], cy = vy[c];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(G - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(G - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const z = w0 * vz[a] + w1 * vz[b] + w2 * vz[c];
        const i = y * G + x;
        if (!(zbuf[i] >= z)) zbuf[i] = z;
      }
    }
  }
}

/**
 * @param {object} p
 * @param {Uint8ClampedArray} p.photo RGBA pixels of the square portrait
 * @param {number} p.photoSize side length of the portrait in pixels
 * @param {ArrayLike<number>|null} p.landmarks flat [x,y,z,…] normalised to the crop
 * @param {Float32Array|null} p.mask person confidence on a G×G grid (0..1)
 */
export function buildSplats({ photo, photoSize: P, landmarks: L, mask: maskIn }) {
  const N = G * G;
  const rand = rng(0x5eed);
  const hasFace = !!(L && L.length >= 468 * 3);

  // ---- head model, fitted to the face oval when we have landmarks
  let cx = 0.5, top = 0.3, chin = 0.62, W = 0.26;
  if (hasFace) {
    let mn = Infinity, mx = -Infinity;
    for (const i of FACE_OVAL) { mn = Math.min(mn, L[i * 3]); mx = Math.max(mx, L[i * 3]); }
    cx = (mn + mx) / 2; W = mx - mn;
    top = L[10 * 3 + 1]; chin = L[152 * 3 + 1];
  }
  const H = chin - top;
  const headTop = top - 0.4 * H, headBot = chin + 0.05 * H;
  const cy = (headTop + headBot) / 2, ry = (headBot - headTop) / 2, rx = 0.6 * W, rz = 1.15 * rx;
  const ell = (u, v) => ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2;
  let cz = 0;
  if (hasFace) {
    let s = 0;
    for (const i of FACE_OVAL) s += -L[i * 3 + 2] - rz * Math.sqrt(Math.max(0, 1 - ell(L[i * 3], L[i * 3 + 1])));
    cz = s / FACE_OVAL.length;
  }

  // ---- person mask (segmentation, or a head-and-shoulders silhouette)
  let mask = maskIn;
  if (!mask) {
    mask = new Float32Array(N);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const u = (i + 0.5) / G, v = (j + 0.5) / G;
      const head = 1 - smooth(0.85, 1.05, Math.sqrt(ell(u, v)));
      const half = v > chin ? Math.min(0.48, rx * 0.5 + ((v - chin) / H) * rx * 1.8) : 0;
      const body = v > chin ? 1 - smooth(half - 0.02, half + 0.02, Math.abs(u - cx)) : 0;
      mask[j * G + i] = Math.max(head, body);
    }
  }

  // ---- depth: face mesh, head ellipsoid, torso; blended and smoothed
  const zFace = new Float32Array(N).fill(NaN);
  if (hasFace) rasterFace(L, zFace);
  const faceMask = new Float32Array(N);
  const comp = new Float32Array(N);
  for (let j = 0; j < G; j++) {
    const v = (j + 0.5) / G;
    const bodyMix = smooth(cy, chin + 0.15 * H, v);
    for (let i = 0; i < G; i++) {
      const u = (i + 0.5) / G, k = j * G + i;
      const e = ell(u, v);
      const zh = cz + rz * Math.sqrt(Math.max(0, 1 - e));
      const d = (u - cx) / rx;
      const zb = cz + 0.38 * rz * Math.exp(-((d / 0.85) ** 2)) - 0.1 * rz * d * d;
      const outside = smooth(0.9, 1.2, Math.sqrt(e));
      comp[k] = zh * (1 - outside) + (cz * (1 - bodyMix) + zb * bodyMix) * outside;
      if (zFace[k] === zFace[k]) faceMask[k] = 1;
    }
  }
  // The face mesh and the head model never line up exactly. Spread their
  // difference outward from the face (normalised convolution) so forehead,
  // hairline, temples and jaw continue smoothly into the head and neck.
  const offset = new Float32Array(N);
  for (let k = 0; k < N; k++) if (faceMask[k]) offset[k] = zFace[k] - comp[k];
  const R = Math.round(G * 0.07);
  const wSum = blur(faceMask, R), oSum = blur(offset, R);
  for (let k = 0; k < N; k++) {
    if (faceMask[k]) { comp[k] = zFace[k]; continue; }
    if (wSum[k] > 1e-4) comp[k] += (oSum[k] / wSum[k]) * smooth(0, 0.3, wSum[k]);
  }
  const zSmooth = blur(comp, Math.round(G * 0.022));
  const feather = blur(faceMask, Math.round(G * 0.01));
  const detail = blur(faceMask, Math.round(G * 0.02));
  const Z = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const f = faceMask[k] ? clamp((feather[k] - 0.5) * 2.4, 0, 1) : 0;
    Z[k] = zSmooth[k] * (1 - f) + (f ? zFace[k] : 0) * f;
  }

  // ---- world transform: face height = 1 unit, pivot at the head centre
  const S = 1 / H;
  const pivotV = (top + chin) / 2;

  // ---- pass 1: count; pass 2: emit
  const fine = new Uint8Array(N);
  let count = 0;
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const k = j * G + i;
    if (mask[k] < 0.08) continue;
    if (detail[k] > 0.12) { fine[k] = 1; count += 2; } else if (!(i & 1) && !(j & 1)) { fine[k] = 2; count += 1; }
  }

  const center = new Float32Array(count * 4);
  const covA = new Float32Array(count * 4);
  const covB = new Float32Array(count * 4);
  const color = new Uint8Array(count * 4);
  const scale = new Float32Array(count * 3);
  const rot = new Float32Array(count * 4);
  const rgb = [0, 0, 0];
  const cell = (1 / G) * S;
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  let n = 0;

  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const k = j * G + i;
    const kind = fine[k];
    if (!kind) continue;
    const span = kind === 1 ? 1 : 2;
    const reps = kind === 1 ? 2 : 1;
    // Surface tangents for one sample step, in world units. Using them as the
    // splat's axes makes splats tile the surface: steep areas (nose, jaw, the
    // sides of the head) get stretched splats instead of gaps.
    const il = Math.max(0, i - 1), ir = Math.min(G - 1, i + 1), ju = Math.max(0, j - 1), jd = Math.min(G - 1, j + 1);
    const dzdu = (Z[j * G + ir] - Z[j * G + il]) / ((ir - il) / G);
    const dzdv = (Z[jd * G + i] - Z[ju * G + i]) / ((jd - ju) / G);
    const h = (span / G) * (kind === 1 ? Math.SQRT1_2 : 1); // sample spacing in crop units
    const eux = S * h, euz = DEPTH * S * dzdu * h; // step along u (euy = 0)
    const evy = -S * h, evz = DEPTH * S * dzdv * h; // step along v (evx = 0)
    let nx = -DEPTH * dzdu, ny = DEPTH * dzdv, nz = 1;
    const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
    const eul = Math.hypot(eux, euz);
    const t1x = eux / eul, t1y = 0, t1z = euz / eul;
    const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
    // e_v in the (t1, t2) basis, then the principal axes of e_u e_uᵀ + e_v e_vᵀ
    const p = evy * t1y + evz * t1z, q = evy * t2y + evz * t2z;
    const a11 = eul * eul + p * p, a12 = p * q, a22 = q * q;
    const th = 0.5 * Math.atan2(2 * a12, a11 - a22);
    const mid = 0.5 * (a11 + a22), rad = Math.hypot(0.5 * (a11 - a22), a12);
    const flat = S * h, maxAxis = 4 * flat;
    const ax1 = Math.min(Math.sqrt(mid + rad), maxAxis), ax2 = Math.min(Math.sqrt(Math.max(mid - rad, 1e-12)), maxAxis);
    const ct = Math.cos(th), st = Math.sin(th);
    const ux = ct * t1x + st * t2x, uy = ct * t1y + st * t2y, uz = ct * t1z + st * t2z;
    const wx = ny * uz - nz * uy, wy = nz * ux - nx * uz, wz = nx * uy - ny * ux;

    for (let r = 0; r < reps; r++) {
      // stratified jitter: fine cells get two samples on opposite diagonals
      const ox = kind === 1 ? (r ? 0.75 : 0.25) : 0.5, oy = kind === 1 ? (r ? 0.25 : 0.75) : 0.5;
      const u = (i + span * (ox + (rand() - 0.5) * 0.4)) / G, v = (j + span * (oy + (rand() - 0.5) * 0.4)) / G;
      const z = bilinear(Z, u, v);
      // fade the bust out towards the bottom and sides of the crop
      const edgeFade = (1 - smooth(0.84, 0.99, v)) * smooth(0, 0.04, u) * smooth(0, 0.04, 1 - u) * smooth(0, 0.03, v);
      const m = bilinear(mask, u, v) * edgeFade;
      if (m < 0.06) continue;
      // Edge decontamination: near the silhouette the photo still contains some
      // background, so take colour from a little further inside the person.
      let cu = u, cv = v;
      if (m < 0.97) {
        const e = 1.5 / G;
        const gx = bilinear(mask, u + e, v) - bilinear(mask, u - e, v), gy = bilinear(mask, u, v + e) - bilinear(mask, u, v - e);
        const gl = Math.hypot(gx, gy);
        if (gl > 1e-4) { cu += (gx / gl) * (3 / G); cv += (gy / gl) * (3 / G); }
      }
      samplePhoto(photo, P, cu, cv, rgb);

      // σ ≈ 0.8 × sample spacing keeps coverage solid with no see-through gaps
      // splats at the silhouette are a little larger and softer: the familiar splat edge
      const jit = (0.92 + 0.16 * rand()) * (1 + 0.5 * (1 - smooth(0.35, 0.9, m)));
      const s1 = 0.8 * ax1 * jit, s2 = 0.8 * ax2 * jit, s3 = 0.1 * flat;
      const a1 = s1 * s1, a2 = s2 * s2, a3 = s3 * s3;

      const X = (u - cx) * S, Y = -(v - pivotV) * S, Zw = (z - cz) * S * DEPTH;
      const o = n * 4;
      center[o] = X; center[o + 1] = Y; center[o + 2] = Zw;
      center[o + 3] = 0.97 * smooth(0.12, 0.7, m);
      covA[o] = a1 * ux * ux + a2 * wx * wx + a3 * nx * nx;
      covA[o + 1] = a1 * ux * uy + a2 * wx * wy + a3 * nx * ny;
      covA[o + 2] = a1 * ux * uz + a2 * wx * wz + a3 * nx * nz;
      covA[o + 3] = a1 * uy * uy + a2 * wy * wy + a3 * ny * ny;
      covB[o] = a1 * uy * uz + a2 * wy * wz + a3 * ny * nz;
      covB[o + 1] = a1 * uz * uz + a2 * wz * wz + a3 * nz * nz;
      covB[o + 2] = rand();
      covB[o + 3] = kind === 1 ? 0 : 1;
      color[o] = rgb[0]; color[o + 1] = rgb[1]; color[o + 2] = rgb[2]; color[o + 3] = 255;
      scale[n * 3] = s1; scale[n * 3 + 1] = s2; scale[n * 3 + 2] = s3;
      quatFromBasis(ux, uy, uz, wx, wy, wz, nx, ny, nz, rot, o);

      if (X < bounds.minX) bounds.minX = X; if (X > bounds.maxX) bounds.maxX = X;
      if (Y < bounds.minY) bounds.minY = Y; if (Y > bounds.maxY) bounds.maxY = Y;
      if (Zw < bounds.minZ) bounds.minZ = Zw; if (Zw > bounds.maxZ) bounds.maxZ = Zw;
      n++;
    }
  }

  return {
    count: n,
    center: center.subarray(0, n * 4), covA: covA.subarray(0, n * 4), covB: covB.subarray(0, n * 4),
    color: color.subarray(0, n * 4), scale: scale.subarray(0, n * 3), rot: rot.subarray(0, n * 4),
    bounds,
  };
}

// Rotation matrix with columns (a, b, c) → quaternion (w, x, y, z).
function quatFromBasis(m00, m10, m20, m01, m11, m21, m02, m12, m22, out, o) {
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  out[o] = w; out[o + 1] = x; out[o + 2] = y; out[o + 3] = z;
}

// Standard 32-byte-per-splat ".splat" file (position, scale, RGBA, rotation),
// readable by common Gaussian-splat viewers. Converted to their y-down,
// z-forward convention (180° about X).
export function toSplatFile(s) {
  const buf = new ArrayBuffer(s.count * 32);
  const f = new Float32Array(buf), u8 = new Uint8Array(buf);
  for (let i = 0; i < s.count; i++) {
    const o = i * 8, b = i * 32;
    f[o] = s.center[i * 4]; f[o + 1] = -s.center[i * 4 + 1]; f[o + 2] = -s.center[i * 4 + 2];
    f[o + 3] = s.scale[i * 3]; f[o + 4] = s.scale[i * 3 + 1]; f[o + 5] = s.scale[i * 3 + 2];
    u8[b + 24] = s.color[i * 4]; u8[b + 25] = s.color[i * 4 + 1]; u8[b + 26] = s.color[i * 4 + 2];
    u8[b + 27] = Math.round(255 * s.center[i * 4 + 3]);
    // q' = (1,0,0,0 as x-axis 180°) * q  →  (-x, w, -z, y)
    const w = s.rot[i * 4], x = s.rot[i * 4 + 1], y = s.rot[i * 4 + 2], z = s.rot[i * 4 + 3];
    const q = [-x, w, -z, y];
    for (let c = 0; c < 4; c++) u8[b + 28 + c] = clamp(Math.round(q[c] * 128 + 128), 0, 255);
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}
