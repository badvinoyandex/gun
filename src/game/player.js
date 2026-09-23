import * as THREE from 'three';
import { camera, FRAME } from '../core/env.js';
import { clamp, lerp, smoothstep } from '../core/math.js';
import { MAP, SPAWNS, terrainH, edgeDist, inMinefield, lakeRho, ISLAND, CLUSTERS, lakeContour } from '../world/layout.js';
import { hFast } from '../world/heightcache.js';
import { pushOut, supportTop, ceilingAt } from '../core/colliders.js';
import { mineNear } from '../world/military.js';
import { explode, BLAST } from '../fx/explosions.js';
import { click } from '../fx/audio.js';
import { windUniforms } from '../world/wind.js';
import { addRipple } from '../world/lake.js';
import { FX } from '../fx/particles.js';
import { sr } from '../core/math.js';

/* ============================================================================
   ИГРОК: дрон-призрак и пеший режим

   Дрон (по умолчанию) — свободный полёт сквозь кроны и постройки, как у
   «наблюдателя»: только земля и вода не пускают ниже 0.4 м. Инерция, крен
   на поворотах, лёгкое покачивание. На бреющем (< 1.8 м) над минной полосой
   цепляет растяжку — подрыв.
   Пешком — коллизии со стволами, стенами и машинами, окопы (выбраться можно
   только по аппарели), вброд по мелководью, вплавь по озеру. Любой шаг на
   минную полосу — подрыв. После гибели — возрождение на своей базе.
============================================================================ */
export const PL = {
  mode: 'drone', team: 'A',
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: -0.2, roll: 0,
  speed: 12, onGround: false, crouch: 0, eye: 1.68, bob: 0, bobAmp: 0, step: 0,
  dead: 0, deathMsg: '', light: false, swim: false, agl: 0, jumpLock: false,
  cine: null, lastDrop: -9
};
export const keys = {};
const SENS = 0.0021;

export function spawnAt(team, mode = PL.mode) {
  const s = SPAWNS[team];
  PL.team = team; PL.mode = mode;
  PL.vel.set(0, 0, 0);
  PL.yaw = s.yaw; PL.pitch = mode === 'drone' ? -0.22 : -0.03;
  if (mode === 'drone') PL.pos.set(s.x - s.fx * 10, terrainH(s.x, s.z) + 16, s.z - s.fz * 10);
  else PL.pos.set(s.x + s.fx * 2, terrainH(s.x, s.z) + 0.05, s.z + s.fz * 2);
  PL.dead = 0;
}
export function setMode(mode) {
  if (mode === PL.mode) return;
  if (mode === 'walk') {
    // приземляемся под дроном; если внизу вода — ищем берег ближе к камере
    let { x, z } = PL.pos;
    if (lakeRho(x, z) < 0.95) { const s = SPAWNS[PL.team]; x = s.x; z = s.z; }
    if (edgeDist(x, z) > MAP.FENCE - 0.5) { x = clamp(x, -MAP.PLAY + 2, MAP.PLAY - 2); z = clamp(z, -MAP.PLAY + 2, MAP.PLAY - 2); }
    PL.pos.set(x, Math.max(terrainH(x, z), supportTop(x, z, 0.3, PL.pos.y, 50)) + 0.02, z);
    pushOut(PL.pos, 0.32, PL.pos.y + 0.3, PL.pos.y + 1.7);
    PL.pitch = clamp(PL.pitch, -0.6, 0.6);
  } else {
    PL.pos.y += PL.eye + 1.5;
  }
  PL.mode = mode; PL.vel.set(0, 0, 0);
}
export function look(dx, dy) {
  if (PL.cine) return;
  PL.yaw -= dx * SENS;
  PL.pitch = clamp(PL.pitch - dy * SENS, -1.54, 1.54);
}

/* ---------- Смерть и возрождение ---------- */
function die(msg, kind, at) {
  if (PL.dead > 0) return;
  PL.dead = 3.2; PL.deathMsg = msg;
  if (kind === 'mine') click();
  const x = at?.x ?? PL.pos.x, z = at?.z ?? PL.pos.z;
  setTimeout(() => explode(x, terrainH(x, z), z, at?.type || 'pmn'), kind === 'mine' ? 180 : 0);
}
function checkMines() {
  const { x, z } = PL.pos;
  if (!inMinefield(x, z)) return;
  const agl = PL.mode === 'drone' ? PL.pos.y - hFast(x, z) : 0;
  if (PL.mode === 'drone' && agl > 1.8) return;
  // мины стоят через 2.6 м: пройти полосу, не задев ни одной, нельзя
  const m = mineNear(x, z, PL.mode === 'drone' ? 2.2 : 1.6) || (edgeDist(x, z) > MAP.PLAY + 2.5 ? mineNear(x, z, 4) : null);
  if (!m) return;
  m.live = false;
  if (m.mesh) m.mesh.visible = false;
  die(PL.mode === 'drone' ? 'ДРОН ЗАЦЕПИЛ РАСТЯЖКУ' : 'ПОДРЫВ НА МИНЕ', 'mine', m);
}

/* ---------- Сброс гранаты с дрона / бросок пешком ---------- */
const BOMBS = [];
export function dropBomb() {
  if (PL.dead > 0 || FRAME.t - PL.lastDrop < 1.1) return;
  PL.lastDrop = FRAME.t;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const b = { p: camera.position.clone(), v: new THREE.Vector3() };
  if (PL.mode === 'drone') { b.p.y -= 0.35; b.v.copy(PL.vel).multiplyScalar(0.9); }
  else { b.p.addScaledVector(dir, 0.5); b.v.copy(dir).multiplyScalar(14); b.v.y += 4; }
  BOMBS.push(b);
}
function updateBombs(dt) {
  for (let i = BOMBS.length - 1; i >= 0; i--) {
    const b = BOMBS[i];
    b.v.y -= 9.8 * dt;
    b.p.addScaledVector(b.v, dt);
    FX.alpha.spawn({ x: b.p.x, y: b.p.y, z: b.p.z, vx: 0, vy: 0, vz: 0, size: 0.08, grow: 0.3, life: 0.4, col: [0.8, 0.8, 0.8], a: 0.25 });
    const water = lakeRho(b.p.x, b.p.z) < 0.98;
    const g = water ? Math.max(MAP.WATER_Y, terrainH(b.p.x, b.p.z)) : Math.max(hFast(b.p.x, b.p.z), supportTop(b.p.x, b.p.z, 0.05, b.p.y, 0.2));
    if (b.p.y <= g + 0.05) {
      BOMBS.splice(i, 1);
      explode(b.p.x, g, b.p.z, 'vog');
      // сброс на мину — детонирует и её
      const m = mineNear(b.p.x, b.p.z, 3);
      if (m) { m.live = false; if (m.mesh) m.mesh.visible = false; setTimeout(() => explode(m.x, terrainH(m.x, m.z), m.z, m.type), 120); }
      const d = PL.pos.distanceTo(b.p);
      if (PL.mode === 'walk' && d < 4.5) die('ПОДРЫВ НА СОБСТВЕННОЙ ГРАНАТЕ', 'self');
      if (PL.mode === 'drone' && d < 2.2) die('ДРОН УНИЧТОЖЕН ОСКОЛКАМИ', 'self');
    }
  }
}

/* ---------- Кинематографичный облёт ---------- */
export function startCinematic() {
  const A = SPAWNS.A, D = SPAWNS.D, T = CLUSTERS.T, K = CLUSTERS.K;
  const H = (x, z, h) => new THREE.Vector3(x, terrainH(x, z) + h, z);
  const pts = [
    H(A.x - 14, A.z + 14, 22), H(A.x + 4, A.z - 4, 7), H(-62, 60, 3.2), H(-44, 44, 5), H(-24, 24, 2.5),
    new THREE.Vector3(-8, MAP.WATER_Y + 1.6, 8), new THREE.Vector3(ISLAND.x + 7, MAP.WATER_Y + 3, ISLAND.z + 2),
    new THREE.Vector3(-18, MAP.WATER_Y + 2.2, -22), H(-36, -40, 4), H(T.x - 2, T.z + 4, 3), H(T.x - 16, T.z - 14, 9),
    H(-20, -84, 14), H(30, -96, 10), H(D.x - 6, D.z + 6, 8), H(D.x + 12, D.z - 12, 26), H(40, 40, 60), H(-10, 30, 110)
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
  PL.cine = { curve, t: 0, len: curve.getLength(), prevMode: PL.mode };
  PL.mode = 'drone';
}
export function stopCinematic() {
  if (!PL.cine) return;
  PL.cine = null;
  PL.vel.set(0, 0, 0);
}

/* ---------- Кадр ---------- */
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), tmp = new THREE.Vector3(), lookV = new THREE.Vector3();
export function updatePlayer(dt) {
  if (PL.dead > 0) {
    PL.dead -= dt;
    if (PL.dead <= 0) spawnAt(PL.team, PL.mode);
    applyCamera(dt);
    return;
  }
  if (PL.cine) { updateCine(dt); applyCamera(dt); return; }
  const boost = keys.ShiftLeft || keys.ShiftRight ? 3.0 : keys.AltLeft ? 0.3 : 1;
  let ix = 0, iz = 0;
  if (keys.KeyW) iz += 1; if (keys.KeyS) iz -= 1;
  if (keys.KeyD) ix += 1; if (keys.KeyA) ix -= 1;
  if (ix || iz) { const l = Math.hypot(ix, iz); ix /= l; iz /= l; }
  fwd.set(-Math.sin(PL.yaw), 0, -Math.cos(PL.yaw));
  right.set(Math.cos(PL.yaw), 0, -Math.sin(PL.yaw));
  if (PL.mode === 'drone') updateDrone(dt, ix, iz, boost);
  else updateWalk(dt, ix, iz, boost);
  checkMines();
  updateBombs(dt);
  applyCamera(dt);
}
function updateDrone(dt, ix, iz, boost) {
  lookV.set(-Math.sin(PL.yaw) * Math.cos(PL.pitch), Math.sin(PL.pitch), -Math.cos(PL.yaw) * Math.cos(PL.pitch));
  const sp = PL.speed * boost;
  tmp.set(0, 0, 0).addScaledVector(lookV, iz * sp).addScaledVector(right, ix * sp);
  if (keys.Space || keys.KeyE) tmp.y += sp * 0.8;
  if (keys.KeyC || keys.KeyQ || keys.ControlLeft) tmp.y -= sp * 0.8;
  // инерция: разгон мягче торможения
  const k = tmp.lengthSq() > PL.vel.lengthSq() ? 2.6 : 3.8;
  PL.vel.lerp(tmp, Math.min(1, dt * k));
  PL.pos.addScaledVector(PL.vel, dt);
  // земля, вода и граница мира
  const g = Math.max(hFast(PL.pos.x, PL.pos.z), lakeRho(PL.pos.x, PL.pos.z) < 1 ? MAP.WATER_Y : -1e9);
  if (PL.pos.y < g + 0.4) { PL.pos.y = g + 0.4; if (PL.vel.y < 0) PL.vel.y = 0; }
  PL.pos.y = Math.min(PL.pos.y, 160);
  const lim = MAP.FENCE + 40, e = edgeDist(PL.pos.x, PL.pos.z);
  if (e > lim) { PL.pos.x = clamp(PL.pos.x, -lim, lim); PL.pos.z = clamp(PL.pos.z, -lim, lim); }
  PL.agl = PL.pos.y - g;
  // низко над водой — рябь от потока винтов
  if (lakeRho(PL.pos.x, PL.pos.z) < 0.98 && PL.agl < 3 && Math.random() < dt * 4) {
    addRipple(PL.pos.x, PL.pos.z, 0.35 * (1 - PL.agl / 3));
    FX.alpha.spawn({ x: PL.pos.x + sr(-1, 1), y: MAP.WATER_Y + 0.1, z: PL.pos.z + sr(-1, 1), vx: sr(-2, 2), vy: sr(0.3, 1), vz: sr(-2, 2), size: 0.5, grow: 1.4, life: 1.2, col: [0.75, 0.78, 0.8], a: 0.25 });
  }
  // крен и тангаж от ускорения — дрон «ложится» в поворот
  const lat = PL.vel.dot(right) / Math.max(PL.speed, 1);
  PL.roll = lerp(PL.roll, -clamp(lat, -1, 1) * 0.16, Math.min(1, dt * 3));
  windUniforms.uPlayer.value.set(0, -999, 0);
}
function updateWalk(dt, ix, iz, boost) {
  const water = lakeRho(PL.pos.x, PL.pos.z) < 1.0 ? MAP.WATER_Y : -1e9;
  const depth = water - terrainH(PL.pos.x, PL.pos.z);
  PL.swim = depth > 1.25;
  const wantCrouch = keys.KeyC || keys.ControlLeft;
  PL.crouch = lerp(PL.crouch, wantCrouch && !PL.swim ? 1 : 0, Math.min(1, dt * 10));
  const wade = depth > 0.35 && !PL.swim ? 0.55 : 1;
  const sp = (PL.swim ? 1.4 : 3.6 * (boost > 1 ? 1.75 : boost < 1 ? 0.45 : 1)) * lerp(1, 0.45, PL.crouch) * wade;
  tmp.set(0, 0, 0).addScaledVector(fwd, iz * sp).addScaledVector(right, ix * sp);
  const acc = PL.onGround || PL.swim ? 12 : 2.5;
  PL.vel.x += (tmp.x - PL.vel.x) * Math.min(1, acc * dt);
  PL.vel.z += (tmp.z - PL.vel.z) * Math.min(1, acc * dt);
  // горизонталь: шаг, затем проверка крутизны (стенка окопа, откос) и препятствий
  const ox = PL.pos.x, oz = PL.pos.z, oy = PL.pos.y;
  PL.pos.x += PL.vel.x * dt; PL.pos.z += PL.vel.z * dt;
  const gNew = terrainH(PL.pos.x, PL.pos.z), gOld = terrainH(ox, oz);
  const run = Math.hypot(PL.pos.x - ox, PL.pos.z - oz);
  if (!PL.swim && run > 1e-4 && gNew - gOld > 0.02 && (gNew - gOld) / run > 1.35 && gNew > oy + 0.25) {
    PL.pos.x = ox; PL.pos.z = oz; PL.vel.x *= 0.2; PL.vel.z *= 0.2;
  }
  const bodyH = lerp(1.75, 1.1, PL.crouch);
  pushOut(PL.pos, 0.32, PL.pos.y + 0.42, PL.pos.y + bodyH);
  // граница: колючая проволока
  const lim = MAP.FENCE - 0.8;
  PL.pos.x = clamp(PL.pos.x, -lim, lim); PL.pos.z = clamp(PL.pos.z, -lim, lim);
  // вертикаль
  if (PL.swim) {
    PL.pos.y = lerp(PL.pos.y, water - 1.35 + Math.sin(FRAME.t * 1.6) * 0.04, Math.min(1, dt * 4));
    PL.vel.y = 0; PL.onGround = false;
  } else {
    PL.vel.y -= 19.6 * dt;
    if (keys.Space && PL.onGround && !PL.jumpLock && PL.crouch < 0.4) { PL.vel.y = 5.4; PL.onGround = false; PL.jumpLock = true; }
    if (!keys.Space) PL.jumpLock = false;
    PL.pos.y += PL.vel.y * dt;
    const ground = Math.max(terrainH(PL.pos.x, PL.pos.z), supportTop(PL.pos.x, PL.pos.z, 0.3, Math.max(PL.pos.y, oy), 0.45));
    if (PL.pos.y <= ground + 0.001 && PL.vel.y <= 0) { PL.pos.y = ground; PL.vel.y = 0; PL.onGround = true; }
    else if (PL.onGround && PL.pos.y - ground < 0.4 && PL.vel.y <= 0) { PL.pos.y = ground; PL.vel.y = 0; }
    else PL.onGround = false;
    const ceil = ceilingAt(PL.pos.x, PL.pos.z, 0.3, PL.pos.y + 0.5, PL.pos.y + bodyH + 0.1);
    if (ceil < PL.pos.y + bodyH) { PL.pos.y = Math.min(PL.pos.y, ceil - bodyH); PL.vel.y = Math.min(0, PL.vel.y); }
  }
  const hs = Math.hypot(PL.vel.x, PL.vel.z);
  PL.bobAmp = lerp(PL.bobAmp, (PL.onGround || PL.swim) ? clamp(hs / 4.5, 0, 1) : 0, Math.min(1, dt * 8));
  PL.step += hs * dt * 2.1;
  PL.bob = Math.sin(PL.step * Math.PI) * 0.03 * PL.bobAmp;
  PL.roll = lerp(PL.roll, 0, Math.min(1, dt * 6));
  PL.agl = 1.7;
  windUniforms.uPlayer.value.copy(PL.pos);
}
function updateCine(dt) {
  const c = PL.cine;
  c.t += dt * 11 / c.len;
  if (c.t >= 1) { stopCinematic(); return; }
  const e = smoothstep(0, 1, c.t) * 0.15 + c.t * 0.85;
  const p = c.curve.getPointAt(Math.min(1, e));
  const q = c.curve.getPointAt(Math.min(1, e + 0.02));
  PL.vel.copy(q).sub(p).divideScalar(Math.max(dt, 1e-3) * 1);
  PL.pos.copy(p);
  const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
  const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz)) - 0.12;
  let dyaw = yaw - PL.yaw; while (dyaw > Math.PI) dyaw -= Math.PI * 2; while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  PL.roll = lerp(PL.roll, clamp(-dyaw * 2.5, -0.3, 0.3), Math.min(1, dt * 2));
  PL.yaw += dyaw * Math.min(1, dt * 2.2);
  PL.pitch = lerp(PL.pitch, pitch, Math.min(1, dt * 2));
  PL.agl = PL.pos.y - hFast(PL.pos.x, PL.pos.z);
}
function applyCamera(dt) {
  const drone = PL.mode === 'drone';
  const eye = drone ? 0 : (PL.swim ? 1.5 : lerp(PL.eye, 1.02, PL.crouch) + PL.bob);
  camera.position.set(PL.pos.x, PL.pos.y + eye, PL.pos.z);
  // зависание дрона: едва заметный дрейф
  if (drone && !PL.cine) {
    const t = FRAME.t;
    camera.position.y += Math.sin(t * 1.3) * 0.025 + Math.sin(t * 2.9) * 0.012;
    camera.position.x += Math.sin(t * 0.9) * 0.015;
  }
  let shx = 0, shy = 0;
  if (BLAST.shake > 0) {
    const s = BLAST.shake * BLAST.shake;
    shx = (Math.random() - 0.5) * 0.06 * s; shy = (Math.random() - 0.5) * 0.06 * s;
  }
  camera.rotation.set(PL.pitch + shy, PL.yaw + shx, PL.roll + PL.bob * 0.3);
  camera.updateMatrixWorld();
}
export function zoneInfo() {
  const { x, z } = PL.pos;
  const e = edgeDist(x, z);
  for (const s of Object.values(SPAWNS)) if (Math.hypot(x - s.x, z - s.z) < s.r) return { text: 'зона возрождения ' + s.name, warn: false };
  if (e > MAP.PLAY - 4 && e < MAP.PLAY) return { text: 'впереди минное поле', warn: true };
  if (inMinefield(x, z)) return { text: PL.mode === 'drone' ? 'МИННОЕ ПОЛЕ — держите высоту' : 'МИННОЕ ПОЛЕ', warn: true };
  if (e >= MAP.MINE1 + 0.5) return { text: 'за периметром', warn: false };
  return null;
}
