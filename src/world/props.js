import * as THREE from 'three';
import { scene, FRAME } from '../core/env.js';
import { rng, TAU, clamp } from '../core/math.js';
import { MAP, lakeContour, isFree, keep, edgeDist, terrainH, terrainNormal, SPAWNS, CLUSTERS } from './layout.js';
import { hFast } from './heightcache.js';
import { M } from '../gen/materials.js';
import { place, box, cyl } from './builders.js';
import { addBox, addCircle } from '../core/colliders.js';
import { vehicle } from './vehicles.js';
import { PHYS, addBody } from '../core/physics.js';
import { treeNear } from './forest.js';

/* ============================================================================
   УКРЫТИЯ И РЕКВИЗИТ
   Брошенные машины вдоль кольцевой, бочки (реагируют на взрывы), поваленные
   деревья, пни, валуны. Всё раскладывается парами (x,z) и (−x,−z): у каждой
   команды одинаковый набор укрытий на одинаковых дистанциях.
============================================================================ */

// Машины на кольцевой: [угол на кольце, тип, сдвиг от оси дороги, доворот, опции]
const RING_CARS = [
  [3.55, 'sedan', 3.4, 0.25, { paint: 0 }],
  [4.65, 'van', -3.6, -0.2, { paint: 3 }],
  [5.25, 'sedan', 3.2, 2.6, { flip: true, paint: 2 }],
  [2.6, 'sedan', -3.3, 0.5, { burnt: true }],
  [0.25, 'van', 3.6, 3.0, { paint: 4 }]
];
export function planProps() {
  for (const [phi, type, off] of RING_CARS) for (const k of [0, 1]) {
    const [x, z] = carPos(phi + k * Math.PI, off);
    keep(x, z, type === 'van' ? 3 : 2.6);
  }
}
function carPos(phi, off) {
  const [x0, z0] = lakeContour(phi, 11.5), [x1, z1] = lakeContour(phi + 0.02, 11.5);
  const tx = x1 - x0, tz = z1 - z0, l = Math.hypot(tx, tz);
  return [x0 - tz / l * off, z0 + tx / l * off, Math.atan2(tx / l, tz / l)];
}

/* ---------- Бочки: простое твёрдое тело (падение, отскок, качение) ---------- */
export const BARRELS = [];
let barrelIMs = [];
function buildBarrels(R) {
  const spots = [];
  const clusters = [[-52, -44, 4], [-40, -66, 3], [-24, 48, 3], [-70, 20, 3], [-12, 70, 3], [-60, -70, 2], [-88, -10, 3], [-34, 10, 2], [-50, 30, 2]];
  for (const [cx, cz, n] of clusters) for (const s of [1, -1]) for (let i = 0; i < n; i++) {
    for (let t = 0; t < 12; t++) {
      const x = cx * s + R.range(-2.5, 2.5), z = cz * s + R.range(-2.5, 2.5);
      if (!isFree(x, z, 0.4, { pathPad: 0.3 }) || treeNear(x, z, 0.5)) continue;
      spots.push([x, z, R() < 0.25]); keep(x, z, 0.5); break;
    }
  }
  const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.88, 16, 1);
  const ribs = new THREE.TorusGeometry(0.3, 0.018, 4, 16); ribs.rotateX(Math.PI / 2);
  const merged = [geo, ribs.clone().translate(0, 0.2, 0), ribs.clone().translate(0, -0.2, 0)];
  const pos = [], nrm = [], uv = [], idx = [];
  let off = 0;
  for (const g of merged) {
    const u = g.attributes.uv.array.slice();
    if (g === geo) for (let i = 0; i < u.length; i += 2) { u[i] *= 2; }
    pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); uv.push(...u);
    for (const i of g.index.array) idx.push(i + off); off += g.attributes.position.count;
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bg.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  bg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  bg.setIndex(idx);
  const per = M.barrel.map(() => []);
  spots.forEach(([x, z, tipped], i) => per[i % M.barrel.length].push([x, z, tipped]));
  barrelIMs = per.map((list, mi) => {
    const im = new THREE.InstancedMesh(bg, M.barrel[mi], Math.max(1, list.length));
    im.count = list.length; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
    scene.add(im);
    list.forEach(([x, z, tipped], k) => {
      const b = { im, k, pos: new THREE.Vector3(x, 0, z), vel: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), rest: 0, tipped };
      const y = hFast(x, z);
      if (tipped) { b.q.setFromEuler(new THREE.Euler(Math.PI / 2, R() * TAU, 0, 'YXZ')); b.pos.y = y + 0.3; }
      else { b.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * TAU); b.pos.y = y + 0.44; }
      b.col = addCircle(x, z, 0.33, y, y + 0.9);
      b.col.dyn = true;
      BARRELS.push(b);
      writeBarrel(b);
      if (PHYS.ready) {
        // бочка — полноценное тело: катится, бьётся о стволы и стены, падает в воронки
        b.phys = addBody({ shape: 'cyl', size: [0.3, 0.88], mass: 18, pos: b.pos, quat: b.q, keep: true, friction: 0.7, restitution: 0.25, rolling: 0.02, damp: [0.08, 0.25],
          sync: (p, q) => { b.pos.copy(p); b.q.copy(q); b.col.x = p.x; b.col.z = p.z; b.col.y0 = p.y - 0.45; b.col.y1 = p.y + 0.45; writeBarrel(b); } });
      }
    });
    return im;
  });
}
const _m = new THREE.Matrix4(), _one = new THREE.Vector3(1, 1, 1), _n = new THREE.Vector3(), _dq = new THREE.Quaternion(), _ax = new THREE.Vector3();
function writeBarrel(b) {
  b.im.setMatrixAt(b.k, _m.compose(b.pos, b.q, _one));
  b.im.instanceMatrix.needsUpdate = true;
}
/** Импульс от взрыва: бочки ближе 9 м подбрасывает и закручивает. */
export function blastBarrels(x, y, z, power) {
  if (PHYS.ready) return;          // бочки получают импульс вместе со всеми телами (blastImpulse)
  for (const b of BARRELS) {
    const dx = b.pos.x - x, dy = b.pos.y - y, dz = b.pos.z - z, d = Math.hypot(dx, dy, dz);
    if (d > 9) continue;
    const f = power * (1 - d / 9) * (1 - d / 9) * 14;
    b.vel.x += dx / (d + 0.3) * f; b.vel.z += dz / (d + 0.3) * f; b.vel.y += f * 0.7 + 1.5;
    b.w.set((Math.random() - 0.5) * f * 2, (Math.random() - 0.5) * f, (Math.random() - 0.5) * f * 2);
    b.rest = 0;
  }
}
export function updateBarrels(dt) {
  if (PHYS.ready) return;
  for (const b of BARRELS) {
    if (b.rest > 1.5) continue;
    b.vel.y -= 9.8 * dt;
    b.pos.addScaledVector(b.vel, dt);
    const wl = b.w.length();
    if (wl > 1e-3) { _dq.setFromAxisAngle(_ax.copy(b.w).divideScalar(wl), wl * dt); b.q.premultiply(_dq); }
    const g = terrainH(b.pos.x, b.pos.z) + 0.3;
    if (b.pos.y < g) {
      b.pos.y = g;
      terrainNormal(b.pos.x, b.pos.z, _n);
      const vn = b.vel.dot(_n);
      if (vn < 0) b.vel.addScaledVector(_n, -vn * 1.35);
      b.vel.multiplyScalar(0.8); b.w.multiplyScalar(0.75);
      // на земле бочка ложится набок и катится по склону
      b.vel.x += _n.x * 3 * dt; b.vel.z += _n.z * 3 * dt;
    }
    if (b.vel.lengthSq() < 0.05 && b.pos.y - g < 0.05) b.rest += dt; else b.rest = 0;
    b.col.x = b.pos.x; b.col.z = b.pos.z;
    writeBarrel(b);
  }
}

/* ---------- Поваленные деревья, пни, валуны ---------- */
function fallenLog(x, z, rot, L, r, R) {
  const y = hFast(x, z);
  const a = Math.cos(rot), s = Math.sin(rot);
  const y2 = hFast(x + s * L / 2, z + a * L / 2), y1 = hFast(x - s * L / 2, z - a * L / 2);
  const pitch = Math.atan2(y2 - y1, L);
  const g = new THREE.CylinderGeometry(r * 0.75, r, L, 9, 1);
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * L / 1.2);
  place(M.barkPine, g, x, y + r * 0.8, z, [Math.PI / 2 - pitch, rot, 0]);
  // обломанные сучья
  for (let i = 0; i < 4; i++) {
    const t = R.range(-0.4, 0.45) * L, bx = x + s * t, bz = z + a * t;
    cyl(M.deadwood, bx, y + r * 1.4 + 0.2, bz, 0.04, 0.02, R.range(0.5, 1.1), { seg: 4, rot: [R.range(-0.8, 0.8), R() * TAU, R.range(-0.8, 0.8)] });
  }
  // корневой выворот у части стволов
  if (R() < 0.5) {
    const rx = x - s * L / 2, rz = z - a * L / 2;
    // пласт земли с корнями: сплюснутый неровный ком, торчащие корни
    const disc = new THREE.IcosahedronGeometry(1, 1);
    const pa = disc.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const k = 1 + 0.28 * Math.sin(pa.getX(i) * 4.1 + pa.getY(i) * 3.3) + R.range(-0.08, 0.08);
      pa.setXYZ(i, pa.getX(i) * k * r * 3, pa.getY(i) * k * r * 2.6, pa.getZ(i) * 0.22);
    }
    disc.computeVertexNormals();
    const gy = hFast(rx, rz) + r * 2.0;
    place(M.dirtMound, disc, rx, gy, rz, [0.1, rot, R.range(-0.3, 0.3)]);
    for (let k = 0; k < 7; k++) {
      const ang = R() * TAU, len = R.range(0.6, 1.4);
      cyl(M.deadwood, rx + Math.cos(ang) * r * 2 * Math.cos(rot), gy + Math.sin(ang) * r * 2, rz - Math.cos(ang) * r * 2 * Math.sin(rot), 0.05, 0.015, len, { seg: 4, rot: [R.range(-1.2, 1.2), rot + R.range(-0.5, 0.5), ang] });
    }
    addBox(rx, hFast(rx, rz) + r * 2.2, rz, r * 6, r * 5.5, 0.5, rot);
  }
  addBox(x, y + r * 0.8, z, r * 1.8, r * 1.8, L, rot);
}
function stump(x, z, R) {
  const y = hFast(x, z), r = R.range(0.2, 0.42), h = R.range(0.3, 0.8);
  cyl(M.barkSpruce, x, y + h / 2 - 0.05, z, r * 1.25, r, h, { seg: 8 });
  place(M.logEnd, new THREE.CircleGeometry(r * 0.95, 9), x, y + h - 0.04, z, [-Math.PI / 2 + R.range(-0.2, 0.2), 0, R.range(-0.2, 0.2)]);
  addCircle(x, z, r * 1.2, y, y + h);
}
function boulder(x, z, s, R) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const n = 1 + 0.18 * Math.sin(vx * 3.1 + vz * 2.3) + 0.12 * Math.sin(vy * 5.2 + vx * 1.7);
    p.setXYZ(i, vx * n * R.range(0.95, 1.05), vy * n * 0.62, vz * n);
    // мох на верхней стороне
    const moss = clamp(vy * 1.4, 0, 1);
    col[i * 3] = 1 - moss * 0.45; col[i * 3 + 1] = 1 - moss * 0.12; col[i * 3 + 2] = 1 - moss * 0.6;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const y = hFast(x, z);
  place(M.stone, g, x, y + s * 0.18, z, R() * TAU, [s * R.range(1, 1.5), s, s * R.range(0.8, 1.2)]);
  addCircle(x, z, s * 1.05, y, y + s * 0.8);
}

export function buildProps() {
  const R = rng(2468);
  for (const [phi, type, off, rotAdd, opt] of RING_CARS) for (const k of [0, 1]) {
    const [x, z, rot] = carPos(phi + k * Math.PI, off);
    vehicle(type, x, z, rot + rotAdd, { ...opt, seed: Math.round(phi * 100) + k });
  }
  // колонна на южной/северной тропе: УАЗ и «копейка» съехали в лес
  for (const s of [1, -1]) {
    vehicle('van', -14 * s, 99 * s, 1.9 + (s < 0 ? Math.PI : 0), { seed: 40 + s, paint: 1, tilt: 0.1, roll: 0.12 });
    vehicle('sedan', 30 * s, 82 * s, -0.9 + (s < 0 ? Math.PI : 0), { seed: 50 + s, burnt: true });
    keep(-14 * s, 99 * s, 3); keep(30 * s, 82 * s, 3);
  }
  buildBarrels(R);
  // поваленные стволы: укрытия лёжа на средней дистанции
  let n = 0;
  for (let t = 0; t < 4000 && n < 70; t++) {
    const x = R.range(-104, 104), z = R.range(-104, 104), rot = R() * TAU, L = R.range(6, 13), r = R.range(0.22, 0.38);
    const ok = s => {
      const px = x * s, pz = z * s, ca = Math.cos(rot), sa = Math.sin(rot);
      for (const k of [-0.5, 0, 0.5]) if (!isFree(px + sa * L * k, pz + ca * L * k, 1, { pathPad: 0.6 }) || treeNear(px + sa * L * k, pz + ca * L * k, 0.8)) return false;
      return edgeDist(px, pz) < MAP.PLAY - 6;
    };
    if (!ok(1) || !ok(-1)) continue;
    for (const s of [1, -1]) { fallenLog(x * s, z * s, rot + (s < 0 ? Math.PI : 0), L, r, R); keep(x * s, z * s, L / 2); }
    n++;
  }
  for (let t = 0; t < 3000 && n < 330; t++) {
    const x = R.range(-MAP.FENCE, MAP.FENCE), z = R.range(-MAP.FENCE, MAP.FENCE);
    if (!isFree(x, z, 0.5) || treeNear(x, z, 0.6)) continue;
    stump(x, z, R); n++;
  }
  let b = 0;
  for (let t = 0; t < 3000 && b < 40; t++) {
    const x = R.range(-104, 104), z = R.range(-104, 104), s = R.range(0.6, 1.5);
    if (!isFree(x, z, s + 0.4) || !isFree(-x, -z, s + 0.4) || treeNear(x, z, s) || treeNear(-x, -z, s)) continue;
    boulder(x, z, s, R); boulder(-x, -z, s, R); keep(x, z, s); keep(-x, -z, s); b++;
  }
}
