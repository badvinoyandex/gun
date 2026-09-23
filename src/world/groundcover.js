import * as THREE from 'three';
import { scene, camera, Q, NO_REFLECT } from '../core/env.js';
import { rng, hash2, TAU, lerp } from '../core/math.js';
import { MAP, isFree, lakeRho, edgeDist } from './layout.js';
import { hFast, grassDensity } from './heightcache.js';
import { forestDensity, treeNear, saplingGeo } from './forest.js';
import { M } from '../gen/materials.js';
import { injectWind } from './wind.js';

/* ============================================================================
   ПОДЛЕСОК: трава вокруг камеры, папоротник, черничник, подрост ёлок.
   Трава пересобирается по мере движения; позиции берутся из хеша ячейки,
   поэтому при возврате на место травинки те же — ничего не «прыгает».
============================================================================ */
export const GRASS = { im: null, center: new THREE.Vector2(1e9, 1e9), count: 0 };

function clumpGeo(planes, w, h, segs = 2) {
  const parts = [];
  for (let p = 0; p < planes; p++) {
    const g = new THREE.PlaneGeometry(w, h, 1, segs);
    g.translate(0, h / 2, 0);
    g.rotateY(p / planes * Math.PI + 0.2);
    // нормали вверх: пучок освещается как объём, а не как плоскость
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, n.getX(i) * 0.3, 0.9, n.getZ(i) * 0.3);
    parts.push(g);
  }
  const merged = new THREE.BufferGeometry();
  const pos = [], nrm = [], uv = [], idx = [];
  let off = 0;
  for (const g of parts) {
    pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); uv.push(...g.attributes.uv.array);
    for (const i of g.index.array) idx.push(i + off);
    off += g.attributes.position.count;
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  merged.setIndex(idx);
  return merged;
}

/** Пучок настоящих травинок: изогнутые сужающиеся ленты, у корня темнее, к кончику светлее и суше. */
function tuftGeo(blades = 11, segs = 4) {
  const pos = [], nrm = [], col = [], idx = [];
  let v = 0;
  const R = (k) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  for (let b = 0; b < blades; b++) {
    const a = R(b) * Math.PI * 2, rr = Math.sqrt(R(b + 17)) * 0.13;
    const bx = Math.cos(a) * rr, bz = Math.sin(a) * rr;
    const h = 0.32 + R(b + 31) * 0.5, w = 0.022 + R(b + 43) * 0.018;
    const lean = 0.15 + R(b + 57) * 0.45, la = a + (R(b + 71) - 0.5) * 1.2;
    const lx = Math.cos(la), lz = Math.sin(la), sx = -lz, sz = lx;
    const dry = R(b + 83);
    for (let k = 0; k <= segs; k++) {
      const t = k / segs, y = h * t, off = lean * h * t * t;
      const cx = bx + lx * off, cz = bz + lz * off, ww = w * (1 - t * 0.92);
      for (const e of [-1, 1]) {
        pos.push(cx + sx * ww * e, y, cz + sz * ww * e);
        // нормаль: наполовину вверх, наполовину от стебля — пучок освещается как объём
        nrm.push(lx * 0.35 + sx * e * 0.25, 0.85, lz * 0.35 + sz * e * 0.25);
        const g = 0.35 + 0.65 * t;
        col.push(g * (0.62 + dry * 0.35 * t), g * (0.9 + dry * 0.05), g * (0.42 - dry * 0.12 * t));
      }
      if (k < segs) { const q = v + k * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
    v += (segs + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
export const TUFTS = { im: null, center: new THREE.Vector2(1e9, 1e9), count: 0, R: 12 };
export function buildGrass() {
  injectWind(M.grass, { amp: 0.16, stiff: 1.6, refH: 0.8, flutter: 0.04, trample: true, blast: 1.4, burn: true });
  const im = new THREE.InstancedMesh(clumpGeo(3, 0.62, 0.62), M.grass, Q.grass);
  im.count = 0; im.frustumCulled = false; im.receiveShadow = true; im.castShadow = false;
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.name = 'grass';
  scene.add(im);
  NO_REFLECT.push(im);
  GRASS.im = im;
  // ближний слой: геометрические травинки вокруг игрока
  M.blades = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.78, metalness: 0, color: 0x6f8a4a });
  M.blades.emissive = new THREE.Color(0x0a1206);
  injectWind(M.blades, { amp: 0.14, stiff: 1.5, refH: 0.6, flutter: 0.05, trample: true, blast: 1.5, burn: true });
  TUFTS.R = Math.round(9 + 7 * Q.tex);
  const n = Math.round(Q.grass * 0.28);
  const tim = new THREE.InstancedMesh(tuftGeo(), M.blades, n);
  tim.count = 0; tim.frustumCulled = false; tim.receiveShadow = true; tim.castShadow = Q.tex > 0.9;
  tim.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tim.name = 'grass_tufts';
  scene.add(tim); NO_REFLECT.push(tim);
  TUFTS.im = tim; TUFTS.max = n;
  refreshGrass(true);
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
function refreshTufts(force, cx, cz) {
  const T = TUFTS, im = T.im;
  if (!im) return;
  if (!force && T.center.distanceTo(new THREE.Vector2(cx, cz)) < 1.8) return;
  T.center.set(cx, cz);
  const R = T.R, step = Math.sqrt(Math.PI * R * R / T.max) * 0.95;
  let n = 0;
  const i0 = Math.floor((cx - R) / step), i1 = Math.floor((cx + R) / step), j0 = Math.floor((cz - R) / step), j1 = Math.floor((cz + R) / step);
  for (let i = i0; i <= i1 && n < T.max; i++) for (let j = j0; j <= j1 && n < T.max; j++) {
    const h1 = hash2(i + 501, j - 77), h2 = hash2(j + 913, i + 41), h3 = hash2(i * 5 - 3, j * 3 + 11);
    const x = (i + h1) * step, z = (j + h2) * step, dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
    if (d2 > R * R) continue;
    const dens = grassDensity(x, z);
    if (h3 > dens * (0.25 + (1 - d2 / (R * R)) * 0.85)) continue;
    const e = edgeDist(x, z);
    const tall = e > MAP.PLAY - 2 && e < MAP.FENCE ? 1.5 : lakeRho(x, z) < 1.5 ? 1.3 : 1;
    const sc = lerp(0.7, 1.35, hash2(i + 3, j + 7)) * tall;
    _p.set(x, hFast(x, z) - 0.02, z); _q.setFromAxisAngle(_up, h1 * TAU); _s.set(sc, sc * lerp(0.75, 1.25, h2), sc);
    im.setMatrixAt(n, _m.compose(_p, _q, _s));
    const dry = tall > 1.4 ? 0.5 : (1 - forestDensity(x, z)) * 0.25, v = lerp(0.85, 1.15, h3);
    _c.setRGB(v * lerp(0.95, 1.3, dry), v * lerp(1.0, 0.95, dry), v * lerp(0.95, 0.65, dry));
    im.setColorAt(n, _c);
    n++;
  }
  im.count = n; T.count = n;
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
}
export function refreshGrass(force) {
  const im = GRASS.im;
  if (!im) return;
  const cx = camera.position.x, cz = camera.position.z;
  const agl = camera.position.y - hFast(cx, cz);
  // с высоты дрона трава не видна — не тратим на неё кадр
  if (agl > 55) { if (im.count) { im.count = 0; TUFTS.im.count = 0; } GRASS.center.set(1e9, 1e9); TUFTS.center.set(1e9, 1e9); return; }
  if (agl < 25) refreshTufts(force, cx, cz); else TUFTS.im.count = 0;
  const R = Q.grassR;
  if (!force && GRASS.center.distanceTo(new THREE.Vector2(cx, cz)) < R * 0.22) return;
  GRASS.center.set(cx, cz);
  const step = Math.sqrt(Math.PI * R * R / Q.grass) * 0.92;
  const RN = TUFTS.R * 0.55;
  let n = 0;
  const i0 = Math.floor((cx - R) / step), i1 = Math.floor((cx + R) / step);
  const j0 = Math.floor((cz - R) / step), j1 = Math.floor((cz + R) / step);
  for (let i = i0; i <= i1 && n < Q.grass; i++) for (let j = j0; j <= j1 && n < Q.grass; j++) {
    const h1 = hash2(i, j), h2 = hash2(j + 77, i - 31), h3 = hash2(i * 3 + 5, j * 7 - 2);
    const x = (i + h1) * step, z = (j + h2) * step;
    const dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
    if (d2 > R * R) continue;
    // вблизи основную массу дают травинки — карточек меньше
    if (d2 < RN * RN && h1 < 0.55) continue;
    const fade = 1 - d2 / (R * R);
    const dens = grassDensity(x, z);
    if (h3 > dens * (0.35 + fade * 0.75)) continue;
    const y = hFast(x, z);
    const e = edgeDist(x, z);
    const tall = e > MAP.PLAY - 2 && e < MAP.FENCE ? 1.6 : lakeRho(x, z) < 1.5 ? 1.35 : 1;
    const sc = lerp(0.55, 1.25, hash2(i + 9, j + 13)) * tall;
    _p.set(x, y - 0.03, z);
    _q.setFromAxisAngle(_up, h1 * TAU);
    _s.set(sc, sc * lerp(0.7, 1.2, h2), sc);
    _m.compose(_p, _q, _s);
    im.setMatrixAt(n, _m);
    const dry = tall > 1.5 ? 0.55 : (1 - forestDensity(x, z)) * 0.25;
    const v = lerp(0.8, 1.15, h3);
    _c.setRGB(v * lerp(0.85, 1.25, dry), v * lerp(0.95, 1.0, dry), v * lerp(0.8, 0.6, dry));
    im.setColorAt(n, _c);
    n++;
  }
  im.count = n;
  GRASS.count = n;
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
}

/** Статичный подлесок по всей игровой зоне. */
export function buildUndergrowth() {
  const R = rng(4242);
  injectWind(M.fern, { amp: 0.12, stiff: 1.5, refH: 0.9, flutter: 0.05, trample: true, blast: 1.2, burn: true });
  injectWind(M.shrub, { amp: 0.05, stiff: 1.5, refH: 0.5, flutter: 0.03, trample: true, blast: 1.0, burn: true });
  const place = (count, mat, geo, test, scale, tint) => {
    const pts = [];
    for (let k = 0; k < count * 6 && pts.length < count; k++) {
      const x = R.range(-MAP.FENCE, MAP.FENCE), z = R.range(-MAP.FENCE, MAP.FENCE);
      if (!test(x, z)) continue;
      pts.push([x, z]);
    }
    const im = new THREE.InstancedMesh(geo, mat, pts.length);
    pts.forEach(([x, z], i) => {
      const s = R.range(scale[0], scale[1]);
      _p.set(x, hFast(x, z) - 0.04, z); _q.setFromAxisAngle(_up, R.range(0, TAU)); _s.set(s, s * R.range(0.8, 1.15), s);
      _m.compose(_p, _q, _s); im.setMatrixAt(i, _m);
      const v = R.range(0.75, 1.15); _c.setRGB(v * tint[0], v * tint[1], v * tint[2]); im.setColorAt(i, _c);
    });
    im.receiveShadow = true; im.castShadow = false; im.frustumCulled = false;
    scene.add(im); NO_REFLECT.push(im);
    return im;
  };
  // папоротник — в тени и сырости
  place(Math.round(9000 * Q.ferns), M.fern, fernGeo(), (x, z) => {
    const d = forestDensity(x, z);
    return R() < d * 0.9 && isFree(x, z, 0.4, { pathPad: 0.2, trenchPad: 0.8 }) && !treeNear(x, z, 0.4) && edgeDist(x, z) < MAP.PLAY - 1;
  }, [0.7, 1.3], [0.95, 1, 0.9]);
  // черничник — ковром на опушках
  place(Math.round(7000 * Q.ferns), M.shrub, clumpGeo(2, 0.7, 0.42, 1), (x, z) => {
    const d = forestDensity(x, z);
    return R() < 0.25 + d * 0.5 && isFree(x, z, 0.35, { pathPad: 0.2, trenchPad: 0.8 }) && !treeNear(x, z, 0.3);
  }, [0.7, 1.4], [1, 1, 1]);
  // подрост ёлок: укрытие от взгляда, но не от пули
  const sap = saplingGeo();
  place(Math.round(1400 * Q.trees), M.spruce, sap, (x, z) => {
    const d = forestDensity(x, z);
    return R() < d * 0.7 && isFree(x, z, 0.6, { pathPad: 0.8, trenchPad: 1.2 }) && !treeNear(x, z, 1.2) && edgeDist(x, z) < MAP.FENCE;
  }, [1.2, 3.2], [0.8, 0.95, 0.85]);
}
/** Папоротник: вайи веером от центра, наклонены наружу. */
function fernGeo() {
  const pos = [], nrm = [], uv = [], idx = [];
  const fronds = 7;
  for (let f = 0; f < fronds; f++) {
    const a = f / fronds * TAU, ca = Math.cos(a), sa = Math.sin(a);
    const base = pos.length / 3;
    for (let k = 0; k <= 2; k++) {
      const t = k / 2, L = 0.62 * t;
      const y = Math.sin(t * 1.9) * 0.34;         // дуга вверх и вниз к кончику
      for (let e = 0; e <= 1; e++) {
        const w = (e - 0.5) * 0.34;
        pos.push(ca * L - sa * w, y, sa * L + ca * w);
        nrm.push(ca * 0.2, 0.95, sa * 0.2);
        uv.push(e, t);
      }
    }
    for (let k = 0; k < 2; k++) { const i = base + k * 2; idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
