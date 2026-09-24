import { terrainH, lakeRho, pathInfluence, trenchDist, edgeDist, MAP, SPAWNS, streamAt, STREAM_BW, inBog } from './layout.js';
import { forestDensity } from './forest.js';
import { smoothstep, clamp } from '../core/math.js';

/* Кэш высот 0.5 м и плотности травы 1 м для игровой зоны: трава, частицы и
   дрон спрашивают высоту тысячи раз за кадр, аналитика для этого дорога. */
const R = 136, HS = 0.5, HN = Math.round(R * 2 / HS) + 1;
const DS = 1, DN = Math.round(R * 2 / DS) + 1;
let H = null, GD = null, FD = null;

export function buildHeightCache() {
  H = new Float32Array(HN * HN);
  for (let j = 0; j < HN; j++) for (let i = 0; i < HN; i++) H[j * HN + i] = terrainH(-R + i * HS, -R + j * HS);
  GD = new Float32Array(DN * DN);
  FD = new Float32Array(DN * DN);
  for (let j = 0; j < DN; j++) for (let i = 0; i < DN; i++) FD[j * DN + i] = forestDensity(-R + i * DS, -R + j * DS);
  for (let j = 0; j < DN; j++) for (let i = 0; i < DN; i++) GD[j * DN + i] = grassDensityExact(-R + i * DS, -R + j * DS);
}
/** Плотность полога из кэша: трава и подлесок спрашивают её тысячи раз при каждом сдвиге камеры. */
export function forestFast(x, z) {
  if (!FD || x <= -R || z <= -R || x >= R - DS || z >= R - DS) return forestDensity(x, z);
  const fx = (x + R) / DS, fz = (z + R) / DS, i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
  const a = FD[j * DN + i], b = FD[j * DN + i + 1], c = FD[(j + 1) * DN + i], d = FD[(j + 1) * DN + i + 1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
export function hFast(x, z) {
  if (!H || x <= -R || z <= -R || x >= R - HS || z >= R - HS) return terrainH(x, z);
  const fx = (x + R) / HS, fz = (z + R) / HS, i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
  const a = H[j * HN + i], b = H[j * HN + i + 1], c = H[(j + 1) * HN + i], d = H[(j + 1) * HN + i + 1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
export function grassDensity(x, z) {
  if (!GD || x <= -R || z <= -R || x >= R - DS || z >= R - DS) return grassDensityExact(x, z);
  const fx = (x + R) / DS, fz = (z + R) / DS, i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
  const a = GD[j * DN + i], b = GD[j * DN + i + 1], c = GD[(j + 1) * DN + i], d = GD[(j + 1) * DN + i + 1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
/** Трава: густо на прогалинах, у воды и по обочинам; под плотным пологом редко. */
function grassDensityExact(x, z) {
  const rho = lakeRho(x, z);
  if (rho < 1.02) return 0;
  const pi = pathInfluence(x, z, 0.4);
  if (pi > 0.5) return 0;
  const edge = pathInfluence(x, z, 1.6) > 0 ? 0.35 : 0;
  const td = trenchDist(x, z);
  if (td < 1.2) return 0;
  // вода ручья и окна болота — без травы (там осока и рогоз, они свои)
  if (streamAt(x, z).d < STREAM_BW + 0.25) return 0;
  const bog = inBog(x, z);
  if (bog > 0.55) return 0.12;
  let d = (1 - (FD ? forestFast(x, z) : forestDensity(x, z))) * 0.85 + 0.12 + edge;
  d += (1 - smoothstep(1.05, 1.6, rho)) * 0.6;
  const e = edgeDist(x, z);
  if (e > MAP.PLAY - 2 && e < MAP.FENCE) d += 0.5;           // бурьян на минной полосе
  for (const s of Object.values(SPAWNS)) if (Math.hypot(x - s.x, z - s.z) < 9) d *= 0.4;
  if (td < 2.2) d += 0.3;                                     // на брустверах
  return clamp(d, 0, 1.3);
}
/** Для физики и воронок: сам кэш и его сетка. */
export const heightGrid = () => ({ H, HN, HS, R, GD, DN, DS });
