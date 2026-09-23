/* ============================================================================
   КОЛЛИЗИИ ПЕШЕГО РЕЖИМА
   Стволы — вертикальные цилиндры, постройки и реквизит — повёрнутые боксы.
   Верх бокса — опора (пол дома, настил, крыша машины). Сетка 4 м.
============================================================================ */
const CELL = 4;
const GRID = new Map();
export const COLLIDERS = [];
const key = (ix, iz) => ix * 8192 + iz;

function insert(c, minx, minz, maxx, maxz) {
  for (let ix = Math.floor(minx / CELL); ix <= Math.floor(maxx / CELL); ix++)
    for (let iz = Math.floor(minz / CELL); iz <= Math.floor(maxz / CELL); iz++) {
      const k = key(ix, iz);
      if (!GRID.has(k)) GRID.set(k, []);
      GRID.get(k).push(c);
    }
  COLLIDERS.push(c);
  return c;
}
export function addCircle(x, z, r, y0, y1) {
  return insert({ t: 0, x, z, r, y0, y1 }, x - r, z - r, x + r, z + r);
}
/** Бокс: центр (cx,cy,cz), полные размеры, поворот вокруг Y. */
export function addBox(cx, cy, cz, sx, sy, sz, rot = 0, opt = {}) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const hw = sx / 2, hd = sz / 2;
  const ex = Math.abs(c) * hw + Math.abs(s) * hd, ez = Math.abs(s) * hw + Math.abs(c) * hd;
  return insert({ t: 1, x: cx, z: cz, y0: cy - sy / 2, y1: cy + sy / 2, hw, hd, c, s, walk: opt.walk !== false },
    cx - ex, cz - ez, cx + ex, cz + ez);
}
const _seen = new Set();
export function nearby(x, z, r, fn) {
  _seen.clear();
  for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++)
    for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
      const L = GRID.get(key(ix, iz));
      if (!L) continue;
      for (const c of L) { if (_seen.has(c)) continue; _seen.add(c); fn(c); }
    }
}
/** Точка в локальных координатах бокса. */
function local(c, x, z) {
  const dx = x - c.x, dz = z - c.z;
  return [dx * c.c - dz * c.s, dx * c.s + dz * c.c];
}
/** Выталкивание капсулы (радиус r, от y0 до y1) из препятствий по горизонтали. */
export function pushOut(p, r, y0, y1) {
  let hit = false;
  nearby(p.x, p.z, r + 2, c => {
    if (c.dead || c.y1 <= y0 || c.y0 >= y1) return;
    if (c.t === 0) {
      const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), R = r + c.r;
      if (d < R && d > 1e-5) { p.x = c.x + dx / d * R; p.z = c.z + dz / d * R; hit = true; }
    } else {
      const [lx, lz] = local(c, p.x, p.z);
      const qx = Math.max(-c.hw, Math.min(c.hw, lx)), qz = Math.max(-c.hd, Math.min(c.hd, lz));
      let dx = lx - qx, dz = lz - qz, d = Math.hypot(dx, dz);
      if (d >= r) return;
      let nx, nz;
      if (d > 1e-5) { nx = dx / d; nz = dz / d; }
      else {
        // центр внутри бокса — выталкиваем по кратчайшей оси
        const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz);
        if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; d = -px; } else { nx = 0; nz = Math.sign(lz) || 1; d = -pz; }
      }
      const push = r - d;
      const wx = nx * c.c + nz * c.s, wz = -nx * c.s + nz * c.c;
      p.x += wx * push; p.z += wz * push; hit = true;
    }
  });
  return hit;
}
/** Высшая опора под точкой не выше yFrom + step (пол, настил, крыша). */
export function supportTop(x, z, r, yFrom, step) {
  let best = -1e9;
  nearby(x, z, r + 1, c => {
    if (c.dead || c.t !== 1 || !c.walk) return;
    if (c.y1 > yFrom + step) return;
    const [lx, lz] = local(c, x, z);
    if (Math.abs(lx) <= c.hw + r * 0.5 && Math.abs(lz) <= c.hd + r * 0.5 && c.y1 > best) best = c.y1;
  });
  return best;
}
/** Есть ли препятствие над головой (для прыжка и приседа). */
export function ceilingAt(x, z, r, y0, y1) {
  let low = 1e9;
  nearby(x, z, r + 1, c => {
    if (c.dead || c.t !== 1 || c.y0 < y0 || c.y0 > y1) return;
    const [lx, lz] = local(c, x, z);
    if (Math.abs(lx) <= c.hw + r * 0.3 && Math.abs(lz) <= c.hd + r * 0.3) low = Math.min(low, c.y0);
  });
  return low;
}
