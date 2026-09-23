import * as THREE from 'three';
import { scene, camera, FRAME, Q } from '../core/env.js';
import { clamp, lerp, smoothstep, sr, srnd, TAU } from '../core/math.js';
import { DYN_CRATERS, craterDelta, terrainH, lakeRho, MAP } from '../world/layout.js';
import { hFast, heightGrid } from '../world/heightcache.js';
import { TERRAIN, aoAt } from '../world/terrain.js';
import { treesNear, hideTree, charTree, thinTree, treeGeo } from '../world/forest.js';
import { addCircle } from '../core/colliders.js';
import { PHYS, addBody, syncHeights, blastImpulse, freezeBody, isSleeping, removeStaticCollider, addStaticCollider } from '../core/physics.js';
import { M } from '../gen/materials.js';
import { FX } from './particles.js';
import { ignite, scorch, markPuddle, igniteTree, attachFire } from './fire.js';
import { blastGlass } from './glass.js';
import { woodCrack } from './audio.js';
import { WEATHER, refreshRainHeights } from '../world/weather.js';
import { refreshGrass } from '../world/groundcover.js';

/* ============================================================================
   РАЗРУШЕНИЯ
   • Воронка: рельеф проседает по-настоящему — сетка земли, кэш высот (по нему
     ходит игрок), карта высот физики. В воронке копоть, выбитая трава, в дождь
     собирается лужа.
   • Комья земли — физические тела: падают в воронку и в окопы, скатываются.
   • Деревья: слабая волна обрывает ветки (падают телами, часть горит), сильная
     ломает ствол — остаётся расщеплённый пень, верхушка валится по физике
     в сторону от взрыва и остаётся лежать препятствием. Ближние кроны
     занимаются огнём и обугливаются.
   • Ударная волна: вспышка-сфера, кольцо пыли по земле, импульс телам,
     стёкла, отброс игрока.
============================================================================ */
const _v = new THREE.Vector3(), _d = new THREE.Vector3();
let clodGeo = null, clodMat = null, splGeo = null, waveMeshes = [], waveI = 0;
const FALLING = [];

export function buildDestruction() {
  clodGeo = new THREE.IcosahedronGeometry(1, 0);
  clodMat = new THREE.MeshStandardMaterial({ color: 0x3b2c20, roughness: 1 });
  splGeo = new THREE.BoxGeometry(1, 1, 1);
  const wm = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uA: { value: 0 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uA; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); gl_FragColor = vec4(vec3(1.0, 0.92, 0.8) * f * uA, f * uA); }`
  });
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), wm.clone());
    m.visible = false; m.renderOrder = 8; m.frustumCulled = false;
    scene.add(m); waveMeshes.push(m);
  }
}

/** Прогрев шейдеров: варианты материалов обломков компилируются при загрузке, а не в момент взрыва. */
let WARM = null;
export function warmupDestruction() {
  WARM = new THREE.Group();
  const g = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
  const mats = [M.spruce, M.pine, M.birch, M.barkSpruce, M.barkPine, M.barkBirch, M.logEnd, M.deadwood, clodMat];
  for (const m of mats) { const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; WARM.add(mesh); }
  for (const sp of ['spruce', 'pine', 'birch']) WARM.add(new THREE.Mesh(branchGeo(sp), [M.deadwood, M[sp]]));
  WARM.position.set(0, -900, 0);
  scene.add(WARM);
}
export function endWarmup() { if (WARM) { scene.remove(WARM); WARM = null; } }

/* ---------- Воронка ---------- */
export function deformCrater(x, z, r) {
  if (DYN_CRATERS.length > 180 || lakeRho(x, z) < 1.02) return;
  // повторное попадание в ту же воронку углубляет её, но не бесконечно
  let dep = 0.36 * r;
  for (const c of DYN_CRATERS) if (Math.hypot(c.x - x, c.z - z) < c.r * 0.6) dep *= 0.55;
  const c = { x, z, r, dep, rim: 0.1 * r };
  DYN_CRATERS.push(c);
  const G = heightGrid(), R6 = r * 1.6;
  if (G.H) {
    const i0 = clamp(Math.floor((x - R6 + G.R) / G.HS), 0, G.HN - 1), i1 = clamp(Math.ceil((x + R6 + G.R) / G.HS), 0, G.HN - 1);
    const j0 = clamp(Math.floor((z - R6 + G.R) / G.HS), 0, G.HN - 1), j1 = clamp(Math.ceil((z + R6 + G.R) / G.HS), 0, G.HN - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) G.H[j * G.HN + i] += craterDelta(c, -G.R + i * G.HS, -G.R + j * G.HS);
    syncHeights(G.H, i0, j0, i1, j1);
    // трава в чаше выбита
    const a0 = clamp(Math.floor((x - r * 1.2 + G.R) / G.DS), 0, G.DN - 1), a1 = clamp(Math.ceil((x + r * 1.2 + G.R) / G.DS), 0, G.DN - 1);
    const b0 = clamp(Math.floor((z - r * 1.2 + G.R) / G.DS), 0, G.DN - 1), b1 = clamp(Math.ceil((z + r * 1.2 + G.R) / G.DS), 0, G.DN - 1);
    for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) {
      const d = Math.hypot(-G.R + i * G.DS - x, -G.R + j * G.DS - z);
      G.GD[j * G.DN + i] *= smoothstep(r * 0.55, r * 1.2, d);
    }
  }
  for (const mesh of TERRAIN.chunks) {
    const g = mesh.geometry, ud = g.userData;
    if (!ud || !ud.nGrid) continue;
    const bb = g.boundingBox;
    if (x + R6 < bb.min.x || x - R6 > bb.max.x || z + R6 < bb.min.z || z - R6 > bb.max.z) continue;
    const pos = g.attributes.position, nrm = g.attributes.normal, spl = g.attributes.aSplat, ao = g.attributes.aAO, e = ud.step;
    for (let k = 0; k < ud.nGrid; k++) {
      const vx = pos.getX(k), vz = pos.getZ(k), d = Math.hypot(vx - x, vz - z);
      if (d > R6 + e) continue;
      const h = terrainH(vx, vz);
      pos.setY(k, h);
      const hl = terrainH(vx - e, vz), hr = terrainH(vx + e, vz), hd = terrainH(vx, vz - e), hu = terrainH(vx, vz + e);
      _v.set(hl - hr, 2 * e, hd - hu).normalize();
      nrm.setXYZ(k, _v.x, _v.y, _v.z);
      spl.setZ(k, Math.max(spl.getZ(k), 1 - smoothstep(r * 0.7, r * 1.45, d)));
      spl.setW(k, spl.getW(k) * smoothstep(0, r * 1.3, d));
      ao.setX(k, aoAt(vx, vz, h));
    }
    pos.needsUpdate = nrm.needsUpdate = spl.needsUpdate = ao.needsUpdate = true;
    g.computeBoundingBox(); g.computeBoundingSphere();
  }
  refreshGrass(true);
  refreshRainHeights();
}

/* ---------- Мелкие обломки ---------- */
function clods(x, y, z, size, n) {
  for (let i = 0; i < n; i++) {
    const s = sr(0.05, 0.14) * (0.8 + size * 0.25), a = srnd() * TAU, e = sr(0.6, 1.35), sp = sr(4, 11) * Math.sqrt(size);
    const mesh = new THREE.Mesh(clodGeo, clodMat);
    mesh.scale.setScalar(s); mesh.castShadow = true;
    const pos = new THREE.Vector3(x + Math.cos(a) * 0.4, y + 0.3, z + Math.sin(a) * 0.4);
    scene.add(mesh);
    const b = addBody({ shape: 'sphere', size: [s], mass: 1.5, pos, vel: new THREE.Vector3(Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp, Math.sin(a) * Math.cos(e) * sp),
      ang: new THREE.Vector3(sr(-9, 9), sr(-9, 9), sr(-9, 9)), mesh, life: sr(4, 9), friction: 0.9, restitution: 0.1, rolling: 0.1, damp: [0.1, 0.4],
      onDone: () => scene.remove(mesh) });
    if (!b) { scene.remove(mesh); return; }
    // сохранить масштаб при затухании: mesh.scale трогает физика, поэтому масштаб — через sync
    b.mesh = null; b.sync = (p, q, f) => { mesh.position.copy(p); mesh.quaternion.copy(q); mesh.scale.setScalar(s * f); };
  }
}
export function splinters(x, y, z, dir, n, mat = M.logEnd, len = 0.5) {
  for (let i = 0; i < n; i++) {
    const L = sr(0.12, len), w = sr(0.02, 0.06);
    const mesh = new THREE.Mesh(splGeo, mat);
    mesh.castShadow = true; scene.add(mesh);
    const pos = new THREE.Vector3(x + sr(-0.2, 0.2), y + sr(-0.3, 0.3), z + sr(-0.2, 0.2));
    const vel = new THREE.Vector3(dir.x * sr(2, 7) + sr(-2, 2), sr(1, 5), dir.z * sr(2, 7) + sr(-2, 2));
    const b = addBody({ shape: 'box', size: [w, w, L], mass: 0.3, pos, quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(srnd() * 6, srnd() * 6, 0)), vel,
      ang: new THREE.Vector3(sr(-12, 12), sr(-12, 12), sr(-12, 12)), life: sr(8, 16), restitution: 0.3, onDone: () => scene.remove(mesh) });
    if (!b) { scene.remove(mesh); return; }
    b.sync = (p, q, f) => { mesh.position.copy(p); mesh.quaternion.copy(q); mesh.scale.set(w * f, w * f, L * f); };
  }
}

/* ---------- Ветки ---------- */
const BRANCH_GEO = {};
function branchGeo(sp) {
  if (BRANCH_GEO[sp]) return BRANCH_GEO[sp];
  // сук вдоль X (длина 1) + три карточки хвои/листвы вдоль него
  const stick = new THREE.CylinderGeometry(0.018, 0.032, 1, 5, 1).rotateZ(Math.PI / 2).toNonIndexed();
  const cards = [];
  for (let k = 0; k < 4; k++) {
    const c = new THREE.PlaneGeometry(0.5, 0.36).toNonIndexed();
    const uv = c.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5 + (k % 2) * 0.5, uv.getY(i) * 0.5 + (k > 1 ? 0.5 : 0));
    c.rotateX(-Math.PI / 2 + (k % 2 ? 0.5 : -0.5)); c.translate(-0.1 + k * 0.18, 0.02, 0);
    cards.push(c);
  }
  const g = new THREE.BufferGeometry();
  const parts = [stick, ...cards];
  let n = 0; for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3).fill(0.85);
  let o = 0;
  for (const p of parts) { pos.set(p.attributes.position.array, o * 3); nrm.set(p.attributes.normal.array, o * 3); uv.set(p.attributes.uv.array, o * 2); o += p.attributes.position.count; }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.addGroup(0, stick.attributes.position.count, 0); g.addGroup(stick.attributes.position.count, n - stick.attributes.position.count, 1);
  return (BRANCH_GEO[sp] = g);
}
function dropBranches(t, dir, n, hot) {
  const G = treeGeo(t);
  for (let i = 0; i < n; i++) {
    const L = sr(0.6, 1.7) * (t.h / 16), y = t.y + t.h * sr(0.35, 0.85), a = Math.atan2(dir.z, dir.x) + sr(-1.3, 1.3), r = sr(0.3, 1) * t.h * 0.1;
    const pos = new THREE.Vector3(t.x + Math.cos(a) * r, y, t.z + Math.sin(a) * r);
    const mesh = new THREE.Mesh(branchGeo(G.sp), [M.deadwood, G.foliage]);
    mesh.scale.setScalar(L); scene.add(mesh);
    const vel = new THREE.Vector3(dir.x * sr(1, 5) + sr(-1, 1), sr(-0.5, 2.5), dir.z * sr(1, 5) + sr(-1, 1));
    const b = addBody({ shape: 'box', size: [L, 0.1 * L, 0.3 * L], mass: 3 * L, pos, quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(sr(-0.4, 0.4), srnd() * TAU, sr(-0.4, 0.4))), vel,
      ang: new THREE.Vector3(sr(-4, 4), sr(-4, 4), sr(-4, 4)), life: sr(25, 45), friction: 0.9, restitution: 0.05, damp: [0.35, 0.6], onDone: () => scene.remove(mesh) });
    if (!b) { scene.remove(mesh); continue; }
    b.sync = (p, q, f) => { mesh.position.copy(p); mesh.quaternion.copy(q); mesh.scale.setScalar(L * f); };
    if (hot && Math.random() < 0.45 * (1 - WEATHER.wet)) attachFire(b, sr(5, 12));
  }
  // хвоя и сор сыплются с кроны
  for (let i = 0; i < 26; i++) FX.alpha.spawn({ x: t.x + sr(-1.5, 1.5), y: t.y + t.h * sr(0.4, 0.9), z: t.z + sr(-1.5, 1.5), vx: dir.x * sr(0.5, 3), vy: sr(-0.5, 0.5), vz: dir.z * sr(0.5, 3),
    size: sr(0.06, 0.16), life: sr(2.5, 5), col: [0.22, 0.2, 0.1], a: 0.9, grav: 1.4, drag: 1.2, windK: 1, floor: hFast(t.x, t.z) });
}

/* ---------- Излом ствола ---------- */
function colorize(g, c) {
  const n = g.attributes.position.count, col = g.attributes.color ? g.attributes.color.array : new Float32Array(n * 3).fill(1);
  for (let i = 0; i < n; i++) { col[i * 3] *= c.r; col[i * 3 + 1] *= c.g; col[i * 3 + 2] *= c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function breakTree(t, dir, k) {
  const G = treeGeo(t);
  hideTree(t);
  const hb = clamp(sr(0.5, 2.4) / (1 + k * 0.12), 0.35, t.h * 0.3), L = t.h - hb;
  const tint = new THREE.Color(t.tint, t.tint, t.tint).multiplyScalar(1 - (t.char || 0) * 0.7);
  const rBase = t.r * 1.05, rB = t.r * (1 - 0.6 * hb / t.h);
  // пень: расщеплённый верх, свежая древесина на изломе
  const sg = new THREE.CylinderGeometry(rB, rBase, hb, 10, 1, false);
  const sp = sg.attributes.position;
  for (let i = 0; i < sp.count; i++) if (sp.getY(i) > hb / 2 - 1e-3 && Math.abs(sp.getX(i)) + Math.abs(sp.getZ(i)) > 1e-4) sp.setY(i, hb / 2 + sr(-0.05, 0.25));
  sg.computeVertexNormals();
  const stump = new THREE.Mesh(colorize(sg, tint), G.bark);
  stump.position.set(t.x, t.y + hb / 2, t.z); stump.castShadow = stump.receiveShadow = true; scene.add(stump);
  const cap = new THREE.Mesh(new THREE.CircleGeometry(rB * 0.9, 10), M.logEnd);
  cap.rotation.x = -Math.PI / 2; cap.position.set(t.x, t.y + hb + 0.04, t.z); scene.add(cap);
  if (t.col) { removeStaticCollider(t.col); t.col.y1 = t.y + hb; addStaticCollider(t.col); }
  splinters(t.x, t.y + hb, t.z, dir, 7);
  // верхняя часть: ствол + крона выше излома; центр масс на 40% длины
  const yc = L * 0.4;
  const tg = colorize(new THREE.CylinderGeometry(t.r * 0.15, rB * 0.97, L, 8, 3).translate(0, L / 2 - yc, 0), tint);
  let cg = G.crown.index ? G.crown.toNonIndexed() : G.crown.clone();
  cg.scale(t.h, t.h, t.h); cg.rotateY(t.rot); cg.translate(0, -hb, 0);
  {
    // оставить треугольники выше излома
    const p = cg.attributes.position, keep = [];
    for (let i = 0; i < p.count; i += 3) if (Math.min(p.getY(i), p.getY(i + 1), p.getY(i + 2)) > 0.05) keep.push(i);
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv', 'color']) {
      const a = cg.attributes[name]; if (!a) continue;
      const arr = new Float32Array(keep.length * 3 * a.itemSize);
      keep.forEach((i, n) => { for (let v = 0; v < 3; v++) for (let c = 0; c < a.itemSize; c++) arr[(n * 3 + v) * a.itemSize + c] = a.array[(i + v) * a.itemSize + c]; });
      out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
    }
    cg = colorize(out, t.color); cg.translate(0, -yc, 0);
  }
  const group = new THREE.Group();
  const trunkM = new THREE.Mesh(tg, G.bark), crownM = new THREE.Mesh(cg, G.foliage);
  trunkM.castShadow = crownM.castShadow = true; trunkM.receiveShadow = crownM.receiveShadow = true;
  crownM.customDepthMaterial = t.L.hiIM.customDepthMaterial;
  group.add(trunkM, crownM); scene.add(group);
  const start = new THREE.Vector3(t.x, t.y + hb + yc + 0.02, t.z);
  group.position.copy(start);
  const axis = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
  const tilt = new THREE.Quaternion().setFromAxisAngle(axis, 0.04 + k * 0.02);
  const crownR = t.h * (t.sp === 'birch' ? 0.1 : 0.12);
  const fall = { t, group, age: 0, L, hb, yc, frozen: false, axis, ang: 0.04, w: 0.35 + k * 0.4 };
  fall.b = addBody({ shape: 'compound', mass: 120 + 900 * t.r * t.r * t.h, pos: start, quat: tilt, keep: true, friction: 1.0, restitution: 0.05, damp: [0.08, 0.35],
    parts: [{ type: 'cyl', size: [Math.max(0.08, rB * 0.8), L], pos: [0, L / 2 - yc, 0] }, { type: 'cyl', size: [crownR, L * 0.5], pos: [0, L * 0.68 - yc, 0] }],
    vel: new THREE.Vector3(dir.x * (0.6 + k * 0.5), 0.2, dir.z * (0.6 + k * 0.5)), ang: axis.clone().multiplyScalar(0.35 + k * 0.45),
    sync: (p, q) => { group.position.copy(p); group.quaternion.copy(q); } });
  if (!fall.b) group.quaternion.copy(tilt);
  FALLING.push(fall);
  const d = camera.position.distanceTo(start);
  woodCrack(d, 0, 1);
  if (t.char > 0.3 || Math.random() < 0.2) igniteTree({ ...t, h: L, y: t.y + hb, x: t.x + dir.x * L * 0.6, z: t.z + dir.z * L * 0.6 }, 6 + k * 4);
}
/** Упавший ствол: без физики — падение как шарнир; после успокоения — препятствие для игрока. */
function updateFalling(dt) {
  for (const f of FALLING) {
    if (f.frozen) continue;
    f.age += dt;
    if (!f.b) {
      f.w += dt * 1.4 * Math.sin(f.ang) * 9.8 / f.L; f.ang = Math.min(1.45, f.ang + f.w * dt);
      const q = new THREE.Quaternion().setFromAxisAngle(f.axis, f.ang);
      const base = new THREE.Vector3(f.t.x, f.t.y + f.hb, f.t.z);
      f.group.quaternion.copy(q); f.group.position.copy(base).add(new THREE.Vector3(0, f.yc, 0).applyQuaternion(q));
      if (f.ang >= 1.45) settle(f);
      continue;
    }
    if (f.age > 1.5 && (isSleeping(f.b) || f.age > 16)) settle(f);
  }
}
function settle(f) {
  f.frozen = true;
  if (f.b) freezeBody(f.b);
  // цепочка кругов вдоль ствола — по ней игрок упирается в бревно, но может перелезть низкое
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(f.group.quaternion);
  const base = f.group.position.clone().addScaledVector(up, -f.yc);
  const r = Math.max(0.15, f.t.r * 0.8);
  for (let s = 0.3; s < f.L * 0.75; s += 0.8) {
    const p = base.clone().addScaledVector(up, s);
    addCircle(p.x, p.z, r, p.y - r, p.y + r).dyn = true;
  }
}

/* ---------- Ударная волна ---------- */
const WAVES = [];
function shockwave(x, y, z, size, water) {
  const m = waveMeshes[waveI++ % waveMeshes.length];
  m.position.set(x, y + 0.3, z); m.visible = true;
  WAVES.push({ m, age: 0, size });
  // кольцо пыли, бегущее по земле
  const n = Math.round(22 + 16 * size), dust = water ? [0.7, 0.72, 0.74] : WEATHER.wet > 0.5 ? [0.22, 0.2, 0.18] : [0.42, 0.38, 0.32];
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU + sr(-0.1, 0.1), sp = sr(9, 16) * Math.sqrt(size);
    FX.alpha.spawn({ x: x + Math.cos(a) * 0.8, y: y + 0.25, z: z + Math.sin(a) * 0.8, vx: Math.cos(a) * sp, vy: sr(0, 0.8), vz: Math.sin(a) * sp,
      size: sr(0.7, 1.4), grow: 2.2, life: sr(1.2, 2.2), col: dust, a: water ? 0.35 : 0.3, drag: 2.6, windK: 0.5 });
  }
}
function updateWaves(dt) {
  for (let i = WAVES.length - 1; i >= 0; i--) {
    const w = WAVES[i];
    w.age += dt;
    const k = w.age / 0.32;
    if (k >= 1) { w.m.visible = false; WAVES.splice(i, 1); continue; }
    w.m.scale.setScalar(0.6 + k * 8 * w.size);
    w.m.material.uniforms.uA.value = (1 - k) * (1 - k) * 0.55;
  }
}

/* ---------- Главная точка входа: взрыв ---------- */
export function onBlast(x, gy, z, size, water, opt = {}) {
  if (!water) {
    const r = 0.85 + 0.75 * size;
    deformCrater(x, z, r);
    scorch(x, z, Math.ceil(r * 1.7), 1);
    markPuddle(x, z, Math.ceil(r));
    clods(x, gy, z, size, Math.round((5 + 5 * size) * (0.5 + Q.tex * 0.5)));
    // трава занимается от вспышки: сухая — почти всегда, мокрая — редко
    const dry = 1 - WEATHER.wet;
    if (Math.random() < 0.25 + 0.7 * dry) ignite(x, z, Math.ceil(r * 1.2 + size), 0.25 + 0.5 * dry);
  }
  // деревья
  const wet = WEATHER.wet;
  for (const t of treesNear(x, z, 9 * size + 3)) {
    const d = Math.max(0.45, Math.hypot(t.x - x, t.z - z) - t.r);
    const k = size * 2.2 / Math.pow(d, 1.15);
    const strength = Math.max(0.5, t.r / 0.3);
    _d.set(t.x - x, 0, t.z - z).normalize();
    if (k > 1.15 * strength && Math.random() < 0.92) { breakTree(t, _d.clone(), k); continue; }
    if (!t.dead && k > 0.22) {
      dropBranches(t, _d, Math.min(9, Math.round(1 + k * 5 * (0.6 + Q.tex * 0.4))), d < 3 * size);
      thinTree(t, Math.min(0.5, k * 0.25));
    }
    if (!t.dead && d < 3.5 * size && Math.random() < 0.5 * (1 - wet)) { igniteTree(t, 8 + k * 10); charTree(t, 0.55); }
    else if (d < 3 * size) charTree(t, 0.25);
  }
  blastGlass(x, gy, z, size);
  blastImpulse(x, gy, z, 9 * size + 4, 9 * size);
  shockwave(x, gy, z, size, water);
  return true;
}
/** Близкая молния: бьёт в самое высокое дерево рядом — расщеп, огонь в кроне. */
export function lightningHit(x, z) {
  const list = treesNear(x, z, 14);
  if (!list.length) { if (Math.abs(x) < 120 && Math.abs(z) < 120) { scorch(x, z, 2, 0.8); ignite(x, z, 1, 0.8); } return; }
  const t = list.reduce((a, b) => (b.h > a.h ? b : a));
  const dir = new THREE.Vector3(sr(-1, 1), 0, sr(-1, 1)).normalize();
  charTree(t, 0.8);
  if (Math.random() < 0.5 && !t.dead) { dropBranches(t, dir, 6, true); igniteTree(t, 25); }
  else breakTree(t, dir, 1.6);
  scorch(t.x, t.z, 2, 1);
}
export function updateDestruction(dt) {
  updateFalling(dt);
  updateWaves(dt);
}
export const destructionStats = () => ({ craters: DYN_CRATERS.length, fallen: FALLING.length });
