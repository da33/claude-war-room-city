// Claude 戰情城 — 3D renderer: a three.js city with bloom, an orbiting camera and live effects.
// Same meaning as the 2D view: height = today's energy, roof effect = current activity,
// smoke = local CPU, light pulses on the power lines = tokens being spent.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const V3 = THREE.Vector3;
const canvas = $('city');
const lcv = $('labels');
const lctx = lcv.getContext('2d');
let W = 0, H = 0, DPR = 1;

// ---------- renderer, scene, camera ----------

let gl;
try {
  gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  location.search = '?v=2d'; // no WebGL here
  throw e;
}
gl.toneMapping = THREE.ACESFilmicToneMapping;
gl.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const HORIZON = 0x081026; // fog and the bottom of the sky match, so the floor melts into it
scene.fog = new THREE.FogExp2(HORIZON, 0.035);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, {
  enableDamping: true, dampingFactor: 0.08, autoRotate: true, autoRotateSpeed: 0.35,
  maxPolarAngle: 1.32, minDistance: 2.5, maxDistance: 45,
});
controls.target.set(0, 0.5, 0);

const composer = new EffectComposer(gl);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.4, 0.35);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- shared geometry & materials ----------

const BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0); // base at y = 0
const CUBE = new THREE.BoxGeometry(1, 1, 1);
const BALL = new THREE.SphereGeometry(1, 20, 14);
const RING = new THREE.RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2);
const ORBIT = new THREE.TorusGeometry(0.42, 0.006, 6, 64);
const EDGES = new THREE.EdgesGeometry(BOX);

const glow = (color, intensity) => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity });
const additive = (color, opacity) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});
const M = {
  amber: glow(COL.work, 1.5), soft: glow('#ffd890', 1.1), cyan: glow(COL.wait, 1.8), white: glow('#fff3d6', 1.6),
  red: glow(COL.hot, 2), green: glow('#5dffa8', 1.8),
  metal: new THREE.MeshStandardMaterial({ color: 0x8a7a64, metalness: 0.6, roughness: 0.4 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x3a3f52, roughness: 0.7 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x1c2440, roughness: 0.6, metalness: 0.3 }),
  lot: new THREE.MeshStandardMaterial({ color: 0x121b33, roughness: 0.85 }),
};

const PASS_VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

// A light beam that is brightest at its base (uv.y = 0) and fades away from it.
function beamMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: opacity } },
    vertexShader: PASS_VS,
    fragmentShader: 'uniform vec3 color; uniform float opacity; varying vec2 vUv; void main() { gl_FragColor = vec4(color, pow(1.0 - vUv.y, 1.6) * opacity); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// Window textures: grey-scale lit windows on black, tinted per state through emissive.
// 0/1 are two full patterns swapped to flicker while working; then mid, low, almost dark.
const WIN_TEX = [0.85, 0.85, 0.6, 0.3, 0.07].map((density, v) => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 256);
  for (let r = 0; r < 16; r++) {
    for (let k = 0; k < 4; k++) {
      const lum = hash(v * 7 + 3, r, k) < density ? 150 + hash(v, r, k, 9) * 105 : 12;
      g.fillStyle = `rgb(${lum},${lum},${lum})`;
      g.fillRect(k * 32 + 7, r * 16 + 4, 18, 8);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
});
const WIN = { work: [COL.work, 1.2], wait: [COL.wait, 0.9], idle: ['#b8c3de', 0.6], off: ['#6d7891', 0.45] };
const EDGE = { work: COL.work, wait: COL.wait, idle: '#46526e', off: '#262d3f' };
const ENERGY = new THREE.Color(COL.energy);
const heightOf = e => Math.min(4.2, 0.28 + 0.8 * Math.log10(1 + e / 20000));

// ---------- sky, lights, ground ----------

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { top: { value: new THREE.Color(0x02040a) }, bottom: { value: new THREE.Color(HORIZON) }, heat: { value: 0 } },
  vertexShader: 'varying float vY; void main() { vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform float heat; varying float vY;
    void main() {
      float k = smoothstep(0.0, 0.5, vY);
      gl_FragColor = vec4(mix(bottom, top, k) + vec3(0.6, 0.06, 0.03) * heat * (1.0 - k) * 0.3, 1.0);
    }`,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), skyMat));

const stars = (() => {
  const n = 900, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * Math.PI * 2, v = 0.08 + Math.random() * 1.4, r = 120;
    pos.set([Math.cos(u) * Math.cos(v) * r, Math.sin(v) * r, Math.sin(u) * Math.cos(v) * r], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xcfe0ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false, depthWrite: false,
  }));
  scene.add(pts);
  return pts;
})();

scene.add(new THREE.HemisphereLight(0x4a62a8, 0x06070c, 1.1));
const moon = new THREE.DirectionalLight(0xa8bcff, 1.2);
moon.position.set(-8, 14, 6);
scene.add(moon);
const glows = Array.from({ length: 6 }, () => { // roof lights for working / waiting buildings
  const l = new THREE.PointLight(COL.work, 0, 3.5, 1.5);
  scene.add(l);
  return l;
});

const floor = new THREE.Mesh(new THREE.CircleGeometry(140, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x03050b, roughness: 1 }));
floor.position.y = -0.5;
scene.add(floor);

const groundGroup = new THREE.Group();
scene.add(groundGroup);
const SLAB = new THREE.MeshStandardMaterial({ color: 0x0b1324, roughness: 0.9, metalness: 0.15 });
const RIM = new THREE.LineBasicMaterial({ color: 0x2f62c0 });
const ROAD = new THREE.MeshStandardMaterial({ color: 0x16203a, roughness: 0.55, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -1 });
const DASH = new THREE.LineDashedMaterial({ color: 0x3b5ca0, dashSize: 0.1, gapSize: 0.12 });

function buildGround() {
  for (const o of groundGroup.children) o.geometry.dispose();
  groundGroup.clear();
  const G = ringR + 1.5, S = G * 2;
  const slab = new THREE.BoxGeometry(S, 0.5, S).translate(0, -0.25, 0);
  groundGroup.add(new THREE.Mesh(slab, SLAB), new THREE.LineSegments(new THREE.EdgesGeometry(slab), RIM));
  for (let k = -ringR - 2; k <= ringR + 1; k++) {
    const v = k + 0.5;
    const dx = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(-G, 0.008, v), new V3(G, 0.008, v)]), DASH);
    const dz = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(v, 0.008, -G), new V3(v, 0.008, G)]), DASH);
    dx.computeLineDistances();
    dz.computeLineDistances();
    groundGroup.add(
      new THREE.Mesh(new THREE.PlaneGeometry(S, 0.17).rotateX(-Math.PI / 2).translate(0, 0.004, v), ROAD),
      new THREE.Mesh(new THREE.PlaneGeometry(0.17, S).rotateX(-Math.PI / 2).translate(v, 0.004, 0), ROAD),
      dx, dz,
    );
  }
}

// a ring of light that sweeps out from the power plant across the city
const groundPulse = new THREE.Mesh(RING, additive(COL.wait, 0));
groundPulse.position.y = 0.012;
scene.add(groundPulse);

// ---------- particles: smoke (normal blend) and glow (additive) ----------

const MAXP = 2400;
function particleLayer(blending) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAXP * 3), col = new Float32Array(MAXP * 4), size = new Float32Array(MAXP);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('rgba', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    uniforms: { scale: { value: 500 } }, transparent: true, depthWrite: false, blending,
    vertexShader: `attribute float size; attribute vec4 rgba; uniform float scale; varying vec4 vColor;
      void main() {
        vColor = rgba;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `varying vec4 vColor;
      void main() {
        float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
        gl_FragColor = vec4(vColor.rgb, vColor.a * a);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  return { list: [], pos, col, size, geo, mat };
}
const smokeLayer = particleLayer(THREE.NormalBlending);
const glowLayer = particleLayer(THREE.AdditiveBlending);

const C = {
  smoke: new THREE.Color('#aeb8cf'), hot: new THREE.Color('#ff7a60'), steam: new THREE.Color('#cfe2ff'),
  factory: new THREE.Color('#9a9aa6'), spark: new THREE.Color(COL.energy), spark2: new THREE.Color(COL.work),
  head: new THREE.Color('#fff4dc'), tail: new THREE.Color('#ff4646'),
};

function puff(layer, x, y, z, o) {
  if (layer.list.length >= MAXP) return;
  layer.list.push({ x, y, z, vx: 0, vy: 0, vz: 0, ay: 0, life: 0, max: 3, s0: 0.1, s1: 0.5, a: 0.35, c: C.smoke, smoke: true, ...o });
}

// Advance one layer and upload it; `extra` are single-frame points [x, y, z, size, color, alpha].
function stepLayer(L, dt, extra) {
  let n = 0;
  const put = (x, y, z, s, c, a) => {
    if (n >= MAXP) return;
    L.pos[n * 3] = x; L.pos[n * 3 + 1] = y; L.pos[n * 3 + 2] = z;
    L.col[n * 4] = c.r; L.col[n * 4 + 1] = c.g; L.col[n * 4 + 2] = c.b; L.col[n * 4 + 3] = a;
    L.size[n] = s;
    n++;
  };
  L.list = L.list.filter(p => (p.life += dt) < p.max);
  for (const p of L.list) {
    p.vy += p.ay * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    const k = p.life / p.max;
    put(p.x, p.y, p.z, p.s0 + (p.s1 - p.s0) * k, p.c, (p.smoke ? Math.min(1, k * 6) * (1 - k) : 1 - k) * p.a);
  }
  for (const e of extra) put(...e);
  L.geo.setDrawRange(0, n);
  for (const k of ['position', 'rgba', 'size']) L.geo.attributes[k].needsUpdate = true;
}

// ---------- roof effects (built on first use, one set per building) ----------

const _w = new V3();

function gearMesh(r, teeth, mat) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.05, 24).rotateX(Math.PI / 2), mat));
  for (let i = 0; i < teeth; i++) {
    const a = i / teeth * Math.PI * 2, tooth = new THREE.Mesh(CUBE, mat);
    tooth.scale.set(r * 0.45, r * 0.4, 0.05);
    tooth.position.set(Math.cos(a) * r * 1.1, Math.sin(a) * r * 1.1, 0);
    tooth.rotation.z = a;
    g.add(tooth);
  }
  return g;
}

const FX = {
  bash() { // turning gears
    const g = new THREE.Group(), face = new THREE.Group();
    const pole = new THREE.Mesh(BOX, M.metal);
    pole.scale.set(0.025, 0.3, 0.025);
    const big = gearMesh(0.13, 10, M.amber), small = gearMesh(0.08, 8, M.soft);
    big.position.y = 0.42;
    small.position.set(0.2, 0.32, 0.02);
    face.add(big, small);
    g.add(pole, face);
    g.userData.tick = t => {
      big.rotation.z = t * 2.6;
      small.rotation.z = -t * 4.2;
      face.getWorldPosition(_w);
      face.lookAt(camera.position.x, _w.y, camera.position.z); // always show the gear face
    };
    return g;
  },
  edit() { // tower crane
    const g = new THREE.Group();
    const mast = new THREE.Mesh(BOX, M.amber);
    mast.scale.set(0.035, 0.9, 0.035);
    mast.position.set(-0.12, 0, -0.12);
    const jib = new THREE.Group();
    jib.position.set(-0.12, 0.9, -0.12);
    const arm = new THREE.Mesh(CUBE, M.amber);
    arm.scale.set(0.85, 0.03, 0.03);
    arm.position.x = 0.25;
    const weight = new THREE.Mesh(CUBE, M.metal);
    weight.scale.set(0.12, 0.08, 0.08);
    weight.position.x = -0.16;
    const cable = new THREE.Mesh(CUBE, M.soft), hook = new THREE.Mesh(CUBE, M.soft);
    cable.position.x = hook.position.x = 0.62;
    hook.scale.set(0.07, 0.06, 0.07);
    jib.add(arm, weight, cable, hook);
    const tip = new THREE.Mesh(BALL, M.red);
    tip.scale.setScalar(0.028);
    tip.position.set(-0.12, 0.94, -0.12);
    g.add(mast, jib, tip);
    g.userData.tick = t => {
      jib.rotation.y = 0.7 + Math.sin(t * 0.55) * 1.3;
      const drop = 0.28 + Math.sin(t * 1.6) * 0.12;
      cable.scale.set(0.006, drop, 0.006);
      cable.position.y = -drop / 2;
      hook.position.y = -drop - 0.03;
      tip.visible = Math.sin(t * 6) > 0;
    };
    return g;
  },
  read() { // sweeping searchlight
    const g = new THREE.Group(), spin = new THREE.Group(), tilt = new THREE.Group();
    const lamp = new THREE.Mesh(BALL, M.white);
    lamp.scale.setScalar(0.06);
    lamp.position.y = spin.position.y = 0.08;
    tilt.rotation.z = 0.5;
    tilt.add(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.03, 3.6, 24, 1, true).translate(0, 1.8, 0), beamMaterial('#ffecbe', 0.45)));
    spin.add(tilt);
    g.add(lamp, spin);
    g.userData.tick = t => { spin.rotation.y = t * 0.9; };
    return g;
  },
  web() { // antenna sending radio rings
    const g = new THREE.Group();
    const mast = new THREE.Mesh(BOX, M.metal);
    mast.scale.set(0.025, 0.7, 0.025);
    const bar = new THREE.Mesh(CUBE, M.metal);
    bar.scale.set(0.18, 0.015, 0.015);
    bar.position.y = 0.25;
    const bar2 = bar.clone();
    bar2.scale.x = 0.12;
    bar2.position.y = 0.45;
    const tip = new THREE.Mesh(BALL, M.white);
    tip.scale.setScalar(0.035);
    tip.position.y = 0.72;
    const rings = [0, 1, 2].map(() => {
      const r = new THREE.Mesh(RING, additive(COL.work, 0));
      r.position.y = 0.72;
      return r;
    });
    g.add(mast, bar, bar2, tip, ...rings);
    g.userData.tick = t => {
      rings.forEach((r, i) => {
        const k = (t * 0.7 + i / 3) % 1;
        r.scale.setScalar(0.05 + k * 0.9);
        r.material.opacity = (1 - k) * 0.9;
      });
      tip.material = Math.sin(t * 8) > 0 ? M.white : M.amber;
    };
    return g;
  },
  think() { // glowing orb with orbiting dots
    const g = new THREE.Group();
    const orb = new THREE.Mesh(BALL, M.white);
    const dots = [0, 1, 2].map(() => {
      const d = new THREE.Mesh(BALL, M.amber);
      d.scale.setScalar(0.03);
      return d;
    });
    g.add(orb, ...dots);
    g.userData.tick = t => {
      const y = 0.5 + Math.sin(t * 2) * 0.04;
      orb.position.y = y;
      orb.scale.setScalar(0.1 + Math.sin(t * 4) * 0.012);
      dots.forEach((d, i) => {
        const a = t * 3 + i * 2.094;
        d.position.set(Math.cos(a) * 0.24, y + Math.sin(a * 0.5) * 0.06, Math.sin(a) * 0.24);
      });
    };
    return g;
  },
  mcp() { // rotating beacon
    const g = new THREE.Group(), spin = new THREE.Group();
    const pole = new THREE.Mesh(BOX, M.metal);
    pole.scale.set(0.025, 0.32, 0.025);
    const lamp = new THREE.Mesh(BALL, M.soft);
    lamp.scale.setScalar(0.05);
    lamp.position.y = spin.position.y = 0.36;
    const ray = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.01, 1.4, 16, 1, true).rotateZ(-Math.PI / 2).translate(0.7, 0, 0), beamMaterial('#ffbe5a', 0.5));
    const ray2 = ray.clone();
    ray2.rotation.y = Math.PI;
    spin.add(ray, ray2);
    g.add(pole, lamp, spin);
    g.userData.tick = t => { spin.rotation.y = t * 3; };
    return g;
  },
  wait() { // bobbing cyan gem: your turn
    const g = new THREE.Group();
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.15), M.cyan);
    const ring = new THREE.Mesh(RING, additive(COL.wait, 0));
    ring.position.y = 0.02;
    g.add(gem, ring);
    g.userData.tick = (t, b) => {
      gem.position.y = 0.7 + Math.abs(Math.sin(t * 2.2 + b.id)) * 0.18;
      gem.rotation.y = t * 1.5;
      const k = (t * 0.8 + b.id * 0.3) % 1;
      ring.scale.setScalar(0.15 + k * 0.6);
      ring.material.opacity = (1 - k) * 0.8;
    };
    return g;
  },
  drones() { // subagents circling the roof
    const g = new THREE.Group();
    const rotorMat = additive('#d8deef', 0.6);
    const list = Array.from({ length: 6 }, (_, i) => {
      const d = new THREE.Group();
      const body = new THREE.Mesh(CUBE, M.metal);
      body.scale.set(0.12, 0.03, 0.06);
      const ra = new THREE.Mesh(CUBE, rotorMat);
      ra.scale.set(0.1, 0.004, 0.012);
      ra.position.set(-0.07, 0.03, 0);
      const rb = ra.clone();
      rb.position.x = 0.07;
      const light = new THREE.Mesh(BALL, i % 2 ? M.green : M.red);
      light.scale.setScalar(0.015);
      light.position.y = -0.025;
      d.add(body, ra, rb, light);
      g.add(d);
      return { d, ra, rb, light };
    });
    g.userData.tick = (t, b, n) => {
      list.forEach((x, i) => {
        x.d.visible = i < n;
        if (i >= n) return;
        const a = t * 1.1 + i * Math.PI * 2 / n;
        x.d.position.set(Math.cos(a) * 0.6, 0.85 + Math.sin(t * 3 + i) * 0.06, Math.sin(a) * 0.6);
        x.d.rotation.y = -a;
        x.ra.rotation.y = x.rb.rotation.y = t * 30;
        x.light.visible = Math.sin(t * 6 + i) > 0;
      });
    };
    return g;
  },
  alert() { // just finished: a tall cyan beam and rings for a few seconds
    const g = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 9, 20, 1, true).translate(0, 4.5, 0), beamMaterial(COL.wait, 0));
    const rings = [0, 1, 2].map(() => {
      const r = new THREE.Mesh(RING, additive(COL.wait, 0));
      r.position.y = 0.03;
      return r;
    });
    g.add(beam, ...rings);
    g.userData.tick = (t, b, n, since) => {
      const fade = Math.max(0, 1 - since / 5);
      beam.material.uniforms.opacity.value = 0.9 * fade;
      rings.forEach((r, i) => {
        const k = (since * 0.8 + i / 3) % 1;
        r.scale.setScalar(0.2 + k * 1.4);
        r.material.opacity = (1 - k) * fade;
      });
    };
    return g;
  },
};

// ---------- buildings ----------

const built = new Map(); // key -> 3D parts of that building
const pickables = [];

function build(b) {
  const tex = WIN_TEX.map(t => t.clone()); // own repeat per building; the image is shared
  const side = new THREE.MeshStandardMaterial({ color: 0x131a2d, roughness: 0.45, metalness: 0.4, emissive: '#ffffff', emissiveMap: tex[4] });
  const mesh = new THREE.Mesh(BOX, [side, side, M.roof, M.roof, side, side]);
  mesh.userData.key = b.key;
  const edges = new THREE.LineSegments(EDGES, new THREE.LineBasicMaterial({ color: EDGE.off }));
  mesh.add(edges);
  const lot = new THREE.Mesh(CUBE, M.lot);
  lot.scale.set(0.86, 0.02, 0.86);
  const top = new THREE.Group();
  const chimney = new THREE.Mesh(BOX, M.dark);
  chimney.scale.set(0.07, 0.24, 0.07);
  chimney.position.set(-0.2, 0, -0.2);
  top.add(chimney);
  scene.add(mesh, lot, top);
  pickables.push(mesh);
  const g = { mesh, side, edges, lot, top, chimney, tex, variant: 4, flick: 0, h: 0.05, flash: 0, fx: {}, acc: { smoke: 0, spark: 0 }, line: null };
  built.set(b.key, g);
  return g;
}

function unbuild(key) {
  const g = built.get(key);
  scene.remove(g.mesh, g.lot, g.top);
  if (g.line) { scene.remove(g.line.mesh); g.line.mesh.geometry.dispose(); }
  g.side.dispose();
  g.edges.material.dispose();
  g.tex.forEach(t => t.dispose());
  pickables.splice(pickables.indexOf(g.mesh), 1);
  built.delete(key);
}

function updateBuilding(g, b, dt, t) {
  const p = b.p, [x, z] = b.cell, hov = hoverKey === b.key;
  g.h += (heightOf(p.energy) - g.h) * Math.min(1, dt * 2.2);
  g.mesh.position.set(x, 0, z);
  g.mesh.scale.set(0.6, g.h, 0.6);
  g.lot.position.set(x, 0.01, z);
  g.top.position.set(x, g.h, z);

  // windows: how many are lit follows the state; working buildings flicker
  if (b.kind === 'work' && Math.random() < dt * 1.5) g.flick ^= 1;
  const hrs = (p.idleMs ?? 9e9) / 3.6e6;
  const v = b.kind === 'work' ? g.flick : b.kind === 'wait' ? 2 : b.kind === 'off' ? 4 : hrs < 1 ? 2 : hrs < 6 ? 3 : 4;
  if (v !== g.variant) { g.side.emissiveMap = g.tex[v]; g.variant = v; }
  g.tex[v].repeat.set(1, g.h / 1.6);
  const [wc, wi] = WIN[b.kind];
  g.flash = Math.max(0, g.flash - dt * 1.5);
  g.side.emissive.set(wc).lerp(ENERGY, g.flash * 0.6);
  g.side.emissiveIntensity = (wi * (b.kind === 'idle' ? 0.35 + 0.65 * Math.exp(-hrs / 6) : 1) + g.flash * 2.5) * (hov ? 1.35 : 1);
  g.edges.material.color.set(hov ? '#ffffff' : EDGE[b.kind]);
  g.chimney.visible = !!p.procs;

  // roof effects
  const act = b.kind === 'work' ? (p.act === 'agent' ? 'think' : p.act || 'mcp') : null;
  const drones = b.kind === 'work' && p.act === 'agent' ? Math.max(2, p.subagents) : p.subagents;
  const since = t - (b.alertAt ?? -99);
  const want = {
    bash: act === 'bash', edit: act === 'edit', read: act === 'read', web: act === 'web', think: act === 'think', mcp: act === 'mcp',
    wait: b.kind === 'wait', drones: drones > 0, alert: since < 5,
  };
  for (const name in want) {
    let fx = g.fx[name];
    if (!want[name]) { if (fx) fx.visible = false; continue; }
    if (!fx) { fx = g.fx[name] = FX[name](); g.top.add(fx); }
    fx.visible = true;
    fx.userData.tick(t, b, drones, since);
  }

  // chimney smoke = CPU of this session's processes
  if (p.procs && p.cpu > 0.5) {
    g.acc.smoke += dt * Math.min(14, 0.5 + p.cpu / 7);
    for (; g.acc.smoke >= 1; g.acc.smoke--) {
      puff(smokeLayer, x - 0.2 + rand(-0.02, 0.02), g.h + 0.26, z - 0.2, {
        vx: rand(0.05, 0.15), vy: rand(0.25, 0.4), vz: rand(-0.04, 0.04), max: rand(2.4, 3.8),
        s0: 0.08, s1: 0.35 + Math.min(0.5, p.cpu / 150), a: 0.32, c: p.cpu > 60 ? C.hot : C.smoke,
      });
    }
  }
  if (b.kind === 'work' && p.act === 'bash') g.acc.spark += dt * 7;
  for (; g.acc.spark >= 1; g.acc.spark--) {
    puff(glowLayer, x + rand(-0.15, 0.15), g.h + rand(0.2, 0.5), z + rand(-0.15, 0.15), {
      vx: rand(-0.5, 0.5), vy: rand(0.4, 1.1), vz: rand(-0.5, 0.5), ay: -1.6, max: rand(0.6, 1.2),
      s0: 0.05, s1: 0.02, a: 1, smoke: false, c: Math.random() < 0.5 ? C.spark : C.spark2,
    });
  }
}

// ---------- power lines from the plant (only while a session process is running) ----------

const CORE_TOP = new V3(0, 1.75, 0);
const LINE_FS = `uniform vec3 color; uniform float time; uniform float speed; uniform float opacity; varying vec2 vUv;
  void main() {
    float d = fract(vUv.x * 14.0 - time * speed);
    float dash = smoothstep(0.0, 0.12, d) * smoothstep(0.5, 0.32, d);
    gl_FragColor = vec4(color, opacity * (0.18 + 0.82 * dash));
  }`;

function updateLine(g, b, t) {
  if (!b.p.procs) { if (g.line) g.line.mesh.visible = false; return; }
  if (!g.line) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color() }, time: { value: 0 }, speed: { value: 1 }, opacity: { value: 0.5 } },
      vertexShader: PASS_VS, fragmentShader: LINE_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    g.line = { mesh: new THREE.Mesh(new THREE.BufferGeometry(), mat), h: -1, cell: null, curve: null };
    scene.add(g.line.mesh);
  }
  const L = g.line;
  L.mesh.visible = true;
  if (Math.abs(L.h - g.h) > 0.02 || L.cell !== b.cell) {
    const end = new V3(b.cell[0], g.h + 0.02, b.cell[1]);
    const mid = CORE_TOP.clone().add(end).multiplyScalar(0.5);
    mid.y = Math.max(CORE_TOP.y, end.y) + 0.6 + CORE_TOP.distanceTo(end) * 0.12;
    L.curve = new THREE.QuadraticBezierCurve3(CORE_TOP, mid, end);
    L.mesh.geometry.dispose();
    L.mesh.geometry = new THREE.TubeGeometry(L.curve, 48, 0.012, 6, false);
    L.h = g.h;
    L.cell = b.cell;
  }
  const u = L.mesh.material.uniforms;
  u.color.value.set(b.kind === 'work' ? COL.work : b.kind === 'wait' ? COL.wait : COL.idle);
  u.time.value = t;
  u.speed.value = 0.25 + b.p.cpu * 0.015 + (b.kind === 'work' ? 0.9 : 0);
  u.opacity.value = b.kind === 'work' ? 0.9 : b.kind === 'wait' ? 0.45 : 0.2;
}

const pulses = []; // energy spent: light runs from the plant to the building

// ---------- the power plant: this Mac ----------

const plant = (() => {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.14, 32).translate(0, 0.07, 0),
    new THREE.MeshStandardMaterial({ color: 0x1a2236, metalness: 0.6, roughness: 0.4 }));
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.9, 40, 1, true).translate(0, 0.59, 0),
    new THREE.MeshStandardMaterial({ color: 0x2a3a66, metalness: 0.8, roughness: 0.2, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  const fillMat = glow(COL.wait, 0.7); // memory = liquid level
  const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1, 40).translate(0, 0.5, 0), fillMat);
  fill.position.y = 0.14;
  const cap = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.018, 8, 48).rotateX(Math.PI / 2), M.metal);
  cap.position.y = 1.04;
  const coreMat = glow('#5dffa8', 1.8); // CPU = core colour and orbit speed
  const core = new THREE.Mesh(BALL, coreMat);
  core.scale.setScalar(0.2);
  const orbitMat = additive('#5dffa8', 0.35);
  const orbits = [[Math.PI / 2 + 0.35, 0.2], [Math.PI / 2 - 0.5, -0.6]].map(([rx, rz]) => {
    const tilt = new THREE.Group(), spinner = new THREE.Group();
    tilt.rotation.set(rx, 0, rz);
    tilt.position.y = 1.45;
    for (let i = 0; i < 3; i++) {
      const e = new THREE.Mesh(BALL, coreMat);
      e.scale.setScalar(0.035);
      e.position.set(Math.cos(i * 2.094) * 0.42, Math.sin(i * 2.094) * 0.42, 0);
      spinner.add(e);
    }
    tilt.add(new THREE.Mesh(ORBIT, orbitMat), spinner);
    g.add(tilt);
    return spinner;
  });
  const light = new THREE.PointLight('#5dffa8', 4, 7, 1.4);
  light.position.y = 1.5;
  g.add(base, tank, fill, cap, core, light);
  scene.add(g);
  return { fill, fillMat, core, coreMat, orbitMat, orbits, light, acc: 0 };
})();

function updatePlant(dt, t) {
  const { cpu, mem } = data.machine;
  plant.coreMat.emissive.setHSL((140 - clamp(cpu, 0, 100) * 1.4) / 360, 0.95, 0.55);
  plant.orbitMat.color.copy(plant.coreMat.emissive);
  plant.light.color.copy(plant.coreMat.emissive);
  plant.core.position.y = 1.45 + Math.sin(t * 1.5) * 0.04;
  plant.orbits.forEach((s, i) => { s.rotation.z = t * (0.6 + cpu * 0.06) * (i ? -0.8 : 1); });
  plant.fill.scale.y = Math.max(0.01, 0.88 * mem / 100);
  plant.fillMat.emissive.set(mem > 88 ? COL.hot : COL.wait);
  plant.acc += dt * (1 + cpu / 6);
  for (; plant.acc >= 1; plant.acc--) {
    const a = rand(0, Math.PI * 2);
    puff(smokeLayer, Math.cos(a) * 0.3, 1.06, Math.sin(a) * 0.3, {
      vx: rand(0.03, 0.12), vy: rand(0.2, 0.35), vz: rand(-0.05, 0.05), max: rand(2.5, 4), s0: 0.12, s1: 0.5, a: 0.22, c: C.steam,
    });
  }
  skyMat.uniforms.heat.value = clamp((cpu - 50) / 50, 0, 1);
}

// ---------- factories: other apps using the CPU ----------

const factoryGroup = new THREE.Group();
scene.add(factoryGroup);
const FACTORY_BODY = new THREE.MeshStandardMaterial({ color: 0x2a2128, roughness: 0.8 });
const FACTORY_ROOF = new THREE.MeshStandardMaterial({ color: 0x3e2f38, roughness: 0.7 });
const SAW = new THREE.CylinderGeometry(0.15, 0.15, 0.62, 3).rotateX(Math.PI / 2);
const CHIMNEY = new THREE.CylinderGeometry(0.045, 0.06, 0.7, 12).translate(0, 0.35, 0);
let factorySig = '';

function syncFactories() {
  const sig = factories.map(f => `${f.name}@${f.cell}`).join('|');
  if (sig === factorySig) return;
  factorySig = sig;
  for (const g of factoryGroup.children) g.userData.winMat.dispose();
  factoryGroup.clear();
  factories.forEach((f, i) => {
    if (!f.cell) return;
    const [x, z] = f.cell, g = new THREE.Group();
    g.position.set(x, 0, z);
    const body = new THREE.Mesh(BOX, FACTORY_BODY);
    body.scale.set(0.78, 0.32, 0.62);
    g.add(body);
    for (let k = 0; k < 3; k++) {
      const s = new THREE.Mesh(SAW, FACTORY_ROOF);
      s.position.set(-0.26 + k * 0.26, 0.36, 0);
      s.rotation.z = Math.PI;
      g.add(s);
    }
    const ch1 = new THREE.Mesh(CHIMNEY, FACTORY_ROOF);
    ch1.position.set(-0.22, 0.32, -0.18);
    const ch2 = ch1.clone();
    ch2.position.x = 0.06;
    const winMat = glow('#ff9646', 1);
    const win = new THREE.Mesh(CUBE, winMat);
    win.scale.set(0.66, 0.06, 0.01);
    win.position.set(0, 0.14, 0.315);
    const win2 = win.clone();
    win2.position.z = -0.315;
    g.add(ch1, ch2, win, win2);
    g.userData = { index: i, winMat, acc: 0, tops: [new V3(x - 0.22, 1.02, z - 0.18), new V3(x + 0.06, 1.02, z - 0.18)] };
    factoryGroup.add(g);
  });
}

function updateFactories(dt) {
  for (const g of factoryGroup.children) {
    const u = g.userData, f = factories[u.index];
    if (!f) continue;
    u.winMat.emissiveIntensity = clamp(f.cpu / 50, 0.3, 2.5);
    u.acc += dt * Math.min(10, f.cpu / 6);
    for (; u.acc >= 1; u.acc--) {
      const top = u.tops[Math.random() < 0.5 ? 0 : 1];
      puff(smokeLayer, top.x, top.y, top.z, {
        vx: rand(0.05, 0.15), vy: rand(0.25, 0.4), vz: rand(-0.04, 0.04), max: rand(2.5, 4),
        s0: 0.1, s1: 0.45 + Math.min(0.5, f.cpu / 150), a: 0.3, c: f.cpu > 60 ? C.hot : C.factory,
      });
    }
  }
}

// ---------- traffic ----------

let cars = [];
function newCar() {
  const G = ringR + 1.5, lanes = [];
  for (let k = -ringR - 2; k <= ringR + 1; k++) lanes.push(k + 0.5);
  const dir = Math.random() < 0.5 ? 1 : -1;
  return { vert: Math.random() < 0.5, lane: lanes[Math.floor(Math.random() * lanes.length)] + dir * 0.05,
    pos: rand(-G, G), dir, speed: rand(0.25, 0.6) };
}

// ---------- camera ----------

const view = { fly: null, idleSince: 0, touched: false };
const HOME_DIR = new V3(1, 0.95, 1).normalize();
// phones are tall and narrow: back off far enough that things also fit the width
const widthFit = () => (W ? Math.max(1, 2.3 * H / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (W - panelW())) / 3.6) : 1);
const homeDist = () => (ringR + 1.5) * 3.6 * widthFit();

function home() {
  controls.target.set(0, 0.5, 0);
  camera.position.copy(controls.target).addScaledVector(HOME_DIR, homeDist());
}

// key = a building to fly to; null = back to the whole city
function flyTo(key) {
  const b = key && blds.get(key), g = b && built.get(b.key);
  view.fly = g
    ? { target: new V3(b.cell[0], Math.max(0.4, g.h * 0.55), b.cell[1]), dist: (4.5 + g.h) * widthFit() }
    : { target: new V3(0, 0.5, 0), dist: homeDist(), dir: HOME_DIR };
  controls.autoRotate = false;
  view.idleSince = performance.now();
}

function updateCamera(dt) {
  if (view.fly) {
    const k = Math.min(1, dt * 3), f = view.fly;
    const offset = camera.position.clone().sub(controls.target);
    let dist = offset.length();
    const dir = offset.normalize();
    if (f.dir) dir.lerp(f.dir, k).normalize();
    controls.target.lerp(f.target, k);
    dist += (f.dist - dist) * k;
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    if (controls.target.distanceTo(f.target) < 0.01 && Math.abs(dist - f.dist) < 0.02) view.fly = null;
  }
  // resume the slow orbit after 20 s without interaction
  if (!controls.autoRotate && !view.fly && performance.now() - view.idleSince > 20000) controls.autoRotate = true;
}

// ---------- frame ----------

function update(dt, t) {
  for (const key of [...built.keys()]) if (!blds.has(key)) unbuild(key);
  syncFactories();
  const lit = [], extra = [];
  for (const b of blds.values()) {
    const g = built.get(b.key) || build(b);
    updateBuilding(g, b, dt, t);
    updateLine(g, b, t);
    if (b.kind === 'work' || b.kind === 'wait') lit.push([b, g]);
  }
  lit.sort((a, c) => (c[0].kind === 'work') - (a[0].kind === 'work'));
  glows.forEach((l, i) => {
    const e = lit[i];
    if (!e) { l.intensity = 0; return; }
    const [b, g] = e;
    l.position.set(b.cell[0], g.h + 0.5, b.cell[1]);
    l.color.set(b.kind === 'work' ? COL.work : COL.wait);
    l.intensity = b.kind === 'work' ? 2.5 + Math.sin(t * 3 + b.id) * 0.8 : 1.4;
  });
  updatePlant(dt, t);
  updateFactories(dt);

  for (const q of pulses) q.t += dt / 1.2;
  for (let i = pulses.length - 1; i >= 0; i--) if (pulses[i].t >= 1 || !built.has(pulses[i].key)) pulses.splice(i, 1);
  for (const q of pulses) {
    const curve = q.t >= 0 && built.get(q.key).line?.curve;
    if (!curve) continue;
    for (let i = 0; i < 6; i++) {
      const s = q.t - i * 0.025;
      if (s < 0) break;
      const pt = curve.getPoint(s);
      extra.push([pt.x, pt.y, pt.z, 0.1 - i * 0.013, C.spark, 1 - i * 0.15]);
    }
  }

  const working = lit.filter(([b]) => b.kind === 'work').length, want = 6 + working * 7, G = ringR + 1.5;
  while (cars.length < want) cars.push(newCar());
  if (cars.length > want) cars.length = want;
  for (const c of cars) {
    c.pos += c.dir * c.speed * dt;
    if (c.pos > G || c.pos < -G) Object.assign(c, newCar());
    const at = s => (c.vert ? [c.lane, 0.03, s] : [s, 0.03, c.lane]);
    extra.push([...at(c.pos + c.dir * 0.035), 0.05, C.head, 0.95], [...at(c.pos - c.dir * 0.035), 0.04, C.tail, 0.85]);
  }

  const k = (t / 4) % 1;
  groundPulse.scale.setScalar(0.4 + k * G * 1.35);
  groundPulse.material.opacity = (1 - k) * 0.25;
  stars.rotation.y = t * 0.004;

  stepLayer(smokeLayer, dt, []);
  stepLayer(glowLayer, dt, extra);
  updateCamera(dt);
}

const _p = new V3();
function project(x, y, z) {
  _p.set(x, y, z).project(camera);
  if (_p.z > 1 || Math.abs(_p.x) > 1.3 || Math.abs(_p.y) > 1.3) return null;
  return [(_p.x + 1) / 2 * W, (1 - _p.y) / 2 * H];
}

const proj3d = {
  base: b => built.has(b.key) && project(b.cell[0], -0.02, b.cell[1]),
  roof: b => { const g = built.get(b.key); return g && project(b.cell[0], g.h + 1.05, b.cell[1]); },
  factory: f => project(f.cell[0], 0, f.cell[1]),
};

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000); // tolerate throttled background tabs
  last = now;
  const t = now / 1000;
  if (data) update(dt, t);
  controls.update(dt);
  composer.render(dt);
  lctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  lctx.clearRect(0, 0, W, H);
  if (data) drawLabels(lctx, t, proj3d);
  requestAnimationFrame(frame);
}

// ---------- interaction ----------

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(x, y) {
  ndc.set(x / W * 2 - 1, -(y / H) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(pickables, false)[0];
  return hit ? blds.get(hit.object.userData.key) : null;
}

let down = null;
canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointermove', e => {
  if (e.buttons) return;
  const b = pick(e.clientX, e.clientY);
  setHover(b ? b.key : null, e.clientX, e.clientY);
  canvas.style.cursor = b ? 'pointer' : '';
});
canvas.addEventListener('pointerup', e => {
  if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) {
    const b = pick(e.clientX, e.clientY);
    if (b) flyTo(b.key);
    if (e.pointerType !== 'mouse') setHover(b ? b.key : null); // no hover on touch: a tap shows the card
  }
  down = null;
});
canvas.addEventListener('pointerleave', () => setHover(null));
canvas.addEventListener('dblclick', () => flyTo(null));
controls.addEventListener('start', () => {
  view.touched = true;
  view.fly = null;
  controls.autoRotate = false;
  view.idleSince = performance.now();
});
controls.addEventListener('end', () => { view.idleSince = performance.now(); });

function resize() {
  W = innerWidth; H = innerHeight; DPR = Math.min(phone() ? 1.5 : 2, devicePixelRatio || 1); // phones: spare the battery
  gl.setPixelRatio(DPR);
  gl.setSize(W, H);
  composer.setPixelRatio(DPR);
  composer.setSize(W, H);
  camera.aspect = W / H;
  // centre the city in the space right of the panel (phones: between the top HUD and the bottom sheet)
  camera.setViewOffset(W, H, -panelW() / 2, phone() ? (sheetH() - 130) / 2 : 0, W, H);
  camera.updateProjectionMatrix();
  lcv.width = W * DPR; lcv.height = H * DPR;
  lcv.style.width = W + 'px'; lcv.style.height = H + 'px';
  smokeLayer.mat.uniforms.scale.value = glowLayer.mat.uniforms.scale.value =
    H * DPR / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  if (!view.touched && !view.fly) home(); // the home distance depends on the window shape
}

Object.assign(renderer, {
  burst(b, de) {
    const g = built.get(b.key);
    if (!g) return;
    g.flash = 1;
    g.acc.spark += Math.min(26, 4 + Math.log10(de) * 3);
    if (!b.p.procs) return;
    const n = clamp(Math.round(Math.log10(de) - 2), 1, 6);
    for (let i = 0; i < n; i++) pulses.push({ key: b.key, t: -i * 0.2 });
  },
  focus: flyTo,
  layout() {
    buildGround();
    cars = [];
    if (!view.touched) home();
  },
});

buildGround();
home();
resize();
addEventListener('resize', resize);
requestAnimationFrame(frame);
