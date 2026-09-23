import * as THREE from 'three';
import { rng, TAU } from '../core/math.js';
import { terrainH } from './layout.js';
import { M } from '../gen/materials.js';
import { place, box } from './builders.js';
import { addBox } from '../core/colliders.js';

/* ============================================================================
   РЖАВАЯ ТЕХНИКА: «копейка», «буханка», ПАЗ, грузовик.
   Кузов — выдавленный профиль борта со скруглёнными кромками, окна —
   тёмные проёмы или остатки стекла, колёса спущены или сняты (машина
   проседает на угол). Сгоревшие — без стёкол и резины, на ободах.
============================================================================ */
const TYPES = {
  sedan: {
    L: 4.1, W: 1.62, H: 1.4, clear: 0.3, wheelR: 0.3, axle: [1.25, -1.2],
    profile: [[-2.05, 0.35], [-2.05, 0.82], [-0.95, 0.86], [-0.55, 1.36], [0.75, 1.38], [1.15, 0.9], [2.05, 0.84], [2.05, 0.35]],
    windows: [[-0.5, -0.02, 0.92, 1.3], [0.1, 0.7, 0.92, 1.3]], shield: [-0.95, 0.86, -0.55, 1.36], rear: [0.75, 1.38, 1.15, 0.9]
  },
  van: {
    L: 4.4, W: 1.95, H: 2.1, clear: 0.35, wheelR: 0.38, axle: [1.35, -1.3],
    profile: [[-2.2, 0.45], [-2.2, 1.35], [-2.0, 1.95], [-1.7, 2.08], [1.9, 2.08], [2.2, 1.9], [2.2, 0.45]],
    windows: [[-1.9, -1.1, 1.3, 1.85], [-0.6, 0.4, 1.35, 1.8], [0.7, 1.7, 1.35, 1.8]], shield: [-2.2, 1.35, -2.0, 1.92]
  },
  bus: {
    L: 7.4, W: 2.4, H: 2.9, clear: 0.4, wheelR: 0.46, axle: [2.3, -2.6],
    profile: [[-3.7, 0.5], [-3.7, 1.55], [-3.55, 2.6], [-3.2, 2.9], [3.4, 2.9], [3.7, 2.6], [3.7, 0.5]],
    windows: [[-2.8, -1.8, 1.6, 2.5], [-1.6, -0.6, 1.6, 2.5], [-0.4, 0.6, 1.6, 2.5], [0.8, 1.8, 1.6, 2.5], [2.0, 3.2, 1.6, 2.5]], shield: [-3.7, 1.55, -3.55, 2.6]
  },
  truck: {
    L: 6.2, W: 2.3, H: 2.5, clear: 0.55, wheelR: 0.55, axle: [2.0, -1.9],
    profile: [[-3.1, 0.7], [-3.1, 1.55], [-2.9, 2.4], [-1.3, 2.45], [-1.3, 0.7]],
    windows: [[-2.7, -1.6, 1.6, 2.2]], shield: [-3.1, 1.55, -2.9, 2.4], bed: true
  }
};

function bodyGeo(T) {
  const s = new THREE.Shape();
  T.profile.forEach(([z, y], i) => (i ? s.lineTo(z, y) : s.moveTo(z, y)));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: T.W - 0.08, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.04, bevelSegments: 2, curveSegments: 4 });
  g.rotateY(-Math.PI / 2);
  g.translate((T.W - 0.08) / 2, 0, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.45, uv.getY(i) * 0.45);
  g.computeVertexNormals();
  return g;
}
const GEO = {};

export function vehicle(type, x, z, rot, o = {}) {
  const T = TYPES[type], R = rng(o.seed ?? 5);
  GEO[type] ??= bodyGeo(T);
  const burnt = !!o.burnt;
  const paint = burnt ? M.burnt : M.carPaint[(o.paint ?? R.int(0, M.carPaint.length - 1)) % M.carPaint.length];
  const ground = terrainH(x, z);
  // проседание: спущенные колёса и мягкий грунт
  const tiltX = (o.tilt ?? R.range(-0.04, 0.04)) + (burnt ? 0.03 : 0), tiltZ = o.roll ?? R.range(-0.06, 0.06);
  const drop = burnt ? T.clear * 0.8 : R.range(0.05, 0.18);
  const y = ground + T.clear - drop;
  const rotE = [tiltX, rot, tiltZ];
  const c = Math.cos(rot), s = Math.sin(rot);
  const W = (lx, ly, lz) => [x + lx * c + lz * s, y + ly - tiltX * lz * 0.9 + tiltZ * lx, z - lx * s + lz * c];
  if (o.flip) {
    // на крыше: вращаем кузов вокруг продольной оси
    place(paint, GEO[type], x, ground + T.H - T.clear + 0.05, z, [0.05, rot, Math.PI - 0.08]);
    addBox(x, ground + T.H / 2, z, T.W, T.H, T.L, rot);
    return;
  }
  place(paint, GEO[type], x, y - T.clear, z, rotE);
  // днище
  const [ux, uy, uz] = W(0, T.clear * 0.2, 0);
  box(M.dark, ux, uy - T.clear + 0.35, uz, T.W - 0.2, 0.08, T.L - 0.4, { rot, rx: tiltX, rz: tiltZ });
  // окна: пустые проёмы (тёмные), кое-где остатки стекла
  for (const [z0, z1, y0, y1] of T.windows) for (const side of [-1, 1]) {
    const glass = !burnt && R() < 0.25;
    const [wx, wy, wz] = W(side * (T.W / 2 + 0.005), (y0 + y1) / 2 - T.clear, (z0 + z1) / 2);
    box(glass ? M.glass : M.dark, wx, wy, wz, 0.02, y1 - y0, z1 - z0, { rot, rx: tiltX, rz: tiltZ, tile: 1 });
  }
  for (const key of ['shield', 'rear']) {
    const sh = T[key];
    if (!sh) continue;
    const [z0, y0, z1, y1] = sh, len = Math.hypot(z1 - z0, y1 - y0), ang = Math.atan2(z1 - z0, y1 - y0);
    const [wx, wy, wz] = W(0, (y0 + y1) / 2 - T.clear, (z0 + z1) / 2 + (key === 'shield' ? -0.02 : 0.02));
    box(!burnt && R() < 0.4 ? M.glass : M.dark, wx, wy, wz, T.W - 0.3, len, 0.02, { rot, rx: tiltX + ang, rz: tiltZ, tile: 1 });
  }
  // фары и бампер
  const [bx, by, bz] = W(0, 0.45 - T.clear + 0.15, -T.L / 2 - 0.06);
  box(M.steel, bx, by, bz, T.W, 0.12, 0.08, { rot, rx: tiltX, rz: tiltZ });
  // кузов грузовика
  if (T.bed) {
    const [fx, fy, fz] = W(0, 1.25 - T.clear, 1.2);
    box(M.planksDark, fx, fy, fz, T.W, 0.1, 3.6, { rot, rx: tiltX, rz: tiltZ, tile: 1.2 });
    for (const side of [-1, 1]) {
      const [sx2, sy2, sz2] = W(side * (T.W / 2 - 0.04), 1.65 - T.clear, 1.2);
      if (R() < 0.8) box(M.planksPaint, sx2, sy2, sz2, 0.06, 0.7, 3.6, { rot, rx: tiltX, rz: tiltZ + side * (R() < 0.3 ? 0.4 : 0), tile: 1.2 });
    }
    const [tx, ty, tz] = W(0, 1.65 - T.clear, 3.0);
    box(M.planksPaint, tx, ty, tz, T.W, 0.7, 0.06, { rot, rx: tiltX + (R() < 0.5 ? 0.9 : 0), rz: tiltZ, tile: 1.2 });
    const [rx2, ry2, rz2] = W(0, 0.95 - T.clear, 1.2);
    box(M.dark, rx2, ry2, rz2, 0.25, 0.25, 4.5, { rot, rx: tiltX, rz: tiltZ });
  }
  // колёса
  const tire = new THREE.CylinderGeometry(T.wheelR, T.wheelR, 0.26, 14);
  const rim = new THREE.CylinderGeometry(T.wheelR * 0.55, T.wheelR * 0.55, 0.28, 10);
  for (const az of T.axle) for (const side of [-1, 1]) {
    const gone = burnt || R() < 0.25;
    const [wx, wy, wz] = W(side * (T.W / 2 - 0.12), T.wheelR - T.clear + (gone ? -T.wheelR * 0.4 : 0) + drop * 0.6, az);
    if (!gone || burnt) place(M.rust, rim, wx, Math.max(wy, ground + T.wheelR * 0.45), wz, [0, rot, Math.PI / 2]);
    if (!gone) place(M.rubber, tire, wx, Math.max(wy, ground + T.wheelR * 0.8), wz, [0, rot, Math.PI / 2], [1, 1, 0.85]);
  }
  // сорванная дверь рядом
  if (R() < 0.35 && type !== 'bus') {
    const side = R() < 0.5 ? -1 : 1;
    const [dx, , dz] = W(side * (T.W / 2 + 0.9), 0, -0.2);
    box(paint, dx, terrainH(dx, dz) + 0.05, dz, 1.0, 0.05, 0.9, { rot: rot + R.range(-0.5, 0.5), rx: 0.06, tile: 1 });
  }
  addBox(x, ground + T.H / 2 - drop / 2, z, T.W, T.H - drop, T.L, rot, { walk: false });
}
export const VEHICLE_SIZE = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { L: v.L, W: v.W, H: v.H }]));
