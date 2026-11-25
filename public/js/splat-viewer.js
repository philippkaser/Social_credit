// Gaussian-splat portrait viewer (WebGL2, Three.js).
//
// Each splat is a 3D gaussian (centre, covariance, colour, opacity). In the
// vertex shader we project its covariance to a screen-space ellipse (EWA
// splatting, as in 3D Gaussian Splatting), draw it as a quad and shade it with a
// gaussian falloff. Splats are depth-sorted back-to-front on the CPU whenever
// the view turns, then alpha-composited.
import * as THREE from 'three';
import { buildSplats, imagePixels, toSplatFile, GRID } from './splats.js';

THREE.ColorManagement.enabled = false; // portrait colours pass through untouched

const TEX_W = 2048;
const FOV = 24;

const VERT = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position;
in float splatIndex;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform highp sampler2D tCenter;
uniform highp sampler2D tCovA;
uniform highp sampler2D tCovB;
uniform highp sampler2D tColor;
uniform int uTexW;
uniform vec2 uViewport;
uniform float uFocal;
uniform float uReveal;
uniform float uSat;
out vec4 vColor;
out vec2 vPos;

void main() {
  int i = int(splatIndex + 0.5);
  ivec2 tc = ivec2(i % uTexW, i / uTexW);
  vec4 c = texelFetch(tCenter, tc, 0);
  vec4 ca = texelFetch(tCovA, tc, 0);
  vec4 cb = texelFetch(tCovB, tc, 0);
  vec4 col = texelFetch(tColor, tc, 0);

  // progressive load: coarse splats first, then the fine detail
  float t = cb.w > 0.5 ? cb.z * 0.4 : 0.25 + cb.z * 0.6;
  float f = smoothstep(t, t + 0.18, uReveal * 1.2);
  if (f <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  vec4 cam = modelViewMatrix * vec4(c.xyz, 1.0);
  vec4 clip = projectionMatrix * cam;
  float lim = 1.3 * clip.w;
  if (clip.w <= 0.0 || abs(clip.x) > lim || abs(clip.y) > lim) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  // EWA projection of the 3D covariance into screen space
  mat3 Vrk = mat3(ca.x, ca.y, ca.z, ca.y, ca.w, cb.x, ca.z, cb.x, cb.y);
  float z2 = cam.z * cam.z;
  mat3 J = mat3(
    uFocal / cam.z, 0.0, -(uFocal * cam.x) / z2,
    0.0, uFocal / cam.z, -(uFocal * cam.y) / z2,
    0.0, 0.0, 0.0);
  mat3 T = transpose(mat3(modelViewMatrix)) * J;
  mat3 cov2d = transpose(T) * Vrk * T;
  float a = cov2d[0][0] + 0.3;
  float b = cov2d[0][1];
  float d = cov2d[1][1] + 0.3;
  float mid = 0.5 * (a + d);
  float rad = length(vec2(0.5 * (a - d), b));
  float l1 = mid + rad;
  float l2 = max(mid - rad, 0.1);
  vec2 v1 = abs(b) > 1e-8 ? normalize(vec2(b, l1 - a)) : (a >= d ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 v2 = vec2(-v1.y, v1.x);
  float grow = mix(0.4, 1.0, f);
  vec2 major = min(3.0 * sqrt(l1), 1024.0) * grow * v1;
  vec2 minor = min(3.0 * sqrt(l2), 1024.0) * grow * v2;

  vPos = position.xy * 3.0; // in standard deviations
  float g = dot(col.rgb, vec3(0.299, 0.587, 0.114));
  vColor = vec4(mix(vec3(g), col.rgb, uSat), c.w * f);
  vec2 ndc = clip.xy / clip.w;
  gl_Position = vec4(ndc + (position.x * major + position.y * minor) * 2.0 / uViewport, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
in vec4 vColor;
in vec2 vPos;
out vec4 fragColor;
void main() {
  float r2 = dot(vPos, vPos);
  if (r2 > 9.0) discard;
  float a = vColor.a * exp(-0.5 * r2);
  if (a < 1.0 / 255.0) discard;
  fragColor = vec4(vColor.rgb * a, a); // premultiplied
}`;

const SATURATION = { C: 0.35, D: 0 };

function loadImage(src) {
  if (typeof src !== 'string') return Promise.resolve(src);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

async function loadLandmarks(mesh) {
  if (!mesh) return null;
  if (typeof mesh !== 'string') return mesh.landmarks || mesh;
  try {
    const r = await fetch(mesh);
    return r.ok ? (await r.json()).landmarks : null;
  } catch { return null; }
}

function dataTexture(src, float) {
  const rows = Math.max(1, Math.ceil(src.length / 4 / TEX_W));
  const arr = float ? new Float32Array(TEX_W * rows * 4) : new Uint8Array(TEX_W * rows * 4);
  arr.set(src);
  const t = new THREE.DataTexture(arr, TEX_W, rows, THREE.RGBAFormat, float ? THREE.FloatType : THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export class SplatViewer {
  constructor(container, { interactive = true } = {}) {
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'viewer-canvas';
    container.prepend(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.mv = new THREE.Matrix4();
    this.target = new THREE.Vector3();
    this.framing = { halfW: 1, halfH: 1.4, depth: 1 };

    this.uniforms = {
      tCenter: { value: null }, tCovA: { value: null }, tCovB: { value: null }, tColor: { value: null },
      uTexW: { value: TEX_W }, uViewport: { value: new THREE.Vector2(1, 1) }, uFocal: { value: 1 },
      uReveal: { value: 0 }, uSat: { value: 1 },
    };

    this.yaw = 0; this.pitch = 0; this.tYaw = 0; this.tPitch = 0;
    this.dragging = false; this.lastInteract = -1e9;
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.visible = true;
    this.t0 = performance.now();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; this.kick(); });
    this.io.observe(container);
    this.onVis = () => this.kick();
    document.addEventListener('visibilitychange', this.onVis);
    if (interactive) this.bindPointer();
    this.resize();
  }

  bindPointer() {
    const c = this.canvas;
    c.style.touchAction = 'pan-y';
    let lx = 0, ly = 0;
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true; lx = e.clientX; ly = e.clientY;
      c.setPointerCapture(e.pointerId);
      this.el.classList.add('grabbing', 'touched');
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.tYaw = THREE.MathUtils.clamp(this.tYaw + (e.clientX - lx) * 0.006, -0.6, 0.6);
      this.tPitch = THREE.MathUtils.clamp(this.tPitch + (e.clientY - ly) * 0.004, -0.25, 0.25);
      lx = e.clientX; ly = e.clientY;
      this.lastInteract = performance.now();
    });
    const up = () => { this.dragging = false; this.el.classList.remove('grabbing'); this.lastInteract = performance.now(); };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  /** Builds and shows the splats. Resolves with the splat count. */
  async show({ portrait, mesh, mask, tier }) {
    const token = (this.token = Symbol('subject'));
    const [img, landmarks, maskImg] = await Promise.all([
      loadImage(portrait),
      loadLandmarks(mesh),
      mask ? loadImage(mask).catch(() => null) : null,
    ]);
    if (token !== this.token || this.disposed) return 0;

    const P = Math.min(1024, img.naturalWidth || img.width);
    const photo = imagePixels(img, P, P);
    let maskGrid = null;
    if (maskImg) {
      const px = imagePixels(maskImg, GRID, GRID);
      maskGrid = new Float32Array(GRID * GRID);
      for (let i = 0; i < maskGrid.length; i++) maskGrid[i] = px[i * 4] / 255;
    }
    const s = buildSplats({ photo, photoSize: P, landmarks, mask: maskGrid });
    this.data = s;
    this.setSubject(s);
    this.uniforms.uSat.value = SATURATION[tier] ?? 1;
    this.revealStart = this.reduceMotion ? performance.now() - 1e6 : performance.now();
    this.kick();
    return s.count;
  }

  setTier(tier) {
    this.uniforms.uSat.value = SATURATION[tier] ?? 1;
  }

  setSubject(s) {
    this.clearSubject();
    const u = this.uniforms;
    u.tCenter.value = dataTexture(s.center, true);
    u.tCovA.value = dataTexture(s.covA, true);
    u.tCovB.value = dataTexture(s.covB, true);
    u.tColor.value = dataTexture(s.color, false);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.order = new Float32Array(s.count);
    this.indexAttr = new THREE.InstancedBufferAttribute(this.order, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('splatIndex', this.indexAttr);
    g.instanceCount = s.count;

    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: u,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);

    // sort scratch space
    this.depths = new Float32Array(s.count);
    this.keys = new Uint16Array(s.count);
    this.counts = new Uint32Array(65536);
    this.lastDir = null;

    const b = s.bounds;
    this.target.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0);
    this.framing = { halfW: (b.maxX - b.minX) / 2, halfH: (b.maxY - b.minY) / 2, depth: b.maxZ };
    this.frame();
  }

  frame() {
    const aspect = this.camera.aspect;
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const { halfW, halfH, depth } = this.framing;
    const dist = Math.max(halfH / tan, halfW / (tan * aspect)) * 1.08 + depth;
    this.camera.position.set(this.target.x, this.target.y, dist);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  // Back-to-front order via a 16-bit counting sort on view-space depth.
  sort() {
    const e = this.mv.elements;
    const dx = e[2], dy = e[6], dz = e[10];
    const L = this.lastDir;
    if (L && Math.abs(dx - L[0]) + Math.abs(dy - L[1]) + Math.abs(dz - L[2]) < 0.002) return;
    this.lastDir = [dx, dy, dz];
    const c = this.data.center, n = this.data.count;
    const depths = this.depths, keys = this.keys, counts = this.counts, order = this.order;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = dx * c[i * 4] + dy * c[i * 4 + 1] + dz * c[i * 4 + 2];
      depths[i] = d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const k = 65535 / (max - min || 1);
    counts.fill(0);
    for (let i = 0; i < n; i++) { const key = ((depths[i] - min) * k) | 0; keys[i] = key; counts[key]++; }
    let sum = 0;
    for (let i = 0; i < 65536; i++) { const t = counts[i]; counts[i] = sum; sum += t; }
    for (let i = 0; i < n; i++) order[counts[keys[i]]++] = i; // most negative (farthest) first
    this.indexAttr.needsUpdate = true;
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.uniforms.uViewport.value.set(w * pr, h * pr);
    this.uniforms.uFocal.value = (h * pr) / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    this.frame();
    this.kick();
  }

  kick() {
    if (this.visible && !document.hidden && !this.disposed && !this.running) {
      this.running = true;
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
  }

  tick(now) {
    if (!this.visible || document.hidden || this.disposed) { this.running = false; return; }
    const t = (now - this.t0) / 1000;
    const dt = Math.min(0.25, (now - (this.lastTick ?? now)) / 1000);
    this.lastTick = now;
    if (this.revealStart != null) this.uniforms.uReveal.value = Math.min(1, (now - this.revealStart) / 1600);
    if (!this.dragging && now - this.lastInteract > 2500 && !this.reduceMotion) {
      this.tYaw = Math.sin(t * 0.32) * 0.32;
      this.tPitch = Math.sin(t * 0.23) * 0.04;
    }
    const ease = 1 - Math.exp(-dt * 4); // frame-rate independent smoothing
    this.yaw += (this.tYaw - this.yaw) * ease;
    this.pitch += (this.tPitch - this.pitch) * ease;
    this.root.rotation.set(this.pitch, this.yaw, 0);
    if (this.mesh) {
      this.root.updateMatrixWorld();
      this.mv.multiplyMatrices(this.camera.matrixWorldInverse, this.mesh.matrixWorld);
      this.sort();
    }
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame((tt) => this.tick(tt));
  }

  /** The current splats as a standard .splat file. */
  splatFile() {
    return this.data ? toSplatFile(this.data) : null;
  }

  clearSubject() {
    if (!this.mesh) return;
    this.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    for (const k of ['tCenter', 'tCovA', 'tCovB', 'tColor']) { this.uniforms[k].value?.dispose(); this.uniforms[k].value = null; }
    this.mesh = null;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
    document.removeEventListener('visibilitychange', this.onVis);
    this.clearSubject();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
