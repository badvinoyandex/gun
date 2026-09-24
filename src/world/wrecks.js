import * as THREE from 'three';
import { scene, camera, FRAME } from '../core/env.js';
import { rng, TAU, lerp, clamp, polyAt, polyDist } from '../core/math.js';
import { MAP, SPAWNS, PATHS, terrainH, keep, campXZ } from './layout.js';
import { hFast } from './heightcache.js';
import { M } from '../gen/materials.js';
import { box, cyl, beam, place, frame } from './builders.js';
import { addBox, addCircle } from '../core/colliders.js';
import { addLamp } from './lamps.js';
import { sandbagRing, sandbagWall } from './military.js';
import { findSpot, LANDMARKS } from './landmarks.js';
import { FX } from '../fx/particles.js';
import { cv, tex } from '../gen/canvas.js';
import { sr } from '../core/math.js';

/* ============================================================================
   СЛЕДЫ ФРОНТА
   • Ми-8 упал в лес на западном краю: фюзеляж на боку, хвостовая балка
     оторвана, лопасти согнуты, сломанные деревья, гарь, ещё тлеет.
   • Напротив (у Delta) — брошенная позиция гаубицы Д-30: мешки, ящики, гильзы.
   • Пулемётные гнёзда с горой гильз, открытыми цинками и запиской.
   • Сгоревшая БМП-2 на дороге турбазы и Т-72 без башни у лагеря.
   • Записки с позывными и частотами — в погребах, блиндажах, на вышке.
============================================================================ */
const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const WRECKS = { heli: null, art: null, mg: [], bmp: null, tank: null, smokes: [] };

/** Лист бумаги: на стене (tilt 0) или на ящике/земле (flat). */
export function sheet(i, x, y, z, rot, o = {}) {
  const g = paperGeo(i, o.w ?? 0.21, o.h ?? 0.28);
  if (o.flat) place(M.paperAtlas, g, x, y + 0.004, z, [-Math.PI / 2, rot, 0]);
  else place(M.paperAtlas, g, x, y, z, [o.tilt ?? 0, rot, sr(-0.08, 0.08)]);
}
/** Плоскость листа с UV своей ячейки атласа записок. */
export function paperGeo(i, w, h) {
  const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv, u0 = (i % 2) * 0.5, v0 = 0.5 - ((i % 4) >> 1) * 0.5;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * 0.5, v0 + uv.getY(k) * 0.5);
  return g;
}
/** Россыпь гильз: мелкие (пулемёт) или крупные (гаубица), лежат на боку. */
function casings(x, z, n, big, R, spread = 1.4, dirA = 0) {
  const g = big ? new THREE.CylinderGeometry(0.075, 0.08, 0.45, 10) : new THREE.CylinderGeometry(0.006, 0.0065, 0.054, 6);
  for (let i = 0; i < n; i++) {
    const a = dirA + sr(-1.1, 1.1), r = Math.pow(R(), 0.6) * spread, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    const y = hFast(px, pz) + (big ? 0.075 : 0.006);
    place(M.brass, g, px, y, pz, [Math.PI / 2 + sr(-0.1, 0.1), R() * TAU, 0]);
  }
}
function numberTex(txt, col = '#c9b04a') {
  const [c, x] = cv(256, 128);
  x.clearRect(0, 0, 256, 128); x.font = 'bold 96px Arial, sans-serif'; x.fillStyle = col; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, 128, 68);
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}

/* ---------- План ---------- */
let ROADS = null;
export function planWrecks() {
  const [hx, hz] = findSpot(-100, -22, 6.5, { sym: true });
  WRECKS.heli = { x: hx, z: hz, rot: 0.9 };
  WRECKS.art = { x: -hx, z: -hz, rot: Math.atan2(hx, hz) };
  keep(hx, hz, 11); keep(-hx, -hz, 7);
  { const [x, z] = findSpot(-50, 7, 2.6, { sym: true }); WRECKS.mg.push({ x, z, home: SPAWNS.A }, { x: -x, z: -z, home: SPAWNS.D }); keep(x, z, 2.8); keep(-x, -z, 2.8); }
  const onRoad = (name, tx, tz, off) => {
    const p = PATHS.find(q => q.name === name);
    let best = null, bd = 1e9;
    for (let s = 0; s < p.len; s += 0.5) { const q = polyAt(p.pts, s), d = Math.hypot(q.x - tx, q.z - tz); if (d < bd) { bd = d; best = q; } }
    return { x: best.x - best.tz * off, z: best.z + best.tx * off, rot: Math.atan2(best.tx, best.tz) };
  };
  WRECKS.bmp = onRoad('старая дорога', -59.6, -82, 1.7); WRECKS.bmp.rot += 0.35;
  WRECKS.tank = onRoad('дорога к лагерю', ...campXZ(-26.5, 2), -1.9); WRECKS.tank.rot -= 0.3;
  keep(WRECKS.bmp.x, WRECKS.bmp.z, 4.2); keep(WRECKS.tank.x, WRECKS.tank.z, 4.4);
}

/* ---------- Ми-8 ---------- */
function helicopter(o, R) {
  const { x, z, rot } = o, g0 = terrainH(x, z);
  M.heliV ??= (() => { const m = M.heli.clone(); m.vertexColors = true; return m; })();
  // локальные оси: z — к носу, фюзеляж лежит на левом боку, нос зарылся
  const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, rot, 1.22, 'YXZ'));
  const T = new THREE.Matrix4().compose(V(x, g0 + 1.25, z), Q, V(1, 1, 1));
  const add = (mat, geo, lx = 0, ly = 0, lz = 0, e = [0, 0, 0], sc = 1) => {
    const m = new THREE.Matrix4().compose(V(lx, ly, lz), new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2])), typeof sc === 'number' ? V(sc, sc, sc) : V(...sc));
    geo.applyMatrix4(m).applyMatrix4(T);
    place(mat, geo, 0, 0, 0, 0);
  };
  // фюзеляж: тело вращения, приплюснуто с боков, нос смят
  const prof = [[0, 8.4], [0.55, 8.15], [0.95, 7.6], [1.2, 6.8], [1.3, 5.8], [1.32, 0], [1.25, -2.2], [1.02, -3.4], [0.62, -4.4], [0.46, -4.8]].map(([r, zz]) => new THREE.Vector2(r, zz));
  const fus = new THREE.LatheGeometry(prof, 22);
  fus.rotateX(Math.PI / 2); fus.rotateZ(Math.PI / 2);
  const fp = fus.attributes.position, fc = new Float32Array(fp.count * 3);
  for (let i = 0; i < fp.count; i++) {
    let vx = fp.getX(i), vy = fp.getY(i), vz = fp.getZ(i);
    vy *= 1.12;
    if (vz > 6.2) { const k = (vz - 6.2) / 2.2; vy *= 1 - 0.35 * k; vx += k * 0.5 * Math.sign(vx); vz -= k * k * 0.6; }
    fp.setXYZ(i, vx, vy, vz);
    // остекление кабины и копоть по корме
    const glass = vz > 6.6 && vy > 0.05;
    const soot = clamp((-vz - 1) / 4, 0, 1) * 0.7;
    const v = glass ? 0.08 : 1 - soot;
    fc[i * 3] = v; fc[i * 3 + 1] = v; fc[i * 3 + 2] = v * (glass ? 1.3 : 1);
  }
  fus.setAttribute('color', new THREE.BufferAttribute(fc, 3)); fus.computeVertexNormals();
  add(M.heliV, fus);
  // иллюминаторы, распахнутая сдвижная дверь, номер
  for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) add(M.dark, new THREE.CircleGeometry(0.2, 12), sx * 1.34, 0.3, -1 + k * 1.1, [0, sx * Math.PI / 2, 0]);
  add(M.dark, new THREE.PlaneGeometry(1.3, 1.45), -1.345, -0.05, 2.6, [0, -Math.PI / 2, 0]);
  add(M.heli, new THREE.BoxGeometry(0.05, 1.45, 1.3), -1.42, -0.05, 1.2);
  M.heliNum ??= new THREE.MeshStandardMaterial({ map: numberTex('22'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.7 });
  add(M.heliNum, new THREE.PlaneGeometry(1.1, 0.55), 1.345, 0.6, 4.3, [0, Math.PI / 2, 0]);
  // двигатели, выхлопы, мачта, втулка
  for (const sx of [-0.48, 0.48]) {
    add(M.heliV, new THREE.CylinderGeometry(0.42, 0.45, 3.2, 14), sx, 1.38, 2.6, [Math.PI / 2, 0, 0]);
    add(M.dark, new THREE.CircleGeometry(0.38, 14), sx, 1.38, 4.21, [0, 0, 0]);
    add(M.burnt, new THREE.CylinderGeometry(0.2, 0.26, 0.9, 10, 1, true), sx * 1.5, 1.35, 0.8, [Math.PI / 2, sx * 1.2, 0]);
  }
  add(M.steel, new THREE.CylinderGeometry(0.2, 0.26, 0.8, 10), 0, 1.95, 1.5);
  add(M.steel, new THREE.CylinderGeometry(0.5, 0.5, 0.22, 12), 0, 2.35, 1.5);
  // лопасти: две согнуты и упёрлись в землю, две обломаны, одной нет
  const blade = (a, segs) => {
    let px = 0, py = 2.35, pz = 1.5, dir = a, droop = 0;
    for (const [len, dd] of segs) {
      const ex = px + Math.cos(dir) * len * Math.cos(droop), ez = pz + Math.sin(dir) * len * Math.cos(droop), ey = py - Math.sin(droop) * len;
      const bg = new THREE.BoxGeometry(0.52, 0.06, len);
      const mid = V((px + ex) / 2, (py + ey) / 2, (pz + ez) / 2), d = V(ex - px, ey - py, ez - pz).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), d);
      bg.applyQuaternion(q); bg.translate(mid.x, mid.y, mid.z);
      add(M.dark, bg);
      px = ex; py = ey; pz = ez; droop += dd;
    }
  };
  blade(0.3, [[3, 0.25], [2.5, 0.5], [2, 0.7]]);
  blade(1.55, [[3.2, 0.15], [3, 0.35]]);
  blade(2.8, [[1.6, 0]]);
  blade(4.1, [[1.1, 0]]);
  // подвесные баки (один сорван), шасси
  add(M.heliV, new THREE.CylinderGeometry(0.45, 0.45, 3.4, 14), 1.55, -0.55, 1.8, [Math.PI / 2, 0, 0]);
  add(M.steel, new THREE.CylinderGeometry(0.06, 0.06, 1.1, 6), 0.9, -1.35, -0.6, [0.3, 0, 0.4]);
  add(M.rubber ?? M.dark, new THREE.CylinderGeometry(0.36, 0.36, 0.25, 12), 1.15, -1.75, -0.8, [0, 0, Math.PI / 2]);
  // оторванная хвостовая балка с килем и рулевым винтом — лежит рядом
  {
    const c = Math.cos(rot), s = Math.sin(rot), bx = x - s * 6.5 + c * 2.8, bz = z - c * 6.5 - s * 2.8, by = hFast(bx, bz) + 0.4;
    const Qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.05, rot + 0.7, 0.35, 'YXZ'));
    const Tb = new THREE.Matrix4().compose(V(bx, by, bz), Qb, V(1, 1, 1));
    const addB = (mat, geo, lx = 0, ly = 0, lz = 0, e = [0, 0, 0]) => { geo.applyMatrix4(new THREE.Matrix4().compose(V(lx, ly, lz), new THREE.Quaternion().setFromEuler(new THREE.Euler(...e)), V(1, 1, 1))).applyMatrix4(Tb); place(mat, geo, 0, 0, 0, 0); };
    addB(M.armorBurnt, new THREE.CylinderGeometry(0.26, 0.44, 7.2, 12), 0, 0, -3.6, [Math.PI / 2, 0, 0]);
    addB(M.heli, new THREE.BoxGeometry(0.1, 1.8, 1.3), 0, 0.9, -7.1, [0.25, 0, 0]);
    addB(M.heli, new THREE.BoxGeometry(1.8, 0.06, 0.6), 0, 0.1, -5.6);
    for (let k = 0; k < 3; k++) addB(M.dark, new THREE.BoxGeometry(0.03, 1.6, 0.18), 0.12, 1.2, -7.3, [0, 0, k * 2.09]);
    addB(M.dark, new THREE.CylinderGeometry(0.46, 0.46, 0.05, 14), 0, 0, 0.02, [Math.PI / 2, 0, 0]);
    addBox(bx - Math.sin(rot + 0.7) * 3.6, by, bz - Math.cos(rot + 0.7) * 3.6, 1.0, 0.9, 7.2, rot + 0.7, { walk: false });
  }
  // коллайдеры фюзеляжа
  const c = Math.cos(rot), s = Math.sin(rot);
  addBox(x + s * 1.5, g0 + 1.25, z + c * 1.5, 2.6, 2.5, 10, rot, { walk: true }).car = 'heli';
  addCircle(x - c * 1.6 + s * 1.8, z + s * 1.6 + c * 1.8, 0.5, g0, g0 + 1.2);
  // сломанные деревья: высокие расщеплённые пни и стволы поперёк
  for (let i = 0; i < 5; i++) {
    const a = rot + sr(-0.6, 0.6) + (i % 2 ? Math.PI : 0), d = sr(5, 9), px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d, py = hFast(px, pz), h = sr(1.8, 4.2);
    cyl(M.barkPine, px, py + h / 2, pz, 0.22, 0.26, h, { seg: 9 });
    const sp = new THREE.ConeGeometry(0.22, 0.7, 7, 1, true);
    place(M.logEnd, sp, px, py + h + 0.3, pz, [sr(-0.3, 0.3), R() * TAU, sr(-0.3, 0.3)]);
    addCircle(px, pz, 0.28, py, py + h);
  }
  for (let i = 0; i < 3; i++) {
    const a = rot + Math.PI / 2 + sr(-0.5, 0.5), L = sr(8, 13), px = x + Math.cos(rot) * sr(-6, 6) + Math.sin(rot) * sr(-8, 8), pz = z + sr(-6, 6);
    const py = hFast(px, pz);
    const g = new THREE.CylinderGeometry(0.16, 0.24, L, 9);
    const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 2, uv.getY(k) * L / 1.2);
    place(M.barkPine, g, px, py + 0.25, pz, [Math.PI / 2, a, 0]);
    addBox(px, py + 0.25, pz, 0.5, 0.5, L, a, { walk: true });
  }
  // обломки: обшивка, кресло, ящик, карта у кабины
  for (let i = 0; i < 9; i++) {
    const px = x + sr(-8, 8), pz = z + sr(-8, 8), py = hFast(px, pz);
    box(i % 3 ? M.heli : M.armorBurnt, px, py + 0.03, pz, sr(0.4, 1.4), 0.03, sr(0.3, 1.0), { rot: R() * TAU, rx: sr(-0.2, 0.2), rz: sr(-0.3, 0.3), tile: 1 });
  }
  const nx = x + s * 8.5 + c * 1.5, nz = z + c * 8.5 - s * 1.5;
  sheet(3, nx, hFast(nx, nz), nz, rot + 0.5, { flat: true, w: 0.42, h: 0.56 });
  box(M.olive, nx - 1.2, hFast(nx - 1.2, nz) + 0.15, nz + 0.4, 0.6, 0.3, 0.35, { rot: rot + 1, tile: 1, collide: true });
  LANDMARKS.scorch.push({ x, z, r: 7 });
  WRECKS.smokes.push({ x: x + s * 0.8, y: g0 + 2.2, z: z + c * 0.8, k: 1 });
  addLamp({ kind: 'fire', x: x + s * 0.5, y: g0 + 1.6, z: z + c * 0.5, power: 5, range: 8, ground: g0 });
}

/* ---------- Брошенная позиция гаубицы ---------- */
function artillery(o, R) {
  const { x, z, rot } = o, y = terrainH(x, z), F = frame(x, z, rot), c = Math.cos(rot), s = Math.sin(rot);
  const home = Math.atan2(SPAWNS.D.z - z, SPAWNS.D.x - x);
  sandbagRing(x, z, 4.3, 3, home, 2.4, R);
  const L = (lx, ly, lz) => { const [wx, wz] = F.p(lx, lz); return V(wx, y + ly, wz); };
  // станины разведены на три стороны, колёса подняты
  for (const a of [0, 2.09, 4.19]) { const e = L(Math.sin(a) * 1.8, 0.12, -Math.cos(a) * 1.8); beam(M.armor, L(0, 0.35, 0), e, 0.11, { seg: 4 }); }
  const cr = L(0, 1.0, 0);
  box(M.armor, cr.x, cr.y, cr.z, 0.7, 0.5, 1.5, { rot, tile: 1, collide: true });
  const muzzle = L(0, 1.0 + Math.sin(0.2) * 4.9, Math.cos(0.2) * 4.9);
  beam(M.armor, V(cr.x, cr.y + 0.1, cr.z), muzzle, 0.085, { seg: 10 });
  beam(M.dark, muzzle, V(muzzle.x + s * 0.5, muzzle.y + 0.1, muzzle.z + c * 0.5), 0.15, { seg: 10 });
  for (const e of [-0.14, 0.14]) beam(M.steel, L(e, 1.28, -0.3), L(e, 1.28 + 0.3, 1.4), 0.05, { seg: 6 });
  for (const [lx, a] of [[-0.8, 0.35], [0, 0], [0.8, -0.35]]) { const q = L(lx, 1.25, 0.9); box(M.armor, q.x, q.y, q.z, 0.85, 0.95, 0.03, { rot: rot + a, rx: -0.12, tile: 1 }); }
  for (const e of [-1, 1]) { const q = L(e * 1.05, 1.0, 0.1); cyl(M.rubber ?? M.dark, q.x, q.y, q.z, 0.55, 0.55, 0.3, { seg: 16, rot: [0, rot, Math.PI / 2] }); }
  // ящики со снарядами, открытые, гильзы горой
  for (let i = 0; i < 8; i++) {
    const q = L(-2.3 + (i % 2) * 0.5, 0, -1.2 + Math.floor(i / 2) * 0.55), k = i >= 6 ? 1 : 0;
    box(M.crate, q.x, y + 0.22 + k * 0.44, q.z, 1.3, 0.42, 0.5, { rot: rot + sr(-0.1, 0.1), tile: 0.8, collide: true });
  }
  for (let i = 0; i < 2; i++) {
    const q = L(2.2, 0, -1 + i * 0.7);
    box(M.crate, q.x, y + 0.14, q.z, 1.3, 0.26, 0.5, { rot, tile: 0.8, collide: true });
    for (let k = 0; k < 2; k++) { const w = L(2.2 - 0.3 + k * 0.1, 0.3, -1 + i * 0.7 + (k - 0.5) * 0.2); beam(M.armor, w, V(w.x + s * 0.9, w.y, w.z + c * 0.9), 0.06, { seg: 8 }); }
    const lid = L(2.9, 0.02, -1 + i * 0.7);
    box(M.crate, lid.x, lid.y, lid.z, 1.3, 0.03, 0.5, { rot: rot + 0.4, tile: 0.8 });
  }
  const cp = L(0.8, 0, -2.2);
  casings(cp.x, cp.z, 26, true, R, 1.8, rot + Math.PI);
  sheet(1, L(-2.3, 0, -1.2).x, y + 0.9, L(-2.3, 0, -1.2).z, rot, { flat: true });
  // маскировочная сеть сползла с жердей
  const pole = L(-3, 2.4, 2), pole2 = L(3, 2.4, 2);
  for (const p of [pole, pole2]) { cyl(M.deadwood, p.x, y + 1.2, p.z, 0.04, 0.04, 2.4, { seg: 5 }); addCircle(p.x, p.z, 0.06, y, y + 2.4); }
  const net = new THREE.PlaneGeometry(6.4, 4, 8, 5), np = net.attributes.position;
  for (let i = 0; i < np.count; i++) { const v = np.getY(i); np.setZ(i, Math.sin(np.getX(i) * 1.3) * 0.15 + (v < 0 ? v * v * 0.1 : 0)); }
  net.computeVertexNormals();
  const nc = L(0, 1.4, 1.1);
  place(M.camo, net, nc.x, nc.y, nc.z, [-1.05, rot, 0]);
}

/* ---------- Пулемётное гнездо ---------- */
function mgNest(o, R) {
  const { x, z, home } = o, y = terrainH(x, z);
  const back = Math.atan2(home.z - z, home.x - x), fwd = back + Math.PI;
  sandbagRing(x, z, 1.75, 3, back, 1.3, R);
  const fx = Math.cos(fwd), fz = Math.sin(fwd), rot = Math.atan2(fx, fz);
  // ПКМ на сошках на бруствере
  const mx = x + fx * 1.35, mz = z + fz * 1.35, my = hFast(mx, mz) + 0.62;
  box(M.dark, mx, my + 0.08, mz, 0.1, 0.13, 0.5, { rot, tile: 1 });
  beam(M.dark, V(mx + fx * 0.25, my + 0.1, mz + fz * 0.25), V(mx + fx * 0.85, my + 0.1, mz + fz * 0.85), 0.012, { seg: 6 });
  box(M.planksDark, mx - fx * 0.38, my + 0.05, mz - fz * 0.38, 0.06, 0.14, 0.32, { rot, tile: 1 });
  for (const e of [-1, 1]) beam(M.dark, V(mx + fx * 0.55, my + 0.08, mz + fz * 0.55), V(mx + fx * 0.7 - fz * e * 0.18, my - 0.12, mz + fz * 0.7 + fx * e * 0.18), 0.008, { seg: 4, cast: false });
  box(M.olive, mx + fz * 0.14, my + 0.04, mz - fx * 0.14, 0.12, 0.1, 0.18, { rot, tile: 1 });
  // цинки и коробки, одна открыта, лента свисает
  for (let i = 0; i < 4; i++) {
    const a = back + sr(-0.9, 0.9), r = sr(0.4, 1.1), px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    box(M.olive, px, hFast(px, pz) + 0.1, pz, 0.28, 0.2, 0.16, { rot: R() * TAU, tile: 1 });
  }
  const bx = x + Math.cos(back) * 0.5, bz = z + Math.sin(back) * 0.5, by = hFast(bx, bz);
  box(M.crate, bx, by + 0.18, bz, 0.8, 0.36, 0.45, { rot: back, tile: 0.8, collide: true });
  sheet(0, bx, by + 0.37, bz, back + 0.4, { flat: true });
  place(M.stone, new THREE.DodecahedronGeometry(0.06, 0), bx + 0.05, by + 0.4, bz + 0.05, 0);
  // каска, банки, гильзы веером справа от пулемёта
  const hg = new THREE.SphereGeometry(0.14, 12, 6, 0, TAU, 0, Math.PI / 2);
  place(M.olive, hg, x - fz * 0.8, y + 0.02, z + fx * 0.8, [0.4, R() * TAU, 0.2]);
  for (let i = 0; i < 3; i++) cyl(M.steel, x + sr(-1, 1), y + 0.05, z + sr(-1, 1), 0.04, 0.04, 0.1, { seg: 8, rot: [i ? Math.PI / 2 : 0, R() * TAU, 0] });
  casings(mx + fz * 0.4, mz - fx * 0.4, 160, false, R, 1.2, Math.atan2(-fx, fz));
}

/* ---------- Техника: БМП-2 и Т-72 ---------- */
function hullGeo(profile, W) {
  const sh = new THREE.Shape();
  profile.forEach(([zz, yy], i) => (i ? sh.lineTo(zz, yy) : sh.moveTo(zz, yy)));
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: W, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 1 });
  g.rotateY(-Math.PI / 2); g.translate(W / 2, 0, 0);
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.4, uv.getY(i) * 0.4);
  g.computeVertexNormals();
  return g;
}
function tracks(W, L, wr, n, mat, x, y, z, rot, tilt, R, broken = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (lx, ly, lz) => [x + lx * c + lz * s, y + ly - tilt * lz, z - lx * s + lz * c];
  const wheel = new THREE.CylinderGeometry(wr, wr, 0.3, 14);
  for (const side of [-1, 1]) {
    const lx = side * (W / 2 - 0.25);
    for (let i = 0; i < n; i++) {
      const lz = -L / 2 + 0.8 + i * (L - 1.6) / (n - 1), [px, py, pz] = P(lx, wr, lz);
      place(M.rust, wheel, px, py, pz, [0, rot, Math.PI / 2]);
    }
    if (side === broken) continue;
    // гусеница: нижняя ветвь, верхняя, огибание звёздочки и ленивца
    const [bx, by, bz] = P(lx, 0.06, 0);
    box(M.dark, bx, by, bz, 0.5, 0.08, L - 0.5, { rot, rx: tilt, tile: 1 });
    const [tx, ty, tz] = P(lx, wr * 2 + 0.05, 0);
    box(M.dark, tx, ty, tz, 0.5, 0.06, L - 1.2, { rot, rx: tilt, tile: 1 });
    for (const e of [-1, 1]) { const [ex, ey, ez] = P(lx, wr + 0.06, e * (L / 2 - 0.35)); cyl(M.dark, ex, ey, ez, wr + 0.08, wr + 0.08, 0.5, { seg: 12, rot: [0, rot, Math.PI / 2] }); }
  }
  if (broken) {
    // соскочившая гусеница лежит лентой рядом
    const [bx, , bz] = P(broken * (W / 2 + 0.9), 0, -1.5);
    box(M.dark, bx, hFast(bx, bz) + 0.05, bz, 0.5, 0.07, L + 1.5, { rot: rot + 0.12, tile: 1 });
  }
}
function bmp(o, R) {
  const { x, z, rot } = o, g = terrainH(x, z), tilt = 0.05, W = 3.05, y = g - 0.05, c = Math.cos(rot), s = Math.sin(rot);
  const hull = hullGeo([[-3.3, 0.45], [-3.3, 1.62], [0.9, 1.72], [3.35, 0.95], [3.2, 0.45]], W);
  place(M.armorBurnt, hull, x, y, z, [tilt, rot, 0.02]);
  // рёбра на верхнем лобовом, выхлоп, фары
  for (let k = 0; k < 4; k++) { const lz = 1.5 + k * 0.4, ly = 1.72 - (lz - 0.9) * 0.31; box(M.armorBurnt, x + s * lz, y + ly + 0.02 - tilt * lz, z + c * lz, W - 0.4, 0.04, 0.06, { rot, rx: tilt + 0.3, tile: 1 }); }
  tracks(W, 6.6, 0.34, 6, M.rust, x, y, z, rot, tilt, R, 1);
  // башня развёрнута, пушка опущена, крышки люков открыты
  const tr = rot + 0.9, tx = x + s * 0.2, tz = z + c * 0.2, ty = y + 1.74 - tilt * 0.2;
  cyl(M.armorBurnt, tx, ty + 0.25, tz, 0.95, 0.75, 0.5, { seg: 16 });
  const gx = tx + Math.sin(tr) * 0.8, gz = tz + Math.cos(tr) * 0.8;
  beam(M.dark, V(gx, ty + 0.35, gz), V(gx + Math.sin(tr) * 2.6, ty + 0.12, gz + Math.cos(tr) * 2.6), 0.045, { seg: 8 });
  beam(M.armorBurnt, V(tx - Math.cos(tr) * 0.6, ty + 0.62, tz + Math.sin(tr) * 0.6), V(tx - Math.cos(tr) * 0.6 + Math.sin(tr) * 1.1, ty + 0.62, tz + Math.sin(tr) * 0.6 + Math.cos(tr) * 1.1), 0.08, { seg: 8 });
  for (const e of [-0.35, 0.35]) cyl(M.armorBurnt, tx + Math.cos(tr) * e, ty + 0.62, tz - Math.sin(tr) * e, 0.3, 0.3, 0.04, { seg: 12, rot: [1.2, tr, 0] });
  place(M.dark, new THREE.CircleGeometry(0.3, 12), tx, ty + 0.51, tz, [-Math.PI / 2, 0, 0]);
  // кормовые двери-баки распахнуты, внутри темно
  for (const e of [-1, 1]) {
    const hx = x - s * 3.32 + c * e * 0.75, hz = z - c * 3.32 - s * e * 0.75, a = rot + e * 1.2;
    box(M.armorBurnt, hx - Math.cos(a) * e * 0.35, y + 1.0 + tilt * 3.3, hz + Math.sin(a) * e * 0.35, 0.7, 0.95, 0.12, { rot: a, tile: 1 });
  }
  box(M.dark, x - s * 3.3, y + 1.0 + tilt * 3.3, z - c * 3.3, W - 0.8, 0.95, 0.04, { rot, tile: 1 });
  addBox(x, g + 0.9, z, W, 1.8, 6.7, rot, { walk: true }).car = 'bmp';
  addCircle(tx, tz, 0.9, ty, ty + 0.7);
  WRECKS.smokes.push({ x: tx, y: ty + 0.6, z: tz, k: 0.4 });
}
function tank(o, R) {
  const { x, z, rot } = o, g = terrainH(x, z), tilt = -0.04, W = 3.5, y = g - 0.05, c = Math.cos(rot), s = Math.sin(rot);
  const hull = hullGeo([[-3.45, 0.45], [-3.45, 1.32], [2.2, 1.38], [3.45, 0.82], [3.3, 0.45]], W);
  place(M.armorBurnt, hull, x, y, z, [tilt, rot, -0.03]);
  tracks(W, 6.9, 0.39, 6, M.rust, x, y, z, rot, tilt, R, 0);
  // сорванные резиновые экраны, бочки на корме, пустой погон башни
  for (const e of [-1, 1]) for (let k = 0; k < 4; k++) if (R() < 0.5) { const lz = -2.4 + k * 1.6, px = x + c * e * (W / 2 + 0.03) + s * lz, pz = z - s * e * (W / 2 + 0.03) + c * lz; box(M.dark, px, y + 1.0 - tilt * lz, pz, 0.03, 0.55, 1.5, { rot, rz: e * 0.1, tile: 1 }); }
  for (const e of [-0.7, 0.7]) cyl(M.barrel?.[2] ?? M.rust, x - s * 3.7 + c * e, y + 1.2 + tilt * 3.7, z - c * 3.7 - s * e, 0.28, 0.28, 0.85, { seg: 12, rot: [0, rot, Math.PI / 2] });
  place(M.dark, new THREE.CircleGeometry(1.05, 20), x + s * 0.4, y + 1.40 - tilt * 0.4, z + c * 0.4, [-Math.PI / 2, 0, 0]);
  cyl(M.armorBurnt, x + s * 0.4, y + 1.42 - tilt * 0.4, z + c * 0.4, 1.12, 1.12, 0.06, { seg: 20, open: true });
  // башня отброшена взрывом боекомплекта: лежит вверх дном, ствол погнут
  const ta = rot + 2.2, tx = x + Math.sin(ta) * 6.8, tz = z + Math.cos(ta) * 6.8, ty = hFast(tx, tz);
  const dome = new THREE.SphereGeometry(1, 20, 10, 0, TAU, 0, Math.PI / 2);
  dome.scale(1.15, 0.5, 1.3);
  place(M.armorBurnt, dome, tx, ty + 0.5, tz, [Math.PI + 0.2, ta, 0.15]);
  place(M.dark, new THREE.CircleGeometry(1.0, 20), tx, ty + 0.52, tz, [-Math.PI / 2 + 0.2, ta, 0.15]);
  const b0 = V(tx + Math.sin(ta + 0.4) * 1.1, ty + 0.35, tz + Math.cos(ta + 0.4) * 1.1), b1 = b0.clone().add(V(Math.sin(ta + 0.5) * 2.8, -0.1, Math.cos(ta + 0.5) * 2.8)), b2 = b1.clone().add(V(Math.sin(ta + 0.85) * 2.4, -0.25, Math.cos(ta + 0.85) * 2.4));
  beam(M.armorBurnt, b0, b1, 0.1, { seg: 10 }); beam(M.armorBurnt, b1, b2, 0.085, { seg: 10 });
  for (const t of [0.3, 0.6]) cyl(M.dark, lerp(b0.x, b1.x, t), lerp(b0.y, b1.y, t), lerp(b0.z, b1.z, t), 0.13, 0.13, 0.25, { seg: 10, rot: [Math.PI / 2, Math.atan2(b1.x - b0.x, b1.z - b0.z), 0] });
  addBox(x, g + 0.7, z, W, 1.4, 6.9, rot, { walk: true }).car = 'tank';
  addBox(tx, ty + 0.5, tz, 2.3, 1.0, 2.6, ta, { walk: true }).car = 'turret';
  addBox((b0.x + b2.x) / 2, (b0.y + b2.y) / 2, (b0.z + b2.z) / 2, 0.25, 0.25, b0.distanceTo(b2), Math.atan2(b2.x - b0.x, b2.z - b0.z), { walk: false });
}

export function buildWrecks() {
  const R = rng(6161);
  helicopter(WRECKS.heli, R);
  artillery(WRECKS.art, R);
  for (const m of WRECKS.mg) mgNest(m, R);
  bmp(WRECKS.bmp, R);
  tank(WRECKS.tank, R);
}
/** Тление: тонкие струйки дыма над обломками, ночью в глубине тлеет. */
export function updateWrecks(dt) {
  const cp = camera.position;
  for (const s of WRECKS.smokes) {
    if ((s.x - cp.x) ** 2 + (s.z - cp.z) ** 2 > 150 * 150) continue;
    if (Math.random() < dt * 2.2 * s.k) FX.alpha.spawn({ x: s.x + sr(-0.4, 0.4), y: s.y, z: s.z + sr(-0.4, 0.4), vx: 0, vy: sr(0.5, 1.0), vz: 0, size: sr(0.4, 0.8), grow: 0.8, life: sr(5, 9), col: [0.26, 0.25, 0.24], a: 0.22, fadeIn: 0.8, windK: 1.6, drag: 0.3, glow: 0.05 });
  }
}
