import * as THREE from 'three';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
import { scene } from '../core/env.js';
import { addBox } from '../core/colliders.js';

/* ============================================================================
   СТАТИЧЕСКАЯ ГЕОМЕТРИЯ
   Постройки и реквизит собираются из примитивов, но на экран уходят
   объединёнными по материалу и по квадратам 64 м: сотни досок и брёвен —
   десятки вызовов отрисовки, и отсечение по пирамиде видимости работает.
============================================================================ */
const BUCKETS = new Map();     // mat → Map(tileKey → geo[])
const TILE = 64;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

function put(mat, geo, cast = true) {
  geo.computeBoundingSphere();
  const c = geo.boundingSphere.center;
  const k = Math.floor(c.x / TILE) * 64 + Math.floor(c.z / TILE) + (cast ? 0 : 100000);
  if (!BUCKETS.has(mat)) BUCKETS.set(mat, new Map());
  const b = BUCKETS.get(mat);
  if (!b.has(k)) b.set(k, []);
  b.get(k).push(geo);
}
function normalize(g, mat) {
  let out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) out.deleteAttribute(name);
  if (!out.attributes.uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.attributes.position.count * 2), 2));
  if (mat.vertexColors) {
    if (!out.attributes.color) out.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(out.attributes.position.count * 3).fill(1), 3));
  } else if (out.attributes.color) out.deleteAttribute('color');
  return out;
}
/** Геометрия с трансформом в общий буфер. rot — [rx,ry,rz] или число (ry). */
export function place(mat, geo, x, y, z, rot = 0, scale = 1, opt = {}) {
  const g = geo.clone();
  const r = typeof rot === 'number' ? [0, rot, 0] : rot;
  _e.set(r[0], r[1], r[2], 'YXZ');
  _q.setFromEuler(_e);
  if (typeof scale === 'number') _s.setScalar(scale); else _s.set(scale[0], scale[1], scale[2]);
  _m.compose(_v.set(x, y, z), _q, _s);
  g.applyMatrix4(_m);
  put(mat, normalize(g, mat), opt.cast !== false);
  return g;
}
/** Масштаб UV бокса в метрах: текстура одного размера на любой грани. */
export function uvBox(g, sx, sy, sz, tile = 1.5, vertical = false) {
  const uv = g.attributes.uv;
  const dims = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    let u = uv.getX(i) * dims[f][0] / tile, v = uv.getY(i) * dims[f][1] / tile;
    if (vertical) [u, v] = [v, u];
    uv.setXY(i, u, v);
  }
  return g;
}
/** Бокс с поворотом, UV в метрах и, по желанию, коллайдером. */
export function box(mat, x, y, z, sx, sy, sz, o = {}) {
  const g = uvBox(new THREE.BoxGeometry(sx, sy, sz), sx, sy, sz, o.tile ?? 1.5, o.vertical);
  const ry = o.rot ?? 0;
  place(mat, g, x, y, z, [o.rx ?? 0, ry, o.rz ?? 0], 1, o);
  if (o.collide) addBox(x, y, z, sx, sy, sz, ry, { walk: o.walk !== false });
}
export function cyl(mat, x, y, z, r0, r1, h, o = {}) {
  const g = new THREE.CylinderGeometry(r1, r0, h, o.seg ?? 8, 1, o.open ?? false);
  if (o.tile) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r0 / o.tile, uv.getY(i) * h / o.tile); }
  place(mat, g, x, y, z, o.rot ?? 0, 1, o);
}
/** Цилиндр между двумя точками (брёвна, трубы, раскосы). */
const _up = new THREE.Vector3(0, 1, 0);
export function beam(mat, a, b, r, o = {}) {
  const d = new THREE.Vector3().subVectors(b, a), L = d.length();
  const g = new THREE.CylinderGeometry(o.r1 ?? r, r, L, o.seg ?? 7, 1, false);
  if (o.tile) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * L / o.tile); }
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d.normalize());
  g.applyQuaternion(q);
  const c = a.clone().add(b).multiplyScalar(0.5);
  g.translate(c.x, c.y, c.z);
  put(mat, normalize(g, mat), o.cast !== false);
}
/** Локальная система: точка (lx,lz) относительно (x,z) с поворотом rot. */
export function frame(x, z, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return {
    x, z, rot,
    p: (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c]
  };
}
export function flushStatic() {
  let draws = 0;
  for (const [mat, tiles] of BUCKETS) for (const [k, list] of tiles) {
    const merged = BGU.mergeGeometries(list, false);
    if (!merged) { console.warn('merge failed', mat); continue; }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = k < 100000 - 5000;
    mesh.receiveShadow = true;
    mesh.name = 'static';
    scene.add(mesh);
    draws++;
  }
  BUCKETS.clear();
  return draws;
}
