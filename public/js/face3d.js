// Holographic 3D face renderer.
//
// Given a square photo crop and the 478 MediaPipe landmarks normalised to that
// crop, we build the canonical face mesh (904 triangles, eyes and mouth filled),
// texture it with the photo and light it, so a flat portrait becomes a face you
// can turn. Without landmarks we fall back to a sculpted relief.
//
// The look changes with the subject's standing: gold halo for the elite, cool
// hologram for ordinary citizens, colour drained and glitching for the disgraced.
import * as THREE from 'three';
import { TRIANGLES, LINES, EDGE_HOPS, HOLES, VERT_COUNT, BASE_VERTS } from './face-topology.js';

THREE.ColorManagement.enabled = false; // treat every colour as raw display RGB

const LOOKS = {
  CREATOR: { line: 0xf6d78b, sat: 1.05, halo: 0xf3c969, motes: 0xffe2a0, rim: 0xffd27a, glitch: 0, flicker: 0 },
  AAA: { line: 0xe8c46a, sat: 1, halo: 0xe8c46a, motes: 0xf5d68a, rim: 0xf0c060, glitch: 0, flicker: 0 },
  AA: { line: 0x63e2b4, sat: 1, rim: 0x63e2b4, glitch: 0, flicker: 0 },
  A: { line: 0x86b8ff, sat: 1, rim: 0x86b8ff, glitch: 0, flicker: 0 },
  B: { line: 0xffb54d, sat: 0.8, rim: 0xffb54d, glitch: 0, flicker: 0 },
  C: { line: 0xa3a8b0, sat: 0.12, rim: 0xa3a8b0, glitch: 0.15, flicker: 0.5 },
  D: { line: 0xff4d3d, sat: 0.3, rim: 0xff4d3d, motes: 0xff5a3c, glitch: 1, flicker: 0.8 },
};

const DEPTH = 1.15; // exaggerate MediaPipe depth slightly; reads better on screen

const FACE_VS = /* glsl */ `
  attribute float edge;
  uniform float uTime, uGlitch, uReveal;
  varying vec2 vUv; varying vec3 vN; varying vec3 vP; varying float vEdge;
  float hash(float n){ return fract(sin(n)*43758.5453123); }
  void main(){
    vUv = uv; vEdge = edge; vP = position;
    vec3 p = position;
    if (uGlitch > 0.0) {
      float slice = floor(p.y * 16.0);
      float t = floor(uTime * 7.0);
      float on = step(1.0 - 0.18 * uGlitch, hash(slice + t * 13.1));
      p.x += on * (hash(slice * 7.0 + t) - 0.5) * 0.22 * uGlitch;
    }
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

const FACE_FS = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uRim, uPulseColor;
  uniform float uTime, uSat, uScanY, uPulse, uGlitch, uFlicker, uReveal;
  varying vec2 vUv; varying vec3 vN; varying vec3 vP; varying float vEdge;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
  void main(){
    vec3 col = texture2D(uMap, vUv).rgb;
    if (uGlitch > 0.0) {
      float shift = 0.006 * uGlitch * (0.5 + 0.5 * sin(uTime * 23.0));
      col.r = texture2D(uMap, vUv + vec2(shift, 0.0)).r;
      col.b = texture2D(uMap, vUv - vec2(shift, 0.0)).b;
    }
    float g = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(g), col, uSat);
    vec3 n = normalize(vN);
    vec3 L = normalize(vec3(-0.45, 0.55, 0.9));
    float diff = max(dot(n, L), 0.0);
    col *= 0.62 + 0.55 * diff;
    float facing = clamp(n.z, 0.0, 1.0);
    col += uRim * pow(1.0 - facing, 2.2) * 0.55;
    float scan = 1.0 - smoothstep(0.0, 0.05, abs(vP.y - uScanY));
    col += uRim * scan * 0.2;
    col *= 0.95 + 0.05 * sin(gl_FragCoord.y * 1.4);
    col = mix(col, uPulseColor, uPulse * 0.45 * (0.55 + 0.45 * sin(vP.y * 28.0 - uTime * 18.0)));
    float a = smoothstep(0.0, 1.0, vEdge);
    if (uFlicker > 0.0) a *= 1.0 - uFlicker * 0.35 * step(0.93, hash(vec2(floor(uTime * 12.0), 1.0)));
    float revealLine = mix(1.3, -1.6, uReveal);
    a *= smoothstep(revealLine, revealLine + 0.25, vP.y);
    a = clamp(a, 0.0, 1.0);
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, a);
  }`;

const LINE_VS = /* glsl */ `
  attribute float edge;
  uniform float uTime, uScanY, uGlitch;
  varying float vA;
  void main(){
    vec3 p = position + normal * 0.004;
    float scan = 1.0 - smoothstep(0.0, 0.22, abs(p.y - uScanY));
    vA = (0.12 + 0.5 * scan) * edge;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;
const LINE_FS = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity, uReveal;
  varying float vA;
  void main(){ gl_FragColor = vec4(uColor, vA * uOpacity * uReveal); }`;

const POINT_VS = /* glsl */ `
  attribute float edge;
  uniform float uScanY, uSize, uReveal;
  varying float vA;
  void main(){
    vec3 p = position + normal * 0.006;
    float scan = 1.0 - smoothstep(0.0, 0.18, abs(p.y - uScanY));
    float revealLine = mix(1.4, -1.4, min(uReveal * 1.6, 1.0));
    float shown = step(revealLine, p.y);
    vA = (0.25 + 0.75 * scan) * shown * max(edge, 0.35);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (1.0 + scan * 1.2) * (4.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const POINT_FS = /* glsl */ `
  uniform vec3 uColor; uniform float uOpacity;
  varying float vA;
  void main(){
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    gl_FragColor = vec4(uColor, (1.0 - smoothstep(0.0, 0.5, d)) * vA * uOpacity);
  }`;

const MOTE_VS = /* glsl */ `
  attribute float seed;
  uniform float uTime, uRise;
  varying float vA;
  void main(){
    vec3 p = position;
    float t = fract(seed + uTime * 0.035 * (0.6 + seed));
    p.y = mix(-1.5, 1.8, t) * uRise + p.y * (1.0 - uRise);
    p.x += sin(uTime * 0.5 + seed * 30.0) * 0.08;
    vA = sin(t * 3.14159) * (0.35 + 0.65 * fract(seed * 7.3));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (2.0 + 4.0 * fract(seed * 3.7)) * (4.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;

function faceGeometryFromLandmarks(L) {
  const n = Math.floor(L.length / 3);
  const pos = new Float32Array(VERT_COUNT * 3);
  const uv = new Float32Array(VERT_COUNT * 2);
  const edge = new Float32Array(VERT_COUNT);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sz = 0;
  for (let i = 0; i < 468; i++) {
    const x = L[i * 3], y = L[i * 3 + 1];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    sz += L[i * 3 + 2];
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = sz / 468;
  const s = 2.1 / Math.max(maxY - minY, (maxX - minX) * 1.15);

  const put = (i, x, y, z) => {
    pos[i * 3] = (x - cx) * s;
    pos[i * 3 + 1] = -(y - cy) * s;
    pos[i * 3 + 2] = -(z - cz) * s * DEPTH;
    uv[i * 2] = x;
    uv[i * 2 + 1] = 1 - y;
  };
  for (let i = 0; i < BASE_VERTS; i++) {
    if (i < n) put(i, L[i * 3], L[i * 3 + 1], L[i * 3 + 2]);
    else put(i, cx, cy, cz);
  }
  for (const h of HOLES) {
    let x = 0, y = 0, z = 0;
    for (const v of h.loop) { x += L[v * 3]; y += L[v * 3 + 1]; z += L[v * 3 + 2]; }
    x /= h.loop.length; y /= h.loop.length; z /= h.loop.length;
    if (h.iris != null && h.iris < n) { x = L[h.iris * 3]; y = L[h.iris * 3 + 1]; }
    put(h.centre, x, y, z);
  }
  for (let i = 0; i < VERT_COUNT; i++) edge[i] = Math.min(EDGE_HOPS[i] / 3, 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
  let index = TRIANGLES.slice();
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  // Make sure normals face the camera (+z); flip winding if the mesh came in inside-out.
  const nrm = g.getAttribute('normal');
  let nz = 0;
  for (let i = 0; i < 468; i++) nz += nrm.getZ(i);
  if (nz < 0) {
    for (let i = 0; i < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeVertexNormals();
  }
  return { geometry: g, lines: LINES, pointCount: 468 };
}

// A sculpted relief for photos without landmarks (or no photo at all).
function reliefGeometry() {
  const seg = 72;
  const g = new THREE.PlaneGeometry(2, 2, seg, seg);
  const p = g.getAttribute('position');
  const edge = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    const dx = x / 0.66, dy = (y - 0.02) / 0.86;
    const r = Math.sqrt(dx * dx + dy * dy);
    let z = r < 1 ? 0.42 * Math.sqrt(1 - r * r) : 0;
    z += 0.12 * Math.exp(-((x / 0.11) ** 2 + ((y + 0.04) / 0.22) ** 2));
    z -= 0.05 * Math.exp(-(((Math.abs(x) - 0.24) / 0.12) ** 2 + ((y - 0.12) / 0.07) ** 2));
    p.setZ(i, z);
    edge[i] = 1 - THREE.MathUtils.smoothstep(r, 0.72, 1.02);
  }
  g.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
  g.computeVertexNormals();
  // wireframe: every other grid line, so it reads as a contour map
  const lines = [];
  const row = seg + 1;
  for (let j = 0; j <= seg; j += 3) for (let i = 0; i < seg; i++) lines.push(j * row + i, j * row + i + 1);
  for (let i = 0; i <= seg; i += 3) for (let j = 0; j < seg; j++) lines.push(j * row + i, (j + 1) * row + i);
  return { geometry: g, lines: new Uint32Array(lines), pointCount: 0 };
}

function placeholderTexture(name, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  const grd = x.createRadialGradient(256, 220, 30, 256, 256, 330);
  grd.addColorStop(0, '#3a3d46');
  grd.addColorStop(1, '#111216');
  x.fillStyle = grd;
  x.fillRect(0, 0, 512, 512);
  x.fillStyle = color;
  x.globalAlpha = 0.9;
  x.font = 'italic 200px "Instrument Serif", Georgia, serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const ini = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  x.fillText(ini, 256, 270);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, (t) => { t.anisotropy = 8; t.generateMipmaps = true; resolve(t); }, undefined, reject);
  });
}

export class FaceViewer {
  constructor(container, { interactive = true } = {}) {
    this.el = container;
    this.interactive = interactive;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'viewer-canvas';
    container.prepend(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    this.camera.position.set(0, 0.12, 6);
    this.camera.lookAt(0, 0.12, 0);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.u = {
      uTime: { value: 0 }, uScanY: { value: 2 }, uReveal: { value: 0 },
      uPulse: { value: 0 }, uPulseColor: { value: new THREE.Color(0x3ddc97) },
      uGlitch: { value: 0 }, uFlicker: { value: 0 }, uSat: { value: 1 },
      uRim: { value: new THREE.Color(0x86b8ff) },
    };
    this.yaw = 0; this.pitch = 0; this.tYaw = 0; this.tPitch = 0;
    this.dragging = false; this.lastInteract = -1e9;
    this.disposables = [];
    this.running = false;
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
    this.addOrbits();
  }

  bindPointer() {
    const c = this.canvas;
    c.style.touchAction = 'pan-y';
    let lx = 0, ly = 0;
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true; lx = e.clientX; ly = e.clientY;
      c.setPointerCapture(e.pointerId);
      this.el.classList.add('grabbing');
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.tYaw = THREE.MathUtils.clamp(this.tYaw + (e.clientX - lx) * 0.009, -1.1, 1.1);
      this.tPitch = THREE.MathUtils.clamp(this.tPitch + (e.clientY - ly) * 0.006, -0.5, 0.5);
      lx = e.clientX; ly = e.clientY;
      this.lastInteract = performance.now();
    });
    const up = () => { this.dragging = false; this.el.classList.remove('grabbing'); this.lastInteract = performance.now(); };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  addOrbits() {
    // Two faint gantry rings orbiting the subject.
    const mk = (r, tilt) => {
      const pts = [];
      for (let i = 0; i <= 160; i++) { const a = (i / 160) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const m = new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, dashSize: 0.05, gapSize: 0.06, depthWrite: false });
      const l = new THREE.Line(g, m);
      l.computeLineDistances();
      l.rotation.x = tilt;
      this.disposables.push(g, m);
      return l;
    };
    this.orbits = new THREE.Group();
    this.orbits.add(mk(1.55, 0.18), mk(1.75, -0.12));
    this.orbits.position.y = -0.15;
    this.scene.add(this.orbits);
  }

  async show({ photo, mesh, tier = 'A', name = '' }) {
    this.clearSubject();
    const look = LOOKS[tier] || LOOKS.A;
    this.look = look;
    const token = (this.token = Symbol('subject'));

    let landmarks = null;
    if (mesh) {
      try {
        const data = typeof mesh === 'string' ? await (await fetch(mesh)).json() : mesh;
        landmarks = data.landmarks || data;
      } catch { landmarks = null; }
    }
    let map;
    try { map = photo ? await loadTexture(photo) : placeholderTexture(name, `#${new THREE.Color(look.line).getHexString()}`); }
    catch { map = placeholderTexture(name, '#888'); }
    if (token !== this.token) { map.dispose(); return; }

    const built = landmarks && landmarks.length >= 468 * 3 ? faceGeometryFromLandmarks(landmarks) : reliefGeometry();
    this.mode = landmarks ? 'mesh' : 'relief';
    const u = this.u;
    u.uRim.value.setHex(look.rim);
    u.uSat.value = look.sat;
    u.uGlitch.value = look.glitch;
    u.uFlicker.value = look.flicker;
    u.uReveal.value = 0;
    this.revealStart = performance.now();

    const subject = new THREE.Group();
    const faceMat = new THREE.ShaderMaterial({
      uniforms: { ...u, uMap: { value: map } },
      vertexShader: FACE_VS, fragmentShader: FACE_FS,
      transparent: true, side: THREE.DoubleSide,
    });
    const face = new THREE.Mesh(built.geometry, faceMat);
    subject.add(face);

    const lineGeo = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'edge']) lineGeo.setAttribute(k, built.geometry.getAttribute(k));
    lineGeo.setIndex(new THREE.BufferAttribute(built.lines, 1));
    const lineMat = new THREE.ShaderMaterial({
      uniforms: { uTime: u.uTime, uScanY: u.uScanY, uGlitch: u.uGlitch, uReveal: u.uReveal, uColor: { value: new THREE.Color(look.line) }, uOpacity: { value: this.mode === 'mesh' ? 0.9 : 0.5 } },
      vertexShader: LINE_VS, fragmentShader: LINE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    subject.add(new THREE.LineSegments(lineGeo, lineMat));
    this.disposables.push(lineGeo, lineMat);

    if (built.pointCount) {
      const pg = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'edge']) pg.setAttribute(k, built.geometry.getAttribute(k));
      pg.setDrawRange(0, built.pointCount);
      const pm = new THREE.ShaderMaterial({
        uniforms: { uScanY: u.uScanY, uReveal: u.uReveal, uSize: { value: 3.2 * this.renderer.getPixelRatio() }, uColor: { value: new THREE.Color(look.line) }, uOpacity: { value: 0.9 } },
        vertexShader: POINT_VS, fragmentShader: POINT_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      subject.add(new THREE.Points(pg, pm));
      this.disposables.push(pg, pm);
    }

    if (look.halo) {
      const hg = new THREE.TorusGeometry(0.54, 0.012, 12, 160);
      const hm = new THREE.MeshBasicMaterial({ color: look.halo, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
      const halo = new THREE.Mesh(hg, hm);
      const gg = new THREE.TorusGeometry(0.54, 0.05, 12, 160);
      const gm = new THREE.MeshBasicMaterial({ color: look.halo, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false });
      halo.add(new THREE.Mesh(gg, gm));
      halo.position.set(0, 1.2, -0.3);
      halo.rotation.x = Math.PI / 2.35;
      this.halo = halo;
      subject.add(halo);
      this.disposables.push(hg, hm, gg, gm);
    }

    if (look.motes) {
      const N = 140;
      const mp = new Float32Array(N * 3), seed = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2, r = 0.9 + Math.random() * 0.9;
        mp[i * 3] = Math.cos(a) * r; mp[i * 3 + 1] = Math.random() * 3 - 1.5; mp[i * 3 + 2] = Math.sin(a) * r * 0.6 - 0.2;
        seed[i] = Math.random();
      }
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
      mg.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
      const mm = new THREE.ShaderMaterial({
        uniforms: { uTime: u.uTime, uRise: { value: 1 }, uColor: { value: new THREE.Color(look.motes) }, uOpacity: { value: 0.8 } },
        vertexShader: MOTE_VS, fragmentShader: POINT_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      this.scene.add((this.motes = new THREE.Points(mg, mm)));
      this.disposables.push(mg, mm);
    }

    this.disposables.push(built.geometry, faceMat, map);
    this.subject = subject;
    this.root.add(subject);
    this.orbits.children.forEach((l) => l.material.color.setHex(look.line));
    this.el.dataset.mode = this.mode;
    this.kick();
  }

  pulse(positive) {
    this.u.uPulseColor.value.setHex(positive ? 0x3ddc97 : 0xff4d3d);
    this.pulseStart = performance.now();
    this.kick();
  }

  clearSubject() {
    if (this.subject) this.root.remove(this.subject);
    if (this.motes) this.scene.remove(this.motes);
    this.subject = null; this.motes = null; this.halo = null;
    // keep orbit resources (first 4 disposables); release the rest
    const keep = this.disposables.splice(0, 4);
    for (const d of this.disposables) d.dispose?.();
    this.disposables = keep;
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the face comfortably framed in tall and wide boxes alike
    const aspect = w / h;
    this.camera.position.z = aspect < 0.8 ? (6 * 0.8) / Math.max(aspect, 0.5) : 6;
    this.camera.updateProjectionMatrix();
    this.kick();
  }

  kick() {
    const should = this.visible && !document.hidden && !this.disposed;
    if (should && !this.running) {
      this.running = true;
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  frame(now) {
    if (!this.visible || document.hidden || this.disposed) { this.running = false; return; }
    const t = (now - this.t0) / 1000;
    const u = this.u;
    u.uTime.value = t;
    // scan sweeps top → bottom every 4.5s
    const cyc = (t % 4.5) / 4.5;
    u.uScanY.value = 1.5 - cyc * 3.4;
    if (this.revealStart != null) {
      const p = Math.min(1, (now - this.revealStart) / 1800);
      u.uReveal.value = 1 - Math.pow(1 - p, 3);
    }
    if (this.pulseStart != null) {
      const p = (now - this.pulseStart) / 1400;
      u.uPulse.value = p < 1 ? Math.sin(p * Math.PI) : 0;
    }
    const idle = !this.dragging && now - this.lastInteract > 2500;
    if (idle) {
      const k = this.look === LOOKS.CREATOR ? 0.28 : 0.42;
      this.tYaw = Math.sin(t * k) * 0.5;
      this.tPitch = Math.sin(t * 0.31) * 0.07 - 0.03;
    }
    this.yaw += (this.tYaw - this.yaw) * 0.07;
    this.pitch += (this.tPitch - this.pitch) * 0.07;
    this.root.rotation.set(this.pitch, this.yaw, 0);
    this.root.position.y = Math.sin(t * 0.8) * 0.025;
    if (this.halo) this.halo.rotation.z = t * 0.4;
    this.orbits.rotation.y = t * 0.12;
    this.orbits.children[1].rotation.y = -t * 0.2;
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame((tt) => this.frame(tt));
  }

  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
    document.removeEventListener('visibilitychange', this.onVis);
    this.clearSubject();
    for (const d of this.disposables) d.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
