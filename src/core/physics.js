import * as THREE from 'three';
import { COLLIDERS } from './colliders.js';
import { Q, FRAME, PERF } from './env.js';
import { MAP, lakeRho } from '../world/layout.js';
import { WIND } from '../world/wind.js';

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ============================================================================
   ФИЗИКА (ammo.js — Bullet, собранный в WebAssembly)

   Статический мир: рельеф как карта высот (тот же кэш, что у игрока и травы),
   все коллайдеры карты — стволы, стены, обшивка окопов, машины, срубы.
   Динамика: обломки, ветки, осколки стекла, падающие деревья, бочки. Тела
   засыпают, по истечении жизни уходят в землю и возвращаются в пул.
   Лучи (выстрелы, осколки) — rayTest по тому же миру.

   Если ammo.js не загрузился (нет файла/WebAssembly), карта работает:
   обломки получают упрощённую физику, лучи — только рельеф.
============================================================================ */
export const PHYS = { A: null, world: null, ready: false, bodies: [], hf: null, statics: new Map(), player: null, steps: 0 };
let A = null, T0 = null, V0 = null, V1 = null, Q0 = null;

export async function initPhysics() {
  if (typeof window.Ammo !== 'function') { console.warn('[phys] ammo.js не найден — упрощённая физика'); return false; }
  try {
    const opt = {};
    if (window.AMMO_WASM_B64) {
      // однофайловая сборка: wasm встроен в HTML, fetch не нужен (работает и с file://)
      const bin = atob(window.AMMO_WASM_B64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      opt.wasmBinary = u;
    } else opt.locateFile = f => new URL('lib/ammo/' + f, document.baseURI).href;
    A = await window.Ammo(opt);
  } catch (e) { console.warn('[phys] ammo.js не инициализировался', e); return false; }
  PHYS.A = A;
  const cfg = new A.btDefaultCollisionConfiguration();
  const disp = new A.btCollisionDispatcher(cfg);
  const bp = new A.btDbvtBroadphase();
  const sol = new A.btSequentialImpulseConstraintSolver();
  PHYS.world = new A.btDiscreteDynamicsWorld(disp, bp, sol, cfg);
  PHYS.world.setGravity(new A.btVector3(0, -9.81, 0));
  T0 = new A.btTransform(); V0 = new A.btVector3(); V1 = new A.btVector3(); Q0 = new A.btQuaternion(0, 0, 0, 1);
  PHYS.ready = true;
  return true;
}

/* ---------- Статический мир ---------- */
const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const ZERO = () => (V1.setValue(0, 0, 0), V1);
function staticObject(shape, x, y, z, rotY, idx) {
  T0.setIdentity(); V0.setValue(x, y, z); T0.setOrigin(V0);
  if (rotY) { _q.setFromAxisAngle(_up, rotY); Q0.setValue(_q.x, _q.y, _q.z, _q.w); T0.setRotation(Q0); }
  // в этой сборке у btCollisionObject нет конструктора — статика как тело нулевой массы
  const ms = new A.btDefaultMotionState(T0);
  const info = new A.btRigidBodyConstructionInfo(0, ms, shape, ZERO());
  const o = new A.btRigidBody(info);
  A.destroy(info);
  o.setFriction(0.9); o.setRestitution(0.1);
  o.setUserIndex(idx);
  PHYS.world.addRigidBody(o, 2, -1);
  return o;
}
/** Карта высот: данные живут в куче ammo; воронки меняют их на месте. */
export function buildStaticWorld(H, HN, HS, R) {
  if (!PHYS.ready) return;
  let lo = 1e9, hi = -1e9;
  for (let i = 0; i < H.length; i++) { const h = H[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
  lo -= 8; hi += 8;                                   // запас под будущие воронки
  const ptr = A._malloc(H.length * 4);
  new Float32Array(A.HEAPF32.buffer, ptr, H.length).set(H);
  const shape = new A.btHeightfieldTerrainShape(HN, HN, ptr, 1, lo, hi, 1, 'PHY_FLOAT', false);
  V0.setValue(HS, 1, HS); shape.setLocalScaling(V0); shape.setMargin(0.02);
  // Bullet центрирует карту высот по (lo+hi)/2
  PHYS.hf = { ptr, n: HN, obj: staticObject(shape, -R + (HN - 1) * HS / 2, (lo + hi) / 2, -R + (HN - 1) * HS / 2, 0, -1) };
  let n = 0;
  for (let i = 0; i < COLLIDERS.length; i++) if (!COLLIDERS[i].dyn) addStaticCollider(COLLIDERS[i], i), n++;
  console.info(`[phys] статических тел: ${n}`);
}
export function addStaticCollider(c, idx = COLLIDERS.indexOf(c)) {
  if (!PHYS.ready || c.dead) return;
  const h = Math.max(0.05, (c.y1 - c.y0) / 2), y = (c.y0 + c.y1) / 2;
  let shape;
  if (c.t === 0) { V0.setValue(c.r, h, c.r); shape = new A.btCylinderShape(V0); }
  else { V0.setValue(c.hw, h, c.hd); shape = new A.btBoxShape(V0); }
  shape.setMargin(0.02);
  const o = staticObject(shape, c.x, y, c.z, c.t === 1 ? Math.atan2(c.s, c.c) : 0, idx);
  PHYS.statics.set(c, o);
}
export function removeStaticCollider(c) {
  const o = PHYS.statics.get(c);
  if (!o) return;
  PHYS.world.removeRigidBody(o);
  PHYS.statics.delete(c);
}
/** Обновить участок карты высот после воронки (i0..i1, j0..j1 в узлах кэша). */
export function syncHeights(H, i0, j0, i1, j1) {
  if (!PHYS.hf) return;
  const heap = A.HEAPF32, base = PHYS.hf.ptr >> 2, n = PHYS.hf.n;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) heap[base + j * n + i] = H[j * n + i];
  // тела, лежащие на участке, должны проснуться и упасть в воронку
  for (const b of PHYS.bodies) if (b.body) b.body.activate();
}

/* ---------- Динамические тела ---------- */
const MAX = () => Math.round(Q.bodies * (1 - PERF.load * 0.5));
/**
 * o: { shape: 'box'|'sphere'|'cyl'|'capsule'|btShape, size:[..], mass, pos, quat, vel, ang,
 *      mesh | sync(pos, quat, k), life, friction, restitution, damp:[lin,ang], keep, onDone, ccd }
 */
export function addBody(o) {
  if (!PHYS.ready) return null;
  while (PHYS.bodies.length >= MAX()) {
    const i = PHYS.bodies.findIndex(b => !b.keep);
    if (i < 0) break;
    killBody(PHYS.bodies[i]);
  }
  let shape = o.shape;
  const s = o.size || [0.1, 0.1, 0.1];
  if (shape === 'box') { V0.setValue(s[0] / 2, s[1] / 2, s[2] / 2); shape = new A.btBoxShape(V0); }
  else if (shape === 'sphere') shape = new A.btSphereShape(s[0]);
  else if (shape === 'cyl') { V0.setValue(s[0], s[1] / 2, s[0]); shape = new A.btCylinderShape(V0); }
  else if (shape === 'capsule') shape = new A.btCapsuleShape(s[0], s[1]);
  else if (shape === 'compound') {
    // составное тело (дерево: ствол + крона); части задаются относительно центра масс
    const c = new A.btCompoundShape();
    for (const part of o.parts) {
      let ps;
      if (part.type === 'cyl') { V0.setValue(part.size[0], part.size[1] / 2, part.size[0]); ps = new A.btCylinderShape(V0); }
      else { V0.setValue(part.size[0] / 2, part.size[1] / 2, part.size[2] / 2); ps = new A.btBoxShape(V0); }
      ps.setMargin(0.02);
      T0.setIdentity(); V0.setValue(part.pos[0], part.pos[1], part.pos[2]); T0.setOrigin(V0);
      c.addChildShape(T0, ps);
    }
    shape = c;
  }
  shape.setMargin(o.margin ?? 0.01);
  const inertia = new A.btVector3(0, 0, 0);
  if (o.mass > 0) shape.calculateLocalInertia(o.mass, inertia);
  const tr = new A.btTransform(); tr.setIdentity();
  V0.setValue(o.pos.x, o.pos.y, o.pos.z); tr.setOrigin(V0);
  if (o.quat) { Q0.setValue(o.quat.x, o.quat.y, o.quat.z, o.quat.w); tr.setRotation(Q0); }
  const ms = new A.btDefaultMotionState(tr);
  const info = new A.btRigidBodyConstructionInfo(o.mass, ms, shape, inertia);
  const body = new A.btRigidBody(info);
  A.destroy(info); A.destroy(inertia); A.destroy(tr);
  body.setFriction(o.friction ?? 0.8);
  body.setRestitution(o.restitution ?? 0.2);
  body.setDamping(o.damp?.[0] ?? 0.05, o.damp?.[1] ?? 0.2);
  if (o.rolling) body.setRollingFriction(o.rolling);
  if (o.vel) { V0.setValue(o.vel.x, o.vel.y, o.vel.z); body.setLinearVelocity(V0); }
  if (o.ang) { V0.setValue(o.ang.x, o.ang.y, o.ang.z); body.setAngularVelocity(V0); }
  if (o.ccd) { body.setCcdMotionThreshold(o.ccd); body.setCcdSweptSphereRadius(o.ccd * 0.5); }
  body.setSleepingThresholds(0.25, 0.3);
  PHYS.world.addRigidBody(body, 1, -1);
  const b = {
    body, shape, ms, mesh: o.mesh || null, sync: o.sync || null, life: o.life ?? 8, age: 0, keep: !!o.keep, onDone: o.onDone || null,
    pos: new THREE.Vector3().copy(o.pos), quat: new THREE.Quaternion().copy(o.quat || _q.identity()), fade: 1, data: o.data || null, mass: o.mass,
    float: o.float ?? 0, rad: o.rad ?? Math.max(0.05, (o.size?.[1] ?? 0.2) / 2), wet: false, synced: false
  };
  PHYS.bodies.push(b);
  return b;
}
export function killBody(b) {
  const i = PHYS.bodies.indexOf(b);
  if (i >= 0) PHYS.bodies.splice(i, 1);
  if (b.body) { PHYS.world.removeRigidBody(b.body); A.destroy(b.body); A.destroy(b.ms); if (typeof b.shape !== 'string') A.destroy(b.shape); b.body = null; }
  if (b.onDone) b.onDone(b);
}
/** Тело успокоилось — превращаем в статику: остаётся препятствием, но не считается. */
export function freezeBody(b) {
  if (!b?.body) return;
  const i = PHYS.bodies.indexOf(b);
  if (i >= 0) PHYS.bodies.splice(i, 1);
  V0.setValue(0, 0, 0); V1.setValue(0, 0, 0);
  b.body.setLinearVelocity(V0); b.body.setAngularVelocity(V1);
  b.body.setMassProps(0, V0);
  b.body.setCollisionFlags(b.body.getCollisionFlags() | 1);   // CF_STATIC_OBJECT
  b.body.setActivationState(2);
  b.frozen = true;
}
export const isSleeping = b => b?.body && !b.body.isActive();
export function impulse(b, x, y, z, rx = 0, ry = 0, rz = 0) {
  if (!b?.body) return;
  b.body.activate();
  V0.setValue(x, y, z);
  if (rx || ry || rz) { V1.setValue(rx, ry, rz); b.body.applyImpulse(V0, V1); }
  else b.body.applyCentralImpulse(V0);
}
export function setVelocity(b, v, w) {
  if (!b?.body) return;
  V0.setValue(v.x, v.y, v.z); b.body.setLinearVelocity(V0);
  if (w) { V0.setValue(w.x, w.y, w.z); b.body.setAngularVelocity(V0); }
  b.body.activate();
}
/** Ударная волна: импульс всем телам в радиусе, спадает квадратично. */
export function blastImpulse(x, y, z, radius, power) {
  for (const b of PHYS.bodies) {
    if (!b.body) continue;
    const dx = b.pos.x - x, dy = b.pos.y - y + 0.3, dz = b.pos.z - z, d = Math.hypot(dx, dy, dz);
    if (d > radius) continue;
    const f = power * Math.pow(1 - d / radius, 2) * Math.min(b.mass, 40), k = f / (d + 0.3);
    impulse(b, dx * k, dy * k + f * 0.5, dz * k, (Math.random() - 0.5) * 0.2, 0.05, (Math.random() - 0.5) * 0.2);
  }
}

/* ---------- Игрок как кинематическая капсула: расталкивает обломки ---------- */
export function buildPlayerProxy() {
  if (!PHYS.ready) return;
  const shape = new A.btCapsuleShape(0.3, 1.1);
  const tr = new A.btTransform(); tr.setIdentity(); V0.setValue(0, -200, 0); tr.setOrigin(V0);
  const ms = new A.btDefaultMotionState(tr);
  const body = new A.btRigidBody(new A.btRigidBodyConstructionInfo(0, ms, shape, new A.btVector3(0, 0, 0)));
  body.setCollisionFlags(body.getCollisionFlags() | 2);  // CF_KINEMATIC_OBJECT
  body.setActivationState(4);                            // DISABLE_DEACTIVATION
  body.setUserIndex(-2);
  PHYS.world.addRigidBody(body, 4, 1);
  PHYS.player = { body, ms, tr };
}
export function movePlayerProxy(x, y, z, active) {
  const p = PHYS.player;
  if (!p) return;
  p.tr.setIdentity(); V0.setValue(x, active ? y + 0.85 : -200, z); p.tr.setOrigin(V0);
  p.ms.setWorldTransform(p.tr);
}

/* ---------- Лучи ---------- */
const _hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), idx: -1, body: null, dist: 0 };
/** Ближайшее пересечение отрезка a→b с миром. idx: индекс коллайдера, -1 — рельеф, -2 — игрок. */
export function rayCast(a, b, skipPlayer = true) {
  if (!PHYS.ready) return null;
  V0.setValue(a.x, a.y, a.z); V1.setValue(b.x, b.y, b.z);
  const cb = new A.ClosestRayResultCallback(V0, V1);
  if (skipPlayer) cb.set_m_collisionFilterMask(1 | 2);
  PHYS.world.rayTest(V0, V1, cb);
  let res = null;
  if (cb.hasHit()) {
    const p = cb.get_m_hitPointWorld(), n = cb.get_m_hitNormalWorld();
    const obj = cb.get_m_collisionObject();
    _hit.point.set(p.x(), p.y(), p.z()); _hit.normal.set(n.x(), n.y(), n.z());
    _hit.idx = obj.getUserIndex();
    _hit.body = null;
    const ptr = A.getPointer(obj);
    for (const bb of PHYS.bodies) if (bb.body && A.getPointer(bb.body) === ptr) { _hit.body = bb; break; }
    _hit.dist = _hit.point.distanceTo(a);
    res = _hit;
  }
  A.destroy(cb);
  return res;
}

/* ---------- Шаг ---------- */
/* ---------- Вода: плавучесть, вязкость, всплески ----------
   float — во сколько раз выталкивающая сила при полном погружении больше веса:
   доски и ветки (1.6–1.8) плавают, притопленные наполовину, бочки (2.5) — высоко,
   жесть, стекло и комья (0) тонут, но медленно — в воде вязко. */
let onSplash = null;
export const setSplashHandler = fn => { onSplash = fn; };
function buoyancy(dt) {
  const W = MAP.WATER_Y;
  for (const b of PHYS.bodies) {
    if (!b.body || b.frozen || !b.body.isActive()) continue;
    const p = b.pos;
    if (p.y > W + b.rad + 0.05 || lakeRho(p.x, p.z) > 1) { b.wet = false; continue; }
    const sub = clamp((W - (p.y - b.rad)) / (2 * b.rad), 0, 1);
    const v = b.body.getLinearVelocity();
    if (!b.wet) { b.wet = true; if (v.y() < -1.5 && onSplash) onSplash(p.x, p.z, Math.min(1.5, -v.y() * 0.12 * Math.cbrt(b.mass))); }
    if (sub <= 0) continue;
    b.body.activate();
    // выталкивание, покачивание на волне, снос ветром по поверхности — сразу в скорость, с вязкостью воды
    const fl = b.float > 0 ? 1 : 0;
    const dvy = 9.81 * b.float * sub * dt + Math.sin(FRAME.t * 1.7 + p.x) * 0.3 * dt * fl * sub;
    const k = Math.exp(-dt * 2.5 * sub), ky = Math.exp(-dt * 4 * sub);
    V0.setValue(v.x() * k + WIND.dir.x * WIND.strength * 0.15 * dt * fl, (v.y() + dvy) * ky, v.z() * k + WIND.dir.y * WIND.strength * 0.15 * dt * fl);
    b.body.setLinearVelocity(V0);
    const w = b.body.getAngularVelocity(), ka = Math.exp(-dt * 2 * sub);
    V0.setValue(w.x() * ka, w.y() * ka, w.z() * ka);
    b.body.setAngularVelocity(V0);
  }
}
let camRef = null;
export const setPhysCamera = c => { camRef = c; };
const FAR = b => camRef && (b.pos.x - camRef.position.x) ** 2 + (b.pos.z - camRef.position.z) ** 2 > 90 * 90;
export function stepPhysics(dt) {
  if (!PHYS.ready) return;
  buoyancy(dt);
  // на слабых пресетах шаг крупнее и подшагов меньше: медленный кадр не тянет за собой ещё более медленную физику
  PHYS.world.stepSimulation(dt, Q.physSub, Q.physStep);
  PHYS.steps++;
  const L = PHYS.bodies;
  for (let i = L.length - 1; i >= 0; i--) {
    const b = L[i];
    b.age += dt;
    if (!b.body) continue;
    // срок жизни: вдали от камеры обломки живут вдвое меньше. Угасание только убывает —
    // раньше при age < life коэффициент выходил больше 1, и доски раздувались в десятки раз
    const life = b.keep ? Infinity : b.life * (FAR(b) ? 0.5 : 1);
    if (b.age > life) {
      b.fade = Math.min(b.fade, Math.max(0, 1 - (b.age - life) / 1.2));
      if (b.fade <= 0) { killBody(b); continue; }
    }
    // спящее тело не двигается: не читаем трансформ и не трогаем меш
    if (b.synced && b.fade >= 1 && !b.body.isActive()) continue;
    b.ms.getWorldTransform(T0);
    const o = T0.getOrigin(), r = T0.getRotation();
    b.pos.set(o.x(), o.y(), o.z()); b.quat.set(r.x(), r.y(), r.z(), r.w());
    // провалился сквозь карту высот (стык, большая скорость) — убираем
    if (b.pos.y < MAP.WATER_Y - 12 || b.pos.y < -60) { killBody(b); continue; }
    b.synced = true;
    if (b.mesh) { b.mesh.position.copy(b.pos); b.mesh.quaternion.copy(b.quat); if (b.fade < 1) b.mesh.scale.setScalar(Math.max(0.01, b.fade)); }
    if (b.sync) b.sync(b.pos, b.quat, b.fade, b);
  }
}
export const physStats = () => ({ bodies: PHYS.bodies.length, ready: PHYS.ready, statics: PHYS.statics.size });
