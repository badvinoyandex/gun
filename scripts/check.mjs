// Проверка плана карты без браузера: симметрия, геометрия озера и троп,
// минное поле, отсутствие NaN в рельефе. Запуск: npm run check
import { MAP, SPAWNS, PATHS, TRENCHES, terrainH, baseH, lakeRho, pathInfluence, edgeDist, inMinefield, CRATERS } from '../src/world/layout.js';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };

// проверяется «голый» план: площадки под домами регистрируются при сборке сцены в браузере
console.log('Рельеф');
let nan = 0, maxAsym = 0;
for (let x = -120; x <= 120; x += 3) for (let z = -120; z <= 120; z += 3) {
  const h = terrainH(x, z);
  if (!Number.isFinite(h)) nan++;
  // центральная симметрия: высоты в (x,z) и (−x,−z) совпадают (кроме микрошума)
  maxAsym = Math.max(maxAsym, Math.abs(h - terrainH(-x, -z)));
}
ok(nan === 0, 'нет NaN в высотах');
// допуск — микрокочки ±0.11 м, они намеренно не симметризованы
ok(maxAsym < 0.25, `рельеф центрально-симметричен (макс. расхождение ${maxAsym.toFixed(2)} м)`);

console.log('Базы и озеро');
const A = SPAWNS.A, D = SPAWNS.D;
ok(A.x === -D.x && A.z === -D.z, 'A и D противоположны относительно центра');
ok(lakeRho(0, 0) < 0.3 && lakeRho(A.x, A.z) > 2, 'озеро в центре, базы на суше');
ok(Math.abs(terrainH(A.x, A.z) - terrainH(D.x, D.z)) < 0.05, 'базы на одной высоте');
ok(!inMinefield(A.x, A.z) && MAP.PLAY - edgeDist(A.x, A.z) > 15, 'база не ближе 15 м к минному полю');
// прямая A→D перекрыта озером: лобовой прострел невозможен
let wet = 0;
for (let t = 0; t <= 1; t += 0.01) if (lakeRho(A.x + (D.x - A.x) * t, A.z + (D.z - A.z) * t) < 1) wet++;
ok(wet > 12, `линия A–D проходит через озеро на ${wet}% длины`);

console.log('Тропы и окопы');
ok(PATHS.length % 2 === 1, `троп ${PATHS.length}: все парные + кольцевая`);
ok(PATHS.some(p => p.lit) && PATHS.some(p => !p.lit), 'часть троп освещена, часть — нет');
ok(TRENCHES.length >= 8 && TRENCHES.length % 2 === 0, `окопов ${TRENCHES.length}, парами`);
ok(pathInfluence(A.x, A.z) > 0.5, 'от базы A отходят тропы');
// глубина относительно земли в 3 м по обе стороны от оси
const floor = TRENCHES.map(t => {
  const i = Math.floor(t.pts.length / 2), [x, z] = t.pts[i], [x2, z2] = t.pts[i + 1];
  const l = Math.hypot(x2 - x, z2 - z), nx = -(z2 - z) / l * 3, nz = (x2 - x) / l * 3;
  return terrainH(x, z) - Math.min(terrainH(x + nx, z + nz), terrainH(x - nx, z - nz));
});
ok(floor.every(d => d < -1.0), `дно окопов глубже 1 м (мин. ${Math.min(...floor.map(d => -d)).toFixed(2)} м)`);

// окопы не пересекают тропы (разрыв у тропы делается автоматически)
const crossing = TRENCHES.filter(t => t.pts.some(([x, z]) => pathInfluence(x, z, 0.8) > 0)).length;
ok(crossing === 0, `окопы не заходят на тропы (${crossing})`);
ok(TRENCHES.length >= 20, `окопов не меньше 20 (${TRENCHES.length})`);

console.log('Минное поле');
ok(inMinefield(0, -115) && inMinefield(115, 0) && !inMinefield(0, -100), 'полоса 108–122 м по всему периметру');
ok(CRATERS.some(c => c.mine), 'в полосе есть воронки');

console.log(fails ? `\n${fails} проверок не прошли` : '\nвсё в порядке');
process.exit(fails ? 1 : 0);
