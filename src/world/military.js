import * as THREE from 'three';
import { scene, Q } from '../core/env.js';
import { rng, TAU, lerp, polyAt, clamp, hash2 } from '../core/math.js';
import { MAP, SPAWNS, TRENCHES, terrainH, baseH, addPad, keep, edgeDist, PATHS, trenchDist, pathInfluence, isFree } from './layout.js';
import { hFast } from './heightcache.js';
import { M, TEX } from '../gen/materials.js';
import { box, cyl, beam, place, frame } from './builders.js';
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
/** Стенка из мешков: ряды со сдвигом в полмешка, верхний ряд с прорехами. */
export function sandbagWall(x0, z0, x1, z1, rows = 3, R = rng(1), collide = true) {
  const L = Math.hypot(x1 - x0, z1 - z0), rot = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
  const ux = (x1 - x0) / L, uz = (z1 - z0) / L;
  let yMax = -1e9;
  for (let r = 0; r < rows; r++) {
    for (let s = (r % 2) * 0.28; s < L; s += 0.56) {
      if (r === rows - 1 && R() < 0.18) continue;
      const x = x0 + ux * s, z = z0 + uz * s, y = hFast(x, z) + 0.08 + r * 0.17;
      bag(x, y, z, rot + R.range(-0.12, 0.12), R.range(-0.05, 0.05), R.range(-0.08, 0.08));
      yMax = Math.max(yMax, y);
    }
  }
  if (collide) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, g = hFast(cx, cz);
    addBox(cx, g + rows * 0.09, cz, 0.4, rows * 0.18 + 0.05, L, rot - Math.PI / 2, { walk: true });
  }
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

/* ---------- Окопы: обшивка, настил, бруствер ---------- */
function buildTrench(t, R) {
  const step = 1.2;
  const toCenterSign = (x, z, nx, nz) => (nx * -x + nz * -z) > 0 ? 1 : -1;
  for (let s = 0.6; s < t.len - 0.6; s += step) {
    const a = polyAt(t.pts, s), nx = -a.tz, nz = a.tx;
    const taper = clamp(Math.min(s, t.len - s) / 3.0, 0, 1);
    if (taper < 0.55) continue;                          // аппарели на концах без обшивки
    const floor = terrainH(a.x, a.z);
    const rot = Math.atan2(a.tx, a.tz) + Math.PI / 2;
    for (const side of [-1, 1]) {
      const wx = a.x + nx * 0.6 * side, wz = a.z + nz * 0.6 * side;
      const top = Math.max(terrainH(a.x + nx * 0.95 * side, a.z + nz * 0.95 * side), floor + 0.6);
      const hh = top - floor + 0.08;
      if (R() < 0.12) continue;                          // обшивка выбита — голая глина
      box(R() < 0.5 ? M.planks : M.planksDark, wx, floor + hh / 2 - 0.02, wz, step + 0.02, hh, 0.05, { rot, rz: R.range(-0.03, 0.03), rx: side * R.range(0.02, 0.07), tile: 1.1, vertical: true });
      if (Math.round(s / step) % 2 === 0) cyl(M.deadwood, wx - nx * 0.02 * side + a.tx * step / 2, floor + hh / 2, wz - nz * 0.02 * side + a.tz * step / 2, 0.05, 0.05, hh + 0.25, { seg: 6 });
      addBox(wx + nx * side * 0.2, floor + hh / 2, wz + nz * side * 0.2, step, hh, 0.45, rot, { walk: false });
    }
    // настил-трап из поперечных досок
    for (let k = 0; k < 4; k++) {
      const ss = s - step / 2 + k * 0.3, b = polyAt(t.pts, ss);
      if (R() < 0.1) continue;
      box(M.planksDark, b.x, terrainH(b.x, b.z) + 0.05, b.z, 0.95, 0.04, 0.2, { rot: Math.atan2(b.tx, b.tz), rz: R.range(-0.04, 0.04), tile: 1 });
    }
    // мешки на бруствере со стороны противника (к центру карты)
    const side = toCenterSign(a.x, a.z, nx, nz);
    if (R() < 0.75) {
      const bx = a.x + nx * 1.05 * side, bz = a.z + nz * 1.05 * side, y = terrainH(bx, bz);
      for (let r = 0; r < 2; r++) for (let k = 0; k < 2; k++) {
        const off = (k - 0.5) * 0.56 + (r % 2) * 0.28;
        bag(bx + a.tx * off, y + 0.05 + r * 0.16, bz + a.tz * off, rot + R.range(-0.1, 0.1), 0, R.range(-0.08, 0.08));
      }
    }
  }
}
/** Блиндаж: сруб, заглублённый в склон, накат из брёвен, земля сверху. */
function dugout(x, z, rot, R) {
  const F = frame(x, z, rot), g = terrainH(x, z);
  const w = 4.6, d = 3.6, h = 2.1;
  // наземный сруб (ДЗОТ): пол на уровне площадки, сверху земляная подушка
  const fy = g + 0.02;
  box(M.planksDark, x, fy - 0.05, z, w, 0.1, d, { rot, collide: true, tile: 1.2 });
  // стены из брёвен
  for (let y = 0; y < h; y += 0.26) {
    for (const [lx, lz, len, r2] of [[0, -d / 2, w, 0], [-w / 2, 0, d, Math.PI / 2], [w / 2, 0, d, Math.PI / 2]]) {
      const [px, pz] = F.p(lx, lz);
      place(M.barkPine, new THREE.CylinderGeometry(0.13, 0.13, len + 0.3, 7), px, fy + 0.13 + y, pz, [0, rot + r2, Math.PI / 2]);
    }
    for (const s of [-1, 1]) {
      const [px, pz] = F.p(s * (w / 2 - 0.9), d / 2);
      place(M.barkPine, new THREE.CylinderGeometry(0.13, 0.13, 1.5, 7), px, fy + 0.13 + y, pz, [0, rot, Math.PI / 2]);
    }
  }
  for (const [lx, lz, sx, sz] of [[0, -d / 2, w, 0.3], [-w / 2, 0, 0.3, d], [w / 2, 0, 0.3, d], [-w / 2 + 0.75, d / 2, 1.5, 0.3], [w / 2 - 0.75, d / 2, 1.5, 0.3]]) {
    const [px, pz] = F.p(lx, lz);
    addBox(px, fy + h / 2, pz, sx, h, sz, rot, { walk: false });
  }
  // накат и земляная насыпь
  for (let k = -d / 2 - 0.3; k <= d / 2 + 0.3; k += 0.27) {
    const [px, pz] = F.p(0, k);
    place(M.barkPine, new THREE.CylinderGeometry(0.14, 0.14, w + 0.8, 7), px, fy + h + 0.12, pz, [0, rot, Math.PI / 2]);
  }
  const mound = new THREE.SphereGeometry(1, 16, 8, 0, TAU, 0, Math.PI / 2);
  place(M.dirtMound, mound, x, fy + h + 0.2, z, rot, [w * 0.62, 0.7, d * 0.7]);
  for (let i = 0; i < 10; i++) {
    const [px, pz] = F.p(R.range(-w / 2, w / 2), R.range(-d / 2, d / 2));
    bag(px, fy + h + 0.55 + R.range(0, 0.2), pz, R.range(0, TAU), R.range(-0.2, 0.2), R.range(-0.2, 0.2));
  }
  // вход: ступени вниз
  const [sx, sz] = F.p(0, d / 2 + 0.5);
  box(M.planksDark, sx, g + 0.02, sz, 1.2, 0.08, 0.6, { rot, tile: 1 });
  // коптилка внутри
  const [lx, lz] = F.p(w / 2 - 0.6, -d / 2 + 0.5);
  addLamp({ kind: 'bulb', x: lx, y: fy + 1.6, z: lz, flick: 0.2, ground: fy });
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
  // блиндажи у левого крыла переднего рубежа
  for (const sgn of [1, -1]) keep(-85.1 * sgn, 45.5 * sgn, 4);
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
  generator(B.gen[0], B.gen[1], L.rot, R);
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
function generator(x, z, rot, R) {
  const y = hFast(x, z), F = frame(x, z, rot);
  box(M.carPaint[3], x, y + 0.45, z, 1.4, 0.8, 0.8, { rot, tile: 1, collide: true });
  box(M.dark, x, y + 0.9, z, 1.2, 0.12, 0.7, { rot, tile: 1 });
  const [ex, ez] = F.p(0.8, 0);
  cyl(M.rust, ex, y + 1.2, ez, 0.05, 0.05, 1.1, { seg: 6 });
  const [kx, kz] = F.p(-1.2, 0.3);
  cyl(M.barrel[1], kx, y + 0.3, kz, 0.18, 0.18, 0.5, { seg: 10 });
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

/* ---------- Сборка ---------- */
export function buildMilitary() {
  const R = rng(1212);
  for (const t of TRENCHES) buildTrench(t, R);
  for (const B of BASE) buildBase(B, R);
  // вход блиндажа смотрит на конец траншеи
  for (const sgn of [1, -1]) dugout(-85.1 * sgn, 45.5 * sgn, Math.atan2(0.707 * sgn, -0.707 * sgn), R);
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
