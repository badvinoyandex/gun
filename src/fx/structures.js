import * as THREE from 'three';
import { scene, camera, FRAME, Q, PERF } from '../core/env.js';
import { clamp, lerp, sr, srnd, TAU } from '../core/math.js';
import { STRUCTS, collapsePanel, uvBox } from '../world/builders.js';
import { hFast } from '../world/heightcache.js';
import { PHYS, addBody, removeStaticCollider, freezeBody } from '../core/physics.js';
import { M } from '../gen/materials.js';
import { FX } from './particles.js';
import { PANES, breakPane } from './glass.js';
import { woodCrack } from './audio.js';
import { BURN, charData, markCharDirty } from '../core/fxu.js';
import { ignite, heatAt, FIRE, attachFire } from './fire.js';
import { WEATHER } from '../world/weather.js';
import { injectStructFX } from '../world/wind.js';

/* ============================================================================
   РАЗРУШЕНИЕ И ПОЖАР ПОСТРОЕК
   • Взрыв бьёт по панелям с затуханием по расстоянию: сруб держит лучше досок,
     кровля и двери — слабее всего. Разрушенная стена рассыпается на брёвна или
     доски (тела), дверь, лист кровли, мебель улетают целиком.
   • Опоры: кровля держится на стенах, наличники и углы — на соседних кусках,
     фронтон — на своей стене. Выбита опора — деталь падает следом (с задержкой,
     каскадом), провалившаяся кровля перестаёт держать дрон и игрока.
   • Пожар: дом загорается от взрыва рядом, от горящей травы вокруг, от упавшей
     головни и от молнии. Огонь разгорается за полминуты, пламя рвётся из окон и
     дыр кровли, стены чернеют и тлеют, панели выгорают и обрушиваются. Остаётся
     чёрный остов и печная труба. Дождь сбивает огонь.
   Работа разбита по кадрам: не больше нескольких разрушений за кадр.
============================================================================ */
const QUEUE = [];
const BUDGET = () => Math.round(Q.bodies * 0.38 * (1 - PERF.load * 0.6));   // тел обломков на один взрыв; при просадке кадра — меньше
let bodiesThisBlast = 0, bodiesThisFrame = 0;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const LOG_GEO = new THREE.CylinderGeometry(0.11, 0.11, 1, 7).rotateZ(Math.PI / 2);

/** Удар по постройкам: panel.hp уменьшается по расстоянию до панели. */
export function blastStructs(x, y, z, size) {
  bodiesThisBlast = 0;
  _v.set(x, y, z);
  const R = 5 + 7 * size;
  for (const s of STRUCTS) {
    if (!s.center || s.center.distanceTo(_v) > R + s.radius) continue;
    let any = false;
    for (const p of s.panels) {
      if (p.dead || !p.box) continue;
      const d = p.box.distanceToPoint(_v);
      if (d > R) continue;
      const dmg = size * 1.5 / Math.pow(0.6 + d, 1.45);
      p.hp -= dmg * sr(0.8, 1.2);
      if (p.hp <= 0) { kill(p, _v, Math.min(14, 7 * size / (0.8 + d * 0.5)), 0); any = true; }
    }
    if (any) s.shake = 1;
    // пыль и труха с кровли даже без разрушений
    if (s.center.distanceTo(_v) < R) dustFrom(s, 10);
    if (Math.random() < 0.6 * (1 - WEATHER.wet) && s.center.distanceTo(_v) < 3.5 + 2.5 * size + s.radius * 0.5 && size >= 0.8) igniteStruct(s, 0.3);
  }
}
/** Точечное попадание (пуля) в панель: дверь, доска, стекло — копится урон. */
export function hitPanel(p, point, dir, dmg = 0.08) {
  if (!p || p.dead) return;
  p.hp -= dmg;
  splinterPuff(point, dir);
  if (p.hp <= 0) kill(p, point.clone().addScaledVector(dir, -1), 3, 0);
}
function kill(p, from, force, delay) {
  if (p.dead) return;
  p.dead = true;
  QUEUE.push({ p, from: from.clone(), force, t: FRAME.t + delay });
}
/** Снять панель: геометрия схлопывается, коллайдеры гасятся, стёкла на ней бьются. */
function removePanel(p) {
  collapsePanel(p);
  for (const c of p.cols) { c.dead = true; removeStaticCollider(c); }
  for (const pane of PANES) if (pane.panel === p && pane.alive) breakPane(pane, new THREE.Vector3(sr(-1, 1), 0.3, sr(-1, 1)).normalize(), 2);
}
function processQueue() {
  let n = 0;
  // тела обломков создаются порциями: всплеск в один кадр давал рывок 80–100 мс
  bodiesThisFrame = 0;
  const perFrame = Math.max(4, Math.round(Q.bodies * 0.1));
  for (let i = 0; i < QUEUE.length && n < 6 && bodiesThisFrame < perFrame; i++) {
    const e = QUEUE[i];
    if (FRAME.t < e.t) continue;
    QUEUE.splice(i--, 1); n++;
    removePanel(e.p);
    debris(e.p, e.from, e.force, e.fire);
    supportPass(e.p.s);
  }
}
/** Проверка опор: деталь без опоры падает через долю секунды — каскад обрушения. */
function supportPass(s) {
  for (const p of s.panels) {
    if (p.dead || !p.sup) continue;
    const L = p.sup.list;
    if (!L.length) continue;
    const alive = L.filter(q => !q.dead).length / L.length;
    if (alive < p.sup.frac) kill(p, _v.copy(p.center).add(new THREE.Vector3(0, 2, 0)), 0.5, sr(0.05, 0.45));
  }
}

/* ---------- Обломки ---------- */
function localBox(p, rot) {
  // габарит панели в осях постройки: тело получает поворот постройки
  const q = _q.setFromAxisAngle(_up, -rot), b = new THREE.Box3();
  for (const part of p.parts) {
    const pos = part.geo.attributes.position;
    for (let i = 0; i < pos.count; i += 3) b.expandByPoint(_v.fromBufferAttribute(pos, i).sub(p.center).applyQuaternion(q));
  }
  return b;
}
function debris(p, from, force, fire) {
  const s = p.s, canBody = PHYS.ready && bodiesThisBlast < BUDGET();
  const dir = new THREE.Vector3().subVectors(p.center, from); dir.y = Math.max(dir.y, 0.2); dir.normalize();
  dustAt(p.center, p.box, p.kind === 'roof' ? 6 : 10, fire);
  if (p.mode === 'none' || p.mode === 'dust') return;
  if (p.mode === 'shatter' && p.dims) return shatter(p, dir, force, fire, canBody);
  if (!canBody || !p.parts.length) return;
  // целиком: геометрия панели становится телом
  const rot = s.rot ?? 0, lb = localBox(p, rot), size = lb.getSize(new THREE.Vector3()), mid = lb.getCenter(new THREE.Vector3());
  if (size.x * size.y * size.z > 60) return;
  const qInv = new THREE.Quaternion().setFromAxisAngle(_up, -rot);
  const group = new THREE.Group();
  const byMat = new Map();
  for (const part of p.parts) { if (!byMat.has(part.mat)) byMat.set(part.mat, []); byMat.get(part.mat).push(part.geo); }
  for (const [mat, geos] of byMat) for (const g0 of geos) {
    const g = g0.clone().translate(-p.center.x, -p.center.y, -p.center.z).applyQuaternion(qInv).translate(-mid.x, -mid.y, -mid.z);
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  }
  const pos = p.center.clone().add(mid.clone().applyQuaternion(_q.setFromAxisAngle(_up, rot)));
  group.position.copy(pos); group.quaternion.setFromAxisAngle(_up, rot);
  scene.add(group);
  const hs = [Math.max(0.04, size.x), Math.max(0.04, size.y), Math.max(0.04, size.z)];
  const mass = clamp(hs[0] * hs[1] * hs[2] * p.density * 0.5, 2, 400);
  const b = addBody({ shape: 'box', size: hs, mass, pos, quat: group.quaternion, vel: dir.clone().multiplyScalar(force * sr(0.5, 1.1)).add(new THREE.Vector3(0, force * 0.2, 0)),
    ang: new THREE.Vector3(sr(-2, 2), sr(-2, 2), sr(-2, 2)).multiplyScalar(Math.min(3, force * 0.3)), life: p.kind === 'prop' ? 40 : 60, friction: 0.8, restitution: 0.1, damp: [0.1, 0.3],
    float: p.float, rad: Math.min(hs[0], hs[1], hs[2]) / 2, onDone: () => { scene.remove(group); group.traverse(o => o.geometry?.dispose()); },
    sync: (q, r, f) => { group.position.copy(q); group.quaternion.copy(r); if (f < 1) group.scale.setScalar(Math.max(0.01, f)); } });
  if (b) { bodiesThisBlast++; bodiesThisFrame++; if (fire && p.burnable) attachFire(b, sr(5, 10)); }
  else { scene.remove(group); }
}
/** Стена рассыпается: брёвна (сруб) или доски, часть — телами, остальное — пыль и щепа. */
function shatter(p, dir, force, fire, canBody) {
  const D = p.dims, c = Math.cos(D.rot), s = Math.sin(D.rot);
  const ux = c, uz = -s;   // вдоль стены
  const pieces = [];
  if (D.log) {
    const rows = Math.max(1, Math.round(D.sy / 0.225)), segs = Math.max(1, Math.round(D.sx / 1.6));
    for (let r = 0; r < rows; r++) for (let k = 0; k < segs; k++) {
      const L = D.sx / segs, t = -D.sx / 2 + L * (k + 0.5), y = D.y - D.sy / 2 + (r + 0.5) * (D.sy / rows);
      pieces.push({ x: D.x + ux * t, y, z: D.z + uz * t, L: L * sr(0.8, 1), log: true });
    }
  } else {
    const n = Math.max(1, Math.round(D.sx / 0.2));
    for (let k = 0; k < n; k++) {
      const t = -D.sx / 2 + (k + 0.5) * (D.sx / n), cut = D.sy > 1.2 && Math.random() < 0.6 ? 2 : 1;
      for (let q = 0; q < cut; q++) pieces.push({ x: D.x + ux * t, y: D.y - D.sy / 2 + (q + 0.5) * D.sy / cut, z: D.z + uz * t, L: D.sy / cut * sr(0.7, 1), log: false, w: D.sx / n });
    }
  }
  const maxBodies = Math.min(pieces.length, Math.round(3 + Q.bodies / 18));
  pieces.sort(() => Math.random() - 0.5);
  pieces.forEach((pc, i) => {
    if (i >= maxBodies || !canBody || bodiesThisBlast >= BUDGET()) {
      if (i < 12) splinterPuff(_v.set(pc.x, pc.y, pc.z), dir);
      return;
    }
    let mesh, size, qa;
    if (pc.log) {
      mesh = new THREE.Mesh(LOG_GEO, M.logEnd === D.mat ? M.logEnd : M.barkLog || M.logEnd);
      mesh.scale.set(pc.L, 1, 1);
      qa = new THREE.Quaternion().setFromAxisAngle(_up, D.rot);
      size = [pc.L, 0.22, 0.22];
    } else {
      const g = uvBox(new THREE.BoxGeometry(pc.w * 0.9, pc.L, D.sz * 0.8), pc.w * 0.9, pc.L, D.sz * 0.8, 1.5, false);
      mesh = new THREE.Mesh(g, D.mat ?? p.mat ?? M.planks);
      qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(sr(-0.1, 0.1), D.rot, sr(-0.15, 0.15)));
      size = [pc.w * 0.9, pc.L, D.sz * 0.8];
    }
    mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh);
    const pos = new THREE.Vector3(pc.x, pc.y, pc.z);
    const sc = mesh.scale.clone();
    const b = addBody({ shape: 'box', size, mass: size[0] * size[1] * size[2] * 550 + 1, pos, quat: qa,
      vel: dir.clone().multiplyScalar(force * sr(0.3, 1.1)).add(new THREE.Vector3(sr(-1, 1), sr(0, 2) * Math.min(1, force / 4), sr(-1, 1))),
      ang: new THREE.Vector3(sr(-3, 3), sr(-3, 3), sr(-3, 3)), life: sr(35, 60), friction: 0.9, restitution: 0.05, damp: [0.1, 0.35], float: 1.7, rad: 0.1, ccd: 0.08,
      onDone: () => { scene.remove(mesh); if (!pc.log) mesh.geometry.dispose(); },
      sync: (q, r, f) => { mesh.position.copy(q); mesh.quaternion.copy(r); mesh.scale.copy(sc).multiplyScalar(clamp(f, 0.01, 1)); } });
    if (!b) { scene.remove(mesh); return; }
    bodiesThisBlast++; bodiesThisFrame++;
    if (fire && Math.random() < 0.3) attachFire(b, sr(5, 10));
  });
  const d = camera.position.distanceTo(_v.set(D.x, D.y, D.z));
  if (d < 120) woodCrack(d, 0, 0.6);
}
function splinterPuff(p, dir) {
  for (let i = 0; i < 4; i++) FX.dirt.spawn({ x: p.x, y: p.y, z: p.z, vx: dir.x * sr(1, 4) + sr(-1, 1), vy: sr(0.5, 3), vz: dir.z * sr(1, 4) + sr(-1, 1), size: sr(0.04, 0.09), life: 1.2, col: [0.3, 0.24, 0.17], a: 0.95, grav: 9.8, floor: hFast(p.x, p.z) });
  FX.alpha.spawn({ x: p.x, y: p.y, z: p.z, vx: dir.x, vy: 0.3, vz: dir.z, size: 0.3, grow: 0.8, life: 1.2, col: [0.42, 0.38, 0.32], a: 0.35, drag: 2 });
}
function dustAt(c, box, n, fire) {
  const sz = box.getSize(_v);
  for (let i = 0; i < n; i++) FX.alpha.spawn({ x: c.x + sr(-0.5, 0.5) * sz.x, y: c.y + sr(-0.5, 0.5) * sz.y, z: c.z + sr(-0.5, 0.5) * sz.z, vx: sr(-0.8, 0.8), vy: sr(0, 0.8), vz: sr(-0.8, 0.8),
    size: sr(0.4, 1.0), grow: 1.2, life: sr(1.5, 3), col: fire ? [0.12, 0.11, 0.1] : [0.46, 0.42, 0.36], a: 0.4, drag: 1.5, windK: 0.8 });
}
function dustFrom(s, n) {
  for (let i = 0; i < n; i++) FX.alpha.spawn({ x: s.center.x + sr(-1, 1) * s.w * 0.5, y: s.fy + s.h + sr(0, 1), z: s.center.z + sr(-1, 1) * s.d * 0.5, vx: sr(-0.5, 0.5), vy: sr(-0.8, 0), vz: sr(-0.5, 0.5),
    size: sr(0.3, 0.8), grow: 1, life: sr(1.5, 3), col: [0.5, 0.46, 0.4], a: 0.3, drag: 1.2, windK: 0.6 });
}

/* ---------- Пожар ---------- */
export const BURNING = [];
export function igniteStruct(s, k = 0.2) {
  if (s.fuel <= 0.05 || s.kind === 'dugout' && Math.random() < 0.5) return;
  if (!BURNING.includes(s)) { BURNING.push(s); s.burnT = 0; }
  s.burn = Math.max(s.burn, k);
}
const charCell = (x, z, amt, glow) => {
  const i = Math.floor(x - BURN.X0), j = Math.floor(z - BURN.X0);
  if (i < 0 || j < 0 || i >= BURN.N || j >= BURN.N) return;
  const k = (j * BURN.N + i) * 4;
  // накопление с дробной частью: байт копоти растёт даже при малых шагах
  charData[k] = Math.min(255, charData[k] + Math.floor(amt * 255 + Math.random()));
  charData[k + 1] = Math.min(255, Math.max(0, glow * 255));
};
/** Жар внутри горящей постройки — для урона игроку. */
export function structHeatAt(x, z) {
  let h = 0;
  for (const s of BURNING) {
    const dx = x - s.x, dz = z - s.z, c = Math.cos(s.rot || 0), sn = Math.sin(s.rot || 0);
    const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
    if (Math.abs(lx) < (s.w ?? 2) / 2 + 0.5 && Math.abs(lz) < (s.d ?? 2) / 2 + 0.5) h = Math.max(h, s.burn);
  }
  return h;
}
let acc = 0;
function updateBurning(dt) {
  acc += dt;
  const step = acc >= 0.25;
  const st = acc; if (step) acc = 0;
  const cp = camera.position;
  FIRE.structs = [];
  for (let i = BURNING.length - 1; i >= 0; i--) {
    const s = BURNING[i];
    const alive = s.panels.filter(p => !p.dead && p.burnable && p.parts.length);
    if (step) {
      const rain = WEATHER.rain;
      // разгорается ~30 с, топливо — пара минут; дождь сбивает пламя
      s.burn = clamp(s.burn + st * (0.035 * (1 - rain * 0.8) - rain * 0.03 * (s.burn < 0.5 ? 1 : 0.3)), 0, 1);
      s.fuel -= st * s.burn * 0.009;
      s.burnT += st;
      if (s.fuel <= 0 || s.burn <= 0.01 || !alive.length) {
        // догорело: пепелище ещё долго тлеет — дымок, угли, редкие искры
        if (s.burnT > 20 && WEATHER.rain < 0.5) { s.smolder = sr(70, 130); s.smolder0 = s.smolder; if (!SMOLDER.includes(s)) SMOLDER.push(s); }
        s.charred = 1;
        if (s.kind === 'house' || s.kind === 'shed' || s.kind === 'porch') charPile(s);
        s.burn = 0; BURNING.splice(i, 1);
        for (const p of s.panels) if (p.box) forFootprint(p, (x, z) => charCell(x, z, 0.1, 0));
        markCharDirty();
        continue;
      }
      // копоть и жар на стенах
      for (const p of s.panels) if (p.box && !p.dead && Math.random() < 0.5) forFootprint(p, (x, z) => charCell(x, z, st * 0.05 * s.burn, s.burn * sr(0.6, 1)));
      markCharDirty();
      // выгорание: случайные панели теряют прочность, кровля проваливается первой
      for (const p of alive) {
        const k = p.kind === 'roof' ? 1.6 : p.kind === 'wall' ? 0.5 : 1;
        p.hp -= st * s.burn * 0.012 * k * sr(0.3, 1.7) * (s.log ? 0.7 : 1);
        if (p.hp <= 0) { p.fireKill = true; kill(p, _v.copy(p.center).add(new THREE.Vector3(sr(-1, 1), 3, sr(-1, 1))), 0.6, 0); QUEUE[QUEUE.length - 1].fire = true; }
      }
      // огонь перекидывается на траву вокруг и на соседние постройки
      if (s.burn > 0.5 && Math.random() < st * 0.8) ignite(s.x + sr(-1, 1) * ((s.w ?? 3) / 2 + 1.5), s.z + sr(-1, 1) * ((s.d ?? 3) / 2 + 1.5), 1, 0.8);
      if (s.burn > 0.7 && Math.random() < st * 0.02) for (const o of STRUCTS) if (o !== s && o.center && o.center.distanceTo(s.center) < 7 + o.radius) igniteStruct(o, 0.1);
    }
    const d2 = (s.x - cp.x) ** 2 + (s.z - cp.z) ** 2;
    FIRE.structs.push({ x: s.center.x, z: s.center.z, y: s.fy + 1.2, p: s.burn * 8 });
    if (d2 > 170 * 170) continue;
    // пламя из живых панелей (окна, дыры кровли, стены), дым столбом
    const n = Math.round((2 + s.burn * 10) * (0.5 + Q.tex * 0.5));
    for (let k = 0; k < n; k++) {
      if (!alive.length || Math.random() > s.burn) continue;
      const p = alive[(Math.random() * alive.length) | 0], b = p.box;
      const x = sr(b.min.x, b.max.x), y = sr(b.min.y, b.max.y), z = sr(b.min.z, b.max.z);
      FX.add.spawn({ flame: true, x, y, z, vx: sr(-0.3, 0.3), vy: sr(1.5, 3.5), vz: sr(-0.3, 0.3), size: sr(0.5, 1.2) * (0.6 + s.burn), grow: -0.3, life: sr(0.4, 0.9), col: [1.8, 0.85, 0.32], a: 0.9, cool: 0.4, windK: 0.9 });
    }
    // столб дыма: снизу подсвечен пламенем, чем сильнее огонь — тем чернее и гуще
    if (Math.random() < dt * (3 + s.burn * 10)) FX.alpha.spawn({ x: s.center.x + sr(-1, 1), y: s.fy + (s.h ?? 2.5) + sr(0, 1.5), z: s.center.z + sr(-1, 1), vx: 0, vy: sr(1.2, 2.5), vz: 0,
      size: sr(1.5, 3) * (0.6 + s.burn), grow: 1.6, life: sr(6, 12), col: [0.1, 0.095, 0.09].map(v => v * (1.4 - s.burn * 0.6)), a: 0.45 + s.burn * 0.15, fadeIn: 0.6, windK: 2.2, drag: 0.25, glow: 0.35 * s.burn });
    // кровля провалилась: огонь вырывается столбом над срубом
    const roofGone = s.panels.some(p => p.kind === 'roof' && p.dead);
    if (roofGone && s.burn > 0.35) for (let k = 0; k < 2; k++) if (Math.random() < s.burn) {
      const w2 = (s.w ?? 3) * 0.35, d2b = (s.d ?? 3) * 0.35, c = Math.cos(s.rot || 0), sn = Math.sin(s.rot || 0), lx = sr(-w2, w2), lz = sr(-d2b, d2b);
      FX.add.spawn({ flame: true, x: s.x + lx * c + lz * sn, y: s.fy + (s.h ?? 2.5) * sr(0.5, 1), z: s.z - lx * sn + lz * c, vx: sr(-0.3, 0.3), vy: sr(2.5, 4.5), vz: sr(-0.3, 0.3),
        size: sr(1.2, 2.2) * (0.5 + s.burn), grow: -0.4, life: sr(0.5, 1.0), col: [1.7, 0.8, 0.3], a: 0.85, cool: 0.4, windK: 1.0 });
    }
    // тлеющие стены: угли и струйки дыма вдоль уже почерневших панелей
    if (alive.length && Math.random() < dt * 6 * s.burn) {
      const p = alive[(Math.random() * alive.length) | 0], b = p.box;
      FX.alpha.spawn({ x: sr(b.min.x, b.max.x), y: sr(b.min.y, b.max.y), z: sr(b.min.z, b.max.z), vx: 0, vy: sr(0.4, 0.9), vz: 0, size: sr(0.3, 0.6), grow: 0.8, life: sr(2, 4), col: [0.18, 0.17, 0.16], a: 0.3, fadeIn: 0.3, windK: 1.2, drag: 0.4, glow: 0.2 });
    }
    if (Math.random() < dt * s.burn * 4) FX.add.spawn({ x: s.center.x + sr(-2, 2), y: s.fy + sr(1, 3), z: s.center.z + sr(-2, 2), vx: sr(-0.6, 0.6), vy: sr(2, 5), vz: sr(-0.6, 0.6), size: 0.06, life: sr(1.5, 3), col: [2.6, 1.2, 0.4], a: 1, grav: 1, windK: 1.2, drag: 0.35 });
  }
}
/** Клетки карты 1 м под панелью. */
function forFootprint(p, fn) {
  const b = p.box;
  for (let x = Math.floor(b.min.x); x <= Math.ceil(b.max.x); x++) for (let z = Math.floor(b.min.z); z <= Math.ceil(b.max.z); z++) fn(x + 0.5, z + 0.5);
}
/** Горящая трава поджигает постройку, которой касается. */
function grassToStruct() {
  for (const s of STRUCTS) {
    if (!s.center || s.burn > 0 || s.fuel <= 0.05 || s.kind === 'bench' && Math.random() < 0.5) continue;
    const r = Math.max(s.w ?? 1, s.d ?? 1) / 2 + 0.8;
    for (let k = 0; k < 4; k++) {
      const a = Math.random() * TAU;
      if (heatAt(s.center.x + Math.cos(a) * r, s.center.z + Math.sin(a) * r) > 0.5 && Math.random() < 0.15 * (1 - WEATHER.wet)) { igniteStruct(s, 0.15); break; }
    }
  }
}
/** Обугленные балки и доски на полу пепелища: один инстанс-меш на всю карту. */
let PILE = null;
function charPile(s) {
  if (!PILE) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x17120f, roughness: 1, metalness: 0 });
    injectStructFX(mat);
    PILE = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, 400);
    PILE.count = 0; PILE.castShadow = true; PILE.receiveShadow = true; PILE.frustumCulled = false;
    scene.add(PILE);
  }
  const n = Math.round(6 + (s.w ?? 3) * (s.d ?? 3) * 0.35), c = Math.cos(s.rot || 0), sn = Math.sin(s.rot || 0);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  for (let k = 0; k < n && PILE.count < 400; k++) {
    const lx = sr(-0.42, 0.42) * (s.w ?? 3), lz = sr(-0.42, 0.42) * (s.d ?? 3), L = sr(0.8, 2.6), log = s.log || Math.random() < 0.3;
    const x = s.x + lx * c + lz * sn, z = s.z - lx * sn + lz * c;
    e.set(sr(-0.25, 0.25), Math.random() * TAU, sr(-0.35, 0.35) * (k % 3 === 0 ? 1.6 : 1));
    sc.set(L, log ? 0.2 : 0.06, log ? 0.2 : sr(0.12, 0.2));
    p.set(x, (s.fy ?? hFast(x, z)) + sc.y / 2 + Math.random() * 0.12, z);
    PILE.setMatrixAt(PILE.count++, m.compose(p, q.setFromEuler(e), sc));
  }
  PILE.instanceMatrix.needsUpdate = true;
}
/* ---------- Пепелище ----------
   Догоревший дом тлеет ещё минуту-другую: над остовом тянется тонкий дым,
   в углях вспыхивают искры, жар на карте обугливания медленно гаснет. Дождь тушит. */
const SMOLDER = [];
function updateSmolder(dt, step) {
  const cp = camera.position;
  for (let i = SMOLDER.length - 1; i >= 0; i--) {
    const s = SMOLDER[i];
    s.smolder -= dt * (1 + WEATHER.rain * 6);
    if (s.smolder <= 0 || s.burn > 0) { SMOLDER.splice(i, 1); continue; }
    const k = s.smolder / s.smolder0;
    if (step) {
      for (const p of s.panels) if (p.box && Math.random() < 0.25) forFootprint(p, (x, z) => charCell(x, z, 0, k * sr(0.15, 0.5)));
      markCharDirty();
    }
    if ((s.x - cp.x) ** 2 + (s.z - cp.z) ** 2 > 140 * 140) continue;
    const w2 = (s.w ?? 3) * 0.45, d2 = (s.d ?? 3) * 0.45, c = Math.cos(s.rot || 0), sn = Math.sin(s.rot || 0);
    const at = () => { const lx = sr(-w2, w2), lz = sr(-d2, d2); return [s.x + lx * c + lz * sn, s.z - lx * sn + lz * c]; };
    if (Math.random() < dt * 5 * k) {
      const [x, z] = at();
      FX.alpha.spawn({ x, y: s.fy + 0.2, z, vx: 0, vy: sr(0.5, 1.1), vz: 0, size: sr(0.4, 0.9), grow: 0.9, life: sr(4, 8), col: [0.3, 0.29, 0.28], a: 0.22 * (0.4 + k), fadeIn: 0.8, windK: 1.6, drag: 0.3, glow: 0.12 * k });
    }
    if (Math.random() < dt * 2.5 * k) {
      const [x, z] = at();
      FX.add.spawn({ x, y: s.fy + 0.1, z, vx: sr(-0.4, 0.4), vy: sr(1, 2.5), vz: sr(-0.4, 0.4), size: 0.05, life: sr(0.8, 1.6), col: [2.6, 1.1, 0.35], a: 1, grav: 1, windK: 0.9, drag: 0.4 });
    }
    // язычки пламени в углях — первые полминуты
    if (k > 0.65 && Math.random() < dt * 3 * (k - 0.5)) {
      const [x, z] = at();
      FX.add.spawn({ flame: true, x, y: s.fy + 0.05, z, vx: 0, vy: sr(0.4, 0.9), vz: 0, size: sr(0.25, 0.5), grow: -0.2, life: sr(0.4, 0.8), col: [1.7, 0.75, 0.28], a: 0.8, cool: 0.4, windK: 0.5 });
    }
    FIRE.structs.push({ x: s.center.x, z: s.center.z, y: s.fy + 0.4, p: k * 1.5 });
  }
}
let gT = 0, sT = 0;
export function updateStructs(dt) {
  processQueue();
  updateBurning(dt);
  sT += dt;
  updateSmolder(dt, sT > 0.5);
  if (sT > 0.5) sT = 0;
  gT += dt;
  if (gT > 1) { gT = 0; if (FIRE.cells > 0) grassToStruct(); }
}
export const structStats = () => ({ structs: STRUCTS.length, burning: BURNING.length, smolder: SMOLDER.length, broken: STRUCTS.reduce((a, s) => a + s.panels.filter(p => p.dead).length, 0) });
export const structAt = (x, z, r = 2) => STRUCTS.filter(s => s.center && Math.hypot(s.center.x - x, s.center.z - z) < s.radius + r);
