import * as THREE from 'three';
import { scene, Q } from '../core/env.js';
import { rng, TAU, lerp, polyAt, clamp, hash2 } from '../core/math.js';
import { MAP, SPAWNS, TRENCHES, TW, trenchTaper, terrainH, baseH, addPad, keep, edgeDist, PATHS, trenchDist, pathInfluence, isFree, polyDist } from './layout.js';
import { hFast } from './heightcache.js';
import { M, TEX } from '../gen/materials.js';
import { box, cyl, beam, place, frame, beginStruct, panel, noPanel, endStruct, inStruct } from './builders.js';
import { addWire, addGenerator } from '../fx/interact.js';
import { sheet } from './wrecks.js';
import { addBox, addCircle } from '../core/colliders.js';
import { addLamp } from './lamps.js';
import { makeCloth } from './cloth.js';
import { vehicle } from './vehicles.js';
import { injectWind } from './wind.js';

/* ============================================================================
   ФРОНТ: окопы, базы команд, минное поле
============================================================================ */
const V = (x, y, z) => new THREE.Vector3(x, y, z);
let bagGeo = null;
const bag = (x, y, z, rot, rx = 0, rz = 0) => {
  bagGeo ??= (() => { const g = new THREE.SphereGeometry(1, 9, 5); g.scale(0.3, 0.1, 0.18); return g; })();
  place(M.sack, bagGeo, x, y, z, [rx, rot, rz]);
};
/** Стенка из мешков: ряды со сдвигом в полмешка, верхний ряд с прорехами.
    Каждый мешок — деталь: пуля его мнёт (оседает, сыплется песок), близкий
    разрыв сносит. Высота укрытия (коллайдер) следит за уцелевшими мешками. */
export function sandbagWall(x0, z0, x1, z1, rows = 3, R = rng(1), collide = true) {
  const L = Math.hypot(x1 - x0, z1 - z0), rot = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
  const ux = (x1 - x0) / L, uz = (z1 - z0) / L;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, g = hFast(cx, cz);
  const own = !inStruct();
  const wall = { bags: [], base: g, col: null };
  if (own) beginStruct({ kind: 'sandbags', x: cx, z: cz, rot, w: L, d: 0.5, h: rows * 0.17, fy: g, fuel: 0, quiet: true });
  for (let r = 0; r < rows; r++) {
    for (let s = (r % 2) * 0.28; s < L; s += 0.56) {
      if (r === rows - 1 && R() < 0.18) continue;
      const x = x0 + ux * s, z = z0 + uz * s, y = hFast(x, z) + 0.08 + r * 0.17;
      if (own) {
        const p = panel('bag', { hp: 1, mode: 'sag', density: 1600, float: 0, burnable: false });
        p.quiet = true; p.wall = wall; p.top0 = y + 0.1; p.base0 = y - 0.1;
        wall.bags.push(p);
      }
      bag(x, y, z, rot + R.range(-0.12, 0.12), R.range(-0.05, 0.05), R.range(-0.08, 0.08));
    }
  }
  if (own) noPanel();
  if (collide) { wall.col = addBox(cx, g + rows * 0.09, cz, 0.4, rows * 0.18 + 0.05, L, rot - Math.PI / 2, { walk: true }); if (own) wall.col.sandWall = wall; }
  if (own) endStruct();
  return wall;
}
export function sandbagRing(x, z, r, rows, gapA, gapW, R) {
  const n = Math.round(TAU * r / 0.9);
  for (let i = 0; i < n; i++) {
    const a0 = i / n * TAU, a1 = (i + 1) / n * TAU, am = (a0 + a1) / 2;
    let da = Math.abs(((am - gapA + Math.PI * 3) % TAU) - Math.PI);
    if (da < gapW / 2) continue;
    sandbagWall(x + Math.cos(a0) * r, z + Math.sin(a0) * r, x + Math.cos(a1) * r, z + Math.sin(a1) * r, rows, R);
  }
}

/* ---------- Окопы: обшивка, настил, бруствер ----------
   Стенки строятся по смещённым от оси ломаным (со скосом на изгибах), поэтому
   обшивка идёт без щелей и нигде не заходит в проход. Коллайдеры — те же
   отрезки: за доски не пройти ни на прямых, ни на изгибах, ни на аппарелях. */
const ENEMY = (x, z, nx, nz) => (nx * -x + nz * -z) > 0 ? 1 : -1;
/** Точка внутри прохода другого окопа — там стенку не ставим (стык). */
function inOtherTrench(ti, x, z, pad) {
  for (let j = 0; j < TRENCHES.length; j++) {
    if (j === ti) continue;
    const o = TRENCHES[j];
    if (polyDist(x, z, o.pts) < pad) return true;
  }
  return false;
}
function offsetLine(t, side, off) {
  const P = t.pts, n = P.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], c = P[i];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    // скос: на изгибе смещение по биссектрисе длиннее, иначе стенка «съезжает» в проход
    let miter = 1;
    if (i > 0 && i < n - 1) {
      const sx = c[0] - a[0], sz = c[1] - a[1], sl = Math.hypot(sx, sz) || 1;
      miter = 1 / Math.max(0.6, (-sz / sl) * -tz + (sx / sl) * tx);
    }
    out.push({ x: c[0] - tz * off * side * miter, z: c[1] + tx * off * side * miter, cx: c[0], cz: c[1], nx: -tz, nz: tx, tx, tz });
  }
  return out;
}
class Strip {
  constructor() { this.p = []; this.n = []; this.uv = []; }
  quad(a, b, c, d, n, uvs) {
    // a-b нижняя кромка, d-c верхняя (против часовой при взгляде по нормали)
    for (const [v, t] of [[a, uvs[0]], [b, uvs[1]], [c, uvs[2]], [a, uvs[0]], [c, uvs[2]], [d, uvs[3]]]) {
      this.p.push(v[0], v[1], v[2]); this.n.push(n[0], n[1], n[2]); this.uv.push(t[0], t[1]);
    }
  }
  flush(mat) {
    if (!this.p.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    place(mat, g, 0, 0, 0);
    this.p = []; this.n = []; this.uv = [];
  }
}
export const TRENCH_LAMPS = [];
let lanternMat = null;
function buildTrench(t, ti, R) {
  const P = t.pts, n = P.length;
  const walls = { planks: new Strip(), planksDark: new Strip(), deadwood: new Strip(), cap: new Strip() };
  const TPL = 1.1;                                   // метров на повтор текстуры досок
  const enemySide = (() => { const m = P[n >> 1], m2 = P[Math.min(n - 1, (n >> 1) + 1)]; return ENEMY(m[0], m[1], -(m2[1] - m[1]), m2[0] - m[0]); })();
  const floorAt = (x, z) => terrainH(x, z);
  const sArr = [0];
  for (let i = 1; i < n; i++) sArr.push(sArr[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  for (const side of [-1, 1]) {
    const inner = offsetLine(t, side, TW.wall), outer = offsetLine(t, side, TW.cap), col = offsetLine(t, side, TW.wall + 0.16);
    const V = inner.map((q, i) => {
      const fl = floorAt(q.cx, q.cz) - 0.04;
      const top = Math.max(terrainH(outer[i].x, outer[i].z), terrainH(q.cx + q.nx * side * 1.25, q.cz + q.nz * side * 1.25)) + 0.03;
      const ok = top - fl > 0.14 && !inOtherTrench(ti, q.x, q.z, TW.wall + 0.03);
      return { fl, top, ok };
    });
    // панели по 1.2–2.6 м: доски вертикально/горизонтально, светлые/тёмные, изредка плетень
    let panelEnd = -1, kind = 'planks', vert = true, lean = 0;
    for (let i = 0; i < n - 1; i++) {
      const A = V[i], B = V[i + 1];
      if (!A.ok || !B.ok) continue;
      if (sArr[i] >= panelEnd) {
        panelEnd = sArr[i] + R.range(1.2, 2.6);
        const r = R();
        kind = r < 0.5 ? 'planks' : r < 0.86 ? 'planksDark' : 'deadwood';
        vert = kind === 'deadwood' ? false : R() < 0.6;
        lean = side * R.range(0.0, 0.05);
      }
      const a = inner[i], b = inner[i + 1];
      // лёгкий наклон обшивки наружу — стенка «держит» грунт
      const la = (A.top - A.fl) * lean, lb = (B.top - B.fl) * lean;
      const p0 = [a.x, A.fl, a.z], p1 = [b.x, B.fl, b.z];
      const p2 = [b.x + b.nx * side * lb, B.top, b.z + b.nz * side * lb], p3 = [a.x + a.nx * side * la, A.top, a.z + a.nz * side * la];
      const nn = [-(a.nx + b.nx) * 0.5 * side, 0.05, -(a.nz + b.nz) * 0.5 * side];
      const s0 = sArr[i] / TPL, s1 = sArr[i + 1] / TPL;
      const uvs = vert
        ? [[A.fl / TPL, s0], [B.fl / TPL, s1], [B.top / TPL, s1], [A.top / TPL, s0]]
        : [[s0, A.fl / (TPL * 0.8)], [s1, B.fl / (TPL * 0.8)], [s1, B.top / (TPL * 0.8)], [s0, A.top / (TPL * 0.8)]];
      // порядок обхода — лицом в проход
      if (side > 0) walls[kind].quad(p1, p0, p3, p2, nn, [uvs[1], uvs[0], uvs[3], uvs[2]]);
      else walls[kind].quad(p0, p1, p2, p3, nn, uvs);
      // верхняя обвязка: доска-«шапка» от обшивки до грунта
      const oa = outer[i], ob = outer[i + 1];
      const c0 = [p3[0], A.top, p3[2]], c1 = [p2[0], B.top, p2[2]], c2 = [ob.x, B.top - 0.02, ob.z], c3 = [oa.x, A.top - 0.02, oa.z];
      const cuv = [[s0, 0], [s1, 0], [s1, 0.38], [s0, 0.38]];
      if (side > 0) walls.cap.quad(c0, c1, c2, c3, [0, 1, 0], cuv);
      else walls.cap.quad(c1, c0, c3, c2, [0, 1, 0], [cuv[1], cuv[0], cuv[3], cuv[2]]);
      // коллайдер: тот же отрезок, толщина 0.32 за обшивкой, внахлёст 8 см
      const ca = col[i], cb = col[i + 1];
      const L = Math.hypot(cb.x - ca.x, cb.z - ca.z);
      if (L > 1e-3) {
        const y0 = Math.min(A.fl, B.fl) - 0.3, y1 = Math.max(A.top, B.top) + 0.05;
        addBox((ca.x + cb.x) / 2, (y0 + y1) / 2, (ca.z + cb.z) / 2, 0.32, y1 - y0, L + 0.08, Math.atan2(cb.x - ca.x, cb.z - ca.z), { walk: false });
      }
      // стойки обшивки
      if (i % 2 === 0) {
        const h = A.top - A.fl + 0.18;
        cyl(M.deadwood, a.x - a.nx * side * 0.05, A.fl + h / 2, a.z - a.nz * side * 0.05, 0.055, 0.05, h, { seg: 6 });
      }
    }
    // ступени для стрельбы со стороны противника
    if (t.bays && side === enemySide) {
      for (let s = TW.ramp + 1.5; s < t.len - TW.ramp - 1.5; s += R.range(5.5, 8)) {
        const q = polyAt(P, s), i = Math.min(n - 2, sArr.findIndex(v => v > s) - 1);
        if (i < 0 || !V[i].ok || !V[i + 1].ok) continue;
        const nx = -q.tz, nz = q.tx, fl = floorAt(q.x, q.z);
        const bx = q.x + nx * side * (TW.wall - 0.17), bz = q.z + nz * side * (TW.wall - 0.17);
        box(M.planksDark, bx, fl + 0.2, bz, 0.34, 0.42, 1.3, { rot: Math.atan2(q.tx, q.tz), tile: 1, collide: true });
        if (R() < 0.35) crateAt(q.x - nx * side * 0.2 + q.tx * 1.1, q.z - nz * side * 0.2 + q.tz * 1.1, Math.atan2(q.tx, q.tz), fl);
      }
    }
    // мешки на бруствере со стороны противника
    if (side === enemySide) {
      for (let s = 0.8; s < t.len - 0.8; s += 1.15) {
        if (R() > 0.72) continue;
        const q = polyAt(P, s), nx = -q.tz, nz = q.tx;
        const bx = q.x + nx * side * 1.32, bz = q.z + nz * side * 1.32;
        if (trenchTaper(t, s) < 0.6 || inOtherTrench(ti, bx, bz, 1.2)) continue;
        const y = terrainH(bx, bz), rot = Math.atan2(q.tx, q.tz) + Math.PI / 2;
        for (let r = 0; r < 2; r++) for (let k = 0; k < 2; k++) {
          const off = (k - 0.5) * 0.56 + (r % 2) * 0.28;
          bag(bx + q.tx * off, y + 0.04 + r * 0.16, bz + q.tz * off, rot + R.range(-0.1, 0.1), 0, R.range(-0.08, 0.08));
        }
      }
    }
    // занавешенные входы в «лисьи норы» и фонари — на тыльной стенке
    if (side === -enemySide && t.len > 10) {
      for (let s = TW.ramp + 2 + R.range(0, 4); s < t.len - TW.ramp - 1; s += R.range(9, 14)) {
        const q = polyAt(P, s), nx = -q.tz, nz = q.tx, fl = floorAt(q.x, q.z), rot = Math.atan2(q.tx, q.tz);
        if (inOtherTrench(ti, q.x + nx * side * TW.wall, q.z + nz * side * TW.wall, TW.cap + 0.3)) continue;
        const wx = q.x + nx * side * (TW.wall - 0.03), wz = q.z + nz * side * (TW.wall - 0.03);
        if (R() < 0.5) {
          box(M.dark, wx, fl + 0.7, wz, 0.02, 1.3, 0.85, { rot, tile: 1 });
          box(M.canvas, wx - nx * side * 0.03, fl + 0.72, wz - nz * side * 0.03, 0.02, 1.25, 0.8, { rot, rz: side * 0.03, tile: 1 });
          for (const e of [-1, 1]) cyl(M.barkPine, wx + q.tx * e * 0.48, fl + 0.72, wz + q.tz * e * 0.48, 0.07, 0.07, 1.45, { seg: 6 });
          place(M.barkPine, new THREE.CylinderGeometry(0.07, 0.07, 1.15, 6), wx, fl + 1.46, wz, [0, rot, Math.PI / 2]);
        }
        // фонарь: крюк на стойке, часть разбита
        const lx = q.x + nx * side * (TW.wall - 0.12) + q.tx * 1.4, lz = q.z + nz * side * (TW.wall - 0.12) + q.tz * 1.4;
        box(M.dark, lx, fl + 1.52, lz, 0.14, 0.2, 0.14, { rot, tile: 1 });
        place(lanternMat, new THREE.CylinderGeometry(0.05, 0.05, 0.13, 8), lx, fl + 1.5, lz, 0, 1, { cast: false });
        const on = R() > 0.25;
        TRENCH_LAMPS.push(addLamp({ kind: 'bulb', x: lx, y: fl + 1.45, z: lz, on, flick: R() < 0.3 ? 0.5 : 0, ground: fl, color: 0xffc47a }));
      }
    }
  }
  walls.planks.flush(M.planks); walls.planksDark.flush(M.planksDark); walls.deadwood.flush(M.wattle); walls.cap.flush(M.planksDark);
  // настил-трап: поперечные доски на двух лагах, по аппарелям — ступенями
  for (let s = 0.4; s < t.len - 0.3; s += 0.31) {
    if (R() < 0.07) continue;
    const q = polyAt(P, s), q2 = polyAt(P, Math.min(t.len, s + 0.3));
    const y = floorAt(q.x, q.z), y2 = floorAt(q2.x, q2.z);
    box(M.planksDark, q.x, y + 0.06, q.z, 0.95, 0.035, 0.15, { rot: Math.atan2(q.tx, q.tz), rx: -Math.atan2(y2 - y, 0.3), rz: R.range(-0.03, 0.03), tile: 1 });
  }
  // колючка перед окопом: колья и три нити, разрывы у троп и деревьев
  if (t.bays) {
    // колючка: каждый пролёт между кольями — деталь с коллайдером; режется (E) и рвётся взрывом
    const off = 5.5 * enemySide;
    let prev = null;
    const q0 = polyAt(P, t.len / 2);
    beginStruct({ kind: 'wire', x: q0.x, z: q0.z, rot: 0, w: t.len, d: 1, h: 1, fy: hFast(q0.x, q0.z), fuel: 0, quiet: true });
    for (let s = 1; s < t.len; s += 2.6) {
      const q = polyAt(P, s), x = q.x - q.tz * off + R.range(-0.3, 0.3), z = q.z + q.tx * off + R.range(-0.3, 0.3);
      if (pathInfluence(x, z, 0.8) > 0 || trenchDist(x, z) < 2.5 || treeFree(x, z) === false) { prev = null; continue; }
      const y = hFast(x, z);
      noPanel();
      cyl(M.deadwood, x, y + 0.55, z, 0.04, 0.035, 1.1, { seg: 5, rot: [R.range(-0.1, 0.1), 0, R.range(-0.1, 0.1)] });
      if (prev) {
        const pn = panel('wire', { hp: 0.35, mode: 'none', burnable: false, density: 100 });
        pn.quiet = true;
        for (const hh of [0.25, 0.6, 0.95]) beam(M.wire, V(prev[0], prev[1] + hh, prev[2]), V(x, y + hh + R.range(-0.04, 0.04), z), 0.005, { seg: 3, cast: false });
        if (R() < 0.5) beam(M.wire, V(prev[0], prev[1] + 0.95, prev[2]), V(x, y + 0.25, z), 0.005, { seg: 3, cast: false });
        const mx = (prev[0] + x) / 2, mz = (prev[2] + z) / 2, L = Math.hypot(x - prev[0], z - prev[2]);
        addBox(mx, (prev[1] + y) / 2 + 0.5, mz, 0.12, 1.0, L, Math.atan2(x - prev[0], z - prev[2]), { walk: false }).wire = true;
        addWire(pn, V(prev[0], prev[1] + 0.6, prev[2]), V(x, y + 0.6, z));
      }
      prev = [x, y, z];
    }
    noPanel();
    endStruct();
  }
}
function crateAt(x, z, rot, y) {
  box(M.crate, x, y + 0.2, z, 0.9, 0.36, 0.45, { rot, tile: 0.8, collide: true });
}
const treeFree = () => true;
/** Точка и направление «наружу» у конца окопа. */
function trenchEnd(t, end) {
  const P = t.pts, a = end ? P[P.length - 1] : P[0], b = end ? P[P.length - 2] : P[1];
  const dx = a[0] - b[0], dz = a[1] - b[1], l = Math.hypot(dx, dz);
  return { x: a[0], z: a[1], ox: dx / l, oz: dz / l };
}
const DUGOUTS = [];
/** Блиндаж: сруб, заглублённый в склон, накат из брёвен, земля сверху. */
function dugout(x, z, rot, R) {
  const F = frame(x, z, rot), g = terrainH(x, z);
  const w = 4.6, d = 3.6, h = 2.1;
  // наземный сруб (ДЗОТ): пол на уровне площадки, сверху земляная подушка
  const fy = g + 0.02;
  const S = beginStruct({ kind: 'dugout', x, z, rot, w, d, h, fy, fuel: 0.8, log: true });
  noPanel();
  box(M.planksDark, x, fy - 0.05, z, w, 0.1, d, { rot, collide: true, tile: 1.2 });
  // стены из брёвен: каждая сторона — панель, рассыпается на брёвна
  const logs = new THREE.CylinderGeometry(0.13, 0.13, 1, 7);
  const sides = [[0, -d / 2, w, 0], [-w / 2, 0, d, Math.PI / 2], [w / 2, 0, d, Math.PI / 2], [-(w / 2 - 0.9) - 0.0, d / 2, 1.5, 0], [(w / 2 - 0.9), d / 2, 1.5, 0]];
  const walls = [];
  for (const [lx, lz, len, r2] of sides) {
    const [px, pz] = F.p(lx, lz);
    const pn = panel('wall', { hp: 2.2, load: true, mat: M.barkLog, dims: { x: px, y: fy + h / 2, z: pz, sx: len + 0.3, sy: h, sz: 0.3, rot: rot + r2, log: true } });
    walls.push(pn);
    for (let y = 0; y < h; y += 0.26) place(M.barkLog, logs, px, fy + 0.13 + y, pz, [0, rot + r2, Math.PI / 2], [1, len + 0.3, 1]);
    addBox(px, fy + h / 2, pz, r2 ? 0.3 : len, h, r2 ? len : 0.3, rot, { walk: false });
  }
  // накат и земляная насыпь: держатся на стенах; сверху можно стоять, дрон не пролетит
  panel('roof', { hp: 2.5, sup: { list: walls, frac: 0.6 }, mode: 'rigid', density: 300 });
  for (let k = -d / 2 - 0.3; k <= d / 2 + 0.3; k += 0.27) {
    const [px, pz] = F.p(0, k);
    place(M.barkLog, logs, px, fy + h + 0.12, pz, [0, rot, Math.PI / 2], [1, w + 0.8, 1]);
  }
  addBox(x, fy + h + 0.4, z, w + 0.8, 0.8, d + 0.6, rot, { walk: true });
  panel('roof', { hp: 2.5, sup: { list: walls, frac: 0.6 }, mode: 'dust' });
  const mound = new THREE.SphereGeometry(1, 16, 8, 0, TAU, 0, Math.PI / 2);
  place(M.dirtMound, mound, x, fy + h + 0.2, z, rot, [w * 0.62, 0.7, d * 0.7]);
  addBox(x, fy + h + 0.75, z, w * 0.9, 0.5, d * 1.0, rot, { walk: true });
  for (let i = 0; i < 10; i++) {
    const [px, pz] = F.p(R.range(-w / 2, w / 2), R.range(-d / 2, d / 2));
    bag(px, fy + h + 0.55 + R.range(0, 0.2), pz, R.range(0, TAU), R.range(-0.2, 0.2), R.range(-0.2, 0.2));
  }
  noPanel();
  // вход: ступени вниз
  const [sx, sz] = F.p(0, d / 2 + 0.5);
  box(M.planksDark, sx, g + 0.02, sz, 1.2, 0.08, 0.6, { rot, tile: 1 });
  endStruct();
  // коптилка внутри, на стене — позывные и частоты, на ящике — схема
  const [lx, lz] = F.p(w / 2 - 0.6, -d / 2 + 0.5);
  addLamp({ kind: 'bulb', x: lx, y: fy + 1.6, z: lz, flick: 0.2, ground: fy });
  const [px, pz] = F.p(-0.4, -d / 2 + 0.3); sheet(R.int(0, 1), px, fy + 1.35, pz, rot);
  const [qx, qz] = F.p(0.6, -d / 2 + 0.3); sheet(2, qx, fy + 1.25, qz, rot, { tilt: 0.05 });
  const [cx2, cz2] = F.p(-w / 2 + 0.6, -0.4);
  box(M.crate, cx2, fy + 0.2, cz2, 0.9, 0.4, 0.5, { rot: rot + 0.2, tile: 0.8, collide: true });
  sheet(3, cx2, fy + 0.41, cz2, rot + 0.3, { flat: true, w: 0.42, h: 0.56 });
}

/* ---------- Базы команд ---------- */
const BASE = [];
function baseLocal(s) {
  // вперёд — к центру карты, вправо — по часовой
  const fx = s.fx, fz = s.fz, rx = -fz, rz = fx;
  return { p: (a, b) => [s.x + fx * a + rx * b, s.z + fz * a + rz * b], rot: Math.atan2(fx, fz) };
}
export function planMilitary() {
  for (const s of Object.values(SPAWNS)) {
    const L = baseLocal(s);
    const [fx, fz] = L.p(-6, 0), [bx, bz] = L.p(-1.5, -9.5), [nx, nz] = L.p(-2.5, 9.5), [gx, gz] = L.p(3.5, -6.5), [tx, tz] = L.p(-7.5, 7);
    BASE.push({ s, L, flag: [fx, fz], bunker: [bx, bz], net: [nx, nz], gen: [gx, gz], tent: [tx, tz] });
    keep(fx, fz, 2.5); keep(nx, nz, 4.5); keep(gx, gz, 1.8);
    addPad(bx, bz, 3.4, 2.9, L.rot, 2.5);
    addPad(tx, tz, 2.4, 2.9, L.rot + 0.4, 2);
    addPad(s.x, s.z, 7, 7, L.rot, 6);
  }
  // блиндажи в конце окопов: вход смотрит в окоп, сруб — за аппарелью
  for (const t of TRENCHES) for (const end of [0, 1]) {
    if (!(end ? t.dugout1 : t.dugout0)) continue;
    const e = trenchEnd(t, end), off = 1.8 + 1.6;
    const x = e.x + e.ox * off, z = e.z + e.oz * off;
    DUGOUTS.push({ x, z, rot: Math.atan2(-e.ox, -e.oz) });
    keep(x, z, 3.4);
  }
  // блокпосты на старых дорогах у минного поля
  for (const sgn of [1, -1]) keep(-62.7 * sgn, -103 * sgn, 5);
  // пулемётные гнёзда
  for (const sgn of [1, -1]) { keep(-33 * sgn, 22 * sgn, 2.4); keep(-60 * sgn, -26 * sgn, 2.4); }
}
function buildBase(B, R) {
  const { s, L } = B;
  const A = s.team === 'A';
  // флаг команды
  buildFlag(B.flag[0], B.flag[1], L.rot, A ? TEX.flagA : TEX.flagD);
  // блиндаж базы
  dugout(B.bunker[0], B.bunker[1], L.rot - Math.PI / 2, R);
  // мешки полукругом перед базой, проход по центру
  for (const sgn of [-1, 1]) {
    const [x0, z0] = L.p(10.5, sgn * 3), [x1, z1] = L.p(9.5, sgn * 7.5), [x2, z2] = L.p(7, sgn * 10.5);
    sandbagWall(x0, z0, x1, z1, 3, R); sandbagWall(x1, z1, x2, z2, 3, R);
  }
  // маскировочная сеть над складом
  camoNet(B.net[0], B.net[1], L.rot, 7, 5.5, R);
  for (let i = 0; i < 7; i++) {
    const [cx, cz] = L.p(-2.5 + R.range(-2.5, 2.5), 9.5 + R.range(-2, 2));
    crate(cx, cz, L.rot + R.range(-0.3, 0.3), R, R() < 0.4 ? 2 : 1);
  }
  // генератор, прожекторная мачта, бочки
  generator(B.gen[0], B.gen[1], L.rot, R, s);
  const [mx, mz] = L.p(1.5, -3);
  floodMast(mx, mz, L, R);
  const [fbx, fbz] = L.p(1, 4);
  fireBarrel(fbx, fbz);
  for (let i = 0; i < 4; i++) { const [px, pz] = L.p(2 + R.range(-1, 1), 5.5 + R.range(-1, 1)); barrelStatic(px, pz, R); }
  // палатка
  tent(B.tent[0], B.tent[1], L.rot + 0.4, R);
  // граница зоны возрождения: колышки с вымпелами
  const pen = new THREE.MeshStandardMaterial({ map: A ? TEX.pennantA : TEX.pennantD, side: THREE.DoubleSide, roughness: 0.9 });
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * TAU, x = s.x + Math.cos(a) * s.r, z = s.z + Math.sin(a) * s.r;
    if (pathInfluence(x, z, 0.3) > 0 || edgeDist(x, z) > MAP.PLAY - 1) continue;
    const y = hFast(x, z);
    cyl(M.deadwood, x, y + 0.7, z, 0.035, 0.03, 1.4, { seg: 5 });
    const ux = Math.cos(a + 1.3), uz = Math.sin(a + 1.3);
    makeCloth({ nx: 5, ny: 4, material: pen, wind: 1.2, stiff: 3,
      place: (u, v) => new THREE.Vector3(x + ux * u * 0.45, y + 1.38 - v * (0.3 - u * 0.24), z + uz * u * 0.45),
      pinFn: i2 => i2 === 0 });
  }
}

/** Флаг на мачте: 13 м трубы, растяжки, полотнище 5.6×3.5 с дырами по краю. */
export const FLAGS = [];
function buildFlag(x, z, rot, map) {
  const y = terrainH(x, z), H = 13;
  box(M.concrete, x, y + 0.15, z, 1.1, 0.5, 1.1, { rot, tile: 0.8, collide: true });
  cyl(M.steel, x, y + H / 2, z, 0.1, 0.065, H, { seg: 12 });
  place(M.steel, new THREE.SphereGeometry(0.12, 10, 8), x, y + H + 0.05, z, 0);
  addCircle(x, z, 0.16, y, y + H);
  for (let i = 0; i < 3; i++) {
    const a = rot + i * TAU / 3 + 0.5;
    const gx = x + Math.cos(a) * 4.2, gz = z + Math.sin(a) * 4.2;
    beam(M.wire, V(x, y + H * 0.72, z), V(gx, terrainH(gx, gz) + 0.1, gz), 0.012, { seg: 3, cast: false });
    cyl(M.deadwood, gx, terrainH(gx, gz) + 0.2, gz, 0.06, 0.05, 0.6, { seg: 5 });
  }
  // фал вдоль мачты
  beam(M.rope, V(x + 0.09, y + 1.2, z), V(x + 0.09, y + H - 0.2, z), 0.008, { seg: 3, cast: false });
  const mat = new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.92 });
  const FW = 5.6, FH = 3.5, top = y + H - 0.35;
  // полотнище выпускаем по ветру (−ветер = от мачты)
  const nx = Q.cloth + 4, ny = Math.round((Q.cloth + 4) * 0.62);
  const dir = [Math.cos(0.64), Math.sin(0.64)];
  const c = makeCloth({
    nx, ny, material: mat, wind: 1.35, stiff: 6, drag: 0.982,
    place: (u, v) => V(x + dir[0] * u * FW, top - v * FH, z + dir[1] * u * FW),
    pinFn: (i, j) => i === 0 && (j === 0 || j === ny - 1 || j % 2 === 0)
  });
  FLAGS.push({ x, z, cloth: c });
}
function camoNet(x, z, rot, w, d, R) {
  const F = frame(x, z, rot), g = terrainH(x, z);
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]];
  for (const [lx, lz] of corners) {
    const [px, pz] = F.p(lx, lz);
    cyl(M.deadwood, px, g + 1.3, pz, 0.06, 0.05, 2.6, { seg: 6 });
    addCircle(px, pz, 0.08, g, g + 2.6);
  }
  const [cx, cz] = F.p(0, 0);
  cyl(M.deadwood, cx, g + 1.6, cz, 0.06, 0.05, 3.2, { seg: 6 });
  const nx = Math.max(8, Q.cloth), ny = Math.max(6, Math.round(Q.cloth * 0.8));
  makeCloth({
    nx, ny, material: M.camo, wind: 0.55, stiff: 3, drag: 0.97, uvScale: [2, 1.6],
    place: (u, v) => { const [px, pz] = F.p((u - 0.5) * w, (v - 0.5) * d); return V(px, g + 2.55, pz); },
    pinFn: (i, j) => ((i === 0 || i === nx - 1) && (j === 0 || j === ny - 1)) || (i === Math.floor(nx / 2) && j === Math.floor(ny / 2))
  });
}
function crate(x, z, rot, R, stack = 1) {
  const y = hFast(x, z);
  for (let k = 0; k < stack; k++) {
    box(M.crate, x, y + 0.2 + k * 0.4, z, 1.0, 0.4, 0.55, { rot: rot + k * R.range(-0.2, 0.2), tile: 0.8, collide: true });
  }
}
function barrelStatic(x, z, R) {
  const y = hFast(x, z);
  const mat = M.barrel[R.int(0, M.barrel.length - 1)];
  cyl(mat, x, y + 0.44, z, 0.3, 0.3, 0.88, { seg: 14, tile: 1.9 });
  for (const yy of [0.25, 0.62]) cyl(mat, x, y + yy, z, 0.31, 0.31, 0.04, { seg: 14 });
  addCircle(x, z, 0.32, y, y + 0.9);
}
/** Генератор базы питает прожекторы и фонари: подорвали или расстреляли — база во тьме. */
function generator(x, z, rot, R, s) {
  const y = hFast(x, z), F = frame(x, z, rot);
  beginStruct({ kind: 'generator', x, z, rot, w: 1.6, d: 1, h: 1.2, fy: y, fuel: 0, quiet: true });
  const p = panel('prop', { hp: 0.9, mode: 'rigid', density: 1400, float: 0, burnable: false });
  box(M.carPaint[3], x, y + 0.45, z, 1.4, 0.8, 0.8, { rot, tile: 1, collide: true });
  box(M.dark, x, y + 0.9, z, 1.2, 0.12, 0.7, { rot, tile: 1 });
  // решётка радиатора, щиток с приборами, кабели к мачте
  const [rx, rz] = F.p(-0.71, 0); box(M.dark, rx, y + 0.5, rz, 0.02, 0.5, 0.6, { rot, tile: 1 });
  const [bx, bz] = F.p(0.2, 0.41); box(M.steel, bx, y + 0.6, bz, 0.4, 0.3, 0.02, { rot, tile: 1 });
  noPanel();
  const [ex, ez] = F.p(0.8, 0);
  cyl(M.rust, ex, y + 1.2, ez, 0.05, 0.05, 1.1, { seg: 6 });
  const [kx, kz] = F.p(-1.2, 0.3);
  cyl(M.barrel[1], kx, y + 0.3, kz, 0.18, 0.18, 0.5, { seg: 10 });
  endStruct();
  addGenerator({ x, y: y + 0.5, z, panel: p, ex, ey: y + 1.75, ez, cx: s.x, cz: s.z, r: 36 });
}

/** Прожекторная мачта базы: два прожектора освещают подступы и склад. */
function floodMast(x, z, L, R) {
  const y = terrainH(x, z), H = 6.2;
  cyl(M.steel, x, y + H / 2, z, 0.08, 0.06, H, { seg: 8 });
  addCircle(x, z, 0.12, y, y + H);
  for (const [a, b] of [[6, -4], [8, 5]]) {
    const [tx, tz] = L.p(a, b);
    const dir = V(tx - x, terrainH(tx, tz) - (y + H), tz - z).normalize();
    const px = x + dir.x * 0.4, pz = z + dir.z * 0.4, py = y + H - 0.1;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.34, 0.28), M.dark);
    head.position.set(px, py, pz); head.lookAt(px + dir.x, py + dir.y, pz + dir.z); head.castShadow = true;
    scene.add(head);
    const lens = M.lampGlass.clone();
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.28), lens);
    glass.position.set(px + dir.x * 0.15, py + dir.y * 0.15, pz + dir.z * 0.15); glass.lookAt(px + dir.x * 2, py + dir.y * 2, pz + dir.z * 2);
    scene.add(glass);
    addLamp({ kind: 'flood', x: px + dir.x * 0.2, y: py + dir.y * 0.2, z: pz + dir.z * 0.2, dir, lens, on: true, flick: R() < 0.3 ? 0.25 : 0 });
  }
}
export const FIRES = [];
export function fireBarrel(x, z) {
  const y = hFast(x, z);
  cyl(M.burnt, x, y + 0.44, z, 0.3, 0.3, 0.88, { seg: 14, open: true, tile: 1.9 });
  place(M.dark, new THREE.CylinderGeometry(0.28, 0.28, 0.02, 14), x, y + 0.7, z, 0);
  addCircle(x, z, 0.32, y, y + 0.9);
  addLamp({ kind: 'fire', x, y: y + 1.1, z, ground: y });
  FIRES.push({ x, y: y + 0.85, z, r: 0.22 });
}
/** Армейская палатка: брезентовый конёк на растяжках, вход отвёрнут. */
function tent(x, z, rot, R) {
  const y = terrainH(x, z) - 0.02;
  const shape = new THREE.Shape();
  shape.moveTo(-1.9, 0); shape.lineTo(-1.8, 0.9); shape.quadraticCurveTo(-0.9, 2.05, 0, 2.2); shape.quadraticCurveTo(0.9, 2.05, 1.8, 0.9); shape.lineTo(1.9, 0);
  shape.lineTo(1.84, 0); shape.lineTo(1.74, 0.88); shape.quadraticCurveTo(0.86, 1.98, 0, 2.13); shape.quadraticCurveTo(-0.86, 1.98, -1.74, 0.88); shape.lineTo(-1.84, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 4.4, bevelEnabled: false });
  g.translate(0, 0, -2.2);
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.4, uv.getY(i) * 0.4);
  place(M.canvas, g, x, y, z, rot);
  const back = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-1.9, 0), new THREE.Vector2(-1.8, 0.9), new THREE.Vector2(0, 2.2), new THREE.Vector2(1.8, 0.9), new THREE.Vector2(1.9, 0)]));
  const F = frame(x, z, rot);
  const [bx, bz] = F.p(0, -2.2);
  place(M.canvas, back, bx, y, bz, rot);
  for (const lz of [-2.2, 0, 2.2]) { const [px, pz] = F.p(0, lz); cyl(M.deadwood, px, y + 1.1, pz, 0.04, 0.04, 2.2, { seg: 5 }); }
  for (const s of [-1, 1]) { const [px, pz] = F.p(s * 1.85, 0); addBox(px, y + 0.6, pz, 0.3, 1.2, 4.4, rot, { walk: false }); }
  const [px, pz] = F.p(0, -2.2); addBox(px, y + 1, pz, 3.6, 2, 0.2, rot, { walk: false });
  addBox(x, y + 1.85, z, 3.2, 0.6, 4.4, rot, { walk: true });
}

/* ---------- Минное поле ---------- */
export const MINES = { grid: new Map(), list: [] };
const MCELL = 3;
const mkey = (x, z) => Math.floor(x / MCELL) * 4096 + Math.floor(z / MCELL);
function planMines() {
  const R = rng(6060);
  const a = MAP.PLAY + 0.8, b = MAP.MINE1 - 0.3;
  for (let x = -b; x < b; x += 2.6) for (let z = -b; z < b; z += 2.6) {
    const px = x + R.range(-0.9, 0.9), pz = z + R.range(-0.9, 0.9);
    const e = edgeDist(px, pz);
    if (e < a || e > b) continue;
    const m = { x: px, z: pz, type: R() < 0.25 ? 'tm' : R() < 0.7 ? 'pmn' : 'ozm', live: true, mesh: null };
    MINES.list.push(m);
    const k = mkey(px, pz);
    if (!MINES.grid.has(k)) MINES.grid.set(k, []);
    MINES.grid.get(k).push(m);
  }
}
export function mineNear(x, z, r) {
  let best = null, bd = r;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const L = MINES.grid.get(mkey(x + i * MCELL, z + j * MCELL));
    if (!L) continue;
    for (const m of L) { if (!m.live) continue; const d = Math.hypot(m.x - x, m.z - z); if (d < bd) { bd = d; best = m; } }
  }
  return best;
}
function buildMinefield(R) {
  planMines();
  // видимые мины: часть вымыта дождями из грунта
  const tm = new THREE.CylinderGeometry(0.16, 0.16, 0.1, 14), pmn = new THREE.CylinderGeometry(0.056, 0.056, 0.055, 10);
  const olive = new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.6, metalness: 0.3 });
  for (const m of MINES.list) {
    if (m.type === 'ozm') continue;
    if (R() > 0.2) continue;
    const y = hFast(m.x, m.z);
    const mesh = new THREE.Mesh(m.type === 'tm' ? tm : pmn, olive);
    mesh.position.set(m.x, y + (m.type === 'tm' ? 0.01 : 0.005), m.z);
    mesh.rotation.set(R.range(-0.2, 0.2), R() * TAU, R.range(-0.2, 0.2));
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh); m.mesh = mesh;
  }
  // ОЗМ на колышках с растяжками
  for (const m of MINES.list) {
    if (m.type !== 'ozm' || R() > 0.35) continue;
    const y = hFast(m.x, m.z);
    cyl(M.dark, m.x, y + 0.08, m.z, 0.05, 0.05, 0.16, { seg: 8 });
    const a = R() * TAU, L = R.range(2, 4), ex = m.x + Math.cos(a) * L, ez = m.z + Math.sin(a) * L;
    cyl(M.deadwood, ex, hFast(ex, ez) + 0.15, ez, 0.02, 0.02, 0.3, { seg: 4 });
    beam(M.wire, V(m.x, y + 0.14, m.z), V(ex, hFast(ex, ez) + 0.12, ez), 0.004, { seg: 3, cast: false });
  }
  // внутренняя граница: колья, красно-белая лента, таблички
  const e0 = MAP.PLAY - 0.2;
  const ring = [[-e0, -e0], [e0, -e0], [e0, e0], [-e0, e0], [-e0, -e0]];
  const tapeMat = new THREE.MeshStandardMaterial({ map: tapeTex(), side: THREE.DoubleSide, roughness: 0.7 });
  injectWind(tapeMat, { amp: 0.25, stiff: 1, refH: 1, flutter: 0.12, blast: 1.4 });
  let signI = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, az] = ring[k], [bx, bz] = ring[k + 1];
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
    const inward = [-uz, ux];
    let prev = null;
    for (let s = 0; s <= L; s += 4) {
      const x = ax + ux * s + R.range(-0.2, 0.2), z = az + uz * s + R.range(-0.2, 0.2), y = hFast(x, z);
      if (pathInfluence(x, z, 0) > 0.5) { prev = null; continue; }
      cyl(M.deadwood, x, y + 0.5, z, 0.035, 0.03, 1.0, { seg: 5, rot: [R.range(-0.08, 0.08), 0, R.range(-0.08, 0.08)] });
      if (prev && R() > 0.1) tape(prev, [x, y + 0.85, z], tapeMat, R);
      prev = [x, y + 0.85, z];
      if (s % 20 === 0 || (s % 20 === 8 && R() < 0.4)) mineSign(x - inward[0] * 0.4, z - inward[1] * 0.4, Math.atan2(inward[0], inward[1]), signI++, R);
    }
  }
  // внешний забор: столбы, 4 нити колючей проволоки, спираль по земле
  const f = MAP.FENCE;
  const fence = [[-f, -f], [f, -f], [f, f], [-f, f], [-f, -f]];
  const helix = [];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = fence[k], [bx, bz] = fence[k + 1];
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
    let prev = null;
    for (let s = 0; s <= L; s += 3.2) {
      const x = ax + ux * s, z = az + uz * s, y = hFast(x, z);
      const lean = R() < 0.06 ? 0.35 : R.range(-0.05, 0.05);
      cyl(M.deadwood, x, y + 0.9, z, 0.07, 0.06, 1.9, { seg: 6, rot: [lean * uz, 0, lean * ux] });
      if (prev) for (const hh of [0.35, 0.75, 1.15, 1.55]) {
        if (R() < 0.04) continue;
        beam(M.wire, V(prev[0], prev[1] + hh, prev[2]), V(x, y + hh - 0.03, z), 0.006, { seg: 3, cast: false });
      }
      prev = [x, y, z];
      addBox(x, y + 1, z, 0.5, 2.5, 0.5, 0);
    }
    // спираль Бруно чуть внутри
    const off = -1.1;
    const inward = [-uz, ux];
    for (let s = 0; s <= L; s += 0.32) {
      const cx = ax + ux * s + inward[0] * off * -1, cz = az + uz * s + inward[1] * off * -1;
      const ang = s / 0.32 * (TAU / 6);
      const r = 0.42;
      helix.push(V(cx + inward[0] * Math.cos(ang) * r, hFast(cx, cz) + 0.42 + Math.sin(ang) * r, cz + inward[1] * Math.cos(ang) * r).add(V(ux * Math.cos(ang) * 0.12, 0, uz * Math.cos(ang) * 0.12)));
    }
  }
  // одна непрерывная трубка на весь периметр: кусками, чтобы не упереться в размер буфера
  for (let i = 0; i < helix.length - 1; i += 1400) {
    const part = helix.slice(i, i + 1401);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(part), part.length, 0.012, 3), M.wire);
    tube.castShadow = false; scene.add(tube);
  }
  // противотанковые ежи и блокпосты на старых дорогах
  for (const sgn of [1, -1]) checkpoint(-62.7 * sgn, -103 * sgn, sgn, R);
  hedgehogLine(R);
}
function tapeTex() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 16;
  const x = c.getContext('2d');
  for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#e8e2d4' : '#b0231a'; x.save(); x.translate(i * 16, 0); x.transform(1, 0, -0.9, 1, 0, 0); x.fillRect(0, 0, 16, 16); x.restore(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; return t;
}
function tape(a, b, mat, R) {
  const segs = 6, pos = [], uv = [], idx = [];
  const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
  // вершины — относительно точки на земле под первым колом: ветер считает высоту от «корня»
  const ox = a[0], oy = a[1] - 0.85, oz = a[2];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, sag = Math.sin(t * Math.PI) * 0.18 * R.range(0.6, 1.4);
    const x = lerp(a[0], b[0], t) - ox, y = lerp(a[1], b[1], t) - sag - oy, z = lerp(a[2], b[2], t) - oz;
    pos.push(x, y + 0.025, z, x, y - 0.025, z); uv.push(t * L / 2, 1, t * L / 2, 0);
  }
  for (let i = 0; i < segs; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.position.set(ox, oy, oz);
  scene.add(m);
}
function mineSign(x, z, rot, i, R) {
  const y = hFast(x, z);
  cyl(M.deadwood, x, y + 0.75, z, 0.04, 0.04, 1.5, { seg: 5 });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), new THREE.MeshStandardMaterial({ map: TEX.mineSign[i % 2], roughness: 0.8, side: THREE.DoubleSide }));
  m.position.set(x, y + 1.35, z);
  m.rotation.set(R.range(-0.05, 0.05), rot + R.range(-0.2, 0.2), R.range(-0.12, 0.12));
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
}
/** Ёж из трёх двутавров. */
function hedgehog(x, z, R) {
  const y = hFast(x, z) + 0.55, rot = R() * TAU;
  for (let i = 0; i < 3; i++) {
    const a = [[0.95, 0, 0], [0, 0, 0.95], [0.6, 0.6, 0]][i];
    const d = V(Math.cos(rot + i * 2.1) * a[0], i === 2 ? 1 : 0.6, Math.sin(rot + i * 2.1) * a[0]).normalize().multiplyScalar(0.9);
    const p0 = V(x, y, z).sub(d), p1 = V(x, y, z).add(d);
    beam(M.rust, p0, p1, 0.07, { seg: 4 });
  }
  addCircle(x, z, 0.8, y - 0.6, y + 0.8);
}
function hedgehogLine(R) {
  // заграждение поперёк старой дороги: ежи в шахматном порядке на минной полосе
  for (const sgn of [1, -1]) for (let k = 0; k < 7; k++) {
    hedgehog((-63 + (k % 2 ? 2.2 : -2.2) + R.range(-1.5, 1.5)) * sgn, -(MAP.PLAY + 3 + k * 1.7) * sgn, R);
  }
}
/** Блокпост: шлагбаум, будка, бетонные блоки, сгоревшая машина уже за ним — на минах. */
function checkpoint(x, z, sgn, R) {
  const y = hFast(x, z), rot = sgn > 0 ? 0 : Math.PI;
  for (const lx of [-4.2, 4.2]) box(M.concrete, x + lx, y + 0.4, z, 1.6, 0.8, 0.8, { rot: rot + R.range(-0.2, 0.2), tile: 0.8, collide: true });
  cyl(M.carPaint[4], x - 2.8, y + 0.6, z, 0.12, 0.12, 1.2, { seg: 8 });
  box(M.carPaint[2], x - 0.6, y + 1.05, z + 0.1 * sgn, 4.6, 0.1, 0.1, { rot, rz: 0.12 + R.range(0, 0.4), tile: 0.5 });
  box(M.planksPaint, x + 6.5, y + 1.2, z + 1.5 * sgn, 1.8, 2.4, 1.8, { rot, tile: 1.5, collide: true });
  box(M.roofRust, x + 6.5, y + 2.5, z + 1.5 * sgn, 2.2, 0.04, 2.2, { rot, rx: 0.1, tile: 1.2 });
  sandbagWall(x - 6, z - 1.5 * sgn, x - 6, z + 2 * sgn, 3, R);
  vehicle('sedan', x + 0.6, z - 10.5 * sgn, rot + 0.35, { seed: 70 + sgn, burnt: true });
}

/* ---------- Перекрытая щель ----------
   Середина хода сообщения накрыта накатом из брёвен и землёй: по нему можно
   пройти поверху, внутри — сумрак и коптилка. Сверху не видно, кто идёт по ходу. */
function coveredTrench(t, R) {
  const P = t.pts, s0 = t.len * 0.3, s1 = Math.min(t.len - TW.ramp - 1, s0 + 8.5);
  const logs = new THREE.CylinderGeometry(0.11, 0.11, 1, 7);
  const edgeH = q => { const nx = -q.tz, nz = q.tx; return Math.max(terrainH(q.x + nx * 1.35, q.z + nz * 1.35), terrainH(q.x - nx * 1.35, q.z - nz * 1.35)); };
  for (let s = s0; s <= s1; s += 0.24) {
    const q = polyAt(P, s), y = edgeH(q) + 0.05, rot = Math.atan2(q.tx, q.tz);
    place(M.barkLog, logs, q.x, y, q.z, [0, rot, Math.PI / 2], [1, 2.9, 1]);
  }
  // земля на накате — вал поверху, и опорные стойки у входов
  for (let s = s0; s < s1; s += 1.4) {
    const q = polyAt(P, s + 0.7), y = edgeH(q), rot = Math.atan2(q.tx, q.tz);
    place(M.dirtMound, new THREE.SphereGeometry(1, 10, 5, 0, TAU, 0, Math.PI / 2), q.x, y + 0.12, q.z, rot, [1.7, 0.32, 1.1]);
    addBox(q.x, y + 0.2, q.z, 3.0, 0.4, 1.45, rot, { walk: true });
  }
  for (const s of [s0, s1]) {
    const q = polyAt(P, s), nx = -q.tz, nz = q.tx, fl = terrainH(q.x, q.z), y = edgeH(q);
    for (const e of [-1, 1]) cyl(M.barkPine, q.x + nx * e * 0.62, (fl + y) / 2, q.z + nz * e * 0.62, 0.09, 0.09, y - fl + 0.1, { seg: 6 });
    place(M.barkPine, new THREE.CylinderGeometry(0.1, 0.1, 1.5, 6), q.x, y - 0.06, q.z, [0, Math.atan2(q.tx, q.tz) + Math.PI / 2, Math.PI / 2]);
  }
  const q = polyAt(P, (s0 + s1) / 2), fl = terrainH(q.x, q.z);
  addLamp({ kind: 'bulb', x: q.x - q.tz * 0.5, y: fl + 1.55, z: q.z + q.tx * 0.5, flick: 0.3, ground: fl, power: 2.5, range: 6 });
  sheet(0, q.x - q.tz * 0.63, fl + 1.3, q.z + q.tx * 0.63, Math.atan2(q.tx, q.tz) - Math.PI / 2);
}

/* ---------- Сборка ---------- */
export function buildMilitary() {
  const R = rng(1212);
  lanternMat = new THREE.MeshStandardMaterial({ color: 0x8d8f8a, emissive: 0xffb45a, emissiveIntensity: 0, roughness: 0.3 });
  TRENCHES.forEach((t, i) => buildTrench(t, i, R));
  for (const t of TRENCHES) if (t.covered) coveredTrench(t, R);
  // пулемётные ячейки в конце сап
  for (const t of TRENCHES) if (t.nest1) {
    const e = trenchEnd(t, 1);
    sandbagRing(e.x + e.ox * 0.4, e.z + e.oz * 0.4, 1.75, 3, Math.atan2(-e.oz, -e.ox), 1.5, R);
  }
  for (const B of BASE) buildBase(B, R);
  for (const d of DUGOUTS) dugout(d.x, d.z, d.rot, R);
  // пулемётные гнёзда: у береговых ячеек (выход — к своей базе) и на подступах к турбазе/кордону
  for (const sgn of [1, -1]) {
    const home = sgn > 0 ? SPAWNS.A : SPAWNS.D;
    const [ax, az] = [-33 * sgn, 22 * sgn];
    sandbagRing(ax, az, 1.5, 3, Math.atan2(home.z - az, home.x - ax), 1.2, R);
    const [bx, bz] = [-60 * sgn, -26 * sgn];
    sandbagRing(bx, bz, 1.5, 3, Math.atan2(-50 * sgn - bz, -50 * sgn - bx), 1.2, R);
  }
  buildMinefield(R);
}
export const baseInfo = () => BASE;
/** Фонари в окопах загораются в сумерках вместе с сетью турбазы. */
export function updateMilitary(sky) {
  if (lanternMat) lanternMat.emissiveIntensity = sky.lampOn * 2.4;
}
