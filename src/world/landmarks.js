import * as THREE from 'three';
import { scene, Q, camera, FRAME } from '../core/env.js';
import { rng, TAU, lerp, clamp, polyAt, smoothstep } from '../core/math.js';
import { MAP, SPAWNS, CAMP, campXZ, ISLAND, BRIDGE, FORDS, STREAMS, STREAM_BW, BOGS, bogLevel, inBog, streamAt, RING_ROAD, PATHS, CRATERS,
  terrainH, lakeRho, lakeContour, isFree, keep, polyDist, pathInfluence } from './layout.js';
import { hFast } from './heightcache.js';
import { M } from '../gen/materials.js';
import { box, cyl, beam, place, frame, beginStruct, panel, noPanel, endStruct } from './builders.js';
import { addBox, addCircle } from '../core/colliders.js';
import { addLadder } from '../game/ladders.js';
import { addLamp } from './lamps.js';
import { addPane } from '../fx/glass.js';
import { buildBoat } from './lake.js';
import { PHYS, addBody } from '../core/physics.js';
import { injectWind } from './wind.js';
import { saplingGeo } from './forest.js';
import { paperGeo } from './wrecks.js';
import { WIND } from './wind.js';
import { NO_REFLECT } from '../core/env.js';

/* ============================================================================
   ОРИЕНТИРЫ И ПЕРЕПРАВЫ
   • Высота: пожарные вышки (24 м, лестницы маршами с площадками), водонапорные
     башни у лагеря и турбазы, охотничьи лабазы на флангах. Всё валится, если
     выбить опору: вышка кренится в сторону подорванной ноги и ложится поперёк леса.
   • Озеро: свайный мост на остров, броды по песчаным косам с камнями, лодки на
     привязи (качаются, их сносит ветром и взрывом).
   • Ручей: вода в овраге, труба под кольцевой (пролезть — пригнувшись), кладка
     на тропе, бревно-переход.
   • Болото: окна тёмной воды, осока на кочках, рогоз, сухие берёзы, гать.
   Всё парами (x, z) ↔ (−x, −z), кроме водокачек (у лагеря и турбазы разный облик).
============================================================================ */
const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const LANDMARKS = { towers: [], stands: [], water: [], bridges: [], fords: [], boats: [], culverts: [], scorch: [], sites: [] };

/** Свободное место возле цели: вне троп, окопов, воронок, ручьёв и болот (и в зеркальной точке). */
export function findSpot(tx, tz, r, o = {}) {
  const ok = (x, z) => isFree(x, z, r, { pathPad: o.pathPad ?? 1, trenchPad: o.trenchPad ?? 2.5 }) && streamAt(x, z).d > r + 4 && inBog(x, z) === 0
    && !CRATERS.some(c => Math.hypot(c.x - x, c.z - z) < c.r + r + 1);
  for (let k = 0; k < 400; k++) {
    const a = k * 2.39996, d = Math.sqrt(k) * 1.1;
    const x = tx + Math.cos(a) * d, z = tz + Math.sin(a) * d;
    if (ok(x, z) && (!o.sym || ok(-x, -z))) return [x, z];
  }
  return [tx, tz];
}

/* ---------- План: места под ориентиры (до раскладки леса) ---------- */
export function planLandmarks() {
  const P = LANDMARKS;
  // пожарные вышки на высоком западном и восточном краю
  { const [x, z] = findSpot(-97, 42, 3.4, { sym: true }); P.towers.push({ x, z, rot: 0.3 }, { x: -x, z: -z, rot: 0.3 + Math.PI }); }
  // охотничьи лабазы по углам
  for (const [tx, tz] of [[-73, -97], [-97, -73]]) { const [x, z] = findSpot(tx, tz, 2, { sym: true }); P.stands.push({ x, z, rot: Math.atan2(-x, -z) }, { x: -x, z: -z, rot: Math.atan2(x, z) }); }
  // водокачки: у столовой лагеря и за корпусом турбазы
  { const [x, z] = campXZ(19, -13.5); P.water.push({ x, z, rot: Math.atan2(-1, -1), paint: 'camp' }); }
  { const [x, z] = findSpot(-80, -64, 2.6); P.water.push({ x, z, rot: 0.6, paint: 'grey' }); }
  for (const t of P.towers) keep(t.x, t.z, 3.6);
  for (const t of P.stands) keep(t.x, t.z, 2.2);
  for (const t of P.water) keep(t.x, t.z, 2.8);
  // мост: береговой устой и конец на острове
  for (const sgn of [1, -1]) {
    const [ax, az] = lakeContour(BRIDGE.phi, 2.2).map(v => v * sgn);
    const l = Math.hypot(ax - ISLAND.x, az - ISLAND.z), ix = ISLAND.x + (ax - ISLAND.x) / l * 2.4, iz = ISLAND.z + (az - ISLAND.z) / l * 2.4;
    P.bridges.push({ a: [ax, az], b: [ix, iz] });
    keep(ax, az, 1.5);
  }
  // переходы через ручьи: труба под кольцевой, кладка на тропе
  for (const st of STREAMS) {
    let best = null, bd = 1e9;
    for (let s = 0; s < st.len; s += 0.5) { const q = polyAt(st.pts, s), d = polyDist(q.x, q.z, RING_ROAD.pts); if (d < bd) { bd = d; best = { s, x: q.x, z: q.z, tx: q.tx, tz: q.tz }; } }
    P.culverts.push({ st, ...best, kind: 'pipe' });
    for (const pa of PATHS) {
      if (pa.kind !== 'trail') continue;
      let b2 = null, d2 = 1e9;
      for (let s = 0; s < st.len; s += 0.5) { const q = polyAt(st.pts, s), d = polyDist(q.x, q.z, pa.pts); if (d < d2) { d2 = d; b2 = { s, x: q.x, z: q.z, tx: q.tx, tz: q.tz }; } }
      if (d2 < pa.w / 2 + 0.5 && Math.abs(b2.x) < MAP.PLAY) P.culverts.push({ st, ...b2, kind: 'foot', path: pa });
    }
    // бревно-переход ниже кладки
    const q = polyAt(st.pts, st.len * 0.4);
    P.culverts.push({ st, s: st.len * 0.4, x: q.x, z: q.z, tx: q.tx, tz: q.tz, kind: 'log' });
  }
}

/* ---------- Лестница (геометрия) ---------- */
function ladderGeo(mat, x, z, y0, y1, tx, tz, w = 0.5, hoops = null) {
  for (const e of [-1, 1]) beam(mat, V(x + tx * e * w / 2, y0, z + tz * e * w / 2), V(x + tx * e * w / 2, y1 + 0.9, z + tz * e * w / 2), 0.025, { seg: 5 });
  for (let y = y0 + 0.28; y < y1 + 0.05; y += 0.3) beam(mat, V(x - tx * w / 2, y, z - tz * w / 2), V(x + tx * w / 2, y, z + tz * w / 2), 0.016, { seg: 4, cast: false });
  if (hoops) {
    // страховочная клетка: дуги через 0.8 м и три продольные полосы
    const [nx, nz] = hoops, r = 0.42;
    const arc = new THREE.TorusGeometry(r, 0.018, 4, 12, Math.PI);
    for (let y = y0 + 2.4; y < y1 + 0.8; y += 0.8) place(mat, arc, x + nx * 0.42, y, z + nz * 0.42, [Math.PI / 2, Math.atan2(tx, tz), 0]);
    for (const a of [0.25, 0.5, 0.75]) {
      const ang = a * Math.PI, ox = Math.cos(ang) * r, oz = Math.sin(ang) * r;
      const px = x + nx * 0.42 + tx * ox + nx * oz, pz = z + nz * 0.42 + tz * ox + nz * oz;
      beam(mat, V(px, y0 + 2.4, pz), V(px, y1 + 0.8, pz), 0.012, { seg: 3, cast: false });
    }
  }
}

/* ---------- Пожарная вышка ----------
   Решётчатая ферма 24 м: четыре ноги сходятся кверху, пояса через 4 м, раскосы
   крестом. Внутри — марши вертикальных лестниц, между ними площадки-решётки с
   люком (снизу пролезаешь в люк, наверху шагаешь к следующему маршу). Наверху —
   дощатая будка наблюдателя со стёклами, на крыше — мигающий заградительный огонь.
   Опоры: нижние четыре метра каждой ноги — отдельные детали. Выбита одна — вся
   ферма над ней валится телом в сторону выбитой ноги. */
function fireTower(t, R) {
  const { x, z, rot } = t, F = frame(x, z, rot), y = terrainH(x, z) - 0.1, H = 24;
  const c = Math.cos(rot), s = Math.sin(rot);
  const L = (lx, ly, lz) => { const [wx, wz] = F.p(lx, lz); return V(wx, y + ly, wz); };
  const hw = h => 2.3 - 0.95 * h / H;
  const S = beginStruct({ kind: 'tower', name: 'пожарная вышка', x, z, rot, w: 4.6, d: 4.6, h: H + 3.4, fy: y, fuel: 0.3, quiet: true });
  noPanel();
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const p = L(sx * 2.3, 0, sz * 2.3); box(M.concrete, p.x, y + 0.15, p.z, 0.7, 0.6, 0.7, { rot, tile: 0.8 }); }
  // нижние части ног — опоры
  const legs = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const pn = panel('wall', { hp: 1.5, mode: 'rigid', density: 3000, float: 0, burnable: false });
    const a = L(sx * hw(0), 0.3, sz * hw(0)), b = L(sx * hw(4), 4, sz * hw(4));
    beam(M.towerSteel, a, b, 0.09, { seg: 4 });
    beam(M.towerSteel, L(sx * hw(0.3), 0.3, sz * hw(0.3)), L(-sx * hw(2) * 0.4 + sx * hw(2) * 0.6, 2, sz * hw(2)), 0.03, { seg: 4 });
    addCircle(a.x + (b.x - a.x) * 0.5, a.z + (b.z - a.z) * 0.5, 0.16, y, y + 4);
    pn.center = a.clone().lerp(b, 0.5);
    legs.push(pn);
  }
  const top = panel('prop', { hp: 99, mode: 'rigid', density: 800, float: 0, burnable: false, sup: { list: legs, frac: 0.8 } });
  top.big = true;
  // ноги выше опор
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    beam(M.towerSteel, L(sx * hw(4), 4, sz * hw(4)), L(sx * hw(H), H, sz * hw(H)), 0.085, { seg: 4 });
    for (let h = 6; h < H; h += 4) { const p = L(sx * hw(h), h, sz * hw(h)); addCircle(p.x, p.z, 0.14, y + h - 2, y + h + 2); }
  }
  // пояса и раскосы
  for (let h = 4; h <= H; h += 4) {
    const w = hw(h), w0 = hw(h - 4);
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
      beam(M.towerSteel, L(ax * w, h, az * w), L(bx * w, h, bz * w), 0.05, { seg: 4 });
      if (h > 4) {
        beam(M.towerSteel, L(ax * w0, h - 4, az * w0), L(bx * w, h, bz * w), 0.035, { seg: 4, cast: Q.tex > 0.6 });
        beam(M.towerSteel, L(bx * w0, h - 4, bz * w0), L(ax * w, h, az * w), 0.035, { seg: 4, cast: Q.tex > 0.6 });
      }
    }
  }
  // марши и площадки: марш k — от 4k до 4k+4 у стороны sk, люк площадки — над предыдущим маршем
  for (let k = 0; k < 6; k++) {
    const sk = k % 2 ? 1 : -1, y0 = 4 * k, y1 = y0 + 4;
    const lp = L(sk * 0.75, y0, 0);
    // вдоль ступеней — локальная ось z, лезущий стоит ближе к центру
    const [zx, zz] = [s, c], [nx, nz] = [-sk * c, sk * s];
    ladderGeo(M.towerSteel, lp.x, lp.z, y + y0, y + y1, zx, zz, 0.5);
    const ex = L(-sk * 0.35, y1, 0);
    addLadder({ x: lp.x, z: lp.z, nx, nz, y0: y + y0, y1: y + y1, w: 0.5, exit: [ex.x, y + y1 + 0.02, ex.z] });
    if (k === 5) break;
    // площадка на верхнем конце марша: люк над этим маршем
    const ly = y + y1, W = 1.15;
    const plates = [[0, W - 0.4, 2 * W, 0.8], [0, -W + 0.4, 2 * W, 0.8], [-sk * (W + 0.05) / 2 + sk * 0.0, 0, W + 0.05, 0.8]];
    for (const [px, pz, sx2, sz2] of plates) {
      const q = L(px, 0, pz);
      box(M.grate, q.x, ly - 0.02, q.z, sx2, 0.04, sz2, { rot, tile: 0.5 });
      addBox(q.x, ly - 0.06, q.z, sx2, 0.12, sz2, rot, { walk: true });
    }
    // перила площадки (и невидимая сетка — чтобы не шагнуть в пролёт фермы)
    for (const [ax, az, bx, bz] of [[-W, -W, W, -W], [W, -W, W, W], [W, W, -W, W], [-W, W, -W, -W]]) {
      const a = L(ax, y1 + 1.0, az), b = L(bx, y1 + 1.0, bz);
      beam(M.towerSteel, a, b, 0.02, { seg: 4, cast: false });
      const m = L((ax + bx) / 2, 0, (az + bz) / 2);
      addBox(m.x, ly + 0.55, m.z, Math.abs(bx - ax) + 0.1 || 0.1, 1.1, Math.abs(bz - az) + 0.1 || 0.1, rot, { walk: false });
    }
  }
  // будка наблюдателя
  const fy = y + H, CW = 1.55;
  for (const [px, pz, sx2, sz2] of [[0, CW - 0.52, 2 * CW, 1.04], [0, -CW + 0.52, 2 * CW, 1.04], [-(CW + 0.05) / 2, 0, CW + 0.05, 1.04]]) {
    const q = L(px, 0, pz);
    box(M.planksDark, q.x, fy - 0.05, q.z, sx2, 0.1, sz2, { rot, tile: 1.2 });
    addBox(q.x, fy - 0.06, q.z, sx2, 0.12, sz2, rot, { walk: true });
  }
  for (let side = 0; side < 4; side++) {
    const a = rot + side * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
    const cx = x + sa * CW, cz = z + ca * CW;
    box(M.planksPaint, cx, fy + 0.5, cz, 2 * CW, 1.0, 0.06, { rot: a, tile: 1.5, collide: true, walk: false });
    box(M.planksDark, cx, fy + 2.15, cz, 2 * CW, 0.3, 0.06, { rot: a, tile: 1.5 });
    box(M.planksDark, cx + sa * 0.05, fy + 1.02, cz + ca * 0.05, 2 * CW + 0.1, 0.06, 0.18, { rot: a, tile: 1 });
    // окна: четыре стекла на стену, часть выбита
    for (let i = 0; i < 3; i++) {
      const off = -CW + (i + 0.5) * (2 * CW / 3), px = cx + ca * off, pz = cz - sa * off;
      if (R() < 0.7) addPane(px, fy + 1.52, pz, [0, a, 0], 2 * CW / 3 - 0.08, 0.9);
      box(M.planksDark, px + ca * (CW / 3), fy + 1.52, pz - sa * (CW / 3), 0.06, 1.0, 0.07, { rot: a, tile: 1 });
    }
  }
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const q = L(sx * CW, 0, sz * CW); box(M.planksDark, q.x, fy + 1.15, q.z, 0.1, 2.3, 0.1, { rot, tile: 1 }); }
  const roof = new THREE.ConeGeometry(CW * 1.62, 1.1, 4, 1, true); roof.rotateY(Math.PI / 4);
  place(M.roofRust, roof, x, fy + 2.85, z, rot);
  addBox(x, fy + 2.7, z, 2 * CW, 0.4, 2 * CW, rot, { walk: true });
  // внутри: стол с картой, пеленгатор-алидада, табурет, записки
  const tq = L(0.7, 0, -0.9);
  box(M.planks, tq.x, fy + 0.8, tq.z, 1.0, 0.05, 0.6, { rot, tile: 1, collide: true });
  place(M.paperAtlas, paperGeo(2, 0.42, 0.56), tq.x, fy + 0.83, tq.z, [-Math.PI / 2, rot + 0.3, 0]);
  cyl(M.steel, tq.x - 0.2, fy + 0.86, tq.z + 0.1, 0.16, 0.16, 0.03, { seg: 16 });
  place(M.paperAtlas, paperGeo(0, 0.21, 0.28), ...(() => { const q = L(-CW + 0.04, 0, 0.6); return [q.x, fy + 1.3, q.z]; })(), [0, rot + Math.PI / 2, 0.05]);
  addLamp({ kind: 'bulb', x, y: fy + 3.5, z, color: 0xff3320, power: 3, range: 6, blink: true, breakable: true, ground: fy }).panel = top;
  place(M.lampGlass, new THREE.SphereGeometry(0.1, 8, 6), x, fy + 3.42, z, 0);
  endStruct();
  t.struct = S;
}

/* ---------- Водонапорная башня (Рожновского) ----------
   Стальной ствол на бетонном цоколе, бак с конической крышей, кольцевая площадка
   с перилами. Лестница снаружи со страховочной клеткой. Пробитый бак течёт. */
function waterTower(t, R) {
  const { x, z, rot } = t, y = terrainH(x, z) - 0.05, HC = 14, HT = 3.2;
  const paint = t.paint === 'camp' ? M.tankCamp : M.tankGrey;
  const c = Math.cos(rot), s = Math.sin(rot);
  const S = beginStruct({ kind: 'tower', name: 'водокачка', x, z, rot, w: 5, d: 5, h: HC + HT + 1.4, fy: y, fuel: 0.1, quiet: true });
  noPanel();
  cyl(M.concrete, x, y + 0.3, z, 1.55, 1.5, 0.7, { seg: 20, tile: 1 });
  const base = panel('wall', { hp: 2.4, mode: 'rigid', density: 4000, float: 0, burnable: false });
  cyl(paint, x, y + 2.2, z, 1.2, 1.2, 3.2, { seg: 20, tile: 1.6 });
  addCircle(x, z, 1.25, y, y + 3.8);
  base.center = V(x, y + 2, z);
  const up = panel('prop', { hp: 99, mode: 'rigid', density: 900, float: 0, burnable: false, sup: { list: [base], frac: 0.99 } });
  up.big = true;
  cyl(paint, x, y + 3.8 + (HC - 3.8) / 2, z, 1.18, 1.2, HC - 3.8, { seg: 20, tile: 1.6 });
  addCircle(x, z, 1.25, y + 3.8, y + HC);
  // бак, пояс заклёпок, крыша, вентиляционный грибок
  cyl(paint, x, y + HC + HT / 2, z, 1.85, 1.85, HT, { seg: 24, tile: 1.6 });
  cyl(M.steel, x, y + HC + 0.05, z, 1.9, 1.3, 0.3, { seg: 24 });
  cyl(M.rust, x, y + HC + HT * 0.66, z, 1.87, 1.87, 0.06, { seg: 24 });
  const cone = new THREE.ConeGeometry(1.98, 1.1, 24, 1, true);
  place(t.paint === 'camp' ? M.roofCamp : M.roofRust, cone, x, y + HC + HT + 0.55, z, 0);
  cyl(M.steel, x, y + HC + HT + 1.25, z, 0.12, 0.08, 0.3, { seg: 8 });
  const tank = addCircle(x, z, 1.88, y + HC, y + HC + HT);
  tank.leak = { x, z, r: 1.85, y0: y + HC, y1: y + HC + HT };
  addCircle(x, z, 1.4, y + HC + HT, y + HC + HT + 1.0);
  // звезда на баке лагеря, номер на серой
  if (t.paint === 'camp') {
    const star = new THREE.Shape();
    for (let i = 0; i < 10; i++) { const a = i / 10 * TAU - Math.PI / 2, r = i % 2 ? 0.2 : 0.5; i ? star.lineTo(Math.cos(a) * r, -Math.sin(a) * r) : star.moveTo(Math.cos(a) * r, -Math.sin(a) * r); }
    const sg = new THREE.ShapeGeometry(star);
    place(M.paintRed, sg, x + s * 1.87, y + HC + HT * 0.45, z + c * 1.87, rot);
  }
  // кольцевая площадка у днища бака: 12 секторов, в секторе над лестницей — люк
  const GR0 = 1.9, GR1 = 2.65, gy = y + HC - 0.02;
  for (let i = 0; i < 12; i++) {
    const a = rot + (i + 0.5) / 12 * TAU, ca = Math.cos(a), sa = Math.sin(a), r = (GR0 + GR1) / 2;
    const px = x + sa * r, pz = z + ca * r, wd = 2 * Math.PI * GR1 / 12 + 0.05;
    box(M.grate, px, gy, pz, wd, 0.05, GR1 - GR0 + 0.05, { rot: a, tile: 0.5 });
    if (i !== 0 && i !== 11) addBox(px, gy - 0.05, pz, wd, 0.12, GR1 - GR0, a, { walk: true });
    // перила
    const rx = x + sa * GR1, rz = z + ca * GR1;
    beam(M.steel, V(rx, gy, rz), V(rx, gy + 1.05, rz), 0.02, { seg: 4, cast: false });
    const a2 = rot + (i + 1.5) / 12 * TAU;
    beam(M.steel, V(rx, gy + 1.05, rz), V(x + Math.sin(a2) * GR1, gy + 1.05, z + Math.cos(a2) * GR1), 0.018, { seg: 4, cast: false });
    if (i !== 0 && i !== 11) addBox(rx, gy + 0.6, rz, wd, 1.2, 0.1, a, { walk: false });
  }
  for (let i = 0; i < 12; i++) { const a = rot + i / 12 * TAU; beam(M.steel, V(x + Math.sin(a) * 1.25, gy - 1.3, z + Math.cos(a) * 1.25), V(x + Math.sin(a) * GR1, gy - 0.03, z + Math.cos(a) * GR1), 0.03, { seg: 4, cast: false }); }
  // лестница по стволу, лезущий — снаружи
  const lx = x + s * 1.23, lz = z + c * 1.23;
  ladderGeo(M.steel, lx, lz, y + 0.6, gy, c, -s, 0.46, [s, c]);
  const ea = rot + 1.5 / 12 * TAU;
  addLadder({ x: lx, z: lz, nx: s, nz: c, y0: y + 0.05, y1: gy, w: 0.46, exit: [x + Math.sin(ea) * 2.25, gy + 0.03, z + Math.cos(ea) * 2.25] });
  // подводящая труба и задвижка у цоколя
  const px = x - s * 1.3, pz = z - c * 1.3;
  cyl(M.rust, px, y + HC / 2, pz, 0.09, 0.09, HC, { seg: 8 });
  cyl(M.rust, px, y + 0.9, pz, 0.16, 0.16, 0.3, { seg: 10, rot: [Math.PI / 2, rot, 0] });
  endStruct();
  t.struct = S;
}

/* ---------- Охотничий лабаз ----------
   Четыре жерди, помост на 4 м с бортами, скат из рубероида, лестница-стремянка
   с тыла. Опоры — жерди: подрубили (взорвали) — помост падает. */
let SAP = null;
function huntingStand(t, R) {
  const { x, z, rot } = t, F = frame(x, z, rot), y = terrainH(x, z), PH = 4.0, W = 0.95;
  const L = (lx, ly, lz) => { const [wx, wz] = F.p(lx, lz); return V(wx, y + ly, wz); };
  const S = beginStruct({ kind: 'stand', name: 'лабаз', x, z, rot, w: 2.2, d: 2.2, h: PH + 2.4, fy: y, fuel: 0.8 });
  const poles = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const pn = panel('wall', { hp: 0.9, mode: 'rigid', density: 600 });
    const a = L(sx * (W + 0.18), 0, sz * (W + 0.18)), b = L(sx * W, PH + (sz > 0 ? 2.2 : 1.8), sz * W);
    beam(M.deadwood, a, b, 0.08, { seg: 7, r1: 0.06 });
    addCircle(a.x, a.z, 0.12, y, y + PH);
    pn.center = a.clone().lerp(b, 0.3);
    poles.push(pn);
  }
  const top = panel('roof', { hp: 99, mode: 'rigid', density: 600, sup: { list: poles, frac: 0.8 } });
  top.big = true;
  const deck = L(0, PH, 0);
  box(M.planksDark, deck.x, deck.y, deck.z, 2 * W + 0.3, 0.08, 2 * W + 0.3, { rot, tile: 1.2 });
  addBox(deck.x, deck.y - 0.02, deck.z, 2 * W + 0.3, 0.12, 2 * W + 0.3, rot, { walk: true });
  // борта: спереди амбразура, сзади проём под лестницу
  for (const [lx, lz, sx2, sz2, h0, h1] of [[0, W + 0.12, 2 * W + 0.3, 0.05, 0, 0.55], [0, W + 0.12, 2 * W + 0.3, 0.05, 0.95, 1.1], [-W - 0.12, 0, 0.05, 2 * W + 0.3, 0, 1.0], [W + 0.12, 0, 0.05, 2 * W + 0.3, 0, 1.0], [-W * 0.55, -W - 0.12, W, 0.05, 0, 1.0]]) {
    const q = L(lx, PH + (h0 + h1) / 2, lz);
    box(M.planks, q.x, q.y, q.z, sx2, h1 - h0, sz2, { rot, tile: 1.2, vertical: true, collide: true, walk: false });
  }
  // маскировка: лапник по бортам
  SAP ??= saplingGeo();
  for (let i = 0; i < 9; i++) {
    const side = R.int(0, 2), u = R.range(-W, W), q = side === 0 ? L(u, PH - 0.3, W + 0.22) : L((side === 1 ? -1 : 1) * (W + 0.22), PH - 0.3, u);
    place(M.spruce, SAP, q.x, q.y, q.z, [R.range(-0.3, 0.3), R() * TAU, R.range(-0.3, 0.3)], [0.45, 0.6, 0.45]);
  }
  // скат
  const rf = L(0, PH + 2.0, 0);
  box(M.roofTar, rf.x, rf.y, rf.z, 2 * W + 0.8, 0.04, 2 * W + 0.9, { rot, rx: -0.2, tile: 1.2 });
  // стремянка сзади: лезущий снаружи
  const lp = L(W * 0.5, 0, -W - 0.22), [nx, nz] = [-Math.sin(rot), -Math.cos(rot)];
  ladderGeo(M.deadwood, lp.x, lp.z, y, y + PH, Math.cos(rot), -Math.sin(rot), 0.48);
  const ex = L(W * 0.4, PH, -W + 0.45);
  addLadder({ x: lp.x, z: lp.z, nx, nz, y0: y, y1: y + PH + 0.04, w: 0.48, exit: [ex.x, y + PH + 0.05, ex.z], metal: false });
  endStruct();
}

/* ---------- Мост на остров ----------
   Сваи парами через 2.5 м, насадки, прогоны, настил поперёк (часть досок выпала),
   перила местами сорваны. Каждый пролёт — отдельная деталь: взрыв сносит пролёт,
   он падает в воду и плывёт. У берега — сход на землю. */
function bridge(b, R) {
  const [ax, az] = b.a, [bx, bz] = b.b, L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
  const rot = Math.atan2(ux, uz), deck = MAP.WATER_Y + 0.85, n = Math.ceil(L / 2.5), step = L / n;
  const g0 = hFast(ax, az) + 0.12, g1 = Math.max(hFast(bx, bz) + 0.08, deck - 0.2);
  const dy = i => i === 0 ? g0 : i === n ? Math.min(deck, g1) : deck;
  beginStruct({ kind: 'bridge', name: 'мост', x: (ax + bx) / 2, z: (az + bz) / 2, rot, w: 1.8, d: L, h: 1.2, fy: deck, fuel: 0.6 });
  noPanel();
  for (let i = 1; i < n; i++) {
    const px = ax + ux * step * i, pz = az + uz * step * i, bed = terrainH(px, pz);
    for (const e of [-0.72, 0.72]) {
      const qx = px + nx * e, qz = pz + nz * e;
      cyl(M.deadwood, qx, (bed + deck) / 2 - 0.1, qz, 0.11, 0.1, deck - bed + 0.1, { seg: 7 });
      addCircle(qx, qz, 0.13, bed, deck - 0.12);
    }
    box(M.planksDark, px, deck - 0.2, pz, 1.8, 0.14, 0.18, { rot, tile: 1 });
  }
  for (let i = 0; i < n; i++) {
    const pn = panel('roof', { hp: 0.7, mode: 'rigid', density: 500, float: 1.8 });
    const s0 = step * i, s1 = step * (i + 1), y0 = dy(i), y1 = dy(i + 1);
    const cx = ax + ux * (s0 + s1) / 2, cz = az + uz * (s0 + s1) / 2, pitch = Math.atan2(y1 - y0, step);
    for (const e of [-0.5, 0.5]) box(M.planksDark, cx + nx * e, (y0 + y1) / 2 - 0.12, cz + nz * e, 0.14, 0.14, step + 0.1, { rot, rx: -pitch, tile: 1 });
    for (let q = 0.1; q < step; q += 0.21) {
      if (R() < 0.06 && i > 0 && i < n - 1) continue;
      const px = ax + ux * (s0 + q), pz = az + uz * (s0 + q), py = lerp(y0, y1, q / step);
      const broken = R() < 0.05;
      box(R() < 0.5 ? M.planks : M.planksDark, px + nx * (broken ? 0.4 : R.range(-0.03, 0.03)), py - 0.02, pz + nz * (broken ? 0.4 : 0), broken ? 0.8 : 1.6, 0.045, 0.19, { rot, rz: R.range(-0.02, 0.02) + (broken ? 0.3 : 0), rx: -pitch, tile: 1 });
    }
    // пролёт-сход: ступенями по 12 см, иначе на наклонный настил не зайти
    const nk = Math.max(1, Math.ceil(Math.abs(y1 - y0) / 0.12));
    for (let k = 0; k < nk; k++) {
      const sa = s0 + step * (k + 0.5) / nk, yk = lerp(y0, y1, (k + 0.5) / nk);
      addBox(ax + ux * sa, yk - 0.1, az + uz * sa, 1.6, 0.2, step / nk + 0.02, rot, { walk: true });
    }
    // перила
    for (const e of [-0.78, 0.78]) {
      if (R() < 0.2 && i > 0) continue;
      const px = ax + ux * s0 + nx * e, pz = az + uz * s0 + nz * e;
      beam(M.deadwood, V(px, y0 - 0.1, pz), V(px, y0 + 0.95, pz), 0.045, { seg: 5 });
      if (R() < 0.8) beam(M.deadwood, V(px, y0 + 0.9, pz), V(px + ux * step, y1 + 0.9 + (R() < 0.15 ? -0.5 : 0), pz + uz * step), 0.035, { seg: 5 });
      addBox(cx + nx * e, (y0 + y1) / 2 + 0.5, cz + nz * e, 0.08, 0.9, step, rot, { walk: false });
    }
  }
  endStruct();
  // табличка у съезда: «ОСТОРОЖНО» от руки
  const sx = ax - ux * 1.2 + nx * 1.1, sz = az - uz * 1.2 + nz * 1.1, sy = hFast(sx, sz);
  cyl(M.deadwood, sx, sy + 0.7, sz, 0.05, 0.05, 1.4, { seg: 5 });
  place(M.paperAtlas, paperGeo(3, 0.3, 0.4), sx, sy + 1.2, sz + 0.06, [0, rot + Math.PI, 0.08]);
}

/* ---------- Брод: камни по косе, вешки по краям ---------- */
function ford(f, R) {
  const [ax, az] = f.a, [bx, bz] = f.b, L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
  const rock = new THREE.IcosahedronGeometry(1, 1);
  const pa = rock.attributes.position, col = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    const vy = pa.getY(i), k = 1 + 0.12 * Math.sin(pa.getX(i) * 4.3 + pa.getZ(i) * 2.9);
    pa.setXYZ(i, pa.getX(i) * k, vy > 0.35 ? 0.35 + (vy - 0.35) * 0.25 : vy, pa.getZ(i) * k);
    // мокрый низ с зеленцой водорослей, сухой верх светлее, но не белый
    const wet = vy < 0.2; col[i * 3] = wet ? 0.36 : 0.62; col[i * 3 + 1] = wet ? 0.42 : 0.63; col[i * 3 + 2] = wet ? 0.3 : 0.58;
  }
  rock.setAttribute('color', new THREE.BufferAttribute(col, 3)); rock.computeVertexNormals();
  for (let s = 0.6; s < L - 0.3; s += 0.82) {
    const off = (Math.floor(s / 0.82) % 2 ? 0.22 : -0.22) + R.range(-0.08, 0.08);
    const x = ax + ux * s - uz * off, z = az + uz * s + ux * off, bed = terrainH(x, z);
    if (bed > MAP.WATER_Y + 0.05) continue;
    const r = R.range(0.34, 0.46), topY = MAP.WATER_Y + R.range(0.08, 0.16);
    const sy = (topY - bed + 0.05) / 1.51;
    place(M.stone, rock, x, topY - 0.51 * sy, z, R() * TAU, [r * 1.2, sy, r]);
    addBox(x, (topY + bed) / 2, z, r * 1.7, topY - bed, r * 1.5, Math.atan2(ux, uz), { walk: true });
  }
  // вешки — ивовые прутья с тряпицей, отмечают косу
  for (let s = 3; s < L - 2; s += 5.5) for (const e of [-1.7, 1.7]) {
    const x = ax + ux * s - uz * e, z = az + uz * s + ux * e, bed = terrainH(x, z);
    beam(M.deadwood, V(x, bed, z), V(x + R.range(-0.15, 0.15), MAP.WATER_Y + 1.3, z + R.range(-0.15, 0.15)), 0.025, { seg: 4, cast: false });
  }
}

/* ---------- Лодки на привязи ---------- */
const BOATS = [];
function mooredBoat(x, z, rot, ax, az) {
  const g = buildBoat(x, z, rot, 0);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 1.6, 6), M.deadwood);
  post.position.set(ax, hFast(ax, az) + 0.6, az); post.castShadow = true; scene.add(post);
  addCircle(ax, az, 0.1, hFast(ax, az), hFast(ax, az) + 1.4);
  const rope = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(0, 0, 0), V(0, 0, 0), V(0, 0, 0)]), new THREE.LineBasicMaterial({ color: 0x3c3428 }));
  rope.frustumCulled = false; scene.add(rope);
  const B = { g, anchor: V(ax, hFast(ax, az) + 1.0, az), rope, body: null, len: 5.6 };
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0));
  const pos = V(x, MAP.WATER_Y + 0.12, z);
  B.body = addBody({ shape: 'box', size: [1.25, 0.5, 3.5], mass: 150, pos, quat: q, keep: true, float: 2.4, rad: 0.25, damp: [0.35, 0.8], friction: 0.6,
    sync: (p, qq) => { g.position.copy(p).add(V(0, -0.25, 0).applyQuaternion(qq)); g.quaternion.copy(qq); } });
  if (!B.body) { g.position.set(x, MAP.WATER_Y - 0.1, z); }
  BOATS.push(B);
  LANDMARKS.boats.push(B);
}
/** Привязь: канат выбирается, лодку тянет обратно; канат провисает. */
export function updateBoats(dt) {
  for (const B of BOATS) {
    const b = B.body;
    const bow = V(0, 0.4, 1.6).applyQuaternion(B.g.quaternion).add(B.g.position);
    if (b?.body) {
      const d = bow.distanceTo(B.anchor);
      if (d > B.len) {
        const k = Math.min(3, (d - B.len) * 2) * dt * 60;
        const v = B.anchor.clone().sub(bow).normalize().multiplyScalar(k);
        b.body.activate();
        const lv = b.body.getLinearVelocity();
        lv.setValue(lv.x() + v.x * dt, lv.y(), lv.z() + v.z * dt);
        b.body.setLinearVelocity(lv);
      }
    }
    const p = B.rope.geometry.attributes.position, mid = bow.clone().lerp(B.anchor, 0.5);
    mid.y -= Math.max(0, 0.6 - Math.max(0, bow.distanceTo(B.anchor) - B.len + 0.6) * 0.5);
    p.setXYZ(0, B.anchor.x, B.anchor.y, B.anchor.z); p.setXYZ(1, mid.x, Math.max(mid.y, MAP.WATER_Y + 0.02), mid.z); p.setXYZ(2, bow.x, bow.y, bow.z);
    p.needsUpdate = true;
  }
}

/* ---------- Ручей: вода, переходы ---------- */
const STREAM_VS = /* glsl */`
  attribute float aS; attribute float aSlope;
  varying vec3 vW; varying vec2 vUv; varying float vSlope;
  #include <fog_pars_vertex>
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vUv = vec2(uv.x, aS); vSlope = aSlope;
    vec4 mvPosition = viewMatrix * w;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const STREAM_FS = /* glsl */`
  uniform float uT; uniform vec3 uSky, uSun, uDeep; uniform vec3 uSunDir;
  varying vec3 vW; varying vec2 vUv; varying float vSlope;
  #include <fog_pars_fragment>
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
  void main(){
    // рябь течёт вниз по руслу: быстрее на перекатах
    float sp = 0.9 + vSlope * 30.0;
    vec2 q = vec2(vUv.x * 3.0, vUv.y * 0.9 - uT * sp);
    float r1 = n(q * 3.0), r2 = n(q * 7.0 + 3.1), r3 = n(vec2(vUv.x * 9.0, vUv.y * 3.0 - uT * sp * 1.6));
    vec3 nrm = normalize(vec3((r1 - 0.5) * 0.5 + (r3 - 0.5) * 0.25, 1.0, (r2 - 0.5) * 0.5));
    vec3 V = normalize(cameraPosition - vW);
    float fr = 0.04 + 0.96 * pow(1.0 - max(dot(nrm, V), 0.0), 5.0);
    // вода в тенистом овраге: торфяная, отражает небо только под острым углом
    vec3 col = mix(uDeep, uSky * 0.5, fr * 0.85);
    vec3 Hh = normalize(uSunDir + V);
    col += uSun * pow(max(dot(nrm, Hh), 0.0), 160.0) * 1.6;
    // пена на перекатах и у берегов
    float edge = smoothstep(0.35, 0.5, abs(vUv.x - 0.5));
    float foam = smoothstep(0.62, 0.8, r3 + vSlope * 18.0 + edge * 0.25) * (0.35 + vSlope * 25.0);
    col = mix(col, vec3(0.7, 0.72, 0.68) * (0.3 + 0.35 * length(uSky)), clamp(foam * 0.6, 0.0, 0.45));
    float a = mix(0.6, 0.88, fr) * (1.0 - smoothstep(0.42, 0.5, abs(vUv.x - 0.5)) * 0.7);
    gl_FragColor = vec4(col, a);
    #include <fog_fragment>
  }`;
export const STREAM_FX = { mat: null };
function streamWater(st) {
  const w = STREAM_BW + 0.12, pos = [], uv = [], aS = [], aSl = [], idx = [];
  const n = Math.floor(st.len);
  for (let i = 0; i <= n; i++) {
    const q = polyAt(st.pts, i), y = st.bed[Math.min(i, st.bed.length - 1)] + 0.2;
    const slope = i > 0 ? Math.max(0, st.bed[i - 1] - st.bed[Math.min(i, st.bed.length - 1)]) : 0;
    for (const e of [-1, 1]) { pos.push(q.x - q.tz * w * e, y, q.z + q.tx * w * e); uv.push(e < 0 ? 0 : 1, 0); aS.push(i); aSl.push(slope); }
    if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 1));
  g.setAttribute('aSlope', new THREE.Float32BufferAttribute(aSl, 1));
  g.setIndex(idx); g.computeBoundingSphere();
  STREAM_FX.mat ??= new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uT: { value: 0 }, uSky: { value: new THREE.Color(0.5, 0.6, 0.7) }, uSun: { value: new THREE.Color(1, 1, 1) }, uDeep: { value: new THREE.Color(0.1, 0.11, 0.07) }, uSunDir: { value: V(0.3, 0.8, 0.2) } }]),
    vertexShader: STREAM_VS, fragmentShader: STREAM_FS, transparent: true, depthWrite: false, fog: true
  });
  const m = new THREE.Mesh(g, STREAM_FX.mat); m.renderOrder = 2; m.name = 'stream';
  scene.add(m);
  // камни на дне и у берегов
  const R = rng(st.name.length * 97 + Math.round(st.pts[0][0]));
  const rock = new THREE.DodecahedronGeometry(1, 0);
  for (let s = 3; s < st.len - 6; s += R.range(1.5, 4)) {
    const q = polyAt(st.pts, s), e = R.range(-1.4, 1.4), x = q.x - q.tz * e, z = q.z + q.tx * e, r = R.range(0.12, 0.38);
    place(M.stone, rock, x, hFast(x, z) + r * 0.15, z, [R() * 3, R() * 3, R() * 3], [r * 1.3, r * 0.8, r]);
  }
}
/** Часть геометрии по группе материала (ExtrudeGeometry — без индекса). */
function splitGroup(g, mi) {
  const out = new THREE.BufferGeometry();
  const gr = g.groups.filter(q => q.materialIndex === mi);
  for (const name of ['position', 'normal', 'uv']) {
    const a = g.attributes[name], k = a.itemSize, arr = [];
    for (const q of gr) for (let i = q.start; i < q.start + q.count; i++) for (let j = 0; j < k; j++) arr.push(a.array[i * k + j]);
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, k));
  }
  return out;
}
/** Труба под дорогой: бетонный массив с отверстием, торцы-оголовки, гофротруба, столбики ограждения. */
function pipeCulvert(cv) {
  const { x, z, tx, tz, st, s } = cv, rot = Math.atan2(tx, tz), nx = -tz, nz = tx;
  const q = streamAt(x, z), bed = q.bed, R0 = 0.66, len = 6.2;
  let top = bed + 1.9;
  for (const e of [-3.8, 3.8, -2.5, 2.5]) top = Math.max(top, terrainH(x + nx * e, z + nz * e) + 0.05);
  const Wd = 8.2, cy = bed + R0 - 0.04;
  const sh = new THREE.Shape();
  sh.moveTo(-Wd / 2, bed - 0.4); sh.lineTo(Wd / 2, bed - 0.4); sh.lineTo(Wd / 2, top); sh.lineTo(-Wd / 2, top); sh.closePath();
  const hole = new THREE.Path(); hole.absarc(0, cy, R0, 0, TAU, true); sh.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false, curveSegments: 20 });
  g.translate(0, 0, -len / 2);
  const uvs = g.attributes.uv; for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * 0.5, uvs.getY(i) * 0.5);
  // группы: торцы — бетон оголовков, боковины — грунт насыпи
  const caps = splitGroup(g, 0), sides = splitGroup(g, 1);
  place(M.concrete, caps, x, 0, z, rot);
  place(M.dirtMound, sides, x, 0, z, rot);
  M.pipeIn ??= (() => { const m = M.rust.clone(); m.side = THREE.DoubleSide; return m; })();
  const pipe = new THREE.CylinderGeometry(R0 - 0.02, R0 - 0.02, len + 0.5, 22, 1, true);
  const pu = pipe.attributes.uv; for (let i = 0; i < pu.count; i++) pu.setXY(i, pu.getX(i) * 6, pu.getY(i) * 3);
  place(M.pipeIn, pipe, x, cy, z, [Math.PI / 2, rot, 0]);
  // рёбра гофры
  for (let k = -len / 2; k <= len / 2; k += 0.5) place(M.rust, new THREE.TorusGeometry(R0 - 0.03, 0.025, 4, 22), x + tx * k, cy, z + tz * k, [0, rot, 0]);
  // коллайдеры насыпи вокруг трубы
  for (const e of [-1, 1]) addBox(x + nx * e * (Wd / 4 + R0 / 2), (bed + top) / 2, z + nz * e * (Wd / 4 + R0 / 2), Wd / 2 - R0, top - bed, len, rot, { walk: true });
  addBox(x, (cy + R0 + top) / 2, z, 2 * R0 + 0.1, top - cy - R0, len, rot, { walk: true });
  // ограждение на дороге: бетонные столбики с полосой
  for (const e of [-1, 1]) for (const k of [-1.6, 0, 1.6]) {
    const px = x + tx * e * (len / 2 - 0.2) + nx * k, pz = z + tz * e * (len / 2 - 0.2) + nz * k;
    box(M.planksWhite, px, top + 0.4, pz, 0.16, 0.8, 0.16, { rot, tile: 1 });
    box(M.paintRed, px, top + 0.62, pz, 0.17, 0.12, 0.17, { rot, tile: 1 });
    addCircle(px, pz, 0.12, top, top + 0.8);
  }
  cv.top = top;
}
/** Кладка на тропе: два бревна через овраг, доски поперёк, одна жердь-перило. */
function footBridge(cv, R) {
  const { x, z } = cv;
  let best = null, bd = 1e9;
  const pa = cv.path;
  for (let i = 0; i < pa.pts.length - 1; i++) {
    const [a0, a1] = pa.pts[i], [b0, b1] = pa.pts[i + 1], vx = b0 - a0, vz = b1 - a1, L2 = vx * vx + vz * vz;
    const t = clamp(((x - a0) * vx + (z - a1) * vz) / L2, 0, 1), d = Math.hypot(x - a0 - vx * t, z - a1 - vz * t);
    if (d < bd) { bd = d; best = [vx / Math.sqrt(L2), vz / Math.sqrt(L2)]; }
  }
  const [ux, uz] = best, rot = Math.atan2(ux, uz), L = 10;
  const e0 = [x - ux * L / 2, z - uz * L / 2], e1 = [x + ux * L / 2, z + uz * L / 2];
  const y = Math.max(hFast(...e0), hFast(...e1)) + 0.12;
  beginStruct({ kind: 'bridge', name: 'кладка', x, z, rot, w: 1.4, d: L, h: 1, fy: y, fuel: 0.5 });
  panel('roof', { hp: 0.6, mode: 'rigid', density: 500, float: 1.7 });
  for (const e of [-0.45, 0.45]) cyl(M.barkPine, x - uz * e, y - 0.16, z + ux * e, 0.17, 0.15, L, { seg: 8, rot: [Math.PI / 2, rot, 0] });
  for (let s = -L / 2 + 0.3; s < L / 2; s += 0.24) {
    if (R() < 0.07) continue;
    box(M.planksDark, x + ux * s, y + 0.02, z + uz * s, 1.25, 0.05, 0.2, { rot, rz: R.range(-0.03, 0.03), tile: 1 });
  }
  addBox(x, y - 0.05, z, 1.2, 0.14, L, rot, { walk: true });
  const px = x - uz * 0.62, pz = z + ux * 0.62;
  for (const s of [-L / 2 + 0.5, 0, L / 2 - 0.5]) beam(M.deadwood, V(px + ux * s, y - 0.1, pz + uz * s), V(px + ux * s, y + 0.95, pz + uz * s), 0.04, { seg: 5 });
  beam(M.deadwood, V(px - ux * (L / 2 - 0.5), y + 0.9, pz - uz * (L / 2 - 0.5)), V(px + ux * (L / 2 - 0.5), y + 0.85, pz + uz * (L / 2 - 0.5)), 0.035, { seg: 5 });
  endStruct();
}
/** Бревно поперёк оврага: упавшая сосна с сучьями — переход по бревну. */
function logCrossing(cv, R) {
  const { x, z, tx, tz } = cv, nx = -tz, nz = tx, L = 11;
  const a = [x - nx * L / 2, z - nz * L / 2], b = [x + nx * L / 2, z + nz * L / 2];
  const ya = hFast(...a) + 0.18, yb = hFast(...b) + 0.3;
  const g = new THREE.CylinderGeometry(0.2, 0.26, L, 9);
  const uvs = g.attributes.uv; for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * 2, uvs.getY(i) * L / 1.2);
  const pitch = Math.atan2(yb - ya, L), rot = Math.atan2(nx, nz);
  place(M.barkPine, g, x, (ya + yb) / 2, z, [Math.PI / 2 - pitch, rot, 0]);
  for (let i = 0; i < 5; i++) { const s = R.range(-0.4, 0.45) * L; cyl(M.deadwood, x + nx * s, (ya + yb) / 2 + 0.35, z + nz * s, 0.035, 0.015, R.range(0.5, 1.0), { seg: 4, rot: [R.range(-0.8, 0.8), R() * TAU, R.range(-0.8, 0.8)] }); }
  addBox(x, (ya + yb) / 2 - 0.02, z, 0.4, 0.44 + Math.abs(yb - ya), L, rot, { walk: true });
  place(M.stumpTop, new THREE.CircleGeometry(0.25, 10), b[0] + nx * 0.02, yb, b[1] + nz * 0.02, [0, rot, 0]);
}

/* ---------- Болото ---------- */
function sedgeGeo() {
  const pos = [], col = [], nrm = [], idx = [];
  let v = 0;
  for (let b = 0; b < 22; b++) {
    const a = b * 2.4, lean = 0.25 + (b % 5) * 0.08, h = 0.45 + ((b * 37) % 11) / 11 * 0.45, w = 0.02;
    const lx = Math.cos(a), lz = Math.sin(a), sx = -lz, sz = lx, bx = lx * 0.06, bz = lz * 0.06;
    for (let k = 0; k <= 3; k++) {
      const t = k / 3, off = lean * h * t * t, ww = w * (1 - t * 0.9);
      for (const e of [-1, 1]) { pos.push(bx + lx * off + sx * ww * e, h * t, bz + lz * off + sz * ww * e); nrm.push(lx * 0.3, 0.9, lz * 0.3); const d = b % 3 === 0; col.push((0.42 + 0.3 * t) * (d ? 1.25 : 0.9), (0.46 + 0.28 * t) * (d ? 1.05 : 1), (0.2 + 0.08 * t) * (d ? 0.9 : 1)); }
      if (k < 3) { const q = v + k * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
    v += 8;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeBoundingSphere();
  return g;
}
function cattailGeo() {
  const pos = [], col = [], nrm = [], idx = [];
  let v = 0;
  const quad = (a, b, c, d, cl) => { pos.push(...a, ...b, ...c, ...d); for (let i = 0; i < 4; i++) { nrm.push(0.2, 0.9, 0.2); col.push(...cl); } idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4; };
  for (let k = 0; k < 5; k++) {
    const a = k * 1.9, r = 0.05 + k * 0.03, x = Math.cos(a) * r, z = Math.sin(a) * r, h = 1.3 + (k % 3) * 0.3, lx = Math.cos(a) * 0.06, lz = Math.sin(a) * 0.06;
    for (const rr of [0, Math.PI / 2]) {
      const dx = Math.cos(rr) * 0.008, dz = Math.sin(rr) * 0.008;
      quad([x - dx, 0, z - dz], [x + dx, 0, z + dz], [x + lx + dx, h, z + lz + dz], [x + lx - dx, h, z + lz - dz], [0.36, 0.44, 0.2]);
      const hx = x + lx * 0.85, hz = z + lz * 0.85, cx = Math.cos(rr) * 0.035, cz = Math.sin(rr) * 0.035;
      quad([hx - cx, h - 0.35, hz - cz], [hx + cx, h - 0.35, hz + cz], [hx + cx, h - 0.1, hz + cz], [hx - cx, h - 0.1, hz - cz], [0.3, 0.2, 0.12]);
    }
    // длинные листья
    for (const s of [-1, 1]) { const la = a + s * 0.6, L = 1.1; quad([x, 0, z], [x + Math.cos(la + 1.57) * 0.03, 0, z + Math.sin(la + 1.57) * 0.03], [x + Math.cos(la) * 0.25, L, z + Math.sin(la) * 0.25], [x + Math.cos(la) * 0.23, L, z + Math.sin(la) * 0.23], [0.4, 0.5, 0.22]); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeBoundingSphere();
  return g;
}
function bog(b, R) {
  const lvl = bogLevel(b);
  const water = new THREE.Mesh(new THREE.CircleGeometry(b.r * 1.3, 48), M.peat);
  water.rotation.x = -Math.PI / 2; water.position.set(b.x, lvl + 0.03, b.z); water.receiveShadow = true; water.name = 'bog';
  M.peat.transparent = false;
  scene.add(water);
  M.bogFlora ??= (() => { const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85 }); m.emissive = new THREE.Color(0x070a04); injectWind(m, { amp: 0.14, stiff: 1.5, refH: 1.0, flutter: 0.05, trample: true, blast: 1.3, burn: true }); return m; })();
  const scatter = (geo, n, test, sc) => {
    const pts = [];
    for (let k = 0; k < n * 8 && pts.length < n; k++) {
      const a = R() * TAU, r = Math.sqrt(R()) * b.r * 1.15, x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r;
      if (inBog(x, z) < 0.2 || !test(x, z)) continue;
      pts.push([x, z]);
    }
    const im = new THREE.InstancedMesh(geo, M.bogFlora, pts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = V(0, 0, 0), s3 = V(1, 1, 1);
    pts.forEach(([x, z], i) => { const s = R.range(sc[0], sc[1]); p.set(x, hFast(x, z) - 0.03, z); q.setFromAxisAngle(V(0, 1, 0), R() * TAU); s3.set(s, s * R.range(0.8, 1.2), s); im.setMatrixAt(i, m.compose(p, q, s3)); });
    im.receiveShadow = true; im.computeBoundingSphere(); scene.add(im); NO_REFLECT.push(im);
  };
  scatter(sedgeGeo(), 150, (x, z) => hFast(x, z) > lvl + 0.1, [0.7, 1.3]);
  scatter(cattailGeo(), 55, (x, z) => { const h = hFast(x, z); return h > lvl - 0.1 && h < lvl + 0.08 && inBog(x, z) < 0.8; }, [0.8, 1.2]);
  // сухостой: берёзы без кроны, обломаны на разной высоте, одна завалилась
  for (let i = 0; i < 6; i++) {
    const a = R() * TAU, r = Math.sqrt(R()) * b.r * 0.9, x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r, y = hFast(x, z) - 0.2;
    const h = R.range(2.5, 7.5), lean = i === 0 ? 1.1 : R.range(-0.12, 0.12);
    const g = new THREE.CylinderGeometry(0.07, 0.12, h, 8);
    const cols = new Float32Array(g.attributes.position.count * 3).fill(0.75);
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    place(M.barkBirch, g, x + Math.sin(lean) * h / 2, y + Math.cos(lean) * h / 2, z, [0, R() * TAU, lean]);
    place(M.stumpTop, new THREE.CircleGeometry(0.08, 8), x + Math.sin(lean) * h, y + Math.cos(lean) * h + 0.01, z, [-Math.PI / 2, 0, 0]);
    for (let k = 0; k < 3; k++) cyl(M.deadwood, x, y + h * R.range(0.4, 0.9), z, 0.02, 0.008, R.range(0.4, 0.9), { seg: 3, rot: [R.range(0.6, 1.2), R() * TAU, 0], cast: false });
    if (lean < 0.5) addCircle(x, z, 0.14, y, y + h);
  }
  // гать: бревна поперёк хода через болото
  const ga = Math.atan2(b.z, b.x) + Math.PI / 2, ux = Math.cos(ga), uz = Math.sin(ga), L = b.r * 2.3;
  for (let s = -L / 2; s < L / 2; s += 0.3) {
    const px = b.x + ux * s, pz = b.z + uz * s;
    if (inBog(px, pz) < 0.15) continue;
    const yy = Math.max(hFast(px, pz), lvl) + 0.06 + (Math.abs(s) % 1.7 < 0.3 ? -0.05 : 0);
    cyl(M.deadwood, px + R.range(-0.05, 0.05), yy, pz, 0.11, 0.11, 1.5, { seg: 7, rot: [Math.PI / 2, Math.atan2(-uz, ux) + R.range(-0.08, 0.08), 0] });
  }
  for (let s = -L / 2; s < L / 2; s += 1.5) {
    const px = b.x + ux * (s + 0.75), pz = b.z + uz * (s + 0.75);
    if (inBog(px, pz) < 0.15) continue;
    addBox(px, Math.max(hFast(px, pz), lvl) + 0.05, pz, 1.5, 0.22, 1.55, Math.atan2(ux, uz), { walk: true }).bogWalk = true;
  }
}

/* ---------- Сборка ---------- */
export function buildLandmarks() {
  const R = rng(5151);
  for (const t of LANDMARKS.towers) fireTower(t, R);
  for (const t of LANDMARKS.water) waterTower(t, R);
  for (const t of LANDMARKS.stands) huntingStand(t, R);
  for (const b of LANDMARKS.bridges) bridge(b, R);
  for (const f of FORDS) ford(f, R);
  for (const st of STREAMS) streamWater(st);
  for (const cv of LANDMARKS.culverts) cv.kind === 'pipe' ? pipeCulvert(cv) : cv.kind === 'foot' ? footBridge(cv, R) : logCrossing(cv, R);
  for (const b of BOGS) bog(b, R);
  // лодки на привязи у брода: у каждой команды — своя
  for (const f of FORDS) {
    const [ax, az] = f.a, [bx, bz] = f.b, L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
    const px = ax + ux * 5 + uz * 4, pz = az + uz * 5 - ux * 4;
    if (lakeRho(px, pz) < 0.95) mooredBoat(px, pz, Math.atan2(ux, uz) + 0.6, ax + uz * 2.6, az - ux * 2.6);
  }
}
export function updateLandmarks(dt, sky) {
  updateBoats(dt);
  const m = STREAM_FX.mat;
  if (m) {
    m.uniforms.uT.value = FRAME.t;
    m.uniforms.uSky.value.copy(sky.fogColor).multiplyScalar(0.9);
    m.uniforms.uSun.value.copy(sky.sunColor).multiplyScalar(Math.min(1, sky.sunI * 0.25));
    m.uniforms.uSunDir.value.copy(sky.sunDir);
  }
}
