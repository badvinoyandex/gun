import * as THREE from 'three';
import { rng, TAU, lerp } from '../core/math.js';
import { CAMP, campXZ, campRot, inCamp, terrainH, addPad, keep, pathInfluence, trenchDist, isFree } from './layout.js';
import { hFast } from './heightcache.js';
import { M } from '../gen/materials.js';
import { box, cyl, beam, place, frame, beginStruct, panel, noPanel, endStruct } from './builders.js';
import { addBox, addCircle } from '../core/colliders.js';
import { addLamp } from './lamps.js';
import { bench } from './lamps.js';
import { vehicle } from './vehicles.js';
import { makeCloth } from './cloth.js';
import { treeNear } from './forest.js';

/* ============================================================================
   ПИОНЕРСКИЙ ЛАГЕРЬ «ВОЛЧОНОК»
   Заброшен лет тридцать назад. Покосившийся штакетник с проломами, арка с
   облупленной вывеской, линейка с пустым флагштоком и гипсовым горнистом без
   головы, шесть отрядных корпусов, столовая, умывальник, душ, туалеты, качели.
   Всё разрушается: стены, кровля, двери, секции забора, лавки, статуя.
   Фонари на аллеях — старые, мерцают бледно-жёлтым.
   Локальные оси: r — вправо (лицом к озеру), f — к озеру; ворота на f = 16.
============================================================================ */
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const toward = (df, dr) => campRot(dr, df);
const FACE_IN_L = campRot(1, 0), FACE_IN_R = campRot(-1, 0), FACE_LAKE = campRot(0, 1);

/** Постройки-дома для общего конвейера (площадки, house()). */
export function campHouses() {
  const H = [];
  const cab = (n, r, f, face) => {
    const [x, z] = campXZ(r, f);
    H.push({ kind: 'house', id: 'cabin_camp' + n, camp: true, x, z, rot: face, w: 5.2, d: 4.2, h: 2.4, style: 'camp', wallMat: M.planksCamp, trimMat: M.planksWhite,
      roofMat: M.roofCamp, roof: 'rust', seed: 700 + n, damage: 0.45, pitch: 0.55,
      windows: [{ side: 'front', at: 1.5, w: 0.9 }, { side: 'left', at: 0.3, w: 0.9 }, { side: 'right', at: -0.3, w: 0.9 }, { side: 'back', at: 0, w: 0.9 }],
      door: { side: 'front', at: -1.0 }, furnish: cabinFurnish, decor: (o, R, F, fy) => signOver(o, F, fy, M.signCabin[n - 1], -1.0, 0.9, 0.34) });
  };
  cab(1, -15, 10.5, FACE_IN_L); cab(2, -15, 1.5, FACE_IN_L); cab(3, -15, -7.5, FACE_IN_L);
  cab(4, 15, 10.5, FACE_IN_R); cab(5, 15, 1.5, FACE_IN_R); cab(6, 15, -7.5, FACE_IN_R);
  {
    const [x, z] = campXZ(0, -12.2);
    H.push({ kind: 'house', id: 'dining', camp: true, x, z, rot: FACE_LAKE, w: 12, d: 7, h: 2.9, style: 'camp', wallMat: M.planksCream, trimMat: M.planksWhite,
      roofMat: M.roofCamp, roof: 'rust', seed: 777, damage: 0.35, pitch: 0.42, stove: [4.2, -2.2],
      windows: [{ side: 'front', at: -4.4, w: 1.2 }, { side: 'front', at: -2.4, w: 1.2 }, { side: 'front', at: 2.4, w: 1.2 }, { side: 'front', at: 4.4, w: 1.2 },
        { side: 'back', at: -3.5, w: 1.2 }, { side: 'back', at: 0, w: 1.2 }, { side: 'left', at: 0, w: 1.2 }, { side: 'right', at: 1, w: 1.2 }],
      door: { side: 'front', at: 0 }, door2: { side: 'back', at: 3 }, furnish: diningFurnish, decor: (o, R, F, fy) => signOver(o, F, fy, M.signDining, 0, 3.2, 0.8) });
  }
  {
    const [x, z] = campXZ(-18, -16.4);
    H.push({ kind: 'house', id: 'wc', camp: true, x, z, rot: FACE_LAKE, w: 3.8, d: 2.4, h: 2.2, style: 'camp', wallMat: M.planksWhite, trimMat: M.planksCamp,
      roofMat: M.roofCamp, roof: 'rust', seed: 781, damage: 0.5, pitch: 0.25, windows: [], door: { side: 'front', at: -0.95 }, door2: { side: 'front', at: 0.95 },
      furnish: wcFurnish, decor: (o, R, F, fy) => signOver(o, F, fy, M.signWC, 0, 0.8, 0.4) });
  }
  {
    const [x, z] = campXZ(14.5, -17);
    H.push({ kind: 'house', id: 'shower', camp: true, x, z, rot: FACE_LAKE, w: 3, d: 2.2, h: 2.2, style: 'camp', wallMat: M.planksCamp, trimMat: M.planksWhite,
      roofMat: M.roofCamp, roof: 'rust', seed: 790, damage: 0.3, pitch: 0.1, windows: [{ side: 'left', at: 0, w: 0.5 }], door: { side: 'front', at: 0.6 },
      interior: false, decor: showerTank });
  }
  return H;
}
/** Остальное — своими строителями. */
export function campItems() {
  const out = [];
  const [gx, gz] = campXZ(0, CAMP.f1);
  out.push({ kind: 'campGate', x: gx, z: gz, rot: FACE_LAKE });
  out.push({ kind: 'campWash', xz: campXZ(-11.3, -17.3), rot: FACE_LAKE });
  out.push({ kind: 'campFlag', xz: campXZ(-3.6, 2.2) });
  out.push({ kind: 'campStatue', xz: campXZ(3.8, 4.2), rot: campRot(-0.3, 1) });
  out.push({ kind: 'campTribune', xz: campXZ(0, -2.4), rot: FACE_LAKE });
  out.push({ kind: 'campBoard', xz: campXZ(-6.2, 6.2), rot: campRot(1, -0.3) });
  out.push({ kind: 'campSwing', xz: campXZ(7.5, 12.5), rot: campRot(1, 0) });
  out.push({ kind: 'campSpeaker', xz: campXZ(5.2, -1.2) });
  out.push({ kind: 'campBus', xz: campXZ(8.5, 22.5), rot: campRot(1, 0.08) });
  return out;
}
/** Регистрация в плане: площадки, запретные зоны для деревьев, секции забора. */
export function planCamp(items) {
  for (const it of items) {
    const [x, z] = it.xz ?? [it.x, it.z];
    it.x = x; it.z = z;
    const r = { campGate: 3.2, campWash: 3, campFlag: 1.2, campStatue: 1.4, campTribune: 2.2, campBoard: 1.6, campSwing: 2.2, campSpeaker: 0.6, campBus: 4.8 }[it.kind] ?? 1.5;
    keep(x, z, r);
  }
  addPad(...campXZ(0, 1.5), 4.6, 5.2, FACE_LAKE, 3);            // линейка выровнена
  FENCE.length = 0;
  const add = (r0, f0, r1, f1) => {
    const L = Math.hypot(r1 - r0, f1 - f0), n = Math.max(1, Math.round(L / 2.5));
    for (let i = 0; i < n; i++) {
      const a = i / n, b = (i + 1) / n;
      const ra = lerp(r0, r1, a), fa = lerp(f0, f1, a), rb = lerp(r0, r1, b), fb = lerp(f0, f1, b);
      const [xa, za] = campXZ(ra, fa), [xb, zb] = campXZ(rb, fb), mx = (xa + xb) / 2, mz = (za + zb) / 2;
      // проломы: у троп, у окопов и просто сгнившие секции
      if (pathInfluence(mx, mz, 0.6) > 0 || trenchDist(mx, mz) < 2) continue;
      FENCE.push({ xa, za, xb, zb, mx, mz });
      keep(mx, mz, 1.1);
    }
  };
  const { r0, r1, f0, f1 } = CAMP;
  add(r0, f1, -1.9, f1); add(1.9, f1, r1, f1);                   // фасад с воротами
  add(r1, f1, r1, f0); add(r1, f0, r0, f0); add(r0, f0, r0, f1);
}
const FENCE = [];

/* ---------- Строители ---------- */
function signOver(o, F, fy, mat, at, w, h) {
  const [x, z] = F.p(at, o.d / 2 + 0.07);
  panel('trim', { hp: 0.4, density: 400 });
  place(mat, new THREE.PlaneGeometry(w, h), x, fy + 2.12 + (o.h ?? 2.5) - 2.5 + (o.id === 'dining' ? 0.4 : 0), z, [0, o.rot, (Math.random() - 0.5) * 0.08]);
  noPanel();
}
/** Отрядный корпус: ряды железных кроватей, тумбочки, пара кроватей опрокинута. */
function cabinFurnish(o, R, F, fy, B) {
  const { w, d } = o;
  for (let i = 0; i < 4; i++) {
    const lx = -w / 2 + 0.75 + i * 1.2, lz = -d / 2 + 1.1;
    panel('prop', { hp: 0.5, density: 1200, float: 0, burnable: false });
    if (R() < 0.25) {
      B(M.rust, lx, fy + 0.5, lz + 0.3, 0.85, 0.9, 0.05, { r: Math.PI / 2 + R.range(-0.3, 0.3), tile: 1, collide: true, walk: false });
    } else {
      B(M.rust, lx, fy + 0.45, lz, 0.8, 0.04, 1.8, { tile: 1, r: R.range(-0.06, 0.06) });
      for (const [a, b] of [[-0.38, -0.88], [0.38, -0.88], [-0.38, 0.88], [0.38, 0.88]]) B(M.rust, lx + a, fy + 0.3, lz + b, 0.04, 0.6, 0.04, { tile: 1 });
      B(M.rust, lx, fy + 0.75, lz - 0.9, 0.8, 0.5, 0.04, { tile: 1 });
      if (R() < 0.5) B(M.sack, lx, fy + 0.5, lz, 0.72, 0.08, 1.6, { tile: 1, rz: R.range(-0.05, 0.05) });
    }
    panel('prop', { hp: 0.3, density: 450 });
    B(M.planksWhite, lx + 0.6, fy + 0.3, lz - 0.7, 0.36, 0.6, 0.36, { tile: 1, r: R.range(-0.2, 0.2) });
  }
}
/** Столовая: длинные столы и лавки, часть опрокинута, раздача у стены. */
function diningFurnish(o, R, F, fy, B) {
  const { w, d } = o;
  for (let row = 0; row < 2; row++) for (let i = 0; i < 3; i++) {
    const lx = -w / 2 + 2.2 + i * 3.4, lz = -0.8 + row * 2.2;
    panel('prop', { hp: 0.4, density: 450 });
    if (R() < 0.3) B(M.planksCream, lx, fy + 0.38, lz, 2.4, 0.75, 0.05, { tile: 1, r: R.range(-0.4, 0.4), collide: true, walk: false });
    else {
      B(M.planksCream, lx, fy + 0.74, lz, 2.4, 0.05, 0.8, { tile: 1, collide: true });
      for (const a of [-1.05, 1.05]) B(M.steelPipe, lx + a, fy + 0.37, lz, 0.05, 0.72, 0.6, { tile: 1 });
    }
    for (const s of [-1, 1]) {
      panel('prop', { hp: 0.3, density: 450 });
      B(M.planksDark, lx, fy + 0.42, lz + s * 0.65, 2.2, 0.05, 0.28, { tile: 1, rz: R() < 0.2 ? 0.4 : 0 });
    }
  }
  panel('prop', { hp: 0.8, density: 900, float: 0, burnable: false });
  B(M.steelPipe, -w / 2 + 1.8, fy + 0.5, -d / 2 + 0.6, 3, 1.0, 0.7, { tile: 1, collide: true, walk: false });
}
/** Туалет: перегородка, дыры в полу, двери «М» и «Ж». */
function wcFurnish(o, R, F, fy, B) {
  panel('wall', { hp: 0.5, mode: 'rigid', density: 450 });
  B(M.planksWhite, 0, fy + 1.0, 0, 0.05, 2.0, o.d - 0.3, { tile: 1.5, collide: true, walk: false });
  noPanel();
  for (const s of [-1, 1]) B(M.dark, s * 0.95, fy + 0.01, -0.3, 0.3, 0.02, 0.4, { tile: 1 });
}
/** Душ: бак-бочка на раме на крыше — падает первым, когда кровля проваливается. */
function showerTank(o, R, F, fy, B, S) {
  const walls = S.panels.filter(p => p.kind === 'wall');
  panel('prop', { hp: 0.6, sup: { list: walls, frac: 0.6 }, density: 900, float: 2.4, burnable: false });
  const top = fy + (o.h ?? 2.5) + 0.2;
  for (const [a, b] of [[-0.6, -0.5], [0.6, -0.5], [-0.6, 0.5], [0.6, 0.5]]) B(M.steelPipe, a, top + 0.3, b, 0.06, 0.6, 0.06, { tile: 1 });
  const [tx, tz] = F.p(0, 0);
  cyl(M.dark, tx, top + 1.0, tz, 0.55, 0.55, 1.2, { seg: 12, rot: [0, o.rot, Math.PI / 2] });
  noPanel();
  // лейки внутри
  for (const s of [-0.6, 0.6]) { const [px, pz] = F.p(s, -0.4); cyl(M.steelPipe, px, fy + 2.0, pz, 0.08, 0.02, 0.12, { seg: 8 }); }
}

function gate(it) {
  const F = frame(it.x, it.z, it.rot), y = hFast(it.x, it.z);
  const S = beginStruct({ kind: 'gate', x: it.x, z: it.z, rot: it.rot, w: 5, d: 0.6, h: 4, fy: y, fuel: 0.5 });
  const posts = [];
  for (const s of [-1, 1]) {
    const [px, pz] = F.p(s * 2.2, 0);
    posts.push(panel('wall', { hp: 1.6, mode: 'rigid', density: 1600, float: 0, burnable: false }));
    box(M.brick, px, y + 1.25, pz, 0.55, 2.5, 0.55, { rot: it.rot, tile: 0.6, collide: true, walk: false });
    box(M.concrete, px, y + 2.55, pz, 0.65, 0.1, 0.65, { rot: it.rot, tile: 0.6 });
    // стойки арки
    cyl(M.steelPipe, px, y + 3.1, pz, 0.06, 0.06, 1.2, { seg: 8 });
  }
  // арка с вывеской: держится на обоих столбах
  panel('roof', { hp: 0.7, sup: { list: posts, frac: 0.99 }, density: 700, float: 0, burnable: false });
  const [ax, az] = F.p(0, 0);
  box(M.steelPipe, ax, y + 3.72, az, 4.8, 0.08, 0.08, { rot: it.rot, tile: 1 });
  box(M.steelPipe, ax, y + 3.06, az, 4.8, 0.06, 0.06, { rot: it.rot, tile: 1 });
  place(M.signGate, new THREE.PlaneGeometry(4.4, 0.62), ax, y + 3.38, az, [0, it.rot, 0.035]);
  place(M.wolf, new THREE.CircleGeometry(0.42, 20), ax, y + 4.2, az, [0, it.rot, 0]);
  // створки: одна распахнута и перекошена, вторая сорвана и лежит в траве
  panel('door', { hp: 0.4, density: 700, float: 0 });
  const [lx, lz] = F.p(-1.25, 0.9);
  frameGate(lx, y + 0.95, lz, it.rot + 1.2, 2.0);
  panel('door', { hp: 0.4, density: 700, float: 0 });
  const [rx, rz] = F.p(1.9, 2.2);
  frameGate(rx, y + 0.12, rz, it.rot + 0.3, 2.0, Math.PI / 2 - 0.05);
  endStruct();
}
function frameGate(x, y, z, rot, w, lay = 0) {
  const e = [lay, rot, 0];
  const g = new THREE.BoxGeometry(w, 0.06, 0.05), gv = new THREE.BoxGeometry(0.06, 1.7, 0.05);
  const c = Math.cos(rot), s = Math.sin(rot), up = lay ? [0, 0.02, 0] : [0, 1, 0];
  for (const k of [-0.8, 0, 0.8]) {
    const off = lay ? [s * k, 0, c * k] : [0, k, 0];
    place(M.paintRed, g, x + off[0], y + off[1], z + off[2], e);
  }
  for (let i = 0; i <= 6; i++) {
    const t = -w / 2 + i * w / 6;
    place(M.paintRed, gv, x + c * t, y, z - s * t, e);
  }
}
function fence(R) {
  // штакетник: столбы, две прожилины, рейки; секция — отдельная панель, часть повалена
  const picket = new THREE.BoxGeometry(0.09, 1.25, 0.025);
  for (const sec of FENCE) {
    const { xa, za, xb, zb } = sec, L = Math.hypot(xb - xa, zb - za), rot = Math.atan2(xb - xa, zb - za) - Math.PI / 2;
    const ya = hFast(xa, za), yb = hFast(xb, zb);
    const st = beginStruct({ kind: 'fence', x: sec.mx, z: sec.mz, rot, w: L, d: 0.2, h: 1.3, fy: Math.min(ya, yb), fuel: 0.2 });
    noPanel();
    cyl(M.deadwood, xa, ya + 0.65, za, 0.06, 0.05, 1.45, { seg: 6, rot: [R.range(-0.06, 0.06), 0, R.range(-0.06, 0.06)] });
    const fallen = R() < 0.18, lean = fallen ? 0 : R.range(-0.12, 0.12);
    panel('prop', { hp: 0.35, density: 450 });
    const mat = R() < 0.6 ? M.planksCamp : M.planksWhite;
    if (fallen) {
      // секция повалена в траву
      const mx = sec.mx, mz = sec.mz, y = hFast(mx, mz) + 0.05;
      for (let i = 0; i < L / 0.2; i++) {
        const t = -L / 2 + i * 0.2 + 0.1, px = mx + Math.cos(rot) * t, pz = mz - Math.sin(rot) * t;
        if (R() < 0.2) continue;
        place(mat, picket, px, y, pz, [Math.PI / 2, rot, R.range(-0.1, 0.1)]);
      }
      endStruct(); continue;
    }
    for (const hh of [0.3, 1.0]) beam(mat, V(xa, ya + hh, za), V(xb, yb + hh, zb), 0.03, { seg: 4 });
    for (let i = 0; i < L / 0.2; i++) {
      if (R() < 0.12) continue;                                        // выпавшая рейка
      const t = (i + 0.5) / (L / 0.2), px = lerp(xa, xb, t), pz = lerp(za, zb, t), py = lerp(ya, yb, t);
      place(mat, picket, px, py + 0.62, pz, [lean + R.range(-0.04, 0.04), rot, R.range(-0.06, 0.06)]);
    }
    addBox(sec.mx, (ya + yb) / 2 + 0.65, sec.mz, L, 1.3, 0.14, rot, { walk: false });
    endStruct();
  }
}
function wash(it) {
  const [x, z] = [it.x, it.z], F = frame(x, z, it.rot), y = hFast(x, z);
  const S = beginStruct({ kind: 'shed', x, z, rot: it.rot, w: 4.6, d: 1.8, h: 2.3, fy: y, fuel: 0.4 });
  const posts = [];
  for (const a of [-2.1, 2.1]) for (const b of [-0.75, 0.75]) {
    const [px, pz] = F.p(a, b);
    posts.push(panel('prop', { hp: 0.6, density: 450 }));
    cyl(M.deadwood, px, y + 1.1, pz, 0.07, 0.06, 2.3, { seg: 6 });
    addCircle(px, pz, 0.08, y, y + 2.3);
  }
  panel('roof', { hp: 0.5, sup: { list: posts, frac: 0.5 }, density: 1000, float: 0, burnable: false });
  box(M.roofCamp, x, y + 2.35, z, 4.8, 0.03, 2.1, { rot: it.rot, rx: 0.12, tile: 1.2 });
  addBox(x, y + 2.35, z, 4.8, 0.2, 2.1, it.rot, { walk: true });
  place(M.signWash, new THREE.PlaneGeometry(1.8, 0.34), ...(() => { const [px, pz] = F.p(0, 1.07); return [px, y + 2.1, pz]; })(), [0, it.rot, 0]);
  // корыто на ножках с кранами
  panel('prop', { hp: 0.6, density: 1400, float: 0, burnable: false });
  box(M.steelPipe, x, y + 0.85, z, 4.0, 0.22, 0.45, { rot: it.rot, tile: 1, collide: true, walk: false });
  for (const a of [-1.8, -0.6, 0.6, 1.8]) { const [px, pz] = F.p(a, 0); cyl(M.steelPipe, px, y + 0.4, pz, 0.03, 0.03, 0.8, { seg: 5 }); }
  const [bx, bz] = F.p(0, -0.3);
  box(M.steelPipe, bx, y + 1.2, bz, 4.0, 0.06, 0.06, { rot: it.rot, tile: 1 });
  for (let i = 0; i < 7; i++) { const [px, pz] = F.p(-1.8 + i * 0.6, -0.18); cyl(M.steelPipe, px, y + 1.13, pz, 0.02, 0.02, 0.14, { seg: 5, rot: [0.6, it.rot, 0] }); }
  // осколок зеркала на столбе
  const [mx, mz] = F.p(-2.1, -0.72);
  place(M.glass, new THREE.PlaneGeometry(0.3, 0.42), mx, y + 1.55, mz, [0, it.rot, 0.2]);
  endStruct();
}
function flag(it) {
  const [x, z] = [it.x, it.z], y = hFast(x, z), H = 8.5;
  beginStruct({ kind: 'prop', x, z, rot: 0, w: 0.6, d: 0.6, h: H, fy: y, fuel: 0 });
  noPanel();
  box(M.concrete, x, y + 0.2, z, 0.8, 0.4, 0.8, { tile: 0.8 });
  panel('prop', { hp: 1.0, density: 800, float: 0, burnable: false });
  cyl(M.steelPipe, x, y + H / 2, z, 0.07, 0.045, H, { seg: 8 });
  place(M.steelPipe, new THREE.SphereGeometry(0.1, 8, 6), x, y + H + 0.05, z);
  addCircle(x, z, 0.09, y, y + H);
  endStruct();
  // обрывок красного флага на середине мачты — спущен и забыт
  const dir = [Math.cos(0.64), Math.sin(0.64)];
  makeCloth({ nx: 7, ny: 5, material: M.flagRag, wind: 1.2, stiff: 5, drag: 0.98,
    place: (u, v) => V(x + dir[0] * u * 1.3, y + H * 0.55 - v * 0.8, z + dir[1] * u * 1.3), pinFn: (i, j) => i === 0 && (j === 0 || j === 4) });
  beam(M.rope, V(x + 0.07, y + 1.1, z), V(x + 0.07, y + H - 0.1, z), 0.007, { seg: 3, cast: false });
}
/** Гипсовый горнист на постаменте: голова отбита и лежит рядом. */
function statue(it) {
  const [x, z] = [it.x, it.z], y = hFast(x, z), F = frame(x, z, it.rot);
  beginStruct({ kind: 'statue', x, z, rot: it.rot, w: 1.2, d: 1.2, h: 3.4, fy: y, fuel: 0 });
  noPanel();
  box(M.concrete, x, y + 0.5, z, 1.2, 1.0, 1.2, { rot: it.rot, tile: 0.8, collide: true });
  panel('prop', { hp: 1.4, mode: 'rigid', density: 1600, float: 0, burnable: false });
  const P = (lx, ly, lz) => { const [px, pz] = F.p(lx, lz); return [px, y + 1.0 + ly, pz]; };
  cyl(M.plaster, ...P(-0.13, 0.42, 0), 0.1, 0.09, 0.85, { seg: 8 });
  cyl(M.plaster, ...P(0.13, 0.42, 0), 0.1, 0.09, 0.85, { seg: 8 });
  cyl(M.plaster, ...P(0, 1.15, 0), 0.26, 0.22, 0.75, { seg: 10 });
  box(M.plaster, ...P(0, 1.55, 0.05), 0.55, 0.12, 0.3, { rot: it.rot, tile: 1 });
  place(M.plaster, new THREE.CylinderGeometry(0.06, 0.06, 0.2, 8), ...P(0, 1.63, 0), 0);
  // рука с горном вскинута вверх
  beam(M.plaster, V(...P(0.27, 1.45, 0)), V(...P(0.22, 1.9, 0.25)), 0.055);
  beam(M.plaster, V(...P(0.22, 1.9, 0.25)), V(...P(0.05, 1.72, 0.45)), 0.05);
  const horn = new THREE.CylinderGeometry(0.1, 0.02, 0.5, 10, 1, true);
  place(M.steelPipe, horn, ...P(0.02, 1.75, 0.62), [Math.PI / 2 - 0.3, it.rot, 0]);
  beam(M.plaster, V(...P(-0.27, 1.45, 0)), V(...P(-0.33, 1.05, 0.02)), 0.055);
  addBox(x, y + 1.9, z, 0.6, 1.8, 0.6, it.rot, { walk: false });
  noPanel();
  const [hx, hz] = F.p(0.9, 0.7);
  place(M.plaster, new THREE.SphereGeometry(0.15, 10, 8), hx, hFast(hx, hz) + 0.12, hz);
  endStruct();
}
function tribune(it) {
  const [x, z] = [it.x, it.z], y = hFast(x, z), F = frame(x, z, it.rot);
  beginStruct({ kind: 'prop', x, z, rot: it.rot, w: 3, d: 1.6, h: 1.4, fy: y, fuel: 0.4 });
  panel('prop', { hp: 0.8, density: 500 });
  box(M.paintRed, x, y + 0.3, z, 3, 0.6, 1.6, { rot: it.rot, tile: 1, collide: true });
  const [sx, sz] = F.p(0, 1.1);
  box(M.planksDark, sx, y + 0.15, sz, 1.2, 0.3, 0.5, { rot: it.rot, tile: 1, collide: true });
  panel('prop', { hp: 0.4, density: 500 });
  const [lx, lz] = F.p(0, -0.3);
  box(M.planksWhite, lx, y + 1.1, lz, 0.9, 1.0, 0.6, { rot: it.rot, tile: 1 });
  endStruct();
}
function board(it) {
  const [x, z] = [it.x, it.z], y = hFast(x, z);
  beginStruct({ kind: 'sign', x, z, rot: it.rot, w: 3.2, d: 0.3, h: 2.6, fy: y, fuel: 0.3 });
  panel('prop', { hp: 0.5, density: 450 });
  for (const s of [-1, 1]) cyl(M.deadwood, x + Math.cos(it.rot) * s * 1.5, y + 1.2, z - Math.sin(it.rot) * s * 1.5, 0.06, 0.06, 2.4, { seg: 6 });
  place(M.signMotto, new THREE.PlaneGeometry(3.2, 0.8), x, y + 1.95, z, [0, it.rot, -0.05]);
  endStruct();
}
/** Качели: ржавая П-рама, сиденье висит на одной цепи. */
function swing(it) {
  const [x, z] = [it.x, it.z], y = hFast(x, z), F = frame(x, z, it.rot);
  beginStruct({ kind: 'prop', x, z, rot: it.rot, w: 2.4, d: 1.5, h: 2.4, fy: y, fuel: 0 });
  panel('prop', { hp: 0.9, density: 900, float: 0, burnable: false });
  for (const s of [-1, 1]) for (const b of [-0.6, 0.6]) {
    const [ax, az] = F.p(s * 1.2, b), [bx, bz] = F.p(s * 1.2, 0);
    beam(M.steelPipe, V(ax, y, az), V(bx, y + 2.3, bz), 0.04);
  }
  const [l, lz] = F.p(-1.2, 0), [r, rz] = F.p(1.2, 0);
  beam(M.steelPipe, V(l, y + 2.3, lz), V(r, y + 2.3, rz), 0.045);
  panel('prop', { hp: 0.3, density: 500 });
  const [c1, c1z] = F.p(-0.25, 0), [c2, c2z] = F.p(0.25, 0), [sx, sz] = F.p(0.1, 0.35);
  beam(M.steelPipe, V(c1, y + 2.3, c1z), V(sx - 0.2, y + 0.5, sz), 0.008, { cast: false });
  beam(M.steelPipe, V(c2, y + 2.3, c2z), V(sx + 0.3, y + 0.2, sz + 0.1), 0.008, { cast: false });
  box(M.planksCamp, sx, y + 0.35, sz, 0.55, 0.04, 0.25, { rot: it.rot, rz: 0.5, tile: 1 });
  addBox(x, y + 1.15, z, 2.5, 2.3, 0.2, it.rot, { walk: false });
  endStruct();
}
function speaker(it) {
  const [x, z] = [it.x, it.z], y = hFast(x, z);
  beginStruct({ kind: 'prop', x, z, rot: 0, w: 0.5, d: 0.5, h: 5, fy: y, fuel: 0.2 });
  panel('prop', { hp: 0.8, density: 500 });
  cyl(M.deadwood, x, y + 2.5, z, 0.1, 0.08, 5, { seg: 7 });
  addCircle(x, z, 0.12, y, y + 5);
  const horn = new THREE.CylinderGeometry(0.28, 0.06, 0.55, 12, 1, true);
  place(M.steelPipe, horn, x + 0.3, y + 4.6, z, [0, 0, -Math.PI / 2 + 0.25]);
  place(M.steelPipe, horn, x - 0.2, y + 4.5, z + 0.25, [Math.PI / 2 - 0.2, 0.6, 0]);
  endStruct();
}
function stumps(R) {
  // пни от спиленных при строительстве сосен
  let n = 0;
  for (let i = 0; i < 140 && n < 16; i++) {
    const [x, z] = campXZ(R.range(CAMP.r0 + 1, CAMP.r1 - 1), R.range(CAMP.f0 + 1, CAMP.f1 - 1));
    if (!isFree(x, z, 0.6, { pathPad: 0.3, trenchPad: 1 }) || treeNear(x, z, 1)) continue;
    const y = hFast(x, z), r = R.range(0.22, 0.4), h = R.range(0.25, 0.55);
    cyl(M.barkLog, x, y + h / 2 - 0.05, z, r * 1.2, r, h, { seg: 8 });
    place(M.logEnd, new THREE.CircleGeometry(r * 0.95, 9), x, y + h - 0.04, z, [-Math.PI / 2, 0, 0]);
    addCircle(x, z, r * 1.1, y, y + h);
    n++;
  }
}
export function buildCampItem(it) {
  if (it.kind === 'campGate') gate(it);
  else if (it.kind === 'campWash') wash(it);
  else if (it.kind === 'campFlag') flag(it);
  else if (it.kind === 'campStatue') statue(it);
  else if (it.kind === 'campTribune') tribune(it);
  else if (it.kind === 'campBoard') board(it);
  else if (it.kind === 'campSwing') swing(it);
  else if (it.kind === 'campSpeaker') speaker(it);
  else if (it.kind === 'campBus') vehicle('bus', it.x, it.z, it.rot, { seed: 91, paint: 3, tilt: 0.05, roll: 0.07 });
  else return false;
  return true;
}
export function buildCampExtras() {
  const R = rng(4747);
  fence(R);
  stumps(R);
  // лавочки у линейки и на аллеях: крашеные рейки на ржавых ножках
  for (const [r, f, dr, df] of [[-5.2, 0, 1, 0], [-5.2, 4, 1, 0], [5.2, 0.2, -1, 0], [5.2, 4.2, -1, 0], [-8.6, 8.5, 1, 0], [8.6, -4, -1, 0], [-8.6, -6, 1, 0], [2.2, -6, 0, 1]]) {
    const [x, z] = campXZ(r, f);
    bench(x, z, campRot(dr, df), R, { leg: M.steelPipe, slat: R() < 0.5 ? M.planksCamp : M.planksWhite });
  }
}
/** Окна-«глаза» ночью: в столовой и одном корпусе кто-то жжёт огарок. */
export const CAMP_INFO = { name: 'Пионерский лагерь «Волчонок»' };
