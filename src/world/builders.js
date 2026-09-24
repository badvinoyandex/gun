import * as THREE from 'three';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
import { scene } from '../core/env.js';
import { addBox, CAPTURE } from '../core/colliders.js';

/* ============================================================================
   СТАТИЧЕСКАЯ ГЕОМЕТРИЯ
   Постройки и реквизит собираются из примитивов, но на экран уходят
   объединёнными по материалу и по квадратам 64 м: сотни досок и брёвен —
   десятки вызовов отрисовки, и отсечение по пирамиде видимости работает.
============================================================================ */
const BUCKETS = new Map();     // mat → Map(tileKey → geo[])
const TILE = 64;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

/* ---------- Разрушаемые постройки ----------
   Постройка делится на панели (кусок стены, скат кровли, дверь, лавка). Геометрия
   панели уходит в общие буферы, как и вся статика, но запоминается диапазон её
   вершин: разрушенная панель схлопывается в точку (без пересборки буфера), а на
   её месте появляются обломки-тела. Коллайдеры панели снимаются вместе с ней. */
export const STRUCTS = [];
let CUR = null, PANEL = null;
export function beginStruct(o) {
  CUR = { id: STRUCTS.length, panels: [], burn: 0, fuel: o.fuel ?? 1, charred: 0, ...o };
  STRUCTS.push(CUR);
  PANEL = null; CAPTURE.list = null;
  return CUR;
}
/** kind: wall | roof | door | trim | prop | glass …; mode: shatter (на доски) | rigid (одним телом) | dust. */
export function panel(kind, o = {}) {
  if (!CUR) return null;
  PANEL = { s: CUR, kind, mode: o.mode ?? (kind === 'wall' ? 'shatter' : 'rigid'), hp: o.hp ?? 1, parts: [], cols: [], ranges: [], dead: false,
    sup: o.sup || null, load: !!o.load, mat: o.mat || null, dims: o.dims || null, density: o.density ?? 500, float: o.float ?? 1.6, burnable: o.burnable !== false };
  CUR.panels.push(PANEL);
  CAPTURE.list = PANEL.cols; CAPTURE.panel = PANEL;
  return PANEL;
}
/** Геометрия вне панели (фундамент, печь) — неразрушаемая часть постройки. */
export function noPanel() { PANEL = null; CAPTURE.list = null; CAPTURE.panel = null; }
export function endStruct() {
  const s = CUR;
  CUR = null; PANEL = null; CAPTURE.list = null; CAPTURE.panel = null;
  if (s) {
    // габарит постройки для быстрого отбора при взрывах
    const bb = new THREE.Box3();
    for (const p of s.panels) for (const q of p.parts) { q.geo.computeBoundingBox(); bb.union(q.geo.boundingBox); }
    s.box = bb; s.center = bb.getCenter(new THREE.Vector3()); s.radius = bb.getSize(new THREE.Vector3()).length() / 2;
    for (const p of s.panels) {
      const b = new THREE.Box3();
      for (const q of p.parts) b.union(q.geo.boundingBox);
      p.box = b; p.center = b.getCenter(new THREE.Vector3());
    }
    s.panels = s.panels.filter(p => p.parts.length || p.cols.length);
  }
  return s;
}
function put(mat, geo, cast = true) {
  geo.computeBoundingSphere();
  const c = geo.boundingSphere.center;
  const k = Math.floor(c.x / TILE) * 64 + Math.floor(c.z / TILE) + (cast ? 0 : 100000);
  if (!BUCKETS.has(mat)) BUCKETS.set(mat, new Map());
  const b = BUCKETS.get(mat);
  if (!b.has(k)) b.set(k, []);
  b.get(k).push({ geo, panel: PANEL });
  if (PANEL) PANEL.parts.push({ mat, geo });
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
  // сдвиг UV: куски одной стены продолжают рисунок досок, а не начинают его заново
  if (o.uvOff) { const uv = g.attributes.uv, t = o.tile ?? 1.5, du = o.uvOff[0] / t, dv = o.uvOff[1] / t; for (let i = 16; i < 24; i++) uv.setXY(i, uv.getX(i) + (o.vertical ? dv : du), uv.getY(i) + (o.vertical ? du : dv)); }
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
    const merged = BGU.mergeGeometries(list.map(e => e.geo), false);
    if (!merged) { console.warn('merge failed', mat); continue; }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mat);
    let off = 0;
    for (const e of list) {
      const n = e.geo.attributes.position.count;
      if (e.panel) e.panel.ranges.push({ mesh, start: off, count: n });
      off += n;
    }
    mesh.castShadow = k < 100000 - 5000;
    mesh.receiveShadow = true;
    mesh.name = 'static';
    scene.add(mesh);
    draws++;
  }
  BUCKETS.clear();
  return draws;
}
/** Спрятать геометрию панели: вершины схлопываются в точку, в GPU уходит только этот диапазон. */
export function collapsePanel(p) {
  for (const r of p.ranges) {
    const pos = r.mesh.geometry.attributes.position, a = pos.array, i0 = r.start * 3;
    const x = a[i0], y = a[i0 + 1], z = a[i0 + 2];
    for (let i = i0; i < (r.start + r.count) * 3; i += 3) { a[i] = x; a[i + 1] = y; a[i + 2] = z; }
    pos.addUpdateRange(i0, r.count * 3);
    pos.needsUpdate = true;
  }
}
