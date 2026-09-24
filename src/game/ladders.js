import { CAPTURE } from '../core/colliders.js';

/* ============================================================================
   ЛЕСТНИЦЫ
   Вертикальная лестница: основание (x, z), нормаль (nx, nz) смотрит туда, где
   стоит лезущий, высота от y0 до y1, ширина w. exit — точка, куда игрок
   ступает наверху (площадка, пол кабины). Лестница, созданная внутри панели
   постройки, пропадает вместе с ней (вышку подорвали — лезть некуда).
   W — вверх, S — вниз, Space — спрыгнуть. Падая мимо лестницы, игрок
   хватается за неё сам — так спускаются с площадки через люк.
============================================================================ */
export const LADDERS = [];
export function addLadder(o) {
  const L = { w: 0.5, ...o, panel: CAPTURE.panel || null };
  const l = Math.hypot(L.nx, L.nz); L.nx /= l; L.nz /= l;
  LADDERS.push(L);
  return L;
}
export const ladderAlive = L => !(L.dead || L.panel?.dead);
/** Лестница, в зоне которой стоит точка: front — отступ от плоскости ступеней. */
export function ladderAt(p, frontMax = 0.8, frontMin = -0.15) {
  let best = null, bd = 1e9;
  for (const L of LADDERS) {
    if (!ladderAlive(L)) continue;
    if (p.y < L.y0 - 0.4 || p.y > L.y1 + 0.3) continue;
    const dx = p.x - L.x, dz = p.z - L.z;
    const front = dx * L.nx + dz * L.nz, along = dx * L.nz - dz * L.nx;
    if (front < frontMin || front > frontMax || Math.abs(along) > L.w / 2 + 0.25) continue;
    const d = Math.abs(front - 0.4) + Math.abs(along);
    if (d < bd) { bd = d; best = L; }
  }
  return best;
}
