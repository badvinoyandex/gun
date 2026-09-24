import * as THREE from 'three';
import { scene, camera, FRAME } from '../core/env.js';
import { sr, srnd, TAU } from '../core/math.js';
import { PHYS, addBody } from '../core/physics.js';
import { FX } from './particles.js';
import { glassSound } from './audio.js';
import { addBox, CAPTURE } from '../core/colliders.js';

/* ============================================================================
   СТЕКЛО
   Целые стёкла в рамах домов и машин — один инстанс-меш. Взрыв выбивает их
   с задержкой по скорости звука (ближние раньше дальних), пуля — сразу.
   Разбитое стекло разлетается осколками-телами: они звенят по полу,
   отскакивают от стен и остаются лежать.
============================================================================ */
export const PANES = [];
let im = null, shardMat = null;
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();

/** Регистрация стекла: центр, поворот [rx, ry, rz] (YXZ), ширина, высота. */
export function addPane(x, y, z, rot, w, h, o = {}) {
  _e.set(rot[0], rot[1], rot[2], 'YXZ');
  const q = new THREE.Quaternion().setFromEuler(_e);
  const p = { pos: new THREE.Vector3(x, y, z), q, w, h, alive: true, i: PANES.length, tint: o.tint ?? 0, normal: new THREE.Vector3(0, 0, 1).applyQuaternion(q) };
  PANES.push(p);
  // коллайдер для дрона: стекло держит, пока не разбито (в физику идёт отдельным телом)
  if (Math.abs(rot[0]) < 0.35 && Math.abs(rot[2]) < 0.35) { p.col = addBox(x, y, z, w, h * Math.cos(rot[0]), 0.05, rot[1], { walk: false }); p.col.dyn = true; p.col.pane = p; }
  p.panel = CAPTURE.panel || null;
  return p;
}
export function buildGlass() {
  const mat = new THREE.MeshPhysicalMaterial({ color: 0x9fb2b8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.32, reflectivity: 0.9, side: THREE.DoubleSide, depthWrite: false });
  shardMat = mat.clone(); shardMat.opacity = 0.55;
  im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, Math.max(1, PANES.length));
  im.count = PANES.length; im.frustumCulled = false; im.renderOrder = 3;
  for (const p of PANES) writePane(p);
  scene.add(im);
  // для лучей: у каждого стекла тонкое статическое тело с индексом −1000−i
  if (PHYS.ready) for (const p of PANES) p.body = paneBody(p);
}
function writePane(p) {
  _s.set(p.alive ? p.w : 0, p.alive ? p.h : 0, 0.008);
  im.setMatrixAt(p.i, _m.compose(p.pos, p.q, _s));
  im.instanceMatrix.needsUpdate = true;
}
function paneBody(p) {
  const A = PHYS.A;
  const shape = new A.btBoxShape(new A.btVector3(p.w / 2, p.h / 2, 0.01));
  const tr = new A.btTransform(); tr.setIdentity();
  tr.setOrigin(new A.btVector3(p.pos.x, p.pos.y, p.pos.z)); tr.setRotation(new A.btQuaternion(p.q.x, p.q.y, p.q.z, p.q.w));
  const info = new A.btRigidBodyConstructionInfo(0, new A.btDefaultMotionState(tr), shape, new A.btVector3(0, 0, 0));
  const b = new A.btRigidBody(info);
  b.setUserIndex(-1000 - p.i);
  PHYS.world.addRigidBody(b, 2, -1);
  return b;
}
/** Разбить стекло: dir — направление удара (от взрыва/по пуле), force — сила разлёта. */
export function breakPane(p, dir, force = 4, hit = null) {
  if (!p.alive) return;
  p.alive = false; writePane(p);
  if (p.col) p.col.dead = true;
  if (p.body) { PHYS.world.removeRigidBody(p.body); p.body = null; }
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(p.q), up = new THREE.Vector3(0, 1, 0).applyQuaternion(p.q);
  const n = Math.min(16, 5 + Math.round(p.w * p.h * 14));
  for (let i = 0; i < n; i++) {
    // осколок: клин неправильной формы, размер от 4 до 22 см
    const u = sr(-0.5, 0.5), v = sr(-0.5, 0.5), s = sr(0.04, 0.22) * Math.min(1, (p.w + p.h));
    const pos = p.pos.clone().addScaledVector(right, u * p.w).addScaledVector(up, v * p.h);
    if (hit) pos.lerp(hit, 0.2);
    const vel = dir.clone().multiplyScalar(force * sr(0.4, 1.2)).add(new THREE.Vector3(sr(-1, 1), sr(-0.3, 1.2), sr(-1, 1)));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(srnd() * TAU, srnd() * TAU, srnd() * TAU));
    const g = shardGeo(s);
    const mesh = new THREE.Mesh(g, shardMat);
    mesh.position.copy(pos); mesh.quaternion.copy(q);
    scene.add(mesh);
    const b = addBody({ shape: 'box', size: [s, s * 0.8, 0.03], mass: 0.08, pos, quat: q, vel, ang: new THREE.Vector3(sr(-15, 15), sr(-15, 15), sr(-15, 15)),
      mesh, life: sr(14, 24), friction: 0.5, restitution: 0.35, ccd: 0.02, float: 0, rad: 0.02, onDone: () => { scene.remove(mesh); g.dispose(); } });
    if (!b) { // без физики — просто падающие блёстки
      scene.remove(mesh); g.dispose();
    }
  }
  for (let i = 0; i < 14; i++) FX.add.spawn({ x: p.pos.x + sr(-p.w, p.w) * 0.5, y: p.pos.y + sr(-p.h, p.h) * 0.5, z: p.pos.z + sr(-0.2, 0.2), vx: dir.x * force * 0.5 + sr(-1, 1), vy: sr(-0.5, 2), vz: dir.z * force * 0.5 + sr(-1, 1), size: 0.03, life: sr(0.4, 1.2), col: [1.6, 1.7, 1.8], a: 0.8, grav: 9.8, drag: 0.5 });
  const d = camera.position.distanceTo(p.pos);
  const rightC = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  glassSound(0, rightC.dot(p.pos.clone().sub(camera.position).normalize()) * (d > 1 ? 1 : 0));
}
function shardGeo(s) {
  const g = new THREE.BufferGeometry(), k = [sr(0.5, 1), sr(0.5, 1), sr(0.5, 1)];
  const a = [0, s * k[0]], b = [-s * k[1] * 0.8, -s * 0.5], c = [s * k[2] * 0.8, -s * 0.4];
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([a[0], a[1], 0, b[0], b[1], 0, c[0], c[1], 0]), 3));
  g.computeVertexNormals();
  return g;
}
const PENDING = [];
/** Волна от взрыва: стёкла в радиусе бьются с запаздыванием по звуку. */
export function blastGlass(x, y, z, size) {
  const R = 16 * size + 6;
  for (const p of PANES) {
    if (!p.alive) continue;
    const d = p.pos.distanceTo(_p.set(x, y, z));
    if (d > R) continue;
    const chance = d < R * 0.45 ? 1 : 1 - (d - R * 0.45) / (R * 0.55);
    if (Math.random() > chance) continue;
    const dir = p.pos.clone().sub(_p).normalize();
    PENDING.push({ p, t: FRAME.t + d / 343, dir, force: Math.max(1.5, 9 * size / (1 + d * 0.3)) });
  }
}
export function updateGlass() {
  for (let i = PENDING.length - 1; i >= 0; i--) {
    const e = PENDING[i];
    if (FRAME.t < e.t) continue;
    PENDING.splice(i, 1);
    breakPane(e.p, e.dir, e.force);
  }
}
export const paneByIndex = idx => PANES[-1000 - idx];
export const breakPaneRef = (p, dir, force) => breakPane(p, dir, force);
export const glassStats = () => ({ panes: PANES.length, intact: PANES.filter(p => p.alive).length });
