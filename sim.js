// Flight Sim — everything except the markup and styles (see index.html).
// Loaded as a classic script after vendor/three.min.js, which provides the global THREE; classic
// rather than an ES module so the page also runs when opened straight from disk.
'use strict';

const { clamp, smoothstep, damp, lerp } = THREE.MathUtils;
const approach = (a, b, step) => (a < b ? Math.min(a + step, b) : Math.max(a - step, b));
const D2R = Math.PI / 180, TAU = Math.PI * 2;
const HPA_PER_INHG = 33.8639;

// ---------- renderer / scene ----------
// Log depth keeps thin decals (runway paint) and the runway itself from z-fighting at distance.
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// sky / fog palette: set from the time of day (see TIMES below)
const HORIZON = new THREE.Color(0xbcd6ec), SKY_TOP = new THREE.Color(0x2f6fc4);
const HAZE = new THREE.Color(0xa9b2ba), OVC_BELOW = new THREE.Color(0x8e959d), IN_CLOUD = new THREE.Color(0xc9ced3);
scene.fog = new THREE.Fog(HORIZON.clone(), 900, 9000);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.3, 30000);

const sunDir = new THREE.Vector3(-0.5, 0.75, -0.35).normalize();
const hemi = new THREE.HemisphereLight(0xd5e9ff, 0x5a6b3a, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 600 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.04; // keeps a low dusk sun from speckling the ground with self-shadow
scene.add(sun, sun.target);

// ---------- sky dome ----------
const skyUniforms = {
  top: { value: SKY_TOP.clone() }, horizon: { value: HORIZON.clone() }, sunDir: { value: sunDir }, sunAmt: { value: 1 },
  discCol: { value: new THREE.Color(1, 0.9, 0.7) }, glow: { value: 0.25 },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(20000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyUniforms,
    vertexShader: `varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform float sunAmt;
      uniform vec3 discCol; uniform float glow; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = mix(horizon, top, pow(clamp(d.y, 0.0, 1.0), 0.55));
        float s = max(dot(d, sunDir), 0.0);
        // disc + halo, plus a broad low glow towards the sun at dusk
        c += sunAmt * discCol * (pow(s, 700.0) * 3.0 + pow(s, 10.0) * glow + pow(s, 3.0) * glow * 0.35 * (1.0 - abs(d.y)));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
);
sky.renderOrder = -1;
scene.add(sky);
// stars: fixed points on the dome (which follows the camera), faded in at night
const stars = (() => {
  const n = 1800, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let seed = 99;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) {
    const y = rnd() * 1.05 - 0.05, a = rnd() * TAU, r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * r * 15000, y * 15000, Math.sin(a) * r * 15000], i * 3);
    const b = 0.25 + rnd() ** 3 * 0.75, tint = rnd();
    col.set([b * (tint < 0.15 ? 1 : 0.85), b * 0.9, b * (tint > 0.85 ? 1 : 0.85)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false,
  }));
  pts.frustumCulled = false;
  sky.add(pts);
  return pts;
})();

// ---------- noise ----------
function hash(ix, iy) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, oct) {
  let s = 0, amp = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += amp * noise(x * f, y * f); n += amp; amp *= 0.5; f *= 2.03; }
  return s / n;
}

// ---------- terrain ----------
const SIZE = 16000, SEG = 400, CELL = SIZE / SEG, HALF = SIZE / 2;
const RWY_HW = 25, RWY_HL = 650; // runway half width / half length
const OFF = 137.31;

function rawHeight(x, z) {
  const b = fbm(x / 2600 + OFF, z / 2600 + OFF, 6);
  let h = Math.pow(b, 2.2) * 1700 - 160;
  h += (fbm(x / 350 - OFF, z / 350, 3) - 0.5) * 40;
  const d = Math.max(Math.abs(x), Math.abs(z)) / HALF;     // island falloff
  const f = 1 - smoothstep(d, 0.75, 0.97);
  return h * f - 60 * (1 - f);
}
const RH = clamp(rawHeight(0, 0), 20, 150); // runway elevation
const rwyDist = (x, z) => Math.hypot(Math.max(Math.abs(x) - RWY_HW - 35, 0), Math.max(Math.abs(z) - RWY_HL - 50, 0));
// apron + hangars east of the runway
const APRON = { x0: 35, x1: 112, z0: -175, z1: 45 };
const apronDist = (x, z) => Math.hypot(Math.max(APRON.x0 - x, x - APRON.x1, 0), Math.max(APRON.z0 - z, z - APRON.z1, 0));
function terrainHeight(x, z) {
  // graded strip and apron are exactly runway height; beyond them the airfield rolls gently (a few
  // metres) before blending into the natural terrain
  const flat = Math.min(rwyDist(x, z), apronDist(x, z));
  const roll = (fbm(x / 260 + 11, z / 260 - 7, 3) - 0.5) * 14 * smoothstep(flat, 0, 120);
  let h = RH + roll + (rawHeight(x, z) - RH - roll) * smoothstep(flat, 250, 900);
  // approach corridors: off both runway ends the terrain is kept well under the 3° glide path
  const beyond = Math.abs(z) - RWY_HL;
  if (beyond > 0) {
    const cap = RH - 30 + (beyond + 300) * Math.tan(3 * D2R) - fbm(x / 500, z / 500, 3) * 40;
    const half = 350 + beyond * 0.15;                            // corridor widens with distance
    const inside = 1 - smoothstep(Math.abs(x), half, half + 700);
    const ramp = smoothstep(beyond, 0, 200);
    if (h > cap) h = lerp(h, cap, inside * ramp);
  }
  return h;
}

const heights = new Float32Array((SEG + 1) * (SEG + 1));
for (let iy = 0; iy <= SEG; iy++)
  for (let ix = 0; ix <= SEG; ix++)
    heights[iy * (SEG + 1) + ix] = terrainHeight(-HALF + ix * CELL, -HALF + iy * CELL);

// Exact height of the rendered mesh (same triangulation as PlaneGeometry).
function groundHeight(x, z) {
  const gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
  if (gx < 0 || gz < 0 || gx >= SEG || gz >= SEG) return -60;
  const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
  const W = SEG + 1;
  const ha = heights[iz * W + ix], hd = heights[iz * W + ix + 1];
  const hb = heights[(iz + 1) * W + ix], hc = heights[(iz + 1) * W + ix + 1];
  if (fx + fz <= 1) return ha + (hd - ha) * fx + (hb - ha) * fz;
  return hc + (hb - hc) * (1 - fx) + (hd - hc) * (1 - fz);
}

{
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heights[i]);
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const C = (h) => new THREE.Color(h);
  const sand = C(0xd9c89a), grass = C(0x5b8a3a), grass2 = C(0x86a24c), rock = C(0x7b7266), snow = C(0xf3f6fa), seabed = C(0x9a8a62);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), h = pos.getY(i), z = pos.getZ(i), ny = nrm.getY(i);
    if (h < 0) c.copy(seabed);
    else if (h < 5) c.copy(sand);
    else {
      c.copy(grass).lerp(grass2, fbm(x / 600, z / 600, 3));
      c.lerp(rock, smoothstep(h, 330, 470));
      c.lerp(rock, smoothstep(0.86 - ny, 0, 0.1));
      if (h > 520 && ny > 0.75) c.lerp(snow, smoothstep(h, 520, 600));
    }
    const j = (fbm(x / 60, z / 60, 2) - 0.5) * 0.12;
    colors[i * 3] = c.r * (1 + j); colors[i * 3 + 1] = c.g * (1 + j); colors[i * 3 + 2] = c.b * (1 + j);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  terrain.receiveShadow = true;
  scene.add(terrain);
}

// water
{
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(200000, 200000).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2a6f97, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.88 })
  );
  water.receiveShadow = true;
  scene.add(water);
}

// ---------- airfield ----------
const RWY_TOP = 0.15;
// Taxiways east of the runway: a parallel taxiway from the apron down to the 36 threshold, the apron
// in front of the hangars, and three links onto the runway. Rectangles are [x0, x1, z0, z1].
const TWY_CL = 50; // taxiway centreline x
const TWY = {
  apron: [42, 70, -165, 35],
  par: [42, 58, 35, 622],
  links: [[25, 42, 598, 622], [25, 42, -75, -45], [25, 42, -162, -138]],
};
const TWY_TOP = 0.1;
{
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x3a3b3e, roughness: 0.9 });
  // Asphalt in strips with gaps where the 0.9 m side stripes go; the stripes fill the gaps at the same
  // height, so nothing is layered and the long stripes can't z-fight with the runway.
  const paint = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.8 });
  const SIDE_IN = RWY_HW - 1.65, SIDE_OUT = RWY_HW - 0.75;        // stripe spans x 23.35 … 24.25
  const strip = (x0, x1, mat) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, RWY_HL * 2).rotateX(-Math.PI / 2), mat);
    m.position.set((x0 + x1) / 2, RH + RWY_TOP, 0);
    m.receiveShadow = true;
    scene.add(m);
  };
  strip(-SIDE_IN, SIDE_IN, asphalt);
  for (const sx of [-1, 1]) {
    strip(sx > 0 ? SIDE_IN : -SIDE_OUT, sx > 0 ? SIDE_OUT : -SIDE_IN, paint);   // side stripe
    strip(sx > 0 ? SIDE_OUT : -RWY_HW, sx > 0 ? RWY_HW : -SIDE_OUT, asphalt);  // asphalt shoulder outside it
  }

  // flat paint decals sitting just above the asphalt
  const markGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const marks = [];
  for (let z = -RWY_HL + 130; z <= RWY_HL - 130; z += 40) marks.push([0, z, 1, 20]);     // centerline
  for (const end of [-1, 1]) {
    for (let k = -4; k <= 4; k++) if (k) marks.push([k * 4.5, end * (RWY_HL - 20), 2, 30]); // thresholds
    for (const side of [-1, 1]) marks.push([side * 9, end * (RWY_HL - 300), 6, 45]);        // aiming points
    // touchdown zone: pairs of 22.5 m bars at 150 m steps from the threshold (3, 2, 1 bars per side),
    // skipping 300 m where the aiming point is; groups centred 9 m either side of the centreline
    for (const [dist, bars] of [[150, 3], [450, 2], [600, 1]]) {
      for (const side of [-1, 1]) for (let b = 0; b < bars; b++) {
        marks.push([side * (9 + (b - (bars - 1) / 2) * 3.3), end * (RWY_HL - dist), 1.8, 22.5]);
      }
    }
  }
  const inst = new THREE.InstancedMesh(markGeo, paint, marks.length);
  const m = new THREE.Matrix4();
  marks.forEach(([x, z, w, l], i) => {
    m.compose(new THREE.Vector3(x, RH + RWY_TOP + 0.05, z), new THREE.Quaternion(), new THREE.Vector3(w, 1, l));
    inst.setMatrixAt(i, m);
  });
  inst.computeBoundingSphere();
  inst.receiveShadow = true;
  scene.add(inst);

  // runway designators: magnetic heading / 10, readable when lined up from that end
  const designator = (text, z, flip) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.font = 'bold 190px Arial, Helvetica, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 138);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 30).rotateX(-Math.PI / 2), // texture top points north (-Z)
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.4, roughness: 0.8 })
    );
    if (flip) mesh.rotation.y = Math.PI;
    mesh.position.set(0, RH + RWY_TOP + 0.05, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
  };
  designator('36', RWY_HL - 70, false); // south end, landing north
  designator('18', -(RWY_HL - 70), true); // north end, landing south

  const hangarMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.7, metalness: 0.3 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a3b2e, roughness: 0.8 });
  for (let i = 0; i < 3; i++) {
    const x = 85, z = -120 + i * 60, gh = groundHeight(x, z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(30, 12, 40), hangarMat);
    body.position.set(x, gh + 6, z);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 40, 16, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2), roofMat);
    roof.position.set(x, gh + 12, z);
    roof.scale.y = 0.4;
    body.castShadow = body.receiveShadow = roof.castShadow = true;
    scene.add(body, roof);
  }

  // taxiways and apron: slightly darker asphalt, yellow centrelines, hold-short bars on each link
  const twyMat = new THREE.MeshStandardMaterial({ color: 0x323336, roughness: 0.92 });
  for (const [x0, x1, z0, z1] of [TWY.apron, TWY.par, ...TWY.links]) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), twyMat);
    mesh.position.set((x0 + x1) / 2, RH + TWY_TOP, (z0 + z1) / 2);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  const yellow = new THREE.MeshStandardMaterial({ color: 0xe8b818, roughness: 0.8 });
  const tm = [];                                     // [x, z, w (x), l (z)]
  tm.push([TWY_CL, (-150 + 610) / 2, 0.3, 760]);     // centreline along apron + parallel taxiway
  for (const [, , z0, z1] of TWY.links) {
    const zc = (z0 + z1) / 2;
    tm.push([(RWY_HW + TWY_CL) / 2, zc, TWY_CL - RWY_HW, 0.3]); // lead-on line to the runway
    // hold short: two solid lines on the taxiway side, two dashed on the runway side
    for (const dx of [0, 0.45]) tm.push([37 + dx, zc, 0.15, z1 - z0]);
    for (const dx of [-0.9, -0.45]) for (let z = z0 + 1; z < z1 - 1; z += 2) tm.push([37 + dx, z + 0.5, 0.15, 1]);
  }
  const ti = new THREE.InstancedMesh(markGeo, yellow, tm.length);
  tm.forEach(([x, z, w, l], i) => {
    m.compose(new THREE.Vector3(x, RH + TWY_TOP + 0.04, z), new THREE.Quaternion(), new THREE.Vector3(w, 1, l));
    ti.setMatrixAt(i, m);
  });
  ti.computeBoundingSphere();
  ti.receiveShadow = true;
  scene.add(ti);
}

// windsocks: striped sleeves west of each touchdown zone; point downwind and droop in light wind
const WINDSOCKS = [[-(RWY_HW + 35), RWY_HL - 180], [-(RWY_HW + 35), -(RWY_HL - 180)]];
const windsocks = WINDSOCKS.map(([x, z]) => {
  const gh = groundHeight(x, z);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 8, 8), new THREE.MeshStandardMaterial({ color: 0xcccccc }));
  pole.position.set(x, gh + 4, z);
  pole.castShadow = true;
  const pivot = new THREE.Group();
  pivot.position.set(x, gh + 7.8, z);
  pivot.rotation.order = 'YXZ';
  const orange = new THREE.MeshStandardMaterial({ color: 0xff6a1a, side: THREE.DoubleSide, roughness: 0.8 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, side: THREE.DoubleSide, roughness: 0.8 });
  // five bands tapering from 0.6 m to 0.22 m over 3.6 m
  for (let i = 0; i < 5; i++) {
    const r0 = 0.6 - i * 0.076, r1 = r0 - 0.076;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, 0.72, 14, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.36 + i * 0.72), i % 2 ? white : orange);
    band.castShadow = true;
    pivot.add(band);
  }
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.03, 6, 20), new THREE.MeshStandardMaterial({ color: 0x888888 }));
  pivot.add(hoop);
  scene.add(pole, pivot);
  return pivot;
});

// ---------- PAPI ----------
// Four lights left of each touchdown zone. Each shows white above its angle, red below:
// 2 white + 2 red = on the 3° path, all white = too high, all red = too low.
const updatePapi = (() => {
  const lights = [];
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.8 });
  const housingGeo = new THREE.BoxGeometry(1.6, 0.9, 1.0);
  for (const dir of [1, -1]) { // 1: approach from +Z, -1: approach from -Z
    const z = dir * (RWY_HL - 300);
    for (let i = 0; i < 4; i++) {
      const x = -dir * (RWY_HW + 15 + i * 9); // inner unit first, on the pilot's left
      const y = groundHeight(x, z);
      const box = new THREE.Mesh(housingGeo, housingMat);
      box.position.set(x, y + 0.45, z);
      box.castShadow = true;
      scene.add(box);
      lights.push({ x, y: y + 0.7, z: z + dir * 0.6, dir, angle: 3.5 - i / 3 });
    }
  }
  const pos = new Float32Array(lights.length * 3), col = new Float32Array(lights.length * 3);
  lights.forEach((l, i) => pos.set([l.x, l.y, l.z], i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const dot = document.createElement('canvas');
  dot.width = dot.height = 64;
  const dctx = dot.getContext('2d'), grd = dctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, '#fff'); grd.addColorStop(0.35, '#fff'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  dctx.fillStyle = grd; dctx.fillRect(0, 0, 64, 64);
  // fog: true so the lights disappear into low cloud / poor visibility like the real thing
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 9, sizeAttenuation: false, vertexColors: true, map: new THREE.CanvasTexture(dot),
    transparent: true, depthWrite: false, fog: true,
  }));
  pts.frustumCulled = false;
  scene.add(pts);
  const RED = new THREE.Color(0xff2a1a), WHITE = new THREE.Color(0xffffff), DARK = new THREE.Color(0x202020);
  return (eye) => {
    lights.forEach((l, i) => {
      const d = (eye.z - l.z) * l.dir;
      const c = d < 20 ? DARK : THREE.MathUtils.radToDeg(Math.atan2(eye.y - l.y, d)) > l.angle ? WHITE : RED;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    });
    geo.attributes.color.needsUpdate = true;
  };
})();

// ---------- light sprites ----------
// Glowing dots for runway, approach and aircraft lights. Their size shrinks with distance down to a
// few pixels (then they dim instead), they show through haze further than terrain does, and they add
// to what's behind them so they bloom at night and are faint by day.
const lightUniforms = { pxScale: { value: 1 }, gain: { value: 1 } };
function updateLightScale() {
  lightUniforms.pxScale.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan(camera.fov * D2R / 2));
}
// pull: metres each sprite is drawn toward the camera, so it never sits level with the surface it's
// mounted on (wingtip, runway) and z-fights with it when seen edge-on
function makeLightPoints(list, pull = 0) { // list of { x, y, z, size }
  const n = list.length, pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3);
  list.forEach((l, i) => { pos.set([l.x, l.y, l.z], i * 3); size[i] = l.size; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('lsize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('lcolor', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...lightUniforms, pull: { value: pull } },
    fog: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec3 lcolor; attribute float lsize; uniform float pxScale; uniform float pull;
      varying vec3 vCol; varying float vFade;
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float dist = length(mvPosition.xyz);
        mvPosition.xyz *= max(dist - pull, min(dist, 0.05)) / dist;
        gl_Position = projectionMatrix * mvPosition;
        float px = lsize * pxScale / max(-mvPosition.z, 0.1);
        gl_PointSize = clamp(px, 3.0, 22.0);
        vFade = clamp(px / 3.0, 0.3, 1.0);
        vCol = lcolor;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform float gain; varying vec3 vCol; varying float vFade;
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float a = exp(-r2 * 5.0) * 0.8 + exp(-r2 * 40.0);
        float f = 1.0;
        #ifdef USE_FOG
          f = 1.0 - smoothstep(fogNear, fogFar * 1.8, vFogDepth); // lights punch through haze further
        #endif
        gl_FragColor = vec4(vCol * a * vFade * gain * f, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 2;
  const setColor = (i, c, k = 1) => { col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k; };
  return { pts, setColor, done: () => { geo.attributes.lcolor.needsUpdate = true; } };
}
const LC = {
  white: new THREE.Color(1, 0.95, 0.85).multiplyScalar(1.6), yellow: new THREE.Color(1, 0.75, 0.15).multiplyScalar(1.6),
  green: new THREE.Color(0.1, 1, 0.35).multiplyScalar(1.6), red: new THREE.Color(1, 0.08, 0.04).multiplyScalar(1.8),
  flash: new THREE.Color(1, 1, 1).multiplyScalar(4), warm: new THREE.Color(1, 0.7, 0.35), off: new THREE.Color(0, 0, 0),
  blue: new THREE.Color(0.2, 0.35, 1).multiplyScalar(1.6),
};

// ---------- airport lighting ----------
// Edge lights (yellow over the last 300 m), centreline (red/white then red near the end), green
// threshold / red end bars, touchdown-zone barrettes, an approach light system with sequenced
// "rabbit" flashers at both ends, a rotating beacon and apron lamps. Directional parts follow the
// way the plane is heading along the runway.
const updateAirportLights = (() => {
  const L = [];
  const onGround = (x, z, h) => Math.max(groundHeight(x, z), 0) + h;
  const add = (kind, x, z, h, size, extra = {}) => L.push({ kind, x, y: onGround(x, z, h), z, size, ...extra });
  const surf = RH + RWY_TOP + 0.12; // flush with the runway, just above the paint
  for (let z = -RWY_HL; z <= RWY_HL; z += 60) for (const sx of [-1, 1]) add('edge', sx * (RWY_HW + 1.5), z, 0.45, 1.0);
  for (let z = -RWY_HL + 7.5, i = 0; z < RWY_HL; z += 15, i++) L.push({ kind: 'cl', x: 1.2, y: surf, z, size: 0.7, i });
  for (const e of [-1, 1]) {                              // e = +1: south end (threshold of 36)
    const z0 = e * RWY_HL;
    for (let x = -RWY_HW + 1; x <= RWY_HW - 1; x += 3) L.push({ kind: 'thr', x, y: surf, z: z0 + e * 0.5, size: 1.2, e });
    // touchdown zone: rows of 3-light barrettes either side of the centreline for 450 m
    for (let d = 60; d <= 450; d += 30) for (const sx of [-1, 1]) for (let k = 0; k < 3; k++)
      L.push({ kind: 'tdz', x: sx * (10 + k * 1.5), y: surf, z: z0 - e * d, size: 0.7, e });
    // approach lights: 5-light barrettes every 30 m out to 720 m, a crossbar at 300 m, rabbits beyond it
    for (let d = 60, k = 0; d <= 720; d += 30) {
      for (let x = -2; x <= 2; x++) add('als', x, z0 + e * d, 1.2, 1.1);
      if (d >= 330) L.push({ kind: 'rabbit', x: 0, y: onGround(0, z0 + e * d, 2.2), z: z0 + e * d, size: 2.2, e, k: Math.round((720 - d) / 30) });
    }
    for (let x = -15; x <= 15; x += 1.5) if (Math.abs(x) > 3) add('als', x, z0 + e * 300, 1.2, 1.1);
  }
  const beaconAt = { x: 112, z: -190 };
  add('beacon', beaconAt.x, beaconAt.z, 16, 2.4);
  for (let i = 0; i < 3; i++) add('apron', 85 - 15.3, -120 + i * 60, 10, 0.6);
  // taxiway edges (blue), skipping the gaps where the links join
  const twyY = RH + TWY_TOP + 0.35;
  const isLinkGap = (z) => TWY.links.some(([, , z0, z1]) => z > z0 - 2 && z < z1 + 2);
  for (let z = TWY.par[2] + 10; z <= TWY.par[3] - 5; z += 30) {
    L.push({ kind: 'twy', x: TWY.par[1] + 0.8, y: twyY, z, size: 0.6 });
    if (!isLinkGap(z)) L.push({ kind: 'twy', x: TWY.par[0] - 0.8, y: twyY, z, size: 0.6 });
  }
  for (const [x0, x1, z0, z1] of TWY.links) for (let x = x0 + 4; x < x1; x += 7)
    for (const z of [z0 - 0.8, z1 + 0.8]) L.push({ kind: 'twy', x, y: twyY, z, size: 0.6 });
  for (const [x, z] of WINDSOCKS) {
    add('apron', x + 1.5, z, 9.5, 0.5);                 // floodlight on the sleeve
    add('obst', x, z, 8.3, 0.45);
  }

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 16, 8), new THREE.MeshStandardMaterial({ color: 0x9aa0a6 }));
  pole.position.set(beaconAt.x, onGround(beaconAt.x, beaconAt.z, 8), beaconAt.z);
  pole.castShadow = true;
  scene.add(pole);

  const { pts, setColor, done } = makeLightPoints(L, 0.6);
  scene.add(pts);
  const RABBITS = 14;
  return (on, t, dir) => { // dir: +1 = moving north (landing 36), −1 = south
    pts.visible = on;
    if (!on) return;
    const rabbit = (t % 1) < 0.5 ? Math.floor((t % 1) / 0.5 * RABBITS) : -1; // twice-a-second run, then pause
    L.forEach((l, i) => {
      const u = -dir * l.z;                    // distance along the direction of travel
      switch (l.kind) {
        case 'edge': setColor(i, u > RWY_HL - 300 ? LC.yellow : LC.white); break;
        case 'cl': {
          const left = RWY_HL - u;
          setColor(i, left < 150 ? LC.red : left < 450 && l.i % 2 ? LC.red : LC.white, 0.8);
          break;
        }
        case 'thr': setColor(i, (camera.position.z - l.z) * l.e > 0 ? LC.green : LC.red); break;
        case 'tdz': setColor(i, l.e === dir ? LC.white : LC.off, 0.8); break;
        case 'als': setColor(i, LC.white, 0.9); break;
        case 'rabbit': setColor(i, l.k === rabbit ? LC.flash : LC.off); break;
        case 'beacon': { // rotating beam: alternate white / green sweeps
          const ph = (t * 0.6) % 1, sweep = Math.max(0, 1 - Math.abs(((ph * 2) % 1) - 0.5) * 12);
          setColor(i, ph < 0.5 ? LC.flash : LC.green, sweep * (ph < 0.5 ? 0.8 : 1.5));
          break;
        }
        case 'apron': setColor(i, LC.warm, 1.2); break;
        case 'twy': setColor(i, LC.blue, 0.8); break;
        case 'obst': setColor(i, LC.red, 1); break;
      }
    });
    done();
  };
})();

// ---------- ILS ----------
// Runway 36 only (approach from +Z heading north); runway 18 is a non-precision runway (VOR approach
// on the field VOR, PAPI for the vertical guidance). Localizer antenna 300 m past the far end,
// glideslope antenna beside the touchdown zone, DME co-located with the glideslope, outer marker 7 km
// and middle marker 1050 m before the threshold.
const ILS = [
  { type: 'ils', name: 'ILS 36', ident: 'I-XSN', freq: '110.30', dir: 1, course: 0 },
];
const GS_ANGLE = 3, LOC_FULL = 2.5, GS_FULL = 0.7, OM_DIST = 7000, MM_DIST = 1050; // degrees / metres
for (const ils of ILS) {
  const d = ils.dir;
  ils.locZ = -d * (RWY_HL + 300);
  ils.gsX = d * (RWY_HW + 95);
  ils.gsZ = d * (RWY_HL - 300);
  ils.thrZ = d * RWY_HL;
}
// VOR/DMEs: the field VOR (west of the runway, used for the RW18 approach) and three en-route
// stations on the hills. obs = the course selected on the HSI for that station, degrees.
const VORS = [
  { name: 'XSIM', ident: 'XSM', freq: '113.40', x: -170, z: -60, obs: 180 },
  { name: 'KARA', ident: 'KRA', freq: '115.80', x: 5000, z: -4000, obs: 0 },
  { name: 'WESTON', ident: 'WSN', freq: '112.70', x: -2000, z: 4000, obs: 0 },
  { name: 'NORTH CAPE', ident: 'NCP', freq: '116.20', x: 1000, z: -6000, obs: 0 },
];
for (const v of VORS) { v.type = 'vor'; v.y = Math.max(groundHeight(v.x, v.z), 0) + 6; }
const NAVAIDS = [...ILS, ...VORS];
let navIdx = 0;
// loc: CDI deflection −1…1 (+ = course is to the right), for the ILS localizer or the VOR course
const nav = { loc: 0, locValid: false, gs: 0, gsValid: false, dme: 0, dmeValid: false, om: false, mm: false, toFrom: null, radial: 0 };

{
  const red = new THREE.MeshStandardMaterial({ color: 0xc8322b, roughness: 0.7 });
  const white = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.7 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.6, metalness: 0.4 });
  const elGeo = new THREE.BoxGeometry(0.5, 2.2, 0.5);
  for (const ils of ILS) {
    // localizer: a row of antenna elements across the extended centreline
    for (let i = -7; i <= 7; i++) {
      const x = i * 2.6, gh = groundHeight(x, ils.locZ);
      const el = new THREE.Mesh(elGeo, i % 2 ? red : white);
      el.position.set(x, gh + 1.1, ils.locZ);
      el.castShadow = true;
      scene.add(el);
    }
    // glideslope: mast and equipment shelter
    const gh = groundHeight(ils.gsX, ils.gsZ);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 14, 8), red);
    mast.position.set(ils.gsX, gh + 7, ils.gsZ);
    const hut = new THREE.Mesh(new THREE.BoxGeometry(3, 2.5, 2.5), grey);
    hut.position.set(ils.gsX + ils.dir * 4, gh + 1.25, ils.gsZ);
    mast.castShadow = hut.castShadow = true;
    scene.add(mast, hut);
  }
}

// VOR ground stations: equipment hut under a raised counterpoise disc with the antenna on top,
// and a red obstruction light
const vorLights = (() => {
  const white = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.4 });
  const tops = [];
  for (const v of VORS) {
    const gh = Math.max(groundHeight(v.x, v.z), 0);
    const g = new THREE.Group();
    g.position.set(v.x, gh, v.z);
    const part = (geo, mat, y) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = m.receiveShadow = true; g.add(m); return m; };
    part(new THREE.CylinderGeometry(3.2, 3.4, 5, 16), white, 0.5);                 // hut, sunk 2 m for slopes
    part(new THREE.CylinderGeometry(9, 9, 0.3, 24), grey, 4.6);                    // counterpoise
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * TAU, leg = part(new THREE.CylinderGeometry(0.12, 0.12, 6, 6), grey, 1.6);
      leg.position.x = Math.cos(a) * 8; leg.position.z = Math.sin(a) * 8;
    }
    part(new THREE.ConeGeometry(0.9, 2.6, 12), white, 6.05);                        // antenna radome
    scene.add(g);
    tops.push({ x: v.x, y: gh + 7.6, z: v.z, size: 0.6 });
  }
  const lp = makeLightPoints(tops, 0.6);
  tops.forEach((_, i) => lp.setColor(i, LC.red, 1.2));
  lp.done();
  scene.add(lp.pts);
  return lp;
})();

function updateNav() {
  const st = NAVAIDS[navIdx];
  nav.om = nav.mm = false;
  nav.gsValid = false;
  if (st.type === 'vor') {
    // course line through the station along the selected course; the CDI shows how far off it you
    // are (10° = full scale) whichever way you're flying, TO/FROM says which side of the station
    const px = S.pos.x - st.x, pz = S.pos.z - st.z, c = st.obs * D2R;
    const along = px * Math.sin(c) - pz * Math.cos(c);       // + = beyond the station along the course
    const lateral = px * Math.cos(c) + pz * Math.sin(c);     // + = right of the course line
    const horiz = Math.hypot(px, pz), elev = Math.atan2(S.pos.y - st.y, horiz) / D2R;
    nav.locValid = !S.crashed && horiz < 90000 && elev < 60; // cone of confusion overhead
    nav.loc = clamp(-Math.atan2(lateral, Math.abs(along)) / D2R / 10, -1, 1);
    nav.toFrom = along >= 0 ? 'FROM' : 'TO';
    nav.radial = (Math.atan2(px, -pz) / D2R + 360) % 360;
    nav.dme = Math.hypot(px, S.pos.y - st.y, pz) / 1852;
    nav.dmeValid = !S.crashed;
    return;
  }
  nav.toFrom = null;
  const ils = st, d = ils.dir;
  const along = (S.pos.z - ils.locZ) * d;   // metres from the localizer antenna, out along the approach
  const lateral = S.pos.x * d;              // + = right of the centreline when flying the approach
  const devDeg = Math.atan2(lateral, along) / D2R;
  nav.locValid = !S.crashed && along > 0 && along < 33000 && Math.abs(devDeg) < 35;
  nav.loc = clamp(-devDeg / LOC_FULL, -1, 1); // + = needle right (course is to your right)

  const gd = (S.pos.z - ils.gsZ) * d;
  const gsAng = Math.atan2(S.pos.y - RH, gd) / D2R;
  nav.gsValid = nav.locValid && gd > 0 && Math.abs(devDeg) < 8 && gsAng > 0.5 && gsAng < 9;
  nav.gs = clamp((GS_ANGLE - gsAng) / GS_FULL, -1, 1); // + = diamond up (glide path above you)

  nav.dme = Math.hypot(S.pos.x - ils.gsX, S.pos.y - RH, S.pos.z - ils.gsZ) / 1852;
  nav.dmeValid = nav.locValid;

  // marker beacons: a cone above each beacon on the extended centreline
  const fromThr = (S.pos.z - ils.thrZ) * d, hgt = S.pos.y - RH;
  const over = (dist) => !S.crashed && !S.grounded && Math.abs(lateral) < 800 && Math.abs(fromThr - dist) < Math.max(120, hgt * 0.7);
  nav.om = over(OM_DIST);
  nav.mm = over(MM_DIST);
}
// keying patterns: outer = dashes, middle = dot-dash
const markerLit = (kind) => {
  if (kind === 'om') return (simTime * 2) % 1 < 0.7;
  const p = simTime % 0.6;
  return p < 0.1 || (p > 0.2 && p < 0.45);
};

// ---------- trees ----------
{
  const N = 6000;
  const crownGeo = new THREE.ConeGeometry(4, 12, 6).translate(0, 9, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.6, 0.8, 4, 5).translate(0, 2, 0);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x2f5a2a, roughness: 1, flatShading: true }), N);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a3e2b, roughness: 1 }), N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let n = 0, seed = 1;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let tries = 0; tries < N * 30 && n < N; tries++) {
    const x = (rnd() * 2 - 1) * HALF * 0.9, z = (rnd() * 2 - 1) * HALF * 0.9;
    const h = groundHeight(x, z);
    if (h < 6 || h > 380 || rwyDist(x, z) < 120 || apronDist(x, z) < 80) continue;
    if (fbm(x / 900 + 50, z / 900, 3) < 0.52) continue; // forest patches
    const slope = Math.hypot(groundHeight(x + 5, z) - groundHeight(x - 5, z), groundHeight(x, z + 5) - groundHeight(x, z - 5)) / 10;
    if (slope > 0.6) continue;
    const sc = 0.7 + rnd() * 0.9;
    m.compose(p.set(x, h - 0.5, z), q.setFromAxisAngle(up, rnd() * 6.28), s.set(sc, sc * (0.8 + rnd() * 0.5), sc));
    crowns.setMatrixAt(n, m); trunks.setMatrixAt(n, m); n++;
  }
  crowns.count = trunks.count = n;
  crowns.castShadow = trunks.castShadow = true;
  crowns.receiveShadow = true;
  scene.add(crowns, trunks);
}

// ---------- weather ----------
const PRESETS = {
  // International Standard Atmosphere at sea level: 1013.25 hPa / 29.92 inHg, 15 °C, no wind, no cloud
  ISA:  { vis: 30000, cloud: 'clear', base: 5000, thick: 2000, windDir: 0,  windVar: 0,  windKt: 0,  gustKt: 0,  qnh: 1013.25, tempC: 15, dewC: 5 },
  VFR:  { vis: 30000, cloud: 'sct', base: 3500, thick: 2000, windDir: 340, windVar: 30, windKt: 8,  gustKt: 0,  qnh: 1018, tempC: 18, dewC: 9 },
  NPA:  { vis: 2400,  cloud: 'ovc', base: 600,  thick: 2500, windDir: 20,  windVar: 20, windKt: 12, gustKt: 20, qnh: 1006, tempC: 9, dewC: 7 },
  CAT1: { vis: 800,   cloud: 'ovc', base: 250,  thick: 3000, windDir: 350, windVar: 0,  windKt: 8,  gustKt: 0,  qnh: 1009, tempC: 8, dewC: 7 },
  CAT2: { vis: 350,   cloud: 'ovc', base: 120,  thick: 3000, windDir: 360, windVar: 0,  windKt: 5,  gustKt: 0,  qnh: 1011, tempC: 6, dewC: 6 },
  CAT3: { vis: 150,   cloud: 'ovc', base: 50,   thick: 3000, windDir: 0,   windVar: 0,  windKt: 0,  gustKt: 0,  qnh: 1013, tempC: 4, dewC: 4 },
};
const weather = { preset: 'VFR', unit: 'hPa', ...PRESETS.VFR };
const CLEAR_VIS = 30000;
const cloudBaseY = () => RH + weather.base / 3.281;
const cloudTopY = () => cloudBaseY() + weather.thick / 3.281;

// cumulus puffs (few / sct / bkn)
const cumulus = new THREE.Group();
scene.add(cumulus);
const puffGeo = new THREE.IcosahedronGeometry(1, 1);
const puffMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true, emissive: 0x8a96a6, emissiveIntensity: 0.35 });
function buildCumulus() {
  cumulus.clear();
  const count = { few: 25, sct: 70, bkn: 170 }[weather.cloud] || 0;
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const tall = clamp(weather.thick / 2000, 0.4, 2.5);
  for (let i = 0; i < count; i++) {
    const g = new THREE.Group();
    const parts = 5 + Math.floor(rnd() * 5), r = 40 + rnd() * 60;
    g.position.set((rnd() * 2 - 1) * 9000, cloudBaseY() + r * 0.6 * tall, (rnd() * 2 - 1) * 9000);
    for (let k = 0; k < parts; k++) {
      const puff = new THREE.Mesh(puffGeo, puffMat);
      const sz = r * (0.6 + rnd() * 0.7);
      puff.scale.set(sz, sz * 0.6 * tall, sz);
      puff.position.set((rnd() - 0.5) * r * 3.5, (rnd() - 0.3) * r * 0.6 * tall, (rnd() - 0.5) * r * 2);
      g.add(puff);
    }
    cumulus.add(g);
  }
}

// overcast stratus: grey ceiling seen from below, lumpy white deck seen from above
const ovcBottom = new THREE.Mesh(
  new THREE.PlaneGeometry(60000, 60000).rotateX(Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: OVC_BELOW })
);
const ovcTop = (() => {
  const geo = new THREE.PlaneGeometry(60000, 60000, 160, 160).rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, -fbm(p.getX(i) / 900, p.getZ(i) / 900, 4) * 90);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 1, flatShading: true }));
})();
scene.add(ovcBottom, ovcTop);

function applyWeather() {
  buildCumulus();
  const ovc = weather.cloud === 'ovc';
  ovcBottom.visible = ovcTop.visible = ovc;
  ovcBottom.position.y = cloudBaseY();
  ovcTop.position.y = cloudTopY();
  updateMetar();
}

// how much of the camera's / plane's surroundings are under or inside the overcast layer
function layerFactors(y) {
  if (weather.cloud !== 'ovc') return { below: 0, inside: 0 };
  const b = cloudBaseY(), t = cloudTopY();
  const intoBase = smoothstep(y, b - 15, b + 15);
  return { below: 1 - intoBase, inside: intoBase * (1 - smoothstep(y, t - 15, t + 15)) };
}

// ---------- time of day ----------
// Day, dusk (sun just above the western horizon) and night (moonlight, stars). Each sets the sky/fog
// palette, the sun-or-moon light and how bright the light sprites look against the background.
const TIMES = {
  day: {
    top: 0x2f6fc4, horizon: 0xbcd6ec, haze: 0xa9b2ba, ovc: 0x8e959d, cloud: 0xc9ced3, dir: [-0.5, 0.75, -0.35],
    sunCol: 0xfff1dc, sunI: 2.4, hemiSky: 0xd5e9ff, hemiGnd: 0x5a6b3a, hemiI: 1.0, disc: 0xffe6b3, glow: 0.25,
    stars: 0, puff: 0.35, lights: 0.45, zulu: '1200',
  },
  dusk: {
    top: 0x24376e, horizon: 0xe08c5c, haze: 0x8a7a7c, ovc: 0x4e4b55, cloud: 0x6d6a72, dir: [-0.95, 0.17, -0.22],
    sunCol: 0xff9a55, sunI: 1.5, hemiSky: 0x8a96c4, hemiGnd: 0x3a3a30, hemiI: 0.55, disc: 0xff8c40, glow: 1.0,
    stars: 0.3, puff: 0.1, lights: 0.8, zulu: '1830',
  },
  night: {
    top: 0x01030a, horizon: 0x0a1222, haze: 0x0a0d13, ovc: 0x07080b, cloud: 0x0c0e11, dir: [0.45, 0.6, 0.35],
    sunCol: 0xa8bce6, sunI: 0.3, hemiSky: 0x2a3550, hemiGnd: 0x0a0c10, hemiI: 0.12, disc: 0xd8deea, glow: 0.04,
    stars: 1, puff: 0, lights: 1, zulu: '2300',
  },
};
let tod = 'day', todPal = TIMES.day;
function setTimeOfDay(name) {
  tod = name; todPal = TIMES[name];
  const p = todPal;
  SKY_TOP.set(p.top); HORIZON.set(p.horizon); HAZE.set(p.haze); OVC_BELOW.set(p.ovc); IN_CLOUD.set(p.cloud);
  sunDir.set(...p.dir).normalize();
  sun.color.set(p.sunCol);
  hemi.color.set(p.hemiSky); hemi.groundColor.set(p.hemiGnd);
  skyUniforms.discCol.value.set(p.disc); skyUniforms.glow.value = p.glow;
  puffMat.emissiveIntensity = p.puff;
  ovcBottom.material.color.copy(OVC_BELOW);
  lightUniforms.gain.value = p.lights;
  if (typeof updateMetar === 'function') updateMetar();
}
// runway / approach lights come on at dusk and night, and by day when it's murky
const airportLightsOn = () => tod !== 'day' || weather.vis < 5000 || (weather.cloud === 'ovc' && weather.base < 1500);

const fogCol = new THREE.Color();
function updateWeatherVisuals() {
  const { below, inside } = layerFactors(camera.position.y);
  // visibility applies under an overcast layer; above it the air is clear
  const vis = weather.cloud === 'ovc' ? lerp(CLEAR_VIS, weather.vis, below) : weather.vis;
  const haze = 1 - smoothstep(vis, 1500, 10000);
  fogCol.copy(HORIZON).lerp(HAZE, haze).lerp(OVC_BELOW, below).lerp(IN_CLOUD, inside);
  scene.fog.color.copy(fogCol);
  scene.fog.near = lerp(Math.min(900, vis * 0.15), 0, inside);
  scene.fog.far = lerp(Math.min(vis * 1.3, 10000), 45, inside);
  const dull = Math.max(below, inside, haze);
  skyUniforms.horizon.value.copy(fogCol);
  skyUniforms.top.value.copy(SKY_TOP).lerp(fogCol, dull);
  skyUniforms.sunAmt.value = 1 - dull;
  sun.intensity = todPal.sunI * (1 - 0.8 * Math.max(below, inside));
  hemi.intensity = todPal.hemiI * (1 - 0.2 * below);
  stars.material.opacity = todPal.stars * (1 - dull);
}

const windVel = new THREE.Vector3(); // m/s, direction the air moves towards
let simTime = 0;
function updateWind(dt) {
  simTime += dt;
  let kt = weather.windKt;
  if (weather.gustKt > kt) kt += (weather.gustKt - kt) * smoothstep(noise(simTime * 0.35, 7.7), 0.45, 0.9);
  // the direction wanders slowly within ± windVar
  weather.curDir = (weather.windDir + weather.windVar * (2 * noise(simTime * 0.04, 13.3) - 1) + 360) % 360;
  const th = weather.curDir * D2R;
  windVel.set(-Math.sin(th), 0, Math.cos(th)).multiplyScalar(kt / 1.944);
}

const fmtQnh = (hpa, unit) => (unit === 'inHg' ? (hpa / HPA_PER_INHG).toFixed(2) : hpa.toFixed(0));
const hdg3 = (d) => String(Math.round(((d % 360) + 360) % 360 / 10) * 10 % 360 || 360).padStart(3, '0');
function updateMetar() {
  const w = weather;
  const dir = String(Math.round(w.windDir / 10) * 10 % 360 || (w.windKt ? 360 : 0)).padStart(3, '0');
  const vrb = w.windVar > 0 && w.windKt <= 3;
  const wind = (w.windKt === 0 && w.gustKt === 0 ? '00000KT'
    : `${vrb ? 'VRB' : dir}${String(w.windKt).padStart(2, '0')}${w.gustKt > w.windKt ? 'G' + w.gustKt : ''}KT`) +
    // METARs only report a variable sector of 60° or more
    (!vrb && w.windKt > 0 && w.windVar * 2 >= 60 ? ` ${hdg3(w.windDir - w.windVar)}V${hdg3(w.windDir + w.windVar)}` : '');
  const vis = w.vis >= 10000 ? '9999' : String(Math.round(w.vis / 50) * 50).padStart(4, '0');
  const cloud = w.cloud === 'clear' ? 'SKC' : `${w.cloud.toUpperCase()}${String(Math.round(w.base / 100)).padStart(3, '0')}`;
  const q = w.unit === 'inHg' ? `A${Math.round(w.qnh / HPA_PER_INHG * 100)}` : `Q${Math.round(w.qnh)}`;
  const visCloud = w.vis >= 10000 && w.cloud === 'clear' ? 'CAVOK' : `${vis} ${cloud}`; // ceiling and visibility OK
  const tt = (c) => `${Math.round(c) < 0 ? 'M' : ''}${String(Math.abs(Math.round(c))).padStart(2, '0')}`;
  $('wxMetar').textContent = `METAR XSIM 21${todPal.zulu}Z ${wind} ${visCloud} ${tt(w.tempC)}/${tt(w.dewC)} ${q}`;
}

// ---------- airplane ----------
function buildPlane() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.45, metalness: 0.1 });
  const red = new THREE.MeshStandardMaterial({ color: 0xc8322b, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223a55, roughness: 0.08, metalness: 0.7 });
  const add = (geo, mat, x, y, z, parent = g) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  // control surface hinged at its leading edge; the panel extends aft (+Z) from the hinge
  const hinged = (x, y, z, w, h, d, mat) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    add(new THREE.BoxGeometry(w, h, d), mat, 0, 0, d / 2, pivot);
    g.add(pivot);
    return pivot;
  };
  add(new THREE.CylinderGeometry(0.28, 0.62, 7, 14).rotateX(Math.PI / 2), white, 0, 0, 0.5);
  add(new THREE.SphereGeometry(0.62, 14, 10), red, 0, 0, -3).scale.set(1, 1, 1.3);
  add(new THREE.ConeGeometry(0.22, 0.6, 12).rotateX(-Math.PI / 2), dark, 0, 0, -3.95);
  // red wing stops 2 cm inside the white tip caps (x 4.9–5.5) so no faces share a plane
  add(new THREE.BoxGeometry(9.84, 0.16, 1.2), red, 0, -0.15, -1.05);
  add(new THREE.BoxGeometry(0.6, 0.17, 1.22), white, 5.2, -0.15, -1.05);
  add(new THREE.BoxGeometry(0.6, 0.17, 1.22), white, -5.2, -0.15, -1.05);
  const flaps = [hinged(1.95, -0.15, -0.45, 2.5, 0.12, 0.5, red), hinged(-1.95, -0.15, -0.45, 2.5, 0.12, 0.5, red)];
  const ailerons = [hinged(4.15, -0.15, -0.45, 1.9, 0.12, 0.5, white), hinged(-4.15, -0.15, -0.45, 1.9, 0.12, 0.5, white)];
  // fixed horizontal stabiliser (z 3.275–3.825), elevator hinged behind it (z 3.83–4.23), and a
  // trim tab on the left half of the elevator's trailing edge. Small gaps between parts keep
  // faces from being coplanar (no z-fighting).
  add(new THREE.BoxGeometry(3.8, 0.1, 0.55), red, 0, 0.1, 3.55);
  const elevator = new THREE.Group();
  elevator.position.set(0, 0.1, 3.83);
  add(new THREE.BoxGeometry(3.8, 0.08, 0.25), white, 0, 0, 0.125, elevator);      // z 0 … 0.25
  const elevTE = (x0, x1) => add(new THREE.BoxGeometry(x1 - x0, 0.08, 0.145), white, (x0 + x1) / 2, 0, 0.3275, elevator);
  elevTE(-1.9, -1.52);                                                            // outboard of the tab
  elevTE(-0.38, 1.9);                                                             // inboard + right side
  const trimTab = new THREE.Group();
  trimTab.position.set(-0.95, 0, 0.255);
  add(new THREE.BoxGeometry(1.1, 0.05, 0.145), red, 0, 0, 0.0725, trimTab);       // x −1.5 … −0.4
  elevator.add(trimTab);
  g.add(elevator);
  add(new THREE.BoxGeometry(0.1, 1.5, 0.75), red, 0, 0.85, 3.5);
  const rudder = hinged(0, 0.85, 3.875, 0.08, 1.4, 0.4, white);
  add(new THREE.SphereGeometry(0.5, 16, 10), glass, 0, 0.5, -1.0).scale.set(0.9, 0.75, 1.8);
  // landing gear: tyre (torus) on a metal hub with hub caps and lug bolts. The nose wheel sits in a
  // fork; the mains hang off the outboard side of their struts on a short axle. Wheel centre is 0.8 m
  // below the leg pivot and the tyre radius is 0.35 m, so ground contact matches GEAR.
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.95 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xd4d6d8, roughness: 0.35, metalness: 0.6 });
  const boltMat = new THREE.MeshStandardMaterial({ color: 0x6a6d70, roughness: 0.4, metalness: 0.7 });
  const strutMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.4, metalness: 0.5 });
  const tyreGeo = new THREE.TorusGeometry(0.255, 0.095, 10, 28).rotateY(Math.PI / 2); // outer r 0.35, 0.19 wide
  const hubGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.15, 20).rotateZ(Math.PI / 2);
  const capGeo = new THREE.CylinderGeometry(0.075, 0.09, 0.04, 14).rotateZ(Math.PI / 2);
  const boltGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.02, 6).rotateZ(Math.PI / 2);
  const makeWheel = (parent, x) => {
    const w = new THREE.Group();
    w.position.set(x, -0.8, 0);
    add(tyreGeo, rubber, 0, 0, 0, w);
    add(hubGeo, hubMat, 0, 0, 0, w);
    for (const side of [-1, 1]) {
      add(capGeo, hubMat, side * 0.085, 0, 0, w);                 // dome over the hub face (x 0.075)
      for (let i = 0; i < 5; i++) {                               // lug bolts: these make the roll visible
        const a = i / 5 * TAU;
        add(boltGeo, boltMat, side * 0.083, Math.cos(a) * 0.12, Math.sin(a) * 0.12, w);
      }
    }
    parent.add(w);
    return w;
  };
  const legs = [];
  // nose leg hangs from the fuselage; the mains hang from the wing underside (y −0.3) at mid-chord.
  // Every wheel centre ends up 1.25 m below the fuselage axis.
  for (const [x, y, z] of [[0, -0.45, -2.8], [2.2, -0.3, -0.85], [-2.2, -0.3, -0.85]]) {
    const leg = new THREE.Group();
    leg.position.set(x, y, z);
    if (x === 0) {
      // nose: oleo strut, crown and two fork blades either side of the tyre
      add(new THREE.BoxGeometry(0.08, 0.4, 0.08), strutMat, 0, -0.18, 0, leg);
      add(new THREE.BoxGeometry(0.31, 0.05, 0.09), strutMat, 0, -0.395, 0, leg);
      for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.035, 0.44, 0.07), strutMat, side * 0.135, -0.63, 0, leg);
      leg.userData.wheel = makeWheel(leg, 0);
    } else {
      // mains: strut on the inboard side of the tyre, short axle out to the hub. Folding inward swings
      // the strut up against the wing and leaves the wheel tucked flat under it.
      const inb = -Math.sign(x);
      add(new THREE.BoxGeometry(0.1, 0.18, 0.14), strutMat, inb * 0.07, -0.01, 0, leg);  // mount, reaching 1 cm into the wing
      add(new THREE.BoxGeometry(0.08, 0.95, 0.08), strutMat, inb * 0.14, -0.5, 0, leg);
      add(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 8).rotateZ(Math.PI / 2), strutMat, inb * 0.07, -0.95, 0, leg);
      leg.userData.wheel = makeWheel(leg, 0);
      leg.userData.wheel.position.y = -0.95;
    }
    g.add(leg);
    legs.push(leg);
  }
  const prop = new THREE.Group();
  prop.position.set(0, 0, -3.85);
  add(new THREE.BoxGeometry(0.18, 2.6, 0.06), dark, 0, 0, 0, prop);
  g.add(prop);
  return { g, prop, flaps, ailerons, elevator, trimTab, rudder, legs };
}
const plane = buildPlane();
scene.add(plane.g);

// ---------- aircraft lights ----------
// Switches: landing (left wing leading edge, long narrow beam), taxi (nose, wide beam angled down),
// nav (red left tip, green right tip, white tail, plus the red beacon on the fin) and strobes
// (white double flash on both wingtips).
const lightsOn = { landing: false, taxi: false, nav: true, strobe: false };
const planeLights = (() => {
  // each light: a glow sprite plus a physical lens (dome / window) that lights up with it.
  // lens: [radius, scale x, y, z, colour]; positions sit just proud of the surface they're on.
  const list = [
    { kind: 'navL', x: -5.52, y: -0.15, z: -1.0, size: 0.35, lens: [0.075, 0.8, 0.8, 1.4, 0xff2a1a] },
    { kind: 'navR', x: 5.52, y: -0.15, z: -1.0, size: 0.35, lens: [0.075, 0.8, 0.8, 1.4, 0x1aff5a] },
    { kind: 'navT', x: 0, y: 0.25, z: 4.02, size: 0.3, lens: [0.075, 0.8, 0.8, 1.4, 0xffffff] },
    { kind: 'beacon', x: 0, y: 1.62, z: 3.5, size: 0.4, lens: [0.08, 1, 1.1, 1.3, 0xff2a1a] },        // dome on the fin top
    { kind: 'strobe', x: -5.53, y: -0.15, z: -0.6, size: 0.9, lens: [0.06, 0.8, 0.8, 1.6, 0xf4f6ff] }, // clear, behind the nav light
    { kind: 'strobe', x: 5.53, y: -0.15, z: -0.6, size: 0.9, lens: [0.06, 0.8, 0.8, 1.6, 0xf4f6ff] },
    { kind: 'landing', x: -2.6, y: -0.15, z: -1.655, size: 0.6, lens: [0.1, 1.8, 0.65, 0.35, 0xe8eef2] }, // window in the leading edge
    { kind: 'taxi', x: 0, y: -0.38, z: -3.64, size: 0.45, lens: [0.08, 1, 1, 0.45, 0xe8eef2] },           // round lamp low on the nose
  ];
  const sp = makeLightPoints(list, 0.3);
  plane.g.add(sp.pts);
  for (const l of list) {
    const [r, sx, sy, sz, color] = l.lens;
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0, roughness: 0.15, metalness: 0.1 }));
    m.position.set(l.x, l.y, l.z);
    m.scale.set(sx, sy, sz);
    plane.g.add(m);
    l.mat = m.material;
  }
  // the beams: always in the scene (switching lights in and out would recompile every shader)
  const beam = (x, y, z, tx, ty, tz, angle, penumbra) => {
    const l = new THREE.SpotLight(0xfff4e0, 0, 0, angle, penumbra, 2);
    l.position.set(x, y, z);
    l.target.position.set(tx, ty, tz);
    plane.g.add(l, l.target);
    return l;
  };
  const landing = beam(-2.6, -0.15, -1.75, -2.6, -7, -120, 0.17, 0.35);
  const taxi = beam(0, -0.38, -3.7, 0, -3.2, -25, 0.55, 0.5);
  return (t) => {
    const strobe = (t % 1.2) < 0.05 || ((t % 1.2) > 0.14 && (t % 1.2) < 0.19);
    const beacon = (t % 1.1) < 0.12;
    list.forEach((l, i) => {
      // [lit?, sprite colour, sprite brightness, lens glow]
      const [on, c, k, glow] = {
        navL: [lightsOn.nav, LC.red, 1, 1.5],
        navR: [lightsOn.nav, LC.green, 1, 1.5],
        navT: [lightsOn.nav, LC.white, 1, 1.2],
        beacon: [lightsOn.nav && beacon, LC.red, 1.6, 2.5],
        strobe: [lightsOn.strobe && strobe, LC.flash, 1, 4],
        landing: [lightsOn.landing, LC.flash, 0.7, 3],
        taxi: [lightsOn.taxi, LC.flash, 0.5, 3],
      }[l.kind];
      sp.setColor(i, on ? c : LC.off, k);
      l.mat.emissiveIntensity = on ? glow : 0;
    });
    sp.done();
    landing.intensity = lightsOn.landing ? 60000 : 0;
    taxi.intensity = lightsOn.taxi ? 2500 : 0;
  };
})();

// ---------- explosion ----------
const fire = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true }));
const smoke = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x333333, transparent: true, flatShading: true }));
fire.visible = smoke.visible = false;
scene.add(fire, smoke);

// ---------- flight model ----------
// Point-mass aerodynamics. Lift = K_LIFT·V²·CL(α) acts perpendicular to the airflow, drag is
// parasitic + induced, thrust acts along the nose. The nose tracks a commanded angle of attack
// (static stability) and the stick moves that command. So: more power → more speed → more lift →
// climb; flaps → more CL at the same α → balloon; bank → tilted lift → the flight path turns.
const G = 9.81;
const THRUST = 3.3;        // m/s² at full throttle at the 72 kt climb speed (≈1400 fpm)
// A propeller's thrust falls as airspeed rises: linear, reaching zero at PROP_V0, normalised so it's
// THRUST at 37 m/s, and capped for the static/low-speed end. This is what limits top speed.
const PROP_V0 = 100, PROP_MAX = 1.15; // m/s (≈195 kt), cap on the low-speed boost
const thrustAt = (throttle, V) => throttle * THRUST * Math.min(PROP_MAX, Math.max(0, (1 - V / PROP_V0) / (1 - 37 / PROP_V0)));
const DRAG = 0.00083;      // parasitic drag factor, gear down / flaps up
const K_LIFT = 0.00969;    // lift accel = K_LIFT·V²·CL  (CL 0.5 at 45 m/s holds 1 g)
const CL0 = 0.25, CL_ALPHA = 5.0, CL_FLAPS = 0.35, ALPHA_STALL = 0.26, K_INDUCED = 0.05;
const ALPHA_TRIM = 0, ALPHA_POWER = 0.03, ALPHA_STICK = 0.25; // rad; neutral trim ≈ level cruise at 75% power, gear up (~100 kt)
const ALPHA_FLAP = 0.06;   // nose-up trim change with full flaps: together with the extra lift, the balloon
const TRIM_UP = 0.14, TRIM_DOWN = -0.04, TRIM_RATE = 0.012; // rad of commanded α (full up ≈ 60 kt, full down ≈ level at full power), rad/s
const TRIM_TO = 0.06;      // takeoff / approach setting: lifts off by itself ≈ 72 kt, ≈ 75 kt climb
const PITCH_STIFF = 2.6;   // 1/s: how quickly the nose chases the commanded α
// pitch inertia: the pitch rate builds up with a short lag and is capped (rad/s, scaled by airspeed
// authority), so the nose can't snap up; rotation on the runway is limited to a few degrees a second
const PITCH_LAG = 5, PITCH_RATE_MAX = 0.18, ROTATE_RATE = 0.09;
// yaw inertia, and the roll that sideslip induces (dihedral): both build up with a lag, so a
// crosswind lift-off eases into its crab instead of snapping round
const YAW_LAG = 1.5, DIHEDRAL_LAG = 4;
// a rudder kick rolls the plane too (the outside wing speeds up and lifts), so a crosswind de-crab
// banks you downwind unless you hold the upwind wing down. Only the rudder's yaw counts, so ordinary
// turns keep their old, slightly self-levelling feel.
const ROLL_FROM_YAW = 0.5;
const GE_LIFT = 0.15, GE_DRAG = 0.6, GE_HEIGHT = 4; // ground effect: lift gain, induced-drag cut, m of decay
const YAW_STIFF = 3.0;     // 1/s: weathervane into the relative wind
const ROLL_RATE = 1.3, YAW_RATE = 0.65; // rad/s at full deflection (full rudder holds ≈ 12° of sideslip)
const ROLL_FRICTION = 0.6, BRAKE = 7;
const ROTATE = 31;         // m/s: the elevator has full authority to lift the nose wheel above this (less with flaps)
const NOSEWHEEL = 0.35, GROUND_RUDDER = 0.2, GROUND_WEATHERVANE = 0.3; // rad/s: ground steering and crosswind yaw
// touchdown: the wings settle level on the gear (rad/s cap) and the tyres scrub off any sideways
// drift (1/s) instead of both snapping to zero in one frame
const SETTLE_ROLL_RATE = 0.25, TYRE_GRIP = 4;
// terrain: you can land on ground up to MAX_LAND_SLOPE and roll on up to MAX_TAXI_SLOPE (rad);
// anything steeper is flying into the hillside / tipping over
const MAX_LAND_SLOPE = 0.14, MAX_TAXI_SLOPE = 0.26;
// slope of the ground under (x, z): gradient (dh/dx, dh/dz) and overall steepness, rad
const _slope = { sx: 0, sz: 0, steep: 0 };
function slopeAt(x, z) {
  const d = 2;
  _slope.sx = (groundHeight(x + d, z) - groundHeight(x - d, z)) / (2 * d);
  _slope.sz = (groundHeight(x, z + d) - groundHeight(x, z - d)) / (2 * d);
  _slope.steep = Math.atan(Math.hypot(_slope.sx, _slope.sz));
  return _slope;
}
const FLAP_VMAX = 56;      // ≈ 110 kt
const GEAR = 1.6 + RWY_TOP;
const FLAP_DEG = [0, 15, 30];

// ---------- atmosphere ----------
// Temperature falls 6.5 °C per km from the field temperature; pressure comes from QNH through the
// standard atmosphere. σ = density / ISA sea-level density scales lift, drag and engine power, and
// turns true airspeed into indicated (IAS = TAS·√σ). The handling is tuned at σ ≈ 1.
const LAPSE = 0.0065; // K per metre
const seaLevelTempK = () => weather.tempC + 273.15 + LAPSE * RH; // field temperature extrapolated down
const oatK = (y) => seaLevelTempK() - LAPSE * Math.max(y, 0);
const pressureHpa = (y) => weather.qnh * Math.pow(1 - LAPSE * Math.max(y, 0) / 288.15, 5.2559);
const densityRatio = (y) => (pressureHpa(y) * 100 / (287.05 * oatK(y))) / 1.225;
// normally aspirated piston engine: power falls a little faster than density (Gagg–Ferrar)
const enginePower = (sig) => clamp(1.132 * sig - 0.132, 0, 1.2);
// density altitude, ft: the ISA altitude with the same density
const densityAltFt = (y) => {
  const sig = densityRatio(y);
  return (1 - Math.pow(sig, 0.234969)) * 145442.16;
};

function liftCoef(alpha, flap) {
  const base = CL0 + flap * CL_FLAPS;
  // linear up to the stall, then lift collapses
  if (alpha > ALPHA_STALL) return base + CL_ALPHA * ALPHA_STALL - Math.min(alpha - ALPHA_STALL, 0.3) * 3.5;
  if (alpha < -ALPHA_STALL) return base - CL_ALPHA * ALPHA_STALL + Math.min(-ALPHA_STALL - alpha, 0.3) * 3.5;
  return base + CL_ALPHA * alpha;
}
const vStall = (flap) => Math.sqrt(G / (K_LIFT * (CL0 + flap * CL_FLAPS + CL_ALPHA * ALPHA_STALL))); // m/s, 1 g

// speed: indicated airspeed (m/s). gs: ground speed while on the wheels. vAir: velocity through the air.
const S = {
  pos: new THREE.Vector3(), quat: new THREE.Quaternion(), vel: new THREE.Vector3(), vAir: new THREE.Vector3(),
  speed: 0, gs: 0, throttle: 0, rpm: 0, grounded: true, heading: 0, gPitch: 0, crashed: false, crashT: 0,
  gearDown: true, gearPos: 1, flapSet: 0, flapPos: 0, stalling: false, alpha: 0, beta: 0, gamma: 0, vDot: 0, trim: 0,
  parkBrake: false, tas: 0, sigma: 1, q: 0, r: 0, rRud: 0, pDih: 0, gRoll: 0, gSide: 0, tPitch: 0, tRoll: 0, // tPitch/tRoll: terrain tilt under the wheels // pitch rate, yaw rate, sideslip-induced roll rate (rad/s)
  baro: 1013.25, // altimeter setting, hPa
};
const ctl = { pitch: 0, roll: 0, yaw: 0 };
const keys = {};

// ---------- controls ----------
// Every action has two binding slots. A binding is a KeyboardEvent.code, optionally with modifiers
// ("Shift+KeyB"). Held actions are read every frame (modifiers ignored); the rest fire once per press.
const ACTIONS = [
  // id, label, group, default bindings, held?
  ['pitchDown', 'Pitch down (nose down)', 'Flight controls', ['KeyW', 'ArrowUp'], true],
  ['pitchUp', 'Pitch up (nose up)', 'Flight controls', ['KeyS', 'ArrowDown'], true],
  ['rollLeft', 'Roll left', 'Flight controls', ['KeyA', 'ArrowLeft'], true],
  ['rollRight', 'Roll right', 'Flight controls', ['KeyD', 'ArrowRight'], true],
  ['yawLeft', 'Rudder left / steer left', 'Flight controls', ['KeyQ'], true],
  ['yawRight', 'Rudder right / steer right', 'Flight controls', ['KeyE'], true],
  ['trimDown', 'Trim nose down', 'Flight controls', ['Semicolon'], true],
  ['trimUp', 'Trim nose up', 'Flight controls', ['Period'], true],
  ['throttleUp', 'Power up', 'Engine & systems', ['KeyR'], true],
  ['throttleDown', 'Power down', 'Engine & systems', ['KeyF'], true],
  ['brakes', 'Brakes (hold)', 'Engine & systems', ['KeyB'], true],
  ['parkBrake', 'Parking brake', 'Engine & systems', ['Shift+KeyB']],
  ['gear', 'Gear up / down', 'Engine & systems', ['KeyG']],
  ['flapsUp', 'Flaps up', 'Engine & systems', ['Digit1']],
  ['flapsDown', 'Flaps down', 'Engine & systems', ['Digit2']],
  ['landingLight', 'Landing light', 'Lights', ['Digit3']],
  ['taxiLight', 'Taxi light', 'Lights', ['Digit4']],
  ['navLights', 'Nav lights + beacon', 'Lights', ['Digit5']],
  ['strobes', 'Strobes', 'Lights', ['Digit6']],
  ['baroDown', 'Altimeter setting down', 'Instruments & nav', ['BracketLeft']],
  ['baroUp', 'Altimeter setting up', 'Instruments & nav', ['BracketRight']],
  ['baroSync', 'Set altimeter to QNH', 'Instruments & nav', ['Backslash']],
  ['ils', 'Tune next NAV station', 'Instruments & nav', ['KeyL']],
  ['navPrev', 'Tune previous NAV station', 'Instruments & nav', ['Shift+KeyL']],
  ['obsDown', 'VOR course −1° (hold to spin)', 'Instruments & nav', ['Digit9']],
  ['obsUp', 'VOR course +1° (hold to spin)', 'Instruments & nav', ['Digit0']],
  ['gpsOut', 'GPS range out', 'Instruments & nav', ['Minus']],
  ['gpsIn', 'GPS range in', 'Instruments & nav', ['Equal']],
  ['camera', 'Camera: chase / cockpit', 'View', ['KeyC']],
  ['recenter', 'Recenter view', 'View', ['KeyV']],
  ['panel', 'Instrument panel', 'View', ['KeyU']],
  ['map', 'Map / GPS', 'View', ['KeyM']],
  ['help', 'Help', 'View', ['KeyH']],
  ['fps', 'FPS counter', 'View', ['KeyK']],
  ['resetRunway', 'Reset on runway', 'Sim', ['KeyT']],
  ['airStart', 'Air start on approach', 'Sim', ['KeyY']],
  ['pause', 'Pause', 'Sim', ['KeyP']],
  ['timeOfDay', 'Day / dusk / night', 'Sim', ['KeyN']],
  ['weather', 'Weather panel', 'Sim', ['KeyX']],
  ['sound', 'Sound on / off', 'Sim', ['KeyO']],
  ['invert', 'Invert pitch', 'Sim', ['KeyI']],
  ['settings', 'Settings (Esc always works too)', 'Sim', []],
];
const ACTION = Object.fromEntries(ACTIONS.map(([id, label, group, def, isHeld]) => [id, { id, label, group, def, held: !!isHeld }]));
const defaultBinds = () => Object.fromEntries(ACTIONS.map(([id, , , def]) => [id, [def[0] || null, def[1] || null]]));
let binds = defaultBinds();
const bareCode = (b) => b.split('+').pop();
const held = (id) => (binds[id].some((b) => b && keys[bareCode(b)]) ? 1 : 0);
const look = { yaw: 0, pitch: 0 };
// frame rate, averaged over half-second windows
const fps = { show: true, value: 0, ms: 0, frames: 0, time: 0 };
let invert = false, paused = false, camMode = 0, snapCam = true, msgTimer = 0, mapMode = 0, showPanel = true;
let chaseDist = 14, turnRate = 0, prevHdg = 0;

const $ = (id) => document.getElementById(id);
function showMsg(text, secs = 2.5) { $('msg').textContent = text; msgTimer = secs; }

function reset(air) {
  S.crashed = false; S.heading = 0; S.gPitch = 0; S.stalling = false; S.gs = 0; S.beta = 0; S.gamma = 0; S.vDot = 0; S.trim = TRIM_TO; S.q = 0; S.r = 0; S.rRud = 0; S.pDih = 0; S.tPitch = 0; S.tRoll = 0; S.gRoll = 0; S.gSide = 0;
  S.gearDown = true; S.gearPos = 1;
  S.baro = weather.qnh; // as if you'd just listened to the ATIS
  plane.g.visible = true; fire.visible = smoke.visible = false;
  if (air) {
    // trimmed on a 3° glide path, 3 km from the southern touchdown zone, flaps 15
    const z = RWY_HL - 300 + 3000, gamma = -3 * D2R;
    S.pos.set(0, Math.max(RH + GEAR + 157, groundHeight(0, z) + 120), z);
    S.speed = 37; S.throttle = 0.37; S.grounded = false;
    S.flapSet = 1; S.flapPos = 0.5;
    S.vAir.set(0, Math.sin(gamma), -Math.cos(gamma)).multiplyScalar(S.speed / Math.sqrt(densityRatio(S.pos.y)));
    S.gamma = gamma;
    S.alpha = (G / (K_LIFT * S.speed ** 2) - CL0 - S.flapPos * CL_FLAPS) / CL_ALPHA;
    S.quat.setFromEuler(new THREE.Euler(gamma + S.alpha, 0, 0, 'YXZ'));
    navIdx = 0;
    showMsg('On ILS 36 approach — follow the needles or the PAPI');
  } else {
    S.pos.set(0, RH + GEAR, RWY_HL - 60);
    S.quat.identity();
    S.speed = 0; S.throttle = 0; S.grounded = true; S.parkBrake = false;
    S.vAir.set(0, 0, 0);
    S.flapSet = 0; S.flapPos = 0;
    showMsg('Ready for takeoff');
  }
  S.rpm = 0.12 + 0.88 * S.throttle;
  snapCam = true;
}

function crash(reason) {
  S.crashed = true; S.crashT = 0; S.speed = 0; S.gs = 0; S.stalling = false;
  plane.g.visible = false;
  fire.position.copy(S.pos); smoke.position.copy(S.pos);
  fire.visible = smoke.visible = true;
  playSound('crash');
  showMsg(`CRASHED — ${reason}. Press T`, 1e9);
}

const _v = new THREE.Vector3(), _h = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _vhat = new THREE.Vector3(), _liftDir = new THREE.Vector3(), _acc = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const fwd = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();

function rotLocal(axis, angle) { S.quat.multiply(_q.setFromAxisAngle(axis, angle)); }

function step(dt) {
  if (!(dt > 0)) return; // first frame can report 0 s; rate terms below divide by dt
  updateWind(dt);
  S.rpm = damp(S.rpm, S.crashed ? 0 : 0.12 + 0.88 * S.throttle, 1.5, dt);

  if (S.crashed) {
    S.crashT += dt;
    const t = S.crashT;
    fire.scale.setScalar(2 + Math.min(t, 1) * 22);
    fire.material.opacity = Math.max(0, 1 - t / 1.6);
    fire.visible = fire.material.opacity > 0;
    smoke.scale.setScalar(4 + t * 10);
    smoke.position.y = S.pos.y + t * 8;
    smoke.material.opacity = Math.max(0, 0.75 - t / 8);
    return;
  }

  if (held('throttleUp')) S.throttle += 0.5 * dt;
  if (held('throttleDown')) S.throttle -= 0.5 * dt;
  S.throttle = clamp(S.throttle, 0, 1);

  let tp = held('pitchUp') - held('pitchDown');
  if (invert) tp = -tp;
  const tr = held('rollRight') - held('rollLeft');
  const ty = held('yawRight') - held('yawLeft');
  if (held('trimUp')) S.trim = Math.min(TRIM_UP, S.trim + TRIM_RATE * dt);
  if (held('trimDown')) S.trim = Math.max(TRIM_DOWN, S.trim - TRIM_RATE * dt);
  // the elevator follows the keys quickly but eases back when they're released, so a tap holds a flare
  ctl.pitch = damp(ctl.pitch, tp, Math.abs(tp) > Math.abs(ctl.pitch) || tp * ctl.pitch < 0 ? 3 : 1.2, dt);
  ctl.roll = damp(ctl.roll, tr, 6, dt);
  ctl.yaw = damp(ctl.yaw, ty, S.grounded ? 2.5 : 4, dt); // gentler on the ground: less twitchy steering

  // gear (4 s travel) and flaps (3 s full travel)
  const gearTarget = S.gearDown ? 1 : 0;
  if (S.gearPos !== gearTarget) {
    S.gearPos = approach(S.gearPos, gearTarget, dt / 4);
    if (S.gearPos === gearTarget) playSound('clunk');
  }
  S.flapPos = approach(S.flapPos, S.flapSet / 2, dt / 3);
  const drag = DRAG * (1 + 0.9 * S.flapPos - 0.3 * (1 - S.gearPos));

  fwd.set(0, 0, -1).applyQuaternion(S.quat);

  if (S.grounded) {
    S.stalling = false;
    _h.set(-Math.sin(S.heading), 0, -Math.cos(S.heading));
    right.set(Math.cos(S.heading), 0, -Math.sin(S.heading));
    // airflow over the plane: crosswind makes a sideslip the fin turns into, more so as the air gets faster
    S.gSide = damp(S.gSide, 0, TYRE_GRIP, dt);             // tyres scrub off sideways drift
    _v.copy(_h).multiplyScalar(S.gs).addScaledVector(right, S.gSide).sub(windVel);
    const air = _v.dot(_h), side = _v.dot(right);
    const sig = S.sigma = densityRatio(S.pos.y), rs = Math.sqrt(sig);
    const airV = Math.hypot(air, side);
    const auth = clamp(airV * rs / 40, 0, 1);
    S.beta = airV > 1 ? clamp(Math.atan2(side, Math.max(air, 0.5)), -0.6, 0.6) : 0;
    // rudder pedals steer the nose wheel (fades as the wheel unloads with speed) and the rudder bites the air
    const wheel = NOSEWHEEL * Math.min(1, S.gs / 5) / (1 + S.gs / 15) * (S.gPitch > 0.03 ? 0 : 1);
    const dHdg = -(ctl.yaw * (wheel + GROUND_RUDDER * auth) + GROUND_WEATHERVANE * S.beta * auth * Math.min(1, S.gs / 3));
    S.heading += dHdg * dt;
    S.r = dHdg; S.pDih = 0;                   // carried into the air at lift-off
    _h.set(-Math.sin(S.heading), 0, -Math.cos(S.heading));
    // wheels resist until thrust/wind beat rolling friction
    const resist = ROLL_FRICTION + Math.max(held('brakes'), S.parkBrake ? 1 : 0) * BRAKE;
    let acc = thrustAt(S.throttle * enginePower(sig), Math.max(air, 0)) - drag * sig * air * Math.abs(air) - G * Math.sin(S.tPitch);
    acc = S.gs > 0 ? acc - resist : Math.max(0, acc - resist);
    S.gs = Math.max(0, S.gs + acc * dt);
    S.tas = Math.max(0, air);
    const ias = S.tas * rs; // indicated
    S.vDot = damp(S.vDot, (ias - S.speed) / dt, 3, dt);
    S.speed = ias;

    // the nose wants the same α as in flight (trim, power, flaps, stick); the elevator only has the
    // authority to lift the nose wheel as the airspeed builds, and the tail limits it
    const alphaCmd = ALPHA_TRIM + S.trim + ALPHA_FLAP * S.flapPos + ALPHA_POWER * S.throttle + ctl.pitch * ALPHA_STICK + Math.min(0.06 * S.vDot, 0.02); // same as in the air
    const lift = smoothstep(S.speed, ROTATE - 10 - 4 * S.flapPos, ROTATE - 4 * S.flapPos);
    const pitchTarget = clamp(alphaCmd * lift, 0, 0.2);
    // nose wheel lifts / lowers smoothly, no faster than ROTATE_RATE; the rate carries into the air
    const gp0 = S.gPitch;
    S.gPitch = approach(S.gPitch, damp(S.gPitch, pitchTarget, 2, dt), ROTATE_RATE * dt);
    S.q = (S.gPitch - gp0) / dt;
    S.alpha = S.gPitch;
    S.gRoll = approach(S.gRoll, damp(S.gRoll, 0, 6, dt), SETTLE_ROLL_RATE * dt); // wings settle level
    right.set(Math.cos(S.heading), 0, -Math.sin(S.heading));
    S.vel.copy(_h).multiplyScalar(S.gs).addScaledVector(right, S.gSide);
    S.pos.addScaledVector(S.vel, dt);
    const gh = groundHeight(S.pos.x, S.pos.z);
    if (gh < 0.3) return crash('rolled into the water');
    const sl = slopeAt(S.pos.x, S.pos.z);
    if (sl.steep > MAX_TAXI_SLOPE) return crash('tipped over on steep ground');
    // sit on the slope: nose up going uphill, the high side's wing up
    S.tPitch = damp(S.tPitch, Math.atan(sl.sx * _h.x + sl.sz * _h.z), 10, dt);
    S.tRoll = damp(S.tRoll, Math.atan(sl.sx * right.x + sl.sz * right.z), 10, dt);
    S.quat.setFromEuler(_e.set(S.gPitch + S.tPitch, S.heading, S.gRoll + S.tRoll, 'YXZ'));
    S.vel.y = (gh + GEAR - S.pos.y) / dt;                   // following the ground up and down
    S.pos.y = gh + GEAR;
    // lift off once the wing carries the weight
    // (with the same ground-effect boost the wing gets just after lift-off, so there's no jump in lift)
    const geLift = 1 + GE_LIFT * Math.exp(-1.6 / GE_HEIGHT);
    if (K_LIFT * S.speed * S.speed * liftCoef(S.gPitch, S.flapPos) * geLift > G) {
      S.grounded = false; S.gamma = 0; S.pos.y += 0.002; // 2 mm clear of the runway: invisible, but not 'touching'
      S.vAir.copy(S.vel).sub(windVel);
      showMsg('Airborne!', 1.5);
    }
    return;
  }

  // ---- airborne ----
  up.set(0, 1, 0).applyQuaternion(S.quat);
  right.set(1, 0, 0).applyQuaternion(S.quat);
  if (S.vAir.lengthSq() < 0.01) S.vAir.copy(fwd).multiplyScalar(0.1);
  const V = S.vAir.length();
  _vhat.copy(S.vAir).divideScalar(V);
  const vf = S.vAir.dot(fwd), vu = S.vAir.dot(up), vr = S.vAir.dot(right);
  const alpha = Math.atan2(-vu, vf);        // + = airflow hitting the wing from below
  const beta = clamp(Math.atan2(vr, vf), -0.6, 0.6); // + = drifting to the right of the nose
  S.alpha = alpha; S.beta = beta;
  const sig = S.sigma = densityRatio(S.pos.y), rs = Math.sqrt(sig);
  const auth = clamp(V * rs / 40, 0.15, 1); // control authority grows with indicated airspeed

  // pitch: nose chases the commanded α; flight-path-rate and speed-rate feedback damp the phugoid
  // (the slow speed/altitude see-saw) so power changes settle into a steady climb or descent
  const gamma = Math.asin(clamp(_vhat.y, -1, 1));
  const gammaDot = clamp((gamma - S.gamma) / dt, -1, 1);
  S.gamma = gamma;
  // (the speed-rate term's nose-up side is capped: it's meant for small phugoid corrections, and the
  // hard acceleration of a takeoff roll would otherwise pitch the nose up sharply at lift-off; the
  // nose-down side stays, lowering the nose as speed bleeds off)
  const alphaCmd = ALPHA_TRIM + S.trim + ALPHA_FLAP * S.flapPos + ALPHA_POWER * S.throttle + ctl.pitch * ALPHA_STICK - 0.8 * gammaDot + Math.min(0.06 * S.vDot, 0.02);
  const qMax = PITCH_RATE_MAX * Math.max(auth, 0.4);
  S.q = damp(S.q, clamp(PITCH_STIFF * auth * (alphaCmd - alpha), -qMax, qMax), PITCH_LAG, dt);
  rotLocal(AX, S.q * dt);
  // roll: aileron rate, plus dihedral effect from sideslip (rudder rolls the plane too)
  S.pDih = damp(S.pDih, beta * 1.5 * auth, DIHEDRAL_LAG, dt);
  S.rRud = damp(S.rRud, -ctl.yaw * YAW_RATE * auth, YAW_LAG, dt); // the rudder's share of the yaw rate
  rotLocal(AZ, (-ctl.roll * ROLL_RATE * auth + S.pDih + ROLL_FROM_YAW * S.rRud) * dt);
  // yaw: rudder, plus weathervane stability into the relative wind
  S.r = damp(S.r, (-ctl.yaw * YAW_RATE - YAW_STIFF * beta) * auth, YAW_LAG, dt);
  rotLocal(AY, S.r * dt);

  // turbulence from gusts, wind and flying through cloud
  const { inside } = layerFactors(S.pos.y);
  const turb = Math.max(0, weather.gustKt - weather.windKt) * 0.012 + weather.windKt * 0.002 + inside * 0.12;
  if (turb > 0) {
    rotLocal(AZ, (noise(simTime * 1.7, 3.1) - 0.5) * turb * 4 * dt);
    rotLocal(AX, (noise(simTime * 1.3, 5.9) - 0.5) * turb * 2 * dt);
    S.vAir.y += (noise(simTime * 0.9, 9.2) - 0.5) * turb * 40 * dt;
  }
  S.quat.normalize();

  // forces (as accelerations)
  // ground effect: within about a wingspan of the surface the wing makes more lift and less induced
  // drag, which cushions the flare and makes the plane float
  const wingH = S.pos.y - GEAR + 1.6 - Math.max(groundHeight(S.pos.x, S.pos.z), 0);
  const ge = Math.exp(-Math.max(wingH, 0) / GE_HEIGHT);
  const CL = liftCoef(alpha, S.flapPos) * (1 + GE_LIFT * ge);
  const q = K_LIFT * sig * V * V;           // dynamic pressure term: ∝ ρV² = ∝ IAS²
  const lift = clamp(q * CL, -3 * G, 6 * G);
  _liftDir.crossVectors(right, _vhat).normalize();
  _acc.copy(fwd).multiplyScalar(thrustAt(S.throttle * enginePower(sig), V))
    .addScaledVector(_liftDir, lift)
    .addScaledVector(_vhat, -(drag * sig * V * V + q * CL * CL * K_INDUCED * (1 - GE_DRAG * ge)))
    .addScaledVector(right, -vr * 1.2 * auth); // side force bleeds off sideslip
  _acc.y -= G;
  S.vAir.addScaledVector(_acc, dt);
  S.tas = S.vAir.length();
  const newSpeed = S.tas * rs;              // indicated
  S.vDot = damp(S.vDot, (newSpeed - S.speed) / dt, 3, dt); // smoothed airspeed rate, m/s²
  S.speed = newSpeed;
  S.stalling = alpha > ALPHA_STALL - 0.035;

  S.vel.copy(S.vAir).add(windVel);
  S.pos.addScaledVector(S.vel, dt);

  const gh = groundHeight(S.pos.x, S.pos.z);
  if (S.pos.y - GEAR <= Math.max(gh, 0)) {
    if (gh < 0.3) return crash('ditched in the water');
    if (S.gearPos < 1) return crash(S.gearPos === 0 ? 'landed with the gear up' : 'gear not locked down');
    _e.setFromQuaternion(S.quat, 'YXZ');
    const sl = slopeAt(S.pos.x, S.pos.z);
    _h.set(-Math.sin(_e.y), 0, -Math.cos(_e.y));
    right.set(Math.cos(_e.y), 0, -Math.sin(_e.y));
    const tPitch = Math.atan(sl.sx * _h.x + sl.sz * _h.z), tRoll = Math.atan(sl.sx * right.x + sl.sz * right.z);
    // speed into the surface (along its normal), and attitude relative to it
    const n = _v.set(-sl.sx, 1, -sl.sz).normalize(), vs = Math.min(S.vel.dot(n), 0);
    const pitch = _e.x - tPitch, roll = _e.z - tRoll;
    if (sl.steep > MAX_LAND_SLOPE) return crash('flew into terrain');
    if (vs > -7 && Math.abs(roll) < 0.35 && pitch > -0.12 && pitch < 0.35) {
      S.grounded = true; S.stalling = false; S.heading = _e.y; S.gPitch = Math.max(0, pitch);
      S.tPitch = tPitch; S.tRoll = tRoll;
      S.pos.y = gh + GEAR;
      _h.set(-Math.sin(S.heading), 0, -Math.cos(S.heading));
      right.set(Math.cos(S.heading), 0, -Math.sin(S.heading));
      S.gs = Math.max(0, S.vel.dot(_h));
      S.gSide = S.vel.dot(right);                          // carried onto the runway, scrubbed off by the tyres
      S.gRoll = roll;                                      // settles level over a moment
      playSound('squeal');
      if (vs <= -2.5) playSound('thud');
      showMsg(vs > -2.5 ? 'Smooth landing!' : 'Hard landing', 2);
    } else {
      crash(vs <= -7 ? 'came down too fast' : 'bad attitude on impact');
    }
  }
}

let noseSteer = 0, wheelSpeed = 0;
function animatePlane(dt) {
  plane.g.position.copy(S.pos);
  plane.g.quaternion.copy(S.quat);
  plane.prop.rotation.z += S.rpm * 70 * dt;
  for (const f of plane.flaps) f.rotation.x = S.flapPos * 0.6;          // + = trailing edge down
  plane.ailerons[0].rotation.x = -ctl.roll * 0.35;                       // right aileron up for right roll
  plane.ailerons[1].rotation.x = ctl.roll * 0.35;
  // elevator: stick deflection plus the offset the trim tab holds it at (− = trailing edge up = nose up);
  // the tab itself deflects the opposite way to the trim it provides
  plane.elevator.rotation.x = -(ctl.pitch * 0.4 + S.trim * 2.5);
  plane.trimTab.rotation.x = S.trim * 5;
  plane.rudder.rotation.y = ctl.yaw * 0.4;
  // nose wheel follows the rudder pedals on the ground (its fork is also what steers the plane, see
  // NOSEWHEEL); once airborne it centres. All wheels roll with ground speed and spin down after lift-off.
  noseSteer = damp(noseSteer, S.grounded && !S.crashed && S.gPitch < 0.03 ? -ctl.yaw * 0.5 : 0, 8, dt);
  wheelSpeed = S.grounded ? S.gs : damp(wheelSpeed, 0, 0.6, dt);
  const up = 1 - S.gearPos;
  plane.legs.forEach((leg, i) => {
    if (i === 0) {
      leg.rotation.x = -up * Math.PI * 0.48;                              // nose folds aft into the nose
      leg.rotation.y = noseSteer;                                         // steering about the strut
    } else {
      leg.rotation.z = (i === 1 ? -1 : 1) * up * Math.PI * 0.5;           // mains fold inward under the wing
    }
    leg.userData.wheel.rotation.x -= wheelSpeed / 0.35 * dt;              // rolls forward (radius 0.35 m)
  });
  // windsock points downwind, droops when the wind is light
  const kt = windVel.length() * 1.944;
  for (const sock of windsocks) {
    sock.rotation.y = Math.atan2(windVel.x, windVel.z);
    sock.rotation.x = (1 - Math.min(kt / 15, 1)) * 1.3;
  }
}

// ---------- camera ----------
// Chase view: a world-level orbit. The camera sits behind the plane's (smoothed) heading; the mouse
// swings it around the vertical axis and raises/lowers it relative to the horizon. The horizon
// never tilts and elevation is capped short of straight up/down so lookAt can't flip.
// Cockpit view: head-look relative to the airframe.
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lookSm = { yaw: 0, pitch: 0 };              // lightly smoothed copy of `look`
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _lookQ = new THREE.Quaternion(), _aim = new THREE.Vector3();
const CHASE_ELEV = 0.25;                          // default height above the horizon, rad
let chaseYaw = 0;                                 // heading the chase camera sits behind
function recenterLook() {
  lookSm.yaw = wrapAngle(lookSm.yaw); // spin back the short way
  look.yaw = look.pitch = 0;
}
function updateCamera(dt) {
  const k = 1 - Math.exp(-dt * 25);
  lookSm.yaw += (look.yaw - lookSm.yaw) * k;
  lookSm.pitch += (look.pitch - lookSm.pitch) * k;
  _lookQ.setFromEuler(lookEuler.set(lookSm.pitch, lookSm.yaw, 0));

  if (camMode === 1 && !S.crashed) {
    camera.position.set(0, 1.15, -0.6).applyQuaternion(S.quat).add(S.pos);
    camera.quaternion.copy(S.quat).multiply(_lookQ);
    snapCam = true;
    return;
  }

  // follow the plane's heading (ignored while pointing nearly straight up/down, where it's undefined)
  fwd.set(0, 0, -1).applyQuaternion(S.quat);
  if (!S.crashed && Math.abs(fwd.y) < 0.97) {
    const hdg = Math.atan2(-fwd.x, -fwd.z);   // same convention as S.heading
    if (snapCam) chaseYaw = hdg;
    else chaseYaw += wrapAngle(hdg - chaseYaw) * (1 - Math.exp(-dt * 4));
  }
  snapCam = false;

  const dist = S.crashed ? Math.max(60, chaseDist) : chaseDist;
  const az = chaseYaw + lookSm.yaw;
  const el = clamp(CHASE_ELEV - lookSm.pitch, -1.35, 1.4); // mouse up = look up = camera lower
  camera.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    .multiplyScalar(dist).add(S.pos);
  camera.position.y = Math.max(camera.position.y, groundHeight(camera.position.x, camera.position.z) + 1.5, 1.5);

  // always aim at the plane itself, so orbiting with the mouse pivots around it
  _aim.copy(S.pos);
  if (!S.crashed) _aim.y += 0.4;
  camera.up.set(0, 1, 0);
  camera.lookAt(_aim);
}

// ---------- HUD ----------
const statsEl = $('stats'), warnEl = $('warn');
function headingRad() {
  fwd.set(0, 0, -1).applyQuaternion(S.quat);
  return Math.atan2(fwd.x, -fwd.z);
}
// altimeter reading: true altitude corrected for the difference between the set baro and actual QNH (~27 ft/hPa)
// Altimeter: set to QNH it reads field elevation on the ground; above the field it assumes standard
// temperatures, so in cold air it over-reads (you're lower than it shows) and in hot air under-reads.
const indicatedAltFt = () => {
  const hMid = (S.pos.y + RH) / 2;
  const ratio = (288.15 - LAPSE * hMid) / oatK(hMid);   // ISA / actual mean temperature of the layer
  return (RH + (S.pos.y - RH) * ratio) * 3.281 + (S.baro - weather.qnh) * 27.3;
};
function updateHud(dt) {
  const gh = Math.max(groundHeight(S.pos.x, S.pos.z), 0);
  const agl = S.pos.y - GEAR - gh;
  // everything else lives on the GPS unit and the instrument panel; only unusual modes show here
  const flags = [invert && 'PITCH INVERTED', audio.muted && 'SOUND OFF'].filter(Boolean);
  const fpsCol = fps.value >= 50 ? '' : fps.value >= 30 ? ' style="color:#ffd27a"' : ' style="color:#ff6a5a"';
  const flagTxt = (fps.show ? `<span class="fps"${fpsCol}>${fps.value.toFixed(0)} FPS · ${fps.ms.toFixed(1)} ms</span>` : '') +
    flags.map((f) => `<span>${f}</span>`).join('');
  if (statsEl.innerHTML !== flagTxt) statsEl.innerHTML = flagTxt;

  const air = !S.grounded && !S.crashed;
  const warns = [];
  if (air && S.vel.y < -15 && agl < -S.vel.y * 6) warns.push('PULL UP');
  if (S.stalling) warns.push('STALL');
  if (air && S.gearPos < 1 && agl < 150 && S.vel.y < -1) warns.push('GEAR');
  if (!S.crashed && S.flapPos > 0.05 && S.speed > FLAP_VMAX) warns.push('FLAP OVERSPEED');
  if (!S.crashed && S.speed * 1.944 > VNE) warns.push('OVERSPEED');
  warnEl.textContent = warns.join('  ·  ');
  warnEl.className = 'hud' + (warns.length ? ' blink' : '');

  if (msgTimer > 0 && (msgTimer -= dt) <= 0) $('msg').textContent = '';
}

// ---------- instrument panel (six pack) ----------
const panelEl = $('panel'), pctx = panelEl.getContext('2d');
const PW = 460, PH = 310, PDPR = 2, GR = 64;
panelEl.width = PW * PDPR; panelEl.height = PH * PDPR;
const VS0 = vStall(1) * 1.944, VS1 = vStall(0) * 1.944, VFE = FLAP_VMAX * 1.944, VNO = 130, VNE = 165; // kt

// gauge angles: 0 = 12 o'clock, clockwise
const pt = (a, r) => [Math.sin(a) * r, -Math.cos(a) * r];
function gFace(c) {
  c.fillStyle = '#0d0e10';
  c.beginPath(); c.arc(0, 0, GR, 0, TAU); c.fill();
  c.lineWidth = 4; c.strokeStyle = '#3a3d42'; c.stroke();
}
function gTick(c, a, r1, r2, w = 1.5, col = '#e8e8e8') {
  const [x1, y1] = pt(a, r1), [x2, y2] = pt(a, r2);
  c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'butt';
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
}
function gText(c, x, y, t, size = 11, col = '#e8e8e8') {
  c.fillStyle = col; c.font = `${size}px ui-monospace, monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(t, x, y);
}
function gHand(c, a, len, w, col = '#fff') {
  c.save(); c.rotate(a);
  c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round';
  c.beginPath(); c.moveTo(0, 8); c.lineTo(0, -len); c.stroke();
  c.restore();
}
function gArc(c, a1, a2, r, w, col) {
  c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'butt';
  c.beginPath(); c.arc(0, 0, r, a1 - Math.PI / 2, a2 - Math.PI / 2); c.stroke();
}
function gHub(c) { c.fillStyle = '#444'; c.beginPath(); c.arc(0, 0, 4, 0, TAU); c.fill(); }

function drawASI(c, ias) {
  gFace(c);
  const A = (kt) => clamp(kt, 0, 200) / 200 * TAU * 0.92;
  gArc(c, A(VS0), A(VFE), GR - 15, 5, '#f2f2f2');   // flap operating range
  gArc(c, A(VS1), A(VNO), GR - 8, 6, '#2fbf4a');    // normal operating range
  gArc(c, A(VNO), A(VNE), GR - 8, 6, '#f2c230');    // caution range
  for (let kt = 0; kt <= 200; kt += 10) gTick(c, A(kt), kt % 20 ? GR - 8 : GR - 12, GR - 3, 1.5);
  gTick(c, A(VNE), GR - 16, GR - 3, 3, '#e33');      // never exceed
  for (let kt = 20; kt <= 200; kt += 20) { const [x, y] = pt(A(kt), GR - 25); gText(c, x, y, String(kt), 9); }
  gText(c, 0, -18, 'IAS', 9, '#9aa');
  gText(c, 0, 20, `${ias.toFixed(0)} KT`, 10);
  gHand(c, A(ias), GR - 10, 3);
  gHub(c);
}

function drawAI(c, pitch, bank) {
  gFace(c);
  c.save();
  c.beginPath(); c.arc(0, 0, GR - 4, 0, TAU); c.clip();
  c.rotate(-bank);
  c.translate(0, clamp(pitch / D2R, -90, 90) * 2.2);
  c.fillStyle = '#2f78c4'; c.fillRect(-150, -400, 300, 400);
  c.fillStyle = '#7a4f2a'; c.fillRect(-150, 0, 300, 400);
  c.strokeStyle = '#fff'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(-150, 0); c.lineTo(150, 0); c.stroke();
  c.lineWidth = 1.2;
  for (let p = -30; p <= 30; p += 5) {
    if (!p) continue;
    const y = -p * 2.2, w = p % 10 ? 7 : 16;
    c.beginPath(); c.moveTo(-w, y); c.lineTo(w, y); c.stroke();
    if (!(p % 10)) { gText(c, -w - 9, y, String(Math.abs(p)), 8); gText(c, w + 9, y, String(Math.abs(p)), 8); }
  }
  c.restore();
  for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) gTick(c, b * D2R, GR - (Math.abs(b) % 30 ? 9 : 14), GR - 4, 1.6);
  c.fillStyle = '#fff';
  c.beginPath(); c.moveTo(0, -GR + 13); c.lineTo(-5, -GR + 4); c.lineTo(5, -GR + 4); c.closePath(); c.fill();
  c.save(); c.rotate(-bank); // bank pointer turns with the horizon card
  c.fillStyle = '#ffcc00';
  c.beginPath(); c.moveTo(0, -GR + 14); c.lineTo(-5, -GR + 23); c.lineTo(5, -GR + 23); c.closePath(); c.fill();
  c.restore();
  c.strokeStyle = '#ffcc00'; c.lineWidth = 3; c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-34, 0); c.lineTo(-12, 0); c.lineTo(-6, 6);
  c.moveTo(34, 0); c.lineTo(12, 0); c.lineTo(6, 6);
  c.stroke();
  c.fillStyle = '#ffcc00'; c.beginPath(); c.arc(0, 0, 2.5, 0, TAU); c.fill();
}

function drawALT(c, altFt, baroText) {
  gFace(c);
  for (let i = 0; i < 50; i++) gTick(c, i / 50 * TAU, i % 5 ? GR - 7 : GR - 12, GR - 3, i % 5 ? 1 : 1.8);
  for (let n = 0; n < 10; n++) { const [x, y] = pt(n / 10 * TAU, GR - 20); gText(c, x, y, String(n), 11); }
  // Kollsman window shows the altimeter setting
  c.fillStyle = '#000'; c.fillRect(-21, 15, 42, 14);
  c.strokeStyle = '#666'; c.lineWidth = 1; c.strokeRect(-21, 15, 42, 14);
  gText(c, 0, 22.5, baroText, 9, '#ffd27a');
  gText(c, 0, -17, 'ALT', 9, '#9aa');
  gHand(c, altFt / 10000 * TAU, 28, 5);   // thousands
  gHand(c, altFt / 1000 * TAU, GR - 10, 2.5); // hundreds
  gHub(c);
}

function drawBank(c, bank, rate, slip) {
  gFace(c);
  // wing tips sit on these marks: right tip at 90° + bank, left tip at 270° + bank
  for (const b of [0, 10, 20, 30, 45, 60]) for (const s of [1, -1]) {
    const w = b % 30 ? 1.2 : 2;
    gTick(c, (90 + s * b) * D2R, GR - (b % 30 ? 9 : 14), GR - 4, w);
    gTick(c, (270 + s * b) * D2R, GR - (b % 30 ? 9 : 14), GR - 4, w);
  }
  gText(c, ...pt(132 * D2R, GR - 22), 'R', 10, '#9aa');
  gText(c, ...pt(228 * D2R, GR - 22), 'L', 10, '#9aa');
  c.save(); c.rotate(bank);
  c.strokeStyle = '#fff'; c.lineCap = 'round';
  c.lineWidth = 4; c.beginPath(); c.moveTo(-46, 0); c.lineTo(46, 0); c.stroke();
  c.lineWidth = 3; c.beginPath(); c.moveTo(0, -7); c.lineTo(0, -15); c.stroke();
  c.fillStyle = '#fff'; c.beginPath(); c.arc(0, 0, 6, 0, TAU); c.fill();
  c.restore();
  const deg = bank / D2R;
  gText(c, 0, -30, 'BANK', 9, '#9aa');
  gText(c, 0, 20, `${Math.abs(deg).toFixed(0)}°${deg > 0.5 ? ' R' : deg < -0.5 ? ' L' : ''}`, 11);
  gText(c, 0, 32, `${Math.abs(rate).toFixed(1)}°/s`, 8, '#9aa');
  // slip ball
  c.fillStyle = '#1c1e21'; c.strokeStyle = '#666'; c.lineWidth = 1;
  c.beginPath(); c.roundRect ? c.roundRect(-24, 40, 48, 11, 5) : c.rect(-24, 40, 48, 11); c.fill(); c.stroke();
  c.strokeStyle = '#888';
  c.beginPath(); c.moveTo(-6, 40); c.lineTo(-6, 51); c.moveTo(6, 40); c.lineTo(6, 51); c.stroke();
  c.fillStyle = '#ddd'; c.beginPath(); c.arc(clamp(slip * 18, -18, 18), 45.5, 4.5, 0, TAU); c.fill();
}

// HSI: compass card + ILS course pointer, localizer deviation bar, glideslope scale and marker lights
function drawHSI(c, hdg) {
  const st = NAVAIDS[navIdx], isVor = st.type === 'vor';
  const course = isVor ? st.obs * D2R : st.course;
  gFace(c);
  c.save(); c.rotate(-hdg);
  for (let d = 0; d < 360; d += 5) gTick(c, d * D2R, d % 10 ? GR - 7 : GR - 12, GR - 3, d % 30 ? 1 : 1.8);
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = 0; d < 360; d += 30) {
    c.save(); c.rotate(d * D2R);
    gText(c, 0, -(GR - 22), names[d] ?? String(d / 10), names[d] ? 13 : 10, names[d] ? '#ffd27a' : '#e8e8e8');
    c.restore();
  }
  c.restore();

  // course pointer, deviation dots and bar turn with the card to the ILS course
  const MAG = '#e04de0';
  c.save(); c.rotate(course - hdg);
  c.fillStyle = '#ddd';
  for (const x of [-20, -10, 10, 20]) { c.beginPath(); c.arc(x, 0, 2, 0, TAU); c.fill(); }
  c.strokeStyle = MAG; c.fillStyle = MAG; c.lineWidth = 3; c.lineCap = 'butt';
  c.beginPath(); c.moveTo(0, -26); c.lineTo(0, -GR + 18); c.moveTo(0, 26); c.lineTo(0, GR - 14); c.stroke();
  c.beginPath(); c.moveTo(0, -GR + 9); c.lineTo(-6, -GR + 19); c.lineTo(6, -GR + 19); c.closePath(); c.fill();
  if (nav.locValid) {
    // TO/FROM arrow (Baron-style HSI): a white triangle on the course pointer's axis, behind the
    // deviation bar, so it turns with the course knob; it points at the course head (TO) or tail (FROM)
    if (nav.toFrom) {
      const f = nav.toFrom === 'TO' ? -1 : 1; // −y is the head of the course pointer
      c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, f * 23); c.lineTo(7, f * 12); c.lineTo(-7, f * 12); c.closePath(); c.fill(); c.stroke();
      c.strokeStyle = MAG; c.lineWidth = 3;
    }
    c.beginPath(); c.moveTo(nav.loc * 20, -24); c.lineTo(nav.loc * 20, 24); c.stroke();
  }
  c.restore();

  c.fillStyle = '#ff8c1a'; // lubber line
  c.beginPath(); c.moveTo(-5, -GR + 1); c.lineTo(5, -GR + 1); c.lineTo(0, -GR + 11); c.closePath(); c.fill();
  c.strokeStyle = '#ffcc00'; c.lineWidth = 2; c.lineCap = 'round'; // small aircraft symbol
  c.beginPath();
  c.moveTo(0, -8); c.lineTo(0, 8);
  c.moveTo(-9, -1); c.lineTo(9, -1);
  c.moveTo(-4, 6); c.lineTo(4, 6);
  c.stroke();

  // failure flags
  if (!nav.locValid) gText(c, -20, 34, isVor ? 'NAV' : 'LOC', 9, '#ff4a3a');
  if (!isVor && !nav.gsValid) gText(c, 20, 34, 'GS', 9, '#ff4a3a');

  // glideslope scale, in the gap right of the gauge
  const gx = 76;
  c.fillStyle = '#ddd';
  for (const y of [-20, -10, 10, 20]) { c.beginPath(); c.arc(gx, y, 2, 0, TAU); c.fill(); }
  c.strokeStyle = '#ddd'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(gx - 5, 0); c.lineTo(gx + 5, 0); c.stroke();
  if (nav.gsValid) {
    const y = -nav.gs * 20;
    c.fillStyle = MAG;
    c.beginPath(); c.moveTo(gx, y - 6); c.lineTo(gx + 5, y); c.lineTo(gx, y + 6); c.lineTo(gx - 5, y); c.closePath(); c.fill();
  }
  gText(c, gx, -30, 'GS', 8, '#9aa');

  // marker beacon lights, in the gap left of the gauge
  const lamp = (y, on, col, letter) => {
    c.fillStyle = on ? col : '#2a2c30';
    c.beginPath(); c.arc(-76, y, 7, 0, TAU); c.fill();
    gText(c, -76, y + 0.5, letter, 8, on ? '#000' : '#777');
  };
  lamp(-10, nav.om && markerLit('om'), '#4aa8ff', 'O');
  lamp(10, nav.mm && markerLit('mm'), '#ffb020', 'M');

  // tuned station, course + DME under the gauge
  const crs = String(Math.round(course / D2R) % 360 || 360).padStart(3, '0');
  gText(c, 0, 73, `${st.ident} ${st.freq} CRS ${crs}${nav.toFrom ? ' ' + nav.toFrom : ''} DME ${nav.dmeValid ? nav.dme.toFixed(1) : '---'}`, 8, '#9aa');
}

function drawVSI(c, fpm) {
  gFace(c);
  const A = (v) => (270 + clamp(v, -2000, 2000) / 2000 * 165) * D2R; // 0 at 9 o'clock, climb clockwise
  for (let v = -2000; v <= 2000; v += 100) gTick(c, A(v), v % 500 ? GR - 7 : GR - 12, GR - 3, v % 500 ? 1 : 1.8);
  for (let v = -2000; v <= 2000; v += 500) { const [x, y] = pt(A(v), GR - 21); gText(c, x, y, String(Math.abs(v / 100)), 9); }
  gText(c, -16, -22, 'UP', 9, '#9aa');
  gText(c, -16, 24, 'DN', 9, '#9aa');
  gText(c, 18, -7, 'VS', 9, '#9aa');
  gText(c, 18, 6, '×100', 8, '#9aa');
  gHand(c, A(fpm), GR - 10, 3);
  gHub(c);
}

function drawPanel() {
  const c = pctx;
  c.setTransform(PDPR, 0, 0, PDPR, 0, 0);
  c.clearRect(0, 0, PW, PH);
  c.fillStyle = 'rgba(22,24,28,0.85)';
  c.beginPath(); c.roundRect ? c.roundRect(0, 0, PW, PH, 14) : c.rect(0, 0, PW, PH); c.fill();
  _e.setFromQuaternion(S.quat, 'YXZ');
  const pitch = _e.x, bank = -_e.z;
  const gauges = [
    () => drawASI(c, S.speed * 1.944),
    () => drawAI(c, pitch, bank),
    () => drawALT(c, indicatedAltFt(), fmtQnh(S.baro, weather.unit)),
    () => drawBank(c, bank, turnRate, S.grounded ? 0 : S.beta * 10),
    () => drawHSI(c, headingRad()),
    () => drawVSI(c, S.vel.y * 196.85),
  ];
  gauges.forEach((draw, i) => {
    c.save();
    c.translate(80 + (i % 3) * 150, 80 + Math.floor(i / 3) * 150);
    draw();
    c.restore();
  });
}

// ---------- map ----------
const mapBase = (() => {
  const W = SEG + 1, c = document.createElement('canvas');
  c.width = c.height = W;
  const ctx = c.getContext('2d'), img = ctx.createImageData(W, W), d = img.data;
  const H = (ix, iz) => heights[clamp(iz, 0, SEG) * W + clamp(ix, 0, SEG)];
  for (let iz = 0; iz < W; iz++) for (let ix = 0; ix < W; ix++) {
    const h = H(ix, iz);
    let r, g, b;
    if (h < 0) {
      const t = clamp(-h / 80, 0, 1);
      r = 90 - 70 * t; g = 160 - 100 * t; b = 195 - 85 * t;
    } else {
      if (h < 5) [r, g, b] = [215, 200, 150];
      else if (h < 330) { const t = h / 330; r = 85 + 50 * t; g = 135 + 25 * t; b = 60 + 20 * t; }
      else if (h < 520) [r, g, b] = [125, 115, 100];
      else [r, g, b] = [240, 240, 245];
      // hillshade, lit from the north-west
      const shade = clamp(1 + ((H(ix - 1, iz) - H(ix + 1, iz)) + (H(ix, iz - 1) - H(ix, iz + 1))) / (2 * CELL) * 1.2, 0.55, 1.35);
      r *= shade; g *= shade; b *= shade;
    }
    const o = (iz * W + ix) * 4;
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
})();

const bigmap = $('bigmap');
// ILS feather on the charts: ±2° wedge 7.5 km out from the threshold with a notched tail
const featherOf = (ils) => {
  const L = 7500, w = L * Math.tan(2 * D2R), notch = 750, tz = ils.thrZ, fz = tz + ils.dir * L;
  return { w, tz, fz, nz: fz - ils.dir * notch };
};
const inFeather = (ils, x, z) => {
  const { w, tz, fz, nz } = featherOf(ils);
  const poly = [[0, tz], [-w, fz], [0, nz], [w, fz]];
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

// Big map view: wheel zooms about the cursor, drag pans, click tunes a VOR or the ILS feather,
// double-click re-centres on the island.
const bigView = { cx: 0, cz: 0, range: HALF };
const BIG_MIN = 600, BIG_MAX = HALF * 1.15;
const bigToWorld = (e) => {
  const r = bigmap.getBoundingClientRect(), sc = r.width / (2 * bigView.range);
  return { x: bigView.cx + (e.clientX - r.left - r.width / 2) / sc, z: bigView.cz + (e.clientY - r.top - r.height / 2) / sc, sc };
};
bigmap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = bigToWorld(e);
  bigView.range = clamp(bigView.range * (e.deltaY > 0 ? 1.2 : 1 / 1.2), BIG_MIN, BIG_MAX);
  const after = bigToWorld(e);              // keep the point under the cursor where it was
  bigView.cx += before.x - after.x; bigView.cz += before.z - after.z;
}, { passive: false });
let bigDrag = null;
bigmap.addEventListener('pointerdown', (e) => {
  bigDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
  bigmap.setPointerCapture(e.pointerId);
  bigmap.style.cursor = 'grabbing';
});
bigmap.addEventListener('pointermove', (e) => {
  if (!bigDrag || e.pointerId !== bigDrag.id) return;
  const { sc } = bigToWorld(e), dx = e.clientX - bigDrag.x, dy = e.clientY - bigDrag.y;
  bigDrag.moved += Math.abs(dx) + Math.abs(dy);
  bigDrag.x = e.clientX; bigDrag.y = e.clientY;
  bigView.cx = clamp(bigView.cx - dx / sc, -HALF, HALF);
  bigView.cz = clamp(bigView.cz - dy / sc, -HALF, HALF);
});
const endBigDrag = (e) => {
  if (!bigDrag || e.pointerId !== bigDrag.id) return;
  const wasClick = bigDrag.moved < 5;
  bigDrag = null;
  bigmap.style.cursor = '';
  if (!wasClick || e.type !== 'pointerup') return;
  // click: nearest VOR within 30 px, otherwise the ILS feather under the cursor
  const { x, z, sc } = bigToWorld(e);
  let best = -1, bestD = 30 / sc;
  VORS.forEach((v) => { const d = Math.hypot(x - v.x, z - v.z); if (d < bestD) { best = NAVAIDS.indexOf(v); bestD = d; } });
  if (best < 0) ILS.forEach((ils) => { if (inFeather(ils, x, z)) best = NAVAIDS.indexOf(ils); });
  if (best >= 0) tuneNav(best);
};
bigmap.addEventListener('pointerup', endBigDrag);
bigmap.addEventListener('pointercancel', endBigDrag);
bigmap.addEventListener('dblclick', () => { bigView.cx = bigView.cz = 0; bigView.range = HALF; });
function drawMap(cv, cx, cz, range, big) {
  const ctx = cv.getContext('2d'), n = cv.width, sc = n / (2 * range);
  const X = (x) => (x - cx) * sc + n / 2, Y = (z) => (z - cz) * sc + n / 2;
  ctx.fillStyle = '#143c6e';
  ctx.fillRect(0, 0, n, n);
  const span = (SEG + 1) * CELL * sc;
  ctx.drawImage(mapBase, X(-HALF - CELL / 2), Y(-HALF - CELL / 2), span, span);

  const rw = Math.max(RWY_HW * 2 * sc, 3);
  ctx.fillStyle = '#222'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
  ctx.fillRect(X(0) - rw / 2, Y(-RWY_HL), rw, RWY_HL * 2 * sc);
  ctx.strokeRect(X(0) - rw / 2, Y(-RWY_HL), rw, RWY_HL * 2 * sc);
  if (sc > 0.05) { // taxiways once zoomed in enough to see them
    ctx.fillStyle = '#444';
    for (const [x0, x1, z0, z1] of [TWY.apron, TWY.par, ...TWY.links]) ctx.fillRect(X(x0), Y(z0), (x1 - x0) * sc, (z1 - z0) * sc);
    ctx.fillStyle = '#9aa3ad';
    for (let i = 0; i < 3; i++) ctx.fillRect(X(70), Y(-140 + i * 60), 30 * sc, 40 * sc);
  }

  // ILS 36 localizer "feather": ±2° wedge out 15 km from the threshold with a notched tail, the left
  // half shaded (chart convention). Magenta when tuned.
  const tuned = NAVAIDS[navIdx];
  for (const ils of ILS) {
    const col = tuned === ils ? '#e04de0' : '#c0c8d0', { w, tz, fz, nz } = featherOf(ils);
    ctx.fillStyle = col + '55';
    ctx.beginPath(); ctx.moveTo(X(0), Y(tz)); ctx.lineTo(X(-w), Y(fz)); ctx.lineTo(X(0), Y(nz)); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = big ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(X(0), Y(tz)); ctx.lineTo(X(-w), Y(fz)); ctx.lineTo(X(0), Y(nz)); ctx.lineTo(X(w), Y(fz)); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(0), Y(tz)); ctx.lineTo(X(0), Y(nz)); ctx.stroke();
    ctx.setLineDash([]);
  }
  // tuned VOR: selected course line through the station
  if (tuned.type === 'vor') {
    const c = tuned.obs * D2R, L = 40000;
    ctx.strokeStyle = '#e04de0'; ctx.lineWidth = big ? 2 : 1.5;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(X(tuned.x - Math.sin(c) * L), Y(tuned.z + Math.cos(c) * L));
    ctx.lineTo(X(tuned.x + Math.sin(c) * L), Y(tuned.z - Math.cos(c) * L));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // VOR symbols: hexagon with a centre dot, ident beside it
  for (const v of VORS) {
    const vx = X(v.x), vy = Y(v.z), r = big ? 9 : 6, on = tuned === v;
    ctx.strokeStyle = on ? '#e04de0' : '#4fd8e8'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = on ? 2 : 1.5;
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) { const a = i / 6 * TAU; ctx[i ? 'lineTo' : 'moveTo'](vx + Math.cos(a) * r, vy + Math.sin(a) * r); }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(vx, vy, 1.6, 0, TAU); ctx.fill();
    ctx.font = `bold ${big ? 13 : 10}px monospace`; ctx.textAlign = 'left';
    ctx.fillStyle = '#000a'; ctx.fillText(v.ident, vx + r + 3, vy + 4);
    ctx.fillStyle = on ? '#ff8cf5' : '#bff4fa'; ctx.fillText(v.ident, vx + r + 2, vy + 3);
    if (big) { ctx.font = '10px monospace'; ctx.fillStyle = '#ddd'; ctx.fillText(v.freq, vx + r + 2, vy + 15); }
  }

  ctx.save();
  ctx.translate(X(S.pos.x), Y(S.pos.z));
  ctx.rotate(headingRad()); // north-up map, canvas rotation is clockwise
  const s = big ? 10 : 8;
  ctx.fillStyle = S.crashed ? '#ff5a4a' : '#ffd23f'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -s); ctx.lineTo(s * 0.7, s * 0.8); ctx.lineTo(0, s * 0.4); ctx.lineTo(-s * 0.7, s * 0.8);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#fff'; ctx.font = `bold ${big ? 20 : 12}px monospace`;
  ctx.textAlign = 'center'; ctx.fillText('N', n / 2, big ? 26 : 14);
  // scale bar: the largest round distance that fits in about a third of the width
  const bar = [100, 250, 500, 1000, 2000, 5000].filter((m) => m * sc <= n / 3).pop() || 100;
  ctx.textAlign = 'left'; ctx.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, 10, n - 18);
  ctx.fillRect(10, n - 12, bar * sc, 3);
}
function applyMapMode() { // M: GPS → GPS + big map → nothing
  gpsEl.style.display = mapMode === 2 ? 'none' : '';
  bigmap.style.display = mapMode === 1 ? 'block' : 'none';
}

// ---------- GPS / multifunction unit ----------
// Top-right box: nav radio + wind + baro on the left, moving map in the middle, flight data on the
// right, and an annunciator strip (gear, flaps, trim, park brake, lights) along the bottom.
const gpsEl = $('gps'), minimap = document.createElement('canvas');
const GPS_W = 520, GPS_H = 236, MAP_X = 116, MAP_Y = 12, MAP_S = 178;
const DATA_R = 410; // right edge of the flight-data column; the systems window sits beyond it
const GPS_RANGES = [500, 1000, 2500, 5000, 10000]; // map half-width, m
let gpsRange = 2, gpsDpr = 1;
function sizeGps() {
  gpsDpr = Math.min(devicePixelRatio || 1, 2);
  gpsEl.width = GPS_W * gpsDpr; gpsEl.height = GPS_H * gpsDpr;
  minimap.width = minimap.height = Math.round(MAP_S * gpsDpr);
}
sizeGps();
function drawGps() {
  const c = gpsEl.getContext('2d');
  c.setTransform(gpsDpr, 0, 0, gpsDpr, 0, 0);
  const rr = (x, y, w, h, r) => { c.beginPath(); c.roundRect(x, y, w, h, r); };
  const txt = (t, x, y, size, col, align = 'left', bold = false) => {
    c.font = `${bold ? 'bold ' : ''}${size}px ui-monospace, Menlo, Consolas, monospace`;
    c.fillStyle = col; c.textAlign = align; c.fillText(t, x, y);
  };
  const CYAN = '#4fd8e8', GREEN = '#5cf06a', MAG = '#ff5cf0', WHITE = '#f2f2f2', DIM = '#55606a', AMBER = '#ffb030';

  // bezel and screen
  rr(0.5, 0.5, GPS_W - 1, GPS_H - 1, 12); c.fillStyle = '#2a2c30'; c.fill(); c.strokeStyle = '#555a'; c.stroke();
  rr(8, 8, GPS_W - 16, 190, 4); c.fillStyle = '#05080b'; c.fill();

  // left column: nav radio, wind, baro
  const st = NAVAIDS[navIdx];
  txt('NAV', 14, 22, 10, CYAN);
  txt(st.type === 'vor' ? 'VOR' : 'ILS', 108, 22, 9, DIM, 'right');
  txt(st.freq, 14, 41, 19, GREEN, 'left', true);
  txt(st.type === 'vor' ? `${st.ident} ${st.name}`.slice(0, 15) : `${st.ident}  RW36`, 14, 55, 10, WHITE);
  txt('DME', 14, 70, 10, CYAN);
  txt(nav.dmeValid ? `${nav.dme.toFixed(1)} NM` : '---', 108, 70, 11, WHITE, 'right');
  txt('CRS', 14, 84, 10, CYAN);
  const crs = st.type === 'vor' ? st.obs : 360;
  txt(`${String(Math.round(crs) % 360 || 360).padStart(3, '0')}°${nav.toFrom && nav.locValid ? ' ' + nav.toFrom : ''}`, 108, 84, 11, MAG, 'right');
  c.fillStyle = '#ffffff22'; c.fillRect(12, 90, 96, 1);
  const windKt = windVel.length() * 1.944;
  txt('WIND', 14, 104, 10, CYAN);
  txt(windKt < 0.5 ? 'CALM' : `${String(Math.round(weather.curDir ?? weather.windDir) % 360 || 360).padStart(3, '0')}°/${windKt.toFixed(0)}`, 108, 104, 12, WHITE, 'right');
  if (windKt >= 0.5) { // arrow showing where the wind blows, north up
    c.save(); c.translate(40, 128); c.rotate(Math.atan2(windVel.x, -windVel.z));
    c.strokeStyle = WHITE; c.fillStyle = WHITE; c.lineWidth = 2;
    c.beginPath(); c.moveTo(0, 12); c.lineTo(0, -8); c.stroke();
    c.beginPath(); c.moveTo(0, -13); c.lineTo(5, -5); c.lineTo(-5, -5); c.closePath(); c.fill();
    c.restore();
  }
  // head/crosswind components on the tuned runway
  const wFrom = (weather.curDir ?? weather.windDir) * D2R;
  const rwyHdg = Math.cos(wFrom) >= 0 ? 0 : Math.PI; // runway 36 or 18, whichever is into the wind
  const head = windKt * Math.cos(wFrom - rwyHdg), cross = windKt * Math.sin(wFrom - rwyHdg);
  txt(rwyHdg ? 'RW18' : 'RW36', 76, 124, 8, DIM, 'right');
  txt(`${head >= 0 ? 'H' : 'T'}${Math.abs(head).toFixed(0)}`, 108, 124, 11, head >= 0 ? WHITE : AMBER, 'right');
  txt(`X${Math.abs(cross).toFixed(0)}${cross >= 0 ? 'R' : 'L'}`, 108, 140, 11, WHITE, 'right');
  c.fillStyle = '#ffffff22'; c.fillRect(12, 150, 96, 1);
  txt('BARO', 14, 164, 10, CYAN);
  txt(`${fmtQnh(S.baro, weather.unit)}`, 108, 164, 12, Math.abs(S.baro - weather.qnh) > 0.5 ? AMBER : WHITE, 'right');
  const oat = oatK(S.pos.y) - 273.15, da = densityAltFt(S.pos.y);
  txt('OAT', 14, 178, 9, CYAN); txt(`${oat.toFixed(0)}°C`, 58, 178, 10, WHITE, 'right');
  txt('DA', 64, 178, 9, CYAN); txt(`${Math.round(da / 100) * 100}`, 108, 178, 10, da > 3000 ? AMBER : WHITE, 'right');
  txt(`RNG ${GPS_RANGES[gpsRange] >= 1000 ? GPS_RANGES[gpsRange] / 1000 + 'km' : GPS_RANGES[gpsRange] + 'm'}`, 14, 192, 9, DIM);

  // moving map (north up)
  drawMap(minimap, S.pos.x, S.pos.z, GPS_RANGES[gpsRange], false);
  c.drawImage(minimap, MAP_X, MAP_Y, MAP_S, MAP_S);
  c.strokeStyle = '#ffffff30'; c.strokeRect(MAP_X + 0.5, MAP_Y + 0.5, MAP_S - 1, MAP_S - 1);

  // data column
  const gh = Math.max(groundHeight(S.pos.x, S.pos.z), 0);
  const gs = S.grounded ? S.gs : Math.hypot(S.vel.x, S.vel.z);
  const agl = (S.pos.y - GEAR - gh) * 3.281;
  const trk = gs > 1 ? (THREE.MathUtils.radToDeg(Math.atan2(S.vel.x, -S.vel.z)) + 360) % 360 : null;
  const dis = Math.hypot(S.pos.x, S.pos.z) / 1852; // to the airfield
  const ete = gs > 2 ? dis * 1852 / gs : null;
  const fields = [
    ['GS', `${(gs * 1.944).toFixed(0)}`, 'kt', WHITE],
    [`IAS  TAS ${(S.tas * 1.944).toFixed(0)}`, `${(S.speed * 1.944).toFixed(0)}`, 'kt', S.stalling ? AMBER : WHITE],
    ['AGL', `${Math.max(0, agl).toFixed(0)}`, 'ft', agl < 200 && !S.grounded ? AMBER : WHITE],
    ['TRK', trk === null ? '---' : `${String(Math.round(trk) % 360).padStart(3, '0')}°`, '', MAG],
    ['DIS APT', dis.toFixed(1), 'nm', MAG],
    ['ETE', ete === null || ete > 5999 ? '--:--' : `${Math.floor(ete / 60)}:${String(Math.floor(ete % 60)).padStart(2, '0')}`, '', WHITE],
  ];
  const DX = MAP_X + MAP_S + 4;
  fields.forEach(([label, value, unit, col], i) => {
    const y = MAP_Y + i * 30;
    c.fillStyle = '#ffffff14'; c.fillRect(DX, y, DATA_R - DX, 28);
    txt(label, DX + 4, y + 11, 9, CYAN);
    txt(value, DATA_R - 20, y + 25, 16, col, 'right', true);
    txt(unit, DATA_R - 4, y + 25, 9, DIM, 'right');
  });

  // systems window: throttle and trim gauges, flaps, gear
  const SX = DATA_R + 4, SW = GPS_W - 10 - SX, sy = MAP_Y;
  c.fillStyle = '#ffffff14'; c.fillRect(SX, sy, SW, MAP_S);
  const gTop = sy + 20, gH = 78, thrX = SX + 24, trimX = SX + SW - 30;
  txt('THR', thrX, sy + 12, 9, CYAN, 'center');
  txt('TRIM', trimX, sy + 12, 9, CYAN, 'center');
  // throttle: filled bar
  c.fillStyle = '#2a2d31'; c.fillRect(thrX - 7, gTop, 14, gH);
  const grad = c.createLinearGradient(0, gTop + gH, 0, gTop);
  grad.addColorStop(0, '#5fd35f'); grad.addColorStop(1, '#ffb347');
  const thrH = gH * S.throttle;
  c.fillStyle = grad; c.fillRect(thrX - 7, gTop + gH - thrH, 14, thrH);
  c.strokeStyle = '#ffffff40'; c.strokeRect(thrX - 7.5, gTop - 0.5, 15, gH + 1);
  txt(`${(S.throttle * 100).toFixed(0)}%`, thrX, gTop + gH + 14, 12, WHITE, 'center', true);
  // trim: vertical scale, nose up at the top, centre mark = neutral, pointer on the left
  const tr = S.trim > 0 ? S.trim / TRIM_UP : -S.trim / TRIM_DOWN, mid = gTop + gH / 2;
  c.fillStyle = '#2a2d31'; c.fillRect(trimX - 2, gTop, 4, gH);
  c.fillStyle = '#999'; c.fillRect(trimX - 8, mid - 0.5, 16, 1);
  for (const f of [-1, -0.5, 0.5, 1]) c.fillRect(trimX - 4, mid - f * gH / 2 - 0.5, 8, 1);
  const toY = mid - TRIM_TO / TRIM_UP * gH / 2;                     // takeoff mark
  c.fillStyle = '#ffb030'; c.fillRect(trimX + 2, toY - 1, 6, 2);
  txt('TO', trimX + 18, toY + 3, 7, '#ffb030', 'center');
  const trimNeutral = Math.abs(S.trim) < 0.002;
  c.fillStyle = trimNeutral ? WHITE : GREEN;
  const py = mid - tr * gH / 2;
  c.beginPath(); c.moveTo(trimX - 4, py); c.lineTo(trimX - 12, py - 5); c.lineTo(trimX - 12, py + 5); c.closePath(); c.fill();
  txt('UP', trimX + 7, gTop + 7, 8, DIM); txt('DN', trimX + 7, gTop + gH, 8, DIM);
  txt(trimNeutral ? 'NEU' : `${tr > 0 ? 'UP' : 'DN'}${Math.round(Math.abs(tr) * 100)}`, trimX, gTop + gH + 14, 11, trimNeutral ? WHITE : GREEN, 'center', true);
  c.fillStyle = '#ffffff22'; c.fillRect(SX + 4, sy + 120, SW - 8, 1);
  // flaps
  const flapMoving = Math.abs(S.flapPos - S.flapSet / 2) > 1e-3;
  txt('FLAPS', SX + 5, sy + 140, 9, CYAN);
  txt(`${Math.round(S.flapPos * 30)}°`, SX + SW - 5, sy + 141, 15, flapMoving ? AMBER : WHITE, 'right', true);
  // gear: three lights (green down and locked, red in transit, dark up)
  txt('GEAR', SX + 5, sy + 163, 9, CYAN);
  for (let i = 0; i < 3; i++) {
    c.beginPath(); c.arc(SX + SW - 34 + i * 12, sy + 160, 4.5, 0, TAU);
    c.fillStyle = S.gearPos === 1 ? GREEN : S.gearPos === 0 ? '#333' : '#ff4a3a'; c.fill();
  }
  txt(S.gearPos === 1 ? 'DOWN' : S.gearPos === 0 ? 'UP' : 'TRANSIT', SX + SW - 5, sy + 175, 8, S.gearPos === 1 ? GREEN : S.gearPos === 0 ? WHITE : '#ff4a3a', 'right');

  // annunciator strip: parking brake and lights
  const Y = 216;
  txt('PARK BRK', 14, Y + 4, 10, S.parkBrake ? '#ff4a3a' : DIM, 'left', S.parkBrake);
  txt('LIGHTS', 300, Y + 4, 10, CYAN);
  [['landing', 'LDG'], ['taxi', 'TXI'], ['nav', 'NAV'], ['strobe', 'STB']].forEach(([k, t], i) =>
    txt(t, 352 + i * 40, Y + 4, 11, lightsOn[k] ? GREEN : DIM, 'left', lightsOn[k]));
}

// ---------- sound ----------
// Everything is synthesized with WebAudio. Browsers only allow audio to start from a click or a
// non-modifier key press, so we (re)try on every one of those.
const audio = { ctx: null, muted: false, volume: 0.5 };
function initAudio() {
  if (audio.ctx) { if (audio.ctx.state === 'suspended' && !paused) audio.ctx.resume(); return; }
  const ctx = new AudioContext();
  const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const filter = (type, f, Q = 1) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; };
  const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noiseSrc = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };

  const master = gain(audio.muted ? 0 : audio.volume);
  master.connect(ctx.destination);

  // engine: buzzy oscillators, propeller "chop" via amplitude LFO
  const eFilter = filter('lowpass', 500, 2), chop = gain(0.7), eGain = gain(0);
  const o1 = osc('sawtooth', 40), o2 = osc('square', 20);
  o1.connect(eFilter);
  o2.connect(gain(0.35)).connect(eFilter);
  const lfo = osc('sine', 20);
  lfo.connect(gain(0.3)).connect(chop.gain);
  eFilter.connect(chop).connect(eGain).connect(master);
  // wind
  const wF = filter('bandpass', 500, 0.6), wG = gain(0);
  noiseSrc().connect(wF).connect(wG).connect(master);
  // ground roll rumble
  const rF = filter('lowpass', 150, 1), rG = gain(0);
  noiseSrc().connect(rF).connect(rG).connect(master);
  // stall horn
  const hG = gain(0);
  osc('square', 780).connect(filter('lowpass', 1800)).connect(hG).connect(master);
  // gear / flap motor whine
  const mG = gain(0);
  osc('sawtooth', 150).connect(filter('lowpass', 600)).connect(mG).connect(master);
  // marker beacon tone (400 Hz outer, 1300 Hz middle)
  const mkG = gain(0), mkOsc = osc('sine', 400);
  mkOsc.connect(mkG).connect(master);

  Object.assign(audio, { ctx, buf, master, gain, filter, o1, o2, lfo, eFilter, eGain, wF, wG, rF, rG, hG, mG, mkG, mkOsc });
}

function playSound(kind) {
  const a = audio;
  if (!a.ctx) return;
  const t = a.ctx.currentTime;
  const [type, f, Q, vol, dur] = {
    squeal: ['bandpass', 1900, 4, 0.5, 0.35],
    thud: ['lowpass', 160, 1, 0.9, 0.25],
    clunk: ['lowpass', 320, 2, 0.45, 0.15],
    click: ['bandpass', 2600, 3, 0.25, 0.04],
    crash: ['lowpass', 700, 0.7, 1.2, 2.5],
  }[kind];
  const src = a.ctx.createBufferSource();
  src.buffer = a.buf;
  const fl = a.filter(type, f, Q), g = a.gain(0);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  if (kind === 'crash') fl.frequency.exponentialRampToValueAtTime(80, t + dur);
  src.connect(fl).connect(g).connect(a.master);
  src.start(t, Math.random());
  src.stop(t + dur + 0.05);
}

function updateAudio() {
  const a = audio;
  if (!a.ctx) return;
  const t = a.ctx.currentTime, set = (p, v, tc = 0.08) => p.setTargetAtTime(v, t, tc);
  const alive = !S.crashed, rpm = S.rpm, v = S.speed;
  const f = 28 + 62 * rpm;
  set(a.o1.frequency, f); set(a.o2.frequency, f / 2); set(a.lfo.frequency, f / 2);
  set(a.eFilter.frequency, 250 + 1700 * rpm);
  set(a.eGain.gain, alive ? 0.12 + 0.25 * rpm : 0, alive ? 0.08 : 0.02);
  set(a.wF.frequency, 250 + v * 14);
  set(a.wG.gain, alive ? Math.min(1, (v / 85) ** 2) * (camMode === 1 ? 0.25 : 0.45) : 0);
  set(a.rF.frequency, 70 + S.gs * 5);
  set(a.rG.gain, alive && S.grounded ? Math.min(1, S.gs / 20) * 0.6 : 0, 0.04);
  set(a.hG.gain, S.stalling ? 0.05 : 0, 0.02);
  const motor = alive && (S.gearPos !== (S.gearDown ? 1 : 0) || S.flapPos !== S.flapSet / 2);
  set(a.mG.gain, motor ? 0.04 : 0, 0.05);
  const marker = nav.om ? 'om' : nav.mm ? 'mm' : null;
  if (marker) a.mkOsc.frequency.setValueAtTime(marker === 'om' ? 400 : 1300, t);
  set(a.mkG.gain, marker && markerLit(marker) ? 0.07 : 0, 0.005);
}

// ---------- weather panel ----------
const wxEl = $('wx');
const wxField = { vis: $('wxVis'), cloud: $('wxCloud'), base: $('wxBase'), thick: $('wxThick'), windDir: $('wxDir'), windVar: $('wxVar'), windKt: $('wxKt'), gustKt: $('wxGust'), tempC: $('wxTemp'), dewC: $('wxDew') };
function fillWx() {
  $('wxPreset').value = weather.preset;
  for (const [key, el] of Object.entries(wxField)) el.value = weather[key];
  $('wxUnit').value = weather.unit;
  $('wxTime').value = tod;
  $('wxQnh').value = fmtQnh(weather.qnh, weather.unit);
  updateMetar();
}
function readWx() {
  const num = (el, lo, hi, fallback) => { const v = parseFloat(el.value); return Number.isFinite(v) ? clamp(v, lo, hi) : fallback; };
  weather.vis = num(wxField.vis, 50, CLEAR_VIS, weather.vis);
  weather.cloud = wxField.cloud.value;
  weather.base = num(wxField.base, 0, 15000, weather.base);
  weather.thick = num(wxField.thick, 200, 10000, weather.thick);
  weather.windDir = num(wxField.windDir, 0, 360, weather.windDir);
  weather.windVar = num(wxField.windVar, 0, 180, weather.windVar);
  weather.windKt = num(wxField.windKt, 0, 60, weather.windKt);
  weather.gustKt = num(wxField.gustKt, 0, 80, weather.gustKt);
  weather.tempC = num(wxField.tempC, -40, 50, weather.tempC);
  weather.dewC = Math.min(weather.tempC, num(wxField.dewC, -50, 50, weather.dewC)); // can't exceed the temperature
  const q = parseFloat($('wxQnh').value);
  if (Number.isFinite(q)) weather.qnh = clamp(weather.unit === 'inHg' ? q * HPA_PER_INHG : q, 940, 1060);
}
function toggleWx(open = wxEl.style.display !== 'block') {
  wxEl.style.display = open ? 'block' : 'none';
  if (open) fillWx();
}
$('wxPreset').addEventListener('change', (e) => {
  if (e.target.value !== 'custom') Object.assign(weather, PRESETS[e.target.value]);
  weather.preset = e.target.value;
  applyWeather(); fillWx();
});
for (const el of [...Object.values(wxField), $('wxQnh')]) {
  el.addEventListener('change', () => {
    readWx();
    weather.preset = 'custom';
    applyWeather(); fillWx();
  });
}
$('wxTime').addEventListener('change', (e) => { setTimeOfDay(e.target.value); fillWx(); });
$('wxUnit').addEventListener('change', (e) => { weather.unit = e.target.value; fillWx(); });
$('wxSync').addEventListener('click', () => { S.baro = weather.qnh; showMsg(`Altimeter ${fmtQnh(S.baro, weather.unit)} ${weather.unit}`, 1.5); });
$('wxClose').addEventListener('click', () => toggleWx(false));

// ---------- input ----------
const canvas = renderer.domElement;
const startEl = $('start');
function dismissStart() { startEl.style.display = 'none'; }
startEl.addEventListener('click', () => {
  dismissStart();
  initAudio();
});

// Drag-to-look: hold a mouse button and drag. Deltas come from our own clientX bookkeeping rather
// than pointer-lock movementX, which some Linux browser setups report with the wrong sign.
let MOUSE_SENS = 0.006; // rad per pixel dragged (settings)
let dragId = null, dragX = 0, dragY = 0;
canvas.style.cursor = 'grab';
canvas.addEventListener('pointerdown', (e) => {
  initAudio();
  if (e.button === 1) { recenterLook(); e.preventDefault(); return; }
  dragId = e.pointerId;
  dragX = e.clientX;
  dragY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== dragId) return;
  const dx = e.clientX - dragX, dy = e.clientY - dragY;
  dragX = e.clientX;
  dragY = e.clientY;
  look.yaw -= dx * MOUSE_SENS; // drag right = look right
  // drag up = look up; limits keep the chase camera between ~77° below and ~80° above the horizon
  look.pitch = clamp(look.pitch - dy * MOUSE_SENS, -1.15, 1.45);
});
const endDrag = (e) => {
  if (e.pointerId !== dragId) return;
  dragId = null;
  canvas.style.cursor = 'grab';
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // allow right-drag
canvas.addEventListener('wheel', (e) => {
  chaseDist = clamp(chaseDist * (e.deltaY > 0 ? 1.12 : 1 / 1.12), 6, 120);
  e.preventDefault();
}, { passive: false });

const isModifier = (code) => /^(Shift|Control|Alt|Meta)/.test(code);
const comboOf = (e) => (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code;
const KEY_NAMES = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Semicolon: ';', Slash: '/', Comma: ',', Period: '.',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Quote: "'", Backquote: '`',
  Escape: 'Esc', Space: 'Space', Enter: 'Enter', Tab: 'Tab',
};
const keyName = (b) => b ? b.split('+').map((p) => KEY_NAMES[p] || p.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Num ')).join('+') : '';
const bindName = (id) => binds[id].filter(Boolean).map(keyName).join(' / ') || '—';
function findAction(combo) {
  for (const [id, b] of Object.entries(binds)) if (!ACTION[id].held && b.includes(combo)) return id;
  return null;
}

function setPanelVisible(v) {
  showPanel = v;
  panelEl.style.display = showPanel ? '' : 'none';
}
function setMuted(m) {
  audio.muted = m;
  if (audio.master) audio.master.gain.value = audio.muted ? 0 : audio.volume;
}
function setPaused(p) {
  paused = p;
  if (paused) { showMsg('PAUSED', 1e9); audio.ctx?.suspend(); }
  else { showMsg('', 0); audio.ctx?.resume(); }
}
function tuneNav(i) {
  navIdx = (i + NAVAIDS.length) % NAVAIDS.length;
  const st = NAVAIDS[navIdx];
  showMsg(st.type === 'vor'
    ? `${st.ident} ${st.name} VOR/DME ${st.freq} — CRS ${String(st.obs || 360).padStart(3, '0')}°`
    : `${st.name} ${st.ident} ${st.freq} — CRS 360°`, 2);
}
function turnObs(step) {
  const st = NAVAIDS[navIdx];
  if (st.type !== 'vor') { showMsg('ILS course is fixed (360°)', 1.2); return; }
  st.obs = (Math.round(st.obs) + step + 360) % 360;
  showMsg(`CRS ${String(st.obs || 360).padStart(3, '0')}°`, 0.8);
}
const toggleLight = (k, name) => {
  lightsOn[k] = !lightsOn[k];
  showMsg(`${name} ${lightsOn[k] ? 'ON' : 'OFF'}`, 1.2);
  playSound('click');
};
// what each one-shot action does
const RUN = {
  resetRunway: () => reset(false),
  airStart: () => reset(true),
  parkBrake: () => {
    if (S.crashed) return;
    S.parkBrake = !S.parkBrake;
    showMsg(S.parkBrake ? 'Parking brake SET' : 'Parking brake released', 1.5);
    playSound('clunk');
  },
  landingLight: () => toggleLight('landing', 'Landing light'),
  taxiLight: () => toggleLight('taxi', 'Taxi light'),
  navLights: () => toggleLight('nav', 'Nav lights + beacon'),
  strobes: () => toggleLight('strobe', 'Strobes'),
  timeOfDay: () => {
    const order = ['day', 'dusk', 'night'];
    setTimeOfDay(order[(order.indexOf(tod) + 1) % 3]);
    showMsg(tod[0].toUpperCase() + tod.slice(1), 1.2);
    if (wxEl.style.display === 'block') fillWx();
  },
  camera: () => { camMode = (camMode + 1) % 2; },
  recenter: () => recenterLook(),
  gear: () => {
    if (S.crashed) return;
    if (S.grounded) { showMsg('Gear stays down on the ground', 1.5); return; }
    S.gearDown = !S.gearDown;
    showMsg(S.gearDown ? 'Gear down' : 'Gear up', 1.2);
  },
  flapsUp: () => { S.flapSet = Math.max(0, S.flapSet - 1); showMsg(`Flaps ${FLAP_DEG[S.flapSet]}°`, 1.2); },
  flapsDown: () => { S.flapSet = Math.min(2, S.flapSet + 1); showMsg(`Flaps ${FLAP_DEG[S.flapSet]}°`, 1.2); },
  baroDown: () => { S.baro = clamp(S.baro - (weather.unit === 'inHg' ? HPA_PER_INHG / 100 : 1), 940, 1060); },
  baroUp: () => { S.baro = clamp(S.baro + (weather.unit === 'inHg' ? HPA_PER_INHG / 100 : 1), 940, 1060); },
  baroSync: () => { S.baro = weather.qnh; showMsg(`Altimeter ${fmtQnh(S.baro, weather.unit)} ${weather.unit}`, 1.5); },
  panel: () => setPanelVisible(!showPanel),
  weather: () => toggleWx(),
  ils: () => tuneNav(navIdx + 1),
  navPrev: () => tuneNav(navIdx - 1),
  obsDown: () => turnObs(-1),
  obsUp: () => turnObs(1),
  gpsOut: () => { gpsRange = Math.min(GPS_RANGES.length - 1, gpsRange + 1); },
  gpsIn: () => { gpsRange = Math.max(0, gpsRange - 1); },
  fps: () => { fps.show = !fps.show; },
  map: () => { mapMode = (mapMode + 1) % 3; applyMapMode(); },
  sound: () => setMuted(!audio.muted),
  invert: () => { invert = !invert; showMsg(invert ? `Pitch inverted (${keyName(binds.pitchDown[0])} = nose up)` : `Pitch normal (${keyName(binds.pitchDown[0])} = nose down)`, 1.5); },
  pause: () => setPaused(!paused),
  help: () => { helpEl.style.display = helpEl.style.display === 'none' ? '' : 'none'; },
  settings: () => toggleSettings(),
};

// ---------- help (built from the current bindings) ----------
const helpEl = $('help');
function renderHelp() {
  const k = (...ids) => `<kbd>${ids.map((id) => binds[id][0] ? keyName(binds[id][0]) : '—').join(' ')}</kbd>`;
  helpEl.innerHTML = [
    `${k('pitchDown', 'pitchUp')} pitch down/up &nbsp; ${k('rollLeft', 'rollRight')} roll &nbsp; ${k('yawLeft', 'yawRight')} rudder / nose-wheel steering`,
    `${k('throttleUp', 'throttleDown')} power up/down &nbsp; ${k('brakes')} brakes &nbsp; ${k('parkBrake')} park brake &nbsp; ${k('gear')} gear`,
    `${k('flapsUp', 'flapsDown')} flaps up/down &nbsp; ${k('trimDown', 'trimUp')} trim nose down/up`,
    `${k('baroDown', 'baroUp')} altimeter &nbsp; ${k('baroSync')} set QNH &nbsp; ${k('timeOfDay')} day / dusk / night`,
    `${k('landingLight')} landing light &nbsp; ${k('taxiLight')} taxi light &nbsp; ${k('navLights')} nav + beacon &nbsp; ${k('strobes')} strobes`,
    `<kbd>Drag</kbd> look around &nbsp; <kbd>Wheel</kbd> zoom &nbsp; ${k('recenter')} recenter &nbsp; ${k('camera')} camera`,
    `${k('panel')} instruments &nbsp; ${k('weather')} weather &nbsp; ${k('map')} map / GPS &nbsp; ${k('gpsOut', 'gpsIn')} GPS range &nbsp; ${k('sound')} sound`,
    `${k('resetRunway')} reset on runway &nbsp; ${k('airStart')} air start (on approach)`,
    `${k('ils')} tune next NAV (ILS / VOR) &nbsp; ${k('obsDown', 'obsUp')} VOR course −/+`,
    'Big map: wheel zoom, drag to pan, double-click to reset, click a VOR or the ILS feather to tune it',
    `${k('invert')} invert pitch &nbsp; ${k('pause')} pause &nbsp; ${k('fps')} FPS &nbsp; ${k('help')} hide help &nbsp; <kbd>Esc</kbd> settings`,
    `Take off: full power, ease ${k('pitchUp')} back at 60 kt, then relax to climb`,
    'PAPI: 2 white + 2 red = on glide path',
  ].join('<br>');
}

// ---------- settings panel ----------
const setEl = $('settings');
let capture = null, pausedBeforeSettings = false; // capture: { id, slot } while waiting for a key
const settings = { renderScale: 1, shadows: true };
function applyRenderScale() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * settings.renderScale);
  renderer.setSize(innerWidth, innerHeight);
  updateLightScale();
}
function applyShadows() {
  renderer.shadowMap.enabled = settings.shadows;
  sun.castShadow = settings.shadows;
  scene.traverse((o) => { for (const m of [].concat(o.material || [])) m.needsUpdate = true; }); // recompile with/without shadows
}
function renderBinds() {
  let html = '', group = '';
  for (const [id, label, g] of ACTIONS) {
    if (g !== group) { group = g; html += `<h4>${g}</h4>`; }
    html += `<div class="bind"><span>${label}</span>` + [0, 1].map((slot) => {
      const b = binds[id][slot], wait = capture && capture.id === id && capture.slot === slot;
      return `<button data-id="${id}" data-slot="${slot}" class="${wait ? 'wait' : b ? '' : 'empty'}">${wait ? 'press a key…' : b ? keyName(b) : '—'}</button>`;
    }).join('') + '</div>';
  }
  $('setBinds').innerHTML = html;
}
function fillSettings() {
  $('setInvert').checked = invert;
  $('setSens').value = MOUSE_SENS;
  $('setFov').value = camera.fov; $('setFovVal').textContent = `${camera.fov}°`;
  $('setHelp').checked = helpEl.style.display !== 'none';
  $('setFps').checked = fps.show;
  $('setPanel').checked = showPanel;
  $('setMap').value = mapMode;
  $('setScale').value = settings.renderScale;
  $('setShadows').checked = settings.shadows;
  $('setSound').checked = !audio.muted;
  $('setVol').value = audio.volume;
  renderBinds();
}
function toggleSettings(open = setEl.style.display !== 'block') {
  if (open === (setEl.style.display === 'block')) return;
  capture = null;
  setEl.style.display = open ? 'block' : 'none';
  if (open) {
    toggleWx(false);
    for (const c in keys) keys[c] = false;
    pausedBeforeSettings = paused;
    if (!paused) setPaused(true);
    $('setNote').textContent = '';
    fillSettings();
  } else if (!pausedBeforeSettings) setPaused(false);
}
$('setInvert').addEventListener('change', (e) => { invert = e.target.checked; });
$('setSens').addEventListener('input', (e) => { MOUSE_SENS = +e.target.value; });
$('setFov').addEventListener('input', (e) => {
  camera.fov = +e.target.value; camera.updateProjectionMatrix(); updateLightScale();
  $('setFovVal').textContent = `${camera.fov}°`;
});
$('setHelp').addEventListener('change', (e) => { helpEl.style.display = e.target.checked ? '' : 'none'; });
$('setFps').addEventListener('change', (e) => { fps.show = e.target.checked; });
$('setPanel').addEventListener('change', (e) => setPanelVisible(e.target.checked));
$('setMap').addEventListener('change', (e) => { mapMode = +e.target.value; applyMapMode(); });
$('setScale').addEventListener('change', (e) => { settings.renderScale = +e.target.value; applyRenderScale(); });
$('setShadows').addEventListener('change', (e) => { settings.shadows = e.target.checked; applyShadows(); });
$('setSound').addEventListener('change', (e) => { initAudio(); setMuted(!e.target.checked); });
$('setVol').addEventListener('input', (e) => { audio.volume = +e.target.value; setMuted(audio.muted); });
$('setClose').addEventListener('click', () => toggleSettings(false));
$('setBtn').addEventListener('click', (e) => { e.currentTarget.blur(); initAudio(); toggleSettings(); });
$('setReset').addEventListener('click', () => {
  binds = defaultBinds(); capture = null;
  $('setNote').textContent = 'Controls reset to defaults.';
  renderBinds(); renderHelp(); savePrefs();
});
$('setBinds').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  capture = { id: btn.dataset.id, slot: +btn.dataset.slot };
  $('setNote').textContent = `Press a key for “${ACTION[capture.id].label}”…`;
  renderBinds();
});
// ---------- saved preferences ----------
// Bindings and the settings above live in this browser's localStorage under one key. Nothing is
// sent anywhere. Storage can be unavailable (private mode, blocked site data), so every access is
// wrapped and the sim just runs on defaults.
const PREFS_KEY = 'xsim-flightsim-prefs-v1';
function savePrefs() {
  const prefs = {
    binds, invert, mouseSens: MOUSE_SENS, fov: camera.fov, help: helpEl.style.display !== 'none', fps: fps.show,
    panel: showPanel, mapMode, renderScale: settings.renderScale, shadows: settings.shadows, muted: audio.muted, volume: audio.volume,
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}
function loadPrefs() {
  let p;
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { p = null; }
  if (!p || typeof p !== 'object') return;
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? clamp(v, lo, hi) : d);
  if (p.binds && typeof p.binds === 'object') {
    for (const id of Object.keys(binds)) {
      const b = p.binds[id];
      if (Array.isArray(b)) binds[id] = [0, 1].map((i) => (typeof b[i] === 'string' && b[i] && !b[i].endsWith('Escape') ? b[i] : null));
    }
  }
  invert = !!p.invert;
  MOUSE_SENS = num(p.mouseSens, 0.002, 0.016, MOUSE_SENS);
  camera.fov = num(p.fov, 45, 95, camera.fov); camera.updateProjectionMatrix();
  if (p.help === false) helpEl.style.display = 'none';
  if (typeof p.fps === 'boolean') fps.show = p.fps;
  if (p.panel === false) setPanelVisible(false);
  if ([0, 1, 2].includes(p.mapMode)) mapMode = p.mapMode;
  if ([0.5, 0.75, 1].includes(p.renderScale)) settings.renderScale = p.renderScale;
  if (typeof p.shadows === 'boolean') settings.shadows = p.shadows;
  audio.muted = !!p.muted;
  audio.volume = num(p.volume, 0, 1, audio.volume);
  applyRenderScale();
  if (!settings.shadows) applyShadows();
  applyMapMode();
}
// any change in the settings panel is saved right away
setEl.addEventListener('change', savePrefs);
setEl.addEventListener('input', savePrefs);
$('setResetAll').addEventListener('click', () => {
  try { localStorage.removeItem(PREFS_KEY); } catch { /* storage unavailable */ }
  binds = defaultBinds(); capture = null;
  invert = false; MOUSE_SENS = 0.006;
  camera.fov = 65; camera.updateProjectionMatrix(); updateLightScale();
  helpEl.style.display = ''; fps.show = true; setPanelVisible(true);
  mapMode = 0; applyMapMode();
  settings.renderScale = 1; applyRenderScale();
  if (!settings.shadows) { settings.shadows = true; applyShadows(); }
  audio.volume = 0.5; setMuted(false);
  fillSettings(); renderHelp();
  $('setNote').textContent = 'All settings reset to defaults.';
});

// the key press that completes a rebind
function captureKey(e) {
  e.preventDefault();
  if (isModifier(e.code)) return;                     // wait for the real key
  const { id, slot } = capture;
  capture = null;
  if (e.code === 'Escape') { $('setNote').textContent = 'Cancelled (Esc is reserved for settings).'; renderBinds(); return; }
  if (e.code === 'Backspace' || e.code === 'Delete') {
    binds[id][slot] = null;
    $('setNote').textContent = `Cleared ${ACTION[id].label}.`;
  } else {
    // held actions ignore modifiers, so they bind the bare key
    const combo = ACTION[id].held ? e.code : comboOf(e);
    let moved = '';
    for (const [other, b] of Object.entries(binds)) {
      for (let i = 0; i < 2; i++) {
        if (b[i] === combo && !(other === id && i === slot)) { b[i] = null; moved = ACTION[other].label; }
      }
    }
    binds[id][slot] = combo;
    $('setNote').textContent = `${ACTION[id].label}: ${keyName(combo)}` + (moved && moved !== ACTION[id].label ? ` (removed from “${moved}”)` : '');
  }
  renderBinds(); renderHelp(); savePrefs();
}

addEventListener('keydown', (e) => {
  if (setEl.style.display === 'block') {
    if (capture) return captureKey(e);
    if (e.code === 'Escape' || findAction(comboOf(e)) === 'settings') { e.preventDefault(); toggleSettings(false); }
    return; // menu open: no flying
  }
  if (e.target instanceof HTMLElement && e.target.closest('#wx')) {
    if (e.code === 'Escape') toggleWx(false);
    return; // typing in the weather panel
  }
  keys[e.code] = true;
  if (!isModifier(e.code)) { initAudio(); dismissStart(); }
  if (e.code === 'Escape') { e.preventDefault(); if (!e.repeat) toggleSettings(true); return; } // always available
  const combo = comboOf(e);
  // exact combo first; with modifiers held, fall back to the bare key unless that combo is unbound
  const id = findAction(combo) ?? (combo !== e.code ? findAction(e.code) : null);
  const isHeldKey = ACTIONS.some(([a]) => ACTION[a].held && binds[a].includes(e.code));
  if (id || isHeldKey || e.code === 'Space') e.preventDefault(); // no page scroll / quick-find on '/' etc.
  if (!id || (e.repeat && id !== 'obsUp' && id !== 'obsDown')) return; // the course knob spins with key repeat
  RUN[id]();
  if (['invert', 'fps', 'help', 'panel', 'map', 'sound'].includes(id)) savePrefs();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const c in keys) keys[c] = false; });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  updateLightScale();
  sizeGps();
});

// ---------- loop ----------
setTimeOfDay('day');
loadPrefs();
renderHelp();
applyWeather();
reset(false);
applyMapMode();
updateLightScale();
const _rdir = new THREE.Vector3();
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const rawDt = clock.getDelta(), dt = Math.min(rawDt, 0.05);
  fps.frames++; fps.time += rawDt;
  if (fps.time >= 0.5) { fps.value = fps.frames / fps.time; fps.ms = fps.time * 1000 / fps.frames; fps.frames = 0; fps.time = 0; }
  if (!paused) {
    const sub = 4;
    for (let i = 0; i < sub; i++) step(dt / sub);
    animatePlane(dt);
    const hdg = headingRad();
    let dh = hdg - prevHdg;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    prevHdg = hdg;
    if (dt > 0) turnRate = damp(turnRate, dh / dt / D2R, 4, dt);
  }
  updateCamera(dt);
  updateWeatherVisuals();
  updateNav();
  updateHud(dt);
  if (showPanel) drawPanel();
  updatePapi(S.pos);
  updateAirportLights(airportLightsOn(), simTime, _rdir.set(0, 0, -1).applyQuaternion(S.quat).z <= 0 ? 1 : -1);
  planeLights(simTime);
  updateAudio();
  if (mapMode !== 2) drawGps();
  if (mapMode === 1) drawMap(bigmap, bigView.cx, bigView.cz, bigView.range, true);
  sky.position.copy(camera.position);
  sun.position.copy(S.pos).addScaledVector(sunDir, 300);
  sun.target.position.copy(S.pos);
  renderer.render(scene, camera);
});
