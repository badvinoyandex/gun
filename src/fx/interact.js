import * as THREE from 'three';
import { scene, camera, FRAME } from '../core/env.js';
import { sr, clamp, TAU } from '../core/math.js';
import { hFast } from '../world/heightcache.js';
import { M } from '../gen/materials.js';
import { place, attachMesh, curPanel } from '../world/builders.js';
import { addBox } from '../core/colliders.js';
import { addStaticCollider, removeStaticCollider } from '../core/physics.js';
import { LAMPS } from '../world/lamps.js';
import { FX } from './particles.js';
import { glassSound, creakSound, wireSnap, sparkSound, hissSound } from './audio.js';
import { breakPanel, setPanelGoneHandler } from './structures.js';

/* ============================================================================
   ВЗАИМОДЕЙСТВИЕ С КАРТОЙ
   • Двери на петлях: E — открыть/закрыть (скрип, хлопок). Закрытая дверь — стена
     для пули и для прохода, выбитая взрывом улетает как обычно.
   • Колючая проволока: держать E у нити — перекусить (1.3 с). Взрыв рвёт сам.
   • Фонари и прожекторы бьются пулей. Генератор базы — если его подорвать или
     расстрелять, прожекторы и фонари базы гаснут.
   • Пулевые пробоины остаются на стенах, машинах, деревьях; пропадают вместе с
     разрушенной деталью. Пробитый бак водокачки течёт струями.
============================================================================ */
export const INTER = { hint: '', press: false, cut: 0, target: null };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* ---------- Двери ---------- */
export const DOORS = [];
/** Дверь на петле: hinge — ось петли, closed — угол закрытой двери (полотно
    уходит от петли вдоль своей оси x), openBy — угол распахнутой (со знаком). */
export function addDoor({ hx, hz, y, closed, openBy, w = 0.9, h = 2.0, t = 0.05, mat = M.planksDark, startOpen = true }) {
  const g = new THREE.BoxGeometry(w, h, t);
  g.translate(w / 2, h / 2, 0);
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i) * h / 1.2, uv.getX(i) * w / 1.2);
  const pivot = new THREE.Group();
  pivot.position.set(hx, y, hz);
  const mesh = new THREE.Mesh(g, mat); mesh.castShadow = mesh.receiveShadow = true;
  pivot.add(mesh); scene.add(pivot);
  const cur = startOpen ? openBy : 0;
  pivot.rotation.y = closed + cur;
  const col = a => { const c = Math.cos(a), s = Math.sin(a); return addBox(hx + c * w / 2, y + h / 2, hz - s * w / 2, w, h, 0.08, a, { walk: false }); };
  const cClosed = col(closed), cOpen = col(closed + openBy);
  (startOpen ? cClosed : cOpen).dead = true;
  const d = { pivot, mesh, closed, openBy, cur, target: cur, w, h, hx, hz, y, cClosed, cOpen, panel: curPanel() };
  pivot.updateMatrixWorld(true);
  attachMesh(mesh);
  DOORS.push(d);
  return d;
}
function doorCenter(d, out) { const a = d.closed + d.cur; return out.set(d.hx + Math.cos(a) * d.w / 2, d.y + 1, d.hz - Math.sin(a) * d.w / 2); }
function toggleDoor(d) {
  const opening = d.target === 0;
  d.target = opening ? d.openBy : 0;
  // проход освобождается сразу, закрытая дверь встаёт стеной по окончании хода
  const off = opening ? d.cClosed : d.cOpen;
  if (!off.dead) { off.dead = true; removeStaticCollider(off); }
  d.moving = true;
  creakSound(camera.position.distanceTo(doorCenter(d, _v)), opening);
}

/* ---------- Колючая проволока ---------- */
export const WIRES = [];
export function addWire(panel, a, b) { WIRES.push({ panel, a: a.clone(), b: b.clone() }); }
function cutWire(w) {
  breakPanel(w.panel, w.a.clone().lerp(w.b, 0.5), 0.2);
  wireSnap(camera.position.distanceTo(w.a));
  // обрывки провисают от кольев
  for (const [p, q] of [[w.a, w.b], [w.b, w.a]]) {
    const dir = q.clone().sub(p).setY(0).normalize();
    const pts = [p.clone(), p.clone().addScaledVector(dir, 0.35).add(V(0, -0.25, 0)), p.clone().addScaledVector(dir, 0.55).add(V(0, -0.55, 0))];
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 6, 0.006, 3), M.wire);
    scene.add(tube);
  }
  for (let i = 0; i < 4; i++) FX.add.spawn({ x: w.a.x, y: w.a.y, z: w.a.z, vx: sr(-1, 1), vy: sr(0.5, 2), vz: sr(-1, 1), size: 0.02, life: 0.25, col: [2, 1.8, 1.4], a: 1, grav: 9.8, must: true });
}

/* ---------- Генераторы баз ---------- */
export const GENS = [];
export function addGenerator(o) { const g = { ...o, alive: true, fire: 0 }; GENS.push(g); if (o.panel) o.panel.onKill = () => powerOut(g); return g; }
function powerOut(g) {
  if (!g.alive) return;
  g.alive = false; g.fire = 45;
  sparkSound(camera.position.distanceTo(V(g.x, g.y, g.z)), 1.5);
  const lamps = LAMPS.filter(L => L.on && L.kind !== 'fire' && L.kind !== 'window' && Math.hypot(L.pos.x - g.cx, L.pos.z - g.cz) < g.r);
  // лампы мигают и гаснут вразнобой, у прожекторов — сноп искр
  lamps.forEach((L, i) => {
    L.flick = 1;
    setTimeout(() => {
      L.on = false;
      for (let k = 0; k < 8; k++) FX.add.spawn({ x: L.pos.x, y: L.pos.y, z: L.pos.z, vx: sr(-1.5, 1.5), vy: sr(-0.5, 2), vz: sr(-1.5, 1.5), size: 0.03, life: sr(0.4, 1.1), col: [2.4, 2.0, 1.2], a: 1, grav: 9.8, must: true });
    }, 250 + i * 180 + Math.random() * 300);
  });
  g.dark = lamps;
}

/* ---------- Фонари под пулей ---------- */
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
/** Луч от o по dir до maxD: задел лампу — лампа разбита. Возвращает true, если попал. */
export function shootLamps(o, dir, maxD) {
  let best = null, bt = maxD;
  for (const L of LAMPS) {
    if (L.broken || !L.breakable || L.kind === 'window' || L.kind === 'fire') continue;
    const r = L.kind === 'flood' ? 0.3 : L.kind === 'post' ? 0.24 : 0.16;
    _v.subVectors(L.pos, o);
    const t = _v.dot(dir);
    if (t < 0.3 || t > bt) continue;
    if (_v.addScaledVector(dir, -t).lengthSq() < r * r) { best = L; bt = t; }
  }
  if (!best) return false;
  const L = best;
  L.broken = true; L.on = false;
  if (L.lens) { L.lens.emissiveIntensity = 0; L.lens.color.setHex(0x2a2b2a); }
  glassSound(camera.position.distanceTo(L.pos));
  for (let k = 0; k < 10; k++) FX.dirt.spawn({ x: L.pos.x, y: L.pos.y, z: L.pos.z, vx: dir.x * 2 + sr(-1.5, 1.5), vy: sr(-0.5, 1.5), vz: dir.z * 2 + sr(-1.5, 1.5), size: sr(0.015, 0.04), life: 1.5, col: [0.75, 0.8, 0.82], a: 0.9, grav: 9.8, floor: hFast(L.pos.x, L.pos.z), must: true });
  if (L.level > 0.05) for (let k = 0; k < 10; k++) FX.add.spawn({ x: L.pos.x, y: L.pos.y, z: L.pos.z, vx: sr(-2, 2), vy: sr(-1, 2), vz: sr(-2, 2), size: 0.03, life: sr(0.3, 0.9), col: [2.4, 2.0, 1.3], a: 1, grav: 9.8, must: true });
  return true;
}

/* ---------- Пулевые пробоины ---------- */
const HOLES = { ims: [], owner: [], n: [], cap: 260 };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
function holeGeo(cell, size) {
  const g = new THREE.PlaneGeometry(size, size), uv = g.attributes.uv, u0 = (cell % 2) * 0.5, v0 = 0.5 - (cell >> 1) * 0.5;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) * 0.5);
  return g;
}
export function buildInteract() {
  for (let c = 0; c < 4; c++) {
    const im = new THREE.InstancedMesh(holeGeo(c, 0.13), M.holes, HOLES.cap);
    for (let i = 0; i < HOLES.cap; i++) im.setMatrixAt(i, ZERO);
    im.frustumCulled = false; im.renderOrder = 4; im.count = 0; scene.add(im);
    HOLES.ims.push(im); HOLES.owner.push(new Array(HOLES.cap).fill(null)); HOLES.n.push(0);
  }
  setPanelGoneHandler(p => {
    for (let c = 0; c < 4; c++) { const own = HOLES.owner[c]; let any = false; for (let i = 0; i < own.length; i++) if (own[i] === p) { own[i] = null; HOLES.ims[c].setMatrixAt(i, ZERO); any = true; } if (any) HOLES.ims[c].instanceMatrix.needsUpdate = true; }
    // сорванная дверь — больше не дверь
    for (const d of DOORS) if (d.panel === p) d.gone = true;
  });
}
/** kind: 0 — дерево, 1 — металл, 2 — камень/бетон, 3 — по касательной. */
export function addHole(p, n, kind, owner = null) {
  if (!HOLES.ims.length) return;
  const im = HOLES.ims[kind], i = HOLES.n[kind]++ % HOLES.cap;
  _q.setFromUnitVectors(_z, n);
  _q.multiply(new THREE.Quaternion().setFromAxisAngle(_z, Math.random() * TAU));
  _s.setScalar(sr(0.7, 1.25));
  im.setMatrixAt(i, _m.compose(_v.copy(p).addScaledVector(n, 0.006), _q, _s));
  im.count = Math.max(im.count, i + 1);
  im.instanceMatrix.needsUpdate = true;
  HOLES.owner[kind][i] = owner;
}
/** Очередь по стене при сборке: кучка пробоин в общей геометрии (исчезнет со стеной). */
export function holeCluster(x, y, z, rot, n, spread, kind, R) {
  const g = holeGeo(kind, 0.12);
  for (let i = 0; i < n; i++) {
    const a = R() * TAU, r = Math.sqrt(R()) * spread;
    place(M.holes, g, x + Math.cos(rot) * Math.cos(a) * r, y + Math.sin(a) * r * 0.7, z - Math.sin(rot) * Math.cos(a) * r, [0, rot, R() * TAU], R.range(0.7, 1.3));
  }
}

/* ---------- Течь из бака ---------- */
const LEAKS = [];
export function addLeak(p, n, tank) {
  if (LEAKS.length > 10) LEAKS.shift();
  LEAKS.push({ p: p.clone(), n: n.clone().setY(0).normalize(), age: 0, life: sr(25, 40), tank });
  hissSound(camera.position.distanceTo(p));
  addHole(p, n, 1, null);
}

/* ---------- Кадр ---------- */
export function updateInteract(dt, pl, keys, sky) {
  INTER.hint = '';
  const walk = pl.mode === 'walk' && pl.dead <= 0 && !pl.ladder;
  const eye = camera.position;
  camera.getWorldDirection(_w);
  // ближайшая цель перед игроком
  let door = null, dd = 2.1, wire = null, wd = 1.3;
  if (walk) {
    for (const d of DOORS) {
      if (d.gone || d.panel?.dead) continue;
      doorCenter(d, _v);
      const dist = Math.hypot(_v.x - eye.x, _v.z - eye.z);
      if (dist > dd) continue;
      const fx = (_v.x - eye.x) / dist, fz = (_v.z - eye.z) / dist;
      if (fx * _w.x + fz * _w.z < 0.35) continue;
      dd = dist; door = d;
    }
    for (const w of WIRES) {
      if (w.panel.dead) continue;
      const vx = w.b.x - w.a.x, vz = w.b.z - w.a.z, L2 = vx * vx + vz * vz;
      const t = clamp(((pl.pos.x - w.a.x) * vx + (pl.pos.z - w.a.z) * vz) / L2, 0, 1);
      const d = Math.hypot(pl.pos.x - w.a.x - vx * t, pl.pos.z - w.a.z - vz * t);
      if (d < wd) { wd = d; wire = w; }
    }
  }
  if (door) {
    INTER.hint = door.target === 0 ? 'E — открыть дверь' : 'E — закрыть дверь';
    if (INTER.press) toggleDoor(door);
  } else if (wire) {
    if (keys.KeyE) {
      INTER.cut += dt;
      INTER.hint = 'перекусываю проволоку… ' + Math.round(Math.min(1, INTER.cut / 1.3) * 100) + '%';
      if (INTER.cut >= 1.3) { cutWire(wire); INTER.cut = 0; }
    } else { INTER.cut = 0; INTER.hint = 'E (держать) — перекусить проволоку'; }
  } else INTER.cut = 0;
  INTER.press = false;
  // ход дверей
  for (const d of DOORS) {
    if (!d.moving) continue;
    if (d.gone || d.panel?.dead) { d.moving = false; continue; }
    const step = 2.6 * dt, diff = d.target - d.cur;
    d.cur += Math.abs(diff) < step ? diff : Math.sign(diff) * step;
    d.pivot.rotation.y = d.closed + d.cur;
    if (d.cur === d.target) {
      d.moving = false;
      const on = d.target === 0 ? d.cClosed : d.cOpen;
      if (on.dead) { on.dead = false; addStaticCollider(on); }
      if (d.target === 0) creakSound(eye.distanceTo(doorCenter(d, _v)), false);
    }
  }
  // генераторы: выхлоп ночью, после подрыва — огонь и дым
  for (const g of GENS) {
    if (g.alive) {
      if (sky.lampOn > 0.1 && Math.random() < dt * 3) FX.alpha.spawn({ x: g.ex, y: g.ey, z: g.ez, vx: sr(-0.1, 0.1), vy: sr(0.5, 0.9), vz: sr(-0.1, 0.1), size: 0.18, grow: 0.5, life: sr(2, 3.5), col: [0.3, 0.3, 0.3], a: 0.25, windK: 1, drag: 0.4 });
    } else if (g.fire > 0) {
      g.fire -= dt;
      const k = Math.min(1, g.fire / 10);
      if (Math.random() < k) FX.add.spawn({ flame: true, x: g.x + sr(-0.4, 0.4), y: g.y + 0.5, z: g.z + sr(-0.3, 0.3), vx: 0, vy: sr(0.8, 1.6), vz: 0, size: sr(0.3, 0.6) * k, grow: -0.3, life: sr(0.4, 0.8), col: [1.8, 0.8, 0.3], a: 0.9, cool: 0.4, windK: 0.6 });
      if (Math.random() < dt * 4) FX.alpha.spawn({ x: g.x, y: g.y + 1, z: g.z, vx: 0, vy: sr(0.8, 1.4), vz: 0, size: sr(0.6, 1.1), grow: 1.1, life: sr(4, 7), col: [0.08, 0.08, 0.08], a: 0.45, fadeIn: 0.4, windK: 1.8, drag: 0.3, glow: 0.2 * k });
      if (Math.random() < dt * 1.5) FX.add.spawn({ x: g.x, y: g.y + 0.6, z: g.z, vx: sr(-2, 2), vy: sr(1, 3), vz: sr(-2, 2), size: 0.03, life: sr(0.3, 0.8), col: [2.4, 2, 1.3], a: 1, grav: 9.8 });
    }
  }
  // течи: струя бьёт вбок и падает, со временем слабеет
  for (let i = LEAKS.length - 1; i >= 0; i--) {
    const L = LEAKS[i];
    L.age += dt;
    if (L.age > L.life) { LEAKS.splice(i, 1); continue; }
    const k = 1 - L.age / L.life, pr = 2.2 * k + 0.4;
    if (eye.distanceToSquared(L.p) > 120 * 120) continue;
    for (let j = 0; j < 2; j++) FX.alpha.spawn({ x: L.p.x, y: L.p.y, z: L.p.z, vx: L.n.x * pr + sr(-0.15, 0.15), vy: sr(-0.2, 0.3), vz: L.n.z * pr + sr(-0.15, 0.15), size: sr(0.05, 0.1), grow: 0.25, life: 1.8, col: [0.62, 0.7, 0.76], a: 0.55, grav: 9.8, floor: hFast(L.p.x, L.p.z) + 0.02, drag: 0.1, must: j === 0 });
  }
}
