/* Детерминированный ГПСЧ, шум и мелкие утилиты.
   Карта генерируется из одного зерна: одинакова при каждом запуске и у каждого игрока. */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

let SEED = 20260922;
export const reseed = s => { SEED = s >>> 0; };
export const srnd = () => { SEED = (SEED * 1664525 + 1013904223) >>> 0; return SEED / 4294967296; };
export const sr = (a, b) => a + srnd() * (b - a);
export const si = (a, b) => Math.floor(sr(a, b + 1));
export const spick = arr => arr[Math.floor(srnd() * arr.length)];

/** Отдельный поток случайности: раскладка не зависит от порядка сборки текстур. */
export function rng(seed) {
  let s = seed >>> 0;
  const f = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  f.range = (a, b) => a + f() * (b - a);
  f.int = (a, b) => Math.floor(a + f() * (b - a + 1));
  f.pick = arr => arr[Math.floor(f() * arr.length)];
  return f;
}

export function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  // логические сдвиги: с арифметическим знаковый бит гасится и хеш не выходит за 0.5
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}
export function fbm(x, z, oct = 4, lac = 2.03, gain = 0.5) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, z * f); n += a; a *= gain; f *= lac; }
  return s / n;
}

/** Расстояние от точки до ломаной; out.s — положение вдоль неё в метрах. */
export function polyDist(x, z, pts, out) {
  let best = 1e9, bestS = 0, acc = 0, bestSeg = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    const vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz, L = Math.sqrt(L2);
    let t = L2 > 0 ? ((x - ax) * vx + (z - az) * vz) / L2 : 0;
    t = clamp(t, 0, 1);
    const dx = x - (ax + vx * t), dz = z - (az + vz * t);
    const d = dx * dx + dz * dz;
    if (d < best) { best = d; bestS = acc + t * L; bestSeg = i; }
    acc += L;
  }
  if (out) { out.s = bestS; out.len = acc; out.seg = bestSeg; }
  return Math.sqrt(best);
}
export function polyLength(pts) {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return L;
}
/** Точка и касательная на ломаной на расстоянии s от начала. */
export function polyAt(pts, s) {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    const L = Math.hypot(bx - ax, bz - az);
    if (acc + L >= s || i === pts.length - 2) {
      const t = L > 0 ? clamp((s - acc) / L, 0, 1) : 0;
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / (L || 1), tz: (bz - az) / (L || 1) };
    }
    acc += L;
  }
  const p = pts[pts.length - 1];
  return { x: p[0], z: p[1], tx: 1, tz: 0 };
}
/** Сглаживание ломаной по Чайкину: тропы без острых изломов. */
export function chaikin(pts, iter = 2, closed = false) {
  let p = pts;
  for (let k = 0; k < iter; k++) {
    const o = closed ? [] : [p[0]];
    const n = closed ? p.length : p.length - 1;
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      o.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) o.push(p[p.length - 1]);
    p = o;
  }
  return p;
}
/** Центральная симметрия карты: (x,z) → (−x,−z). */
export const mirrorPts = pts => pts.map(([x, z]) => [-x, -z]);
