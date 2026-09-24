import * as THREE from 'three';
import { scene, camera, Q, NO_REFLECT } from '../core/env.js';
import { rng, hash2, TAU, lerp } from '../core/math.js';
import { MAP, isFree, lakeRho, edgeDist } from './layout.js';
import { hFast, grassDensity, forestFast } from './heightcache.js';
import { treeNear, saplingGeo } from './forest.js';
import { M } from '../gen/materials.js';
import { injectWind } from './wind.js';

/* ============================================================================
   ПОДЛЕСОК: трава вокруг камеры, папоротник, черничник, подрост ёлок.
   Трава пересобирается по мере движения; позиции берутся из хеша ячейки,
   поэтому при возврате на место травинки те же — ничего не «прыгает».
============================================================================ */
export const GRASS = { im: null, center: new THREE.Vector2(1e9, 1e9), count: 0, cap: 1 };

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
function tuftGeo(blades = Q.tex > 0.9 ? 14 : 11, segs = Q.tex > 0.6 ? 4 : 3) {
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
    // у части травинок — колосок-метёлка на кончике (тимофеевка, мятлик)
    if (R(b + 97) > 0.72) {
      const tx = bx + lx * lean * h, tz = bz + lz * lean * h, L = 0.07 + R(b + 101) * 0.05, sw = 0.012;
      for (const [ex, ez] of [[sx, sz], [lx, lz]]) {
        const q = v;
        pos.push(tx - ex * sw, h - 0.01, tz - ez * sw, tx + ex * sw, h - 0.01, tz + ez * sw, tx + lx * 0.03 - ex * sw * 0.5, h + L, tz + lz * 0.03 - ez * sw * 0.5, tx + lx * 0.03 + ex * sw * 0.5, h + L, tz + lz * 0.03 + ez * sw * 0.5);
        for (let r = 0; r < 4; r++) { nrm.push(lx * 0.3, 0.9, lz * 0.3); col.push(0.78, 0.72, 0.46); }
        idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
        v += 4;
      }
    }
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
  const n = Q.tufts === false ? 1 : Math.round(Q.grass * 0.28);
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
  const max = Math.max(1, Math.round(T.max * GRASS.cap));
  const R = T.R, step = Math.sqrt(Math.PI * R * R / max) * 0.95;
  let n = 0;
  const i0 = Math.floor((cx - R) / step), i1 = Math.floor((cx + R) / step), j0 = Math.floor((cz - R) / step), j1 = Math.floor((cz + R) / step);
  for (let i = i0; i <= i1 && n < max; i++) for (let j = j0; j <= j1 && n < max; j++) {
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
    const dry = tall > 1.4 ? 0.5 : (1 - forestFast(x, z)) * 0.25, v = lerp(0.85, 1.15, h3);
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
  if (agl < 25 && Q.tufts !== false) refreshTufts(force, cx, cz); else TUFTS.im.count = 0;
  const R = Q.grassR;
  if (!force && GRASS.center.distanceTo(new THREE.Vector2(cx, cz)) < R * 0.22) return;
  GRASS.center.set(cx, cz);
  const maxG = Math.round(Q.grass * GRASS.cap);
  const step = Math.sqrt(Math.PI * R * R / maxG) * 0.92;
  const RN = TUFTS.R * 0.55;
  let n = 0;
  const i0 = Math.floor((cx - R) / step), i1 = Math.floor((cx + R) / step);
  const j0 = Math.floor((cz - R) / step), j1 = Math.floor((cz + R) / step);
  for (let i = i0; i <= i1 && n < maxG; i++) for (let j = j0; j <= j1 && n < maxG; j++) {
    const h1 = hash2(i, j), h2 = hash2(j + 77, i - 31), h3 = hash2(i * 3 + 5, j * 7 - 2);
    const x = (i + h1) * step, z = (j + h2) * step;
    const dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
    if (d2 > R * R) continue;
    // вблизи основную массу дают травинки — карточек меньше
    if (Q.tufts !== false && d2 < RN * RN && h1 < 0.55) continue;
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
    const dry = tall > 1.5 ? 0.55 : (1 - forestFast(x, z)) * 0.25;
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

/* ---------- Статичный подлесок ----------
   Раскладка по всей игровой зоне, но на экран — квадратами 64 м: каждый квадрат
   отдельный инстанс-меш с собственной сферой, поэтому работает отсечение по
   пирамиде видимости, а мелочь (цветы, иван-чай, черничник) ещё и гаснет за
   дальностью Q.floraR. Укрытия (подрост, кусты) видны на любой дальности и в
   одинаковом числе на всех пресетах — никто не получает преимущества в обзоре. */
const TILE = 64;
export const FLORA = { tiles: [], drawn: 0 };
function scatter(R, count, mat, geo, test, scale, tint, o = {}) {
  const buckets = new Map();
  let placed = 0;
  for (let k = 0; k < count * 6 && placed < count; k++) {
    const x = R.range(-MAP.FENCE, MAP.FENCE), z = R.range(-MAP.FENCE, MAP.FENCE);
    if (!test(x, z)) continue;
    const key = Math.floor(x / TILE) * 64 + Math.floor(z / TILE);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([x, z, R.range(scale[0], scale[1]), R.range(0, TAU), R.range(0.8, 1.15), R.range(0.75, 1.15)]);
    placed++;
  }
  for (const pts of buckets.values()) {
    const im = new THREE.InstancedMesh(geo, mat, pts.length);
    let cx = 0, cz = 0;
    pts.forEach(([x, z, s, a, sy, v], i) => {
      _p.set(x, hFast(x, z) - (o.sink ?? 0.04), z); _q.setFromAxisAngle(_up, a); _s.set(s, s * sy, s);
      _m.compose(_p, _q, _s); im.setMatrixAt(i, _m);
      const t = typeof tint === 'function' ? tint(x, z, v) : tint;
      _c.setRGB(v * t[0], v * t[1], v * t[2]); im.setColorAt(i, _c);
      cx += x; cz += z;
    });
    im.computeBoundingSphere();
    im.receiveShadow = true; im.castShadow = !!o.cast; im.frustumCulled = true;
    im.name = o.name || 'flora';
    scene.add(im); NO_REFLECT.push(im);
    FLORA.tiles.push({ im, x: cx / pts.length, z: cz / pts.length, far: o.far ?? Infinity });
  }
  return placed;
}
/** Дальние квадраты мелочи не рисуются (раз в полсекунды хватает — квадраты большие). */
let floraT = 0;
export function updateFlora(dt) {
  floraT -= dt;
  if (floraT > 0) return;
  floraT = 0.5;
  const cp = camera.position;
  let n = 0;
  for (const t of FLORA.tiles) {
    const d = Math.hypot(t.x - cp.x, t.z - cp.z) - TILE * 0.72;
    t.im.visible = d < t.far;
    if (t.im.visible) n++;
  }
  FLORA.drawn = n;
}
export function buildUndergrowth() {
  const R = rng(4242);
  injectWind(M.fern, { amp: 0.12, stiff: 1.5, refH: 0.9, flutter: 0.05, trample: true, blast: 1.2, burn: true });
  injectWind(M.shrub, { amp: 0.05, stiff: 1.5, refH: 0.5, flutter: 0.03, trample: true, blast: 1.0, burn: true });
  const smallFar = Q.floraR;
  // папоротник — в тени и сырости
  scatter(R, Math.round(9000 * Q.ferns), M.fern, fernGeo(), (x, z) => {
    const d = forestFast(x, z);
    return R() < d * 0.9 && isFree(x, z, 0.4, { pathPad: 0.2, trenchPad: 0.8 }) && !treeNear(x, z, 0.4) && edgeDist(x, z) < MAP.PLAY - 1;
  }, [0.7, 1.3], [0.95, 1, 0.9], { far: smallFar + 20, name: 'ferns' });
  // черничник — ковром на опушках
  scatter(R, Math.round(7000 * Q.ferns), M.shrub, clumpGeo(2, 0.7, 0.42, 1), (x, z) => {
    const d = forestFast(x, z);
    return R() < 0.25 + d * 0.5 && isFree(x, z, 0.35, { pathPad: 0.2, trenchPad: 0.8 }) && !treeNear(x, z, 0.3);
  }, [0.7, 1.4], [1, 1, 1], { far: smallFar, name: 'shrub' });
  // подрост ёлок: укрытие от взгляда, но не от пули
  const sap = saplingGeo();
  scatter(R, Math.round(1400 * Q.trees), M.spruce, sap, (x, z) => {
    const d = forestFast(x, z);
    return R() < d * 0.7 && isFree(x, z, 0.6, { pathPad: 0.8, trenchPad: 1.2 }) && !treeNear(x, z, 1.2) && edgeDist(x, z) < MAP.FENCE;
  }, [1.2, 3.2], [0.8, 0.95, 0.85], { name: 'saplings' });
  buildFlora(R);
}

/* ---------- Новая растительность ----------
   • Кусты ивняка и лещины на опушках и у воды — лиственная масса между хвоей,
     тоже укрытие от взгляда (число одинаково на всех пресетах).
   • Иван-чай: высокие стебли с розовыми кистями — прогалины, минная полоса, гари.
   • Луговые цветы: ромашки, колокольчики, клевер, пижма — там, где светло.
   • Сухостой-бурьян с метёлками по краям троп и на брустверах.
   Всё гнётся ветром, приминается, чернеет и оседает в огне. */
function buildFlora(R) {
  M.bush = new THREE.MeshStandardMaterial({ map: M.birch.map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, vertexColors: true });
  M.bush.emissive = new THREE.Color(0x0b1206);
  injectWind(M.bush, { amp: 0.16, stiff: 1.6, refH: 2.2, flutter: 0.05, trample: true, blast: 1.0, burn: true });
  M.flora = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8, metalness: 0 });
  M.flora.emissive = new THREE.Color(0x080c05);
  injectWind(M.flora, { amp: 0.12, stiff: 1.5, refH: 0.8, flutter: 0.06, trample: true, blast: 1.4, burn: true });

  // кусты: число не зависит от пресета
  scatter(R, 900, M.bush, bushGeo(), (x, z) => {
    const d = forestFast(x, z), rho = lakeRho(x, z);
    const edge = d > 0.25 && d < 0.7 ? 0.5 : 0.08, shore = rho > 1.05 && rho < 1.45 ? 0.7 : 0;
    return R() < Math.max(edge, shore) && isFree(x, z, 1.0, { pathPad: 0.8, trenchPad: 1.4 }) && !treeNear(x, z, 1.1) && edgeDist(x, z) < MAP.PLAY - 2;
  }, [0.8, 1.5], (x, z, v) => lakeRho(x, z) < 1.5 ? [0.72, 0.86, 0.6] : [0.86, 0.95, 0.66], { name: 'bushes', sink: 0.1 });

  const fl = Q.flora;
  const light = (x, z) => 1 - forestFast(x, z);
  scatter(R, Math.round(2600 * fl), M.flora, fireweedGeo(), (x, z) => {
    const e = edgeDist(x, z), mine = e > MAP.PLAY - 2 && e < MAP.FENCE;
    return R() < (mine ? 0.6 : light(x, z) * 0.35) && isFree(x, z, 0.3, { pathPad: 0.4, trenchPad: 1.0 }) && !treeNear(x, z, 0.5) && lakeRho(x, z) > 1.15;
  }, [0.75, 1.3], [1, 1, 1], { far: Q.floraR, name: 'fireweed' });
  const kinds = [[0xf2efe2, 0xe8c030], [0x6a74d0, 0x4a52a8], [0xc7607e, 0xa84466], [0xe8b83a, 0xd49a20]];
  kinds.forEach(([petal, heart], i) => {
    scatter(R, Math.round(2200 * fl), M.flora, flowerGeo(petal, heart, i), (x, z) => {
      return R() < light(x, z) * 0.55 + (lakeRho(x, z) < 1.6 ? 0.2 : 0) && grassDensity(x, z) > 0.35 && isFree(x, z, 0.2, { pathPad: 0.2, trenchPad: 0.9 }) && lakeRho(x, z) > 1.08;
    }, [0.8, 1.25], [1, 1, 1], { far: Q.floraR * 0.8, name: 'flowers' });
  });
  scatter(R, Math.round(3000 * fl), M.flora, weedGeo(), (x, z) => {
    const e = edgeDist(x, z);
    return R() < (e > MAP.PLAY - 2 && e < MAP.FENCE ? 0.7 : 0.3) && grassDensity(x, z) > 0.25 && isFree(x, z, 0.2, { pathPad: 0.1, trenchPad: 0.9 });
  }, [0.8, 1.4], [1, 1, 1], { far: Q.floraR, name: 'weeds' });
}
/** Геометрия с цветом в вершинах: набор лент/карточек. */
class VG {
  constructor() { this.p = []; this.n = []; this.c = []; this.uv = []; this.i = []; }
  quad(a, b, c, d, col, nrm = [0, 1, 0], uv = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const o = this.p.length / 3;
    for (const [k, v] of [a, b, c, d].entries()) { this.p.push(...v); this.n.push(...nrm); this.c.push(...(Array.isArray(col[0]) ? col[k] : col)); this.uv.push(...uv[k]); }
    this.i.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  /** Стебель: узкая лента от a до b (две скрещённые). */
  stem(a, b, w, c0, c1) {
    for (const r of [0, Math.PI / 2]) {
      const dx = Math.cos(r) * w, dz = Math.sin(r) * w;
      this.quad([a[0] - dx, a[1], a[2] - dz], [a[0] + dx, a[1], a[2] + dz], [b[0] + dx * 0.6, b[1], b[2] + dz * 0.6], [b[0] - dx * 0.6, b[1], b[2] - dz * 0.6], [c0, c0, c1, c1], [0.3, 0.8, 0.3]);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.i); g.computeBoundingSphere();
    return g;
  }
}
const hx = k => { const x = Math.sin(k * 91.7 + 13.1) * 43758.5453; return x - Math.floor(x); };
const rgb = h => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const cellUV = k => { const u = (k & 1) * 0.5, v = ((k >> 1) & 1) * 0.5; return [[u, v], [u + 0.5, v], [u + 0.5, v + 0.5], [u, v + 0.5]]; };
/** Куст: лиственные карточки шапкой на нескольких ветвях. */
function bushGeo() {
  const G = new VG();
  for (let k = 0; k < 14; k++) {
    const a = hx(k) * TAU, r = 0.15 + hx(k + 7) * 0.55, y = 0.35 + hx(k + 3) * 1.1, s = 0.55 + hx(k + 11) * 0.45;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, rr = hx(k + 5) * Math.PI;
    const dx = Math.cos(rr) * s, dz = Math.sin(rr) * s, sh = 0.55 + 0.45 * (y / 1.45);
    const col = [0.6 * sh, 0.7 * sh, 0.5 * sh];
    // карточка из атласа листвы берёзы: верхняя часть атласа — листва
    G.quad([cx - dx, y - s * 0.6, cz - dz], [cx + dx, y - s * 0.6, cz + dz], [cx + dx, y + s * 0.6, cz + dz], [cx - dx, y + s * 0.6, cz - dz], col, [Math.cos(a) * 0.4, 0.8, Math.sin(a) * 0.4], cellUV(k));
  }
  for (let k = 0; k < 5; k++) { const a = hx(k + 40) * TAU; G.stem([0, 0, 0], [Math.cos(a) * 0.4, 0.9, Math.sin(a) * 0.4], 0.025, [0.22, 0.17, 0.12], [0.3, 0.25, 0.18]); }
  return G.build();
}
/** Иван-чай: 4–5 стеблей, узкие листья, розово-лиловые кисти сверху. */
function fireweedGeo() {
  const G = new VG(), pink = rgb(0xc2508a), pinkD = rgb(0x8a3468), green = [0.22, 0.36, 0.14], greenL = [0.35, 0.5, 0.2];
  for (let k = 0; k < 5; k++) {
    const a = hx(k + 1) * TAU, r = hx(k + 9) * 0.18, h = 0.8 + hx(k + 17) * 0.55, lean = (hx(k + 23) - 0.5) * 0.15;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r, tx = bx + lean, tz = bz + lean * 0.5;
    G.stem([bx, 0, bz], [tx, h, tz], 0.012, green, greenL);
    for (let j = 0; j < 4; j++) {
      const y = h * (0.2 + j * 0.15), la = a + j * 2.1, L = 0.16;
      const px = bx + (tx - bx) * (y / h), pz = bz + (tz - bz) * (y / h);
      G.quad([px, y, pz], [px + Math.cos(la) * L, y + 0.05, pz + Math.sin(la) * L], [px + Math.cos(la) * L * 1.1, y + 0.07, pz + Math.sin(la) * L * 1.1], [px, y + 0.03, pz], green, [0, 1, 0]);
    }
    // кисть: скрещённые конусы-карточки, к верху темнее и уже
    const y0 = h * 0.72;
    for (const rr of [0, Math.PI / 2]) {
      const dx = Math.cos(rr) * 0.055, dz = Math.sin(rr) * 0.055;
      G.quad([tx - dx, y0, tz - dz], [tx + dx, y0, tz + dz], [tx + dx * 0.2, h + 0.08, tz + dz * 0.2], [tx - dx * 0.2, h + 0.08, tz - dz * 0.2], [pink, pink, pinkD, pinkD], [0.3, 0.8, 0.3]);
    }
  }
  return G.build();
}
/** Кустик цветов: несколько стеблей с венчиками (i — вид: ромашка, колокольчик, клевер, пижма). */
function flowerGeo(petal, heart, i) {
  const G = new VG(), P = rgb(petal), Hc = rgb(heart), green = [0.2, 0.34, 0.12], greenL = [0.3, 0.46, 0.18];
  const n = i === 2 ? 7 : 5;
  for (let k = 0; k < n; k++) {
    const a = hx(k * 3 + i) * TAU, r = 0.04 + hx(k + i * 7) * 0.14, h = (i === 2 ? 0.14 : 0.28) + hx(k + 31 + i) * 0.22;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r, tx = bx + (hx(k + 5) - 0.5) * 0.08, tz = bz + (hx(k + 6) - 0.5) * 0.08;
    G.stem([bx, 0, bz], [tx, h, tz], 0.006, green, greenL);
    const s = i === 0 ? 0.05 : i === 1 ? 0.035 : 0.03;
    if (i === 1) {
      // колокольчик: поникший венчик — две карточки вниз
      for (const rr of [0, Math.PI / 2]) { const dx = Math.cos(rr) * s, dz = Math.sin(rr) * s; G.quad([tx - dx, h - 0.06, tz - dz], [tx + dx, h - 0.06, tz + dz], [tx + dx * 0.3, h, tz + dz * 0.3], [tx - dx * 0.3, h, tz - dz * 0.3], [P, P, Hc, Hc], [0.3, 0.7, 0.3]); }
    } else {
      // плоский венчик, чуть наклонён; центр — второй цвет
      const tilt = 0.25;
      G.quad([tx - s, h + tilt * s, tz - s], [tx + s, h - tilt * s, tz - s], [tx + s, h - tilt * s, tz + s], [tx - s, h + tilt * s, tz + s], [P, P, P, P], [0, 1, 0]);
      const c = s * 0.38;
      G.quad([tx - c, h + 0.004, tz - c], [tx + c, h + 0.004, tz - c], [tx + c, h + 0.004, tz + c], [tx - c, h + 0.004, tz + c], Hc, [0, 1, 0]);
    }
  }
  return G.build();
}
/** Бурьян: тонкие сухие стебли, на верхушке — метёлка из мелких колосков веером. */
function weedGeo() {
  const G = new VG(), dry0 = [0.36, 0.3, 0.17], dry1 = [0.62, 0.55, 0.36], seed = [0.5, 0.42, 0.26];
  for (let k = 0; k < 7; k++) {
    const a = hx(k + 50) * TAU, r = hx(k + 60) * 0.12, h = 0.55 + hx(k + 70) * 0.5, lean = 0.1 + hx(k + 80) * 0.2;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r, tx = bx + Math.cos(a) * lean, tz = bz + Math.sin(a) * lean;
    G.stem([bx, 0, bz], [tx, h, tz], 0.004, dry0, dry1);
    for (let j = 0; j < 6; j++) {
      const y = h - 0.02 - j * 0.035, ba = a + j * 2.4 + hx(k * 7 + j), L = 0.05 + hx(k + j * 3) * 0.04;
      const px = bx + (tx - bx) * (y / h), pz = bz + (tz - bz) * (y / h);
      const ex = px + Math.cos(ba) * L, ez = pz + Math.sin(ba) * L, ey = y + L * 0.9;
      const sx = -Math.sin(ba) * 0.006, sz = Math.cos(ba) * 0.006;
      G.quad([px - sx, y, pz - sz], [px + sx, y, pz + sz], [ex + sx * 1.6, ey, ez + sz * 1.6], [ex - sx * 1.6, ey, ez - sz * 1.6], seed, [0.3, 0.8, 0.3]);
    }
  }
  return G.build();
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
