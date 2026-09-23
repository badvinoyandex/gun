import { clamp, lerp, smoothstep, fbm, vnoise, polyDist, polyLength, polyAt, chaikin, mirrorPts, rng } from '../core/math.js';

/* ============================================================================
   ПЛАН КАРТЫ «ТИХИЙ БОР»

   Заброшенная турбаза в хвойном лесу у озера, ставшая линией фронта.
   Карта центрально-симметрична: всё, что есть у Alpha, повёрнуто на 180° для
   Delta, поэтому ни у одной команды нет преимущества по укрытиям и дистанциям.

     • A (Alpha) — юго-запад, D (Delta) — северо-восток: точки возрождения
       на пригорках, спиной к минному полю, с большим флагом команды.
     • Центр — озеро, вытянутое поперёк оси A–D: прямой прострел между базами
       закрыт, бой уходит на три линии: два фланга и берег.
     • Северо-запад — турбаза (корпус, домики, баня, пирс), юго-восток — лесной
       кордон (дом лесника, сарай, пилорама). Обе точки равноудалены от баз.
     • Кольцевая грунтовка вокруг озера и фонари турбазы — единственная
       освещённая часть карты ночью. Фланги и окопы остаются в темноте.
     • Периметр — минная полоса 14 м и колючая проволока. Вход = подрыв.

   Оси: x — восток, z — юг, y — вверх. Север — отрицательный z.
============================================================================ */

export const MAP = {
  PLAY: 108,        // внутренняя граница минного поля (полуразмер квадрата)
  MINE1: 122,       // внешняя граница минной полосы
  FENCE: 123.5,     // внешняя колючая проволока: дальше хода нет
  WORLD: 340,       // визуальный лес до горизонта
  WATER_Y: -1.25,
  NAME: 'ТИХИЙ БОР'
};

/* ---------- Точки возрождения ---------- */
export const SPAWNS = {
  A: { team: 'A', name: 'ALPHA', x: -84, z: 84, color: 0x2c5680 },
  D: { team: 'D', name: 'DELTA', x: 84, z: -84, color: 0x94361f }
};
for (const s of Object.values(SPAWNS)) {
  // направление «вперёд» — к центру карты
  const l = Math.hypot(s.x, s.z);
  s.fx = -s.x / l; s.fz = -s.z / l;
  s.yaw = Math.atan2(-s.fx, -s.fz);
  s.r = 14;
}

/* ---------- Озеро ----------
   Эллипс вдоль диагонали СЗ–ЮВ с чётными гармониками по углу: берег
   неровный, но центрально-симметричный. */
const RU = 36, RV = 21;
const S2 = Math.SQRT1_2;
export const lakeUV = (x, z) => [(x + z) * S2, (x - z) * S2];
export const lakeXZ = (u, v) => [(u + v) * S2, (u - v) * S2];
function shoreWobble(phi) {
  return 1 + 0.07 * Math.sin(2 * phi + 1.1) + 0.05 * Math.sin(4 * phi + 2.3) + 0.03 * Math.sin(6 * phi + 0.7);
}
/** ρ < 1 — вода, ρ = 1 — урез, ρ > 1 — суша. */
export function lakeRho(x, z) {
  const u = (x + z) * S2, v = (x - z) * S2;
  const r = Math.hypot(u / RU, v / RV);
  return r / shoreWobble(Math.atan2(v, u));
}
/** Точка контура озера с отступом (метры по нормали наружу, приближённо). */
export function lakeContour(phi, offset = 0) {
  const w = shoreWobble(phi);
  const u = Math.cos(phi) * (RU * w + offset), v = Math.sin(phi) * (RV * w + offset);
  return lakeXZ(u, v);
}
export const ISLAND = { x: 0, z: 0, r: 6.5 };

/* ---------- Сеть троп и дорог ---------- */
export const PATHS = [];      // {pts, w, kind:'road'|'trail', lit, name}
function addPath(pts, w, kind, opt = {}) {
  const sm = opt.closed ? chaikin(pts, 3, true) : chaikin(pts, 3);
  if (opt.closed) sm.push(sm[0]);
  const p = { pts: sm, w, kind, lit: !!opt.lit, name: opt.name || '', len: polyLength(sm) };
  PATHS.push(p);
  return p;
}
function addSym(pts, w, kind, opt = {}) {
  addPath(pts, w, kind, opt);
  addPath(mirrorPts(pts), w, kind, { ...opt, name: (opt.name || '') + '*' });
}

// Кольцевая грунтовка вокруг озера (отступ от уреза ~11 м). Освещена.
const RING = [];
for (let i = 0; i < 28; i++) RING.push(lakeContour(i / 28 * Math.PI * 2, 11.5));
export const RING_ROAD = addPath(RING, 4.0, 'road', { closed: true, lit: true, name: 'кольцевая' });

export const CLUSTERS = {
  T: { x: -50, z: -50, name: 'Турбаза «Лесное»' },
  K: { x: 62, z: 62, name: 'Пионерлагерь «Волчонок»' }
};
/* Пионерлагерь «Волчонок» на юго-восточном конце озера — вместо кордона.
   Локальные оси лагеря: r — вправо (если стоять лицом к озеру), f — к озеру.
   Территория r ∈ [−22, 22], f ∈ [−20, 16], ворота — посередине передней стороны. */
export const CAMP = { x: 62, z: 62, r0: -22, r1: 22, f0: -20, f1: 16 };
export const campXZ = (r, f) => [CAMP.x + (r - f) * S2, CAMP.z + (-r - f) * S2];
/** Поворот постройки, фасад которой смотрит вдоль локального направления (dr, df). */
export const campRot = (dr, df) => { const [x0, z0] = campXZ(0, 0), [x1, z1] = campXZ(dr, df); return Math.atan2(x1 - x0, z1 - z0); };
export const inCamp = (x, z, pad = 0) => {
  const dx = x - CAMP.x, dz = z - CAMP.z, r = (dx - dz) * S2, f = (-dx - dz) * S2;
  return r > CAMP.r0 - pad && r < CAMP.r1 + pad && f > CAMP.f0 - pad && f < CAMP.f1 + pad;
};
const C = campXZ;

// Турбаза: дорога от кольца через неё на север — в минное поле (разбитый блокпост).
addPath([[-33.5, -33.5], [-42, -41], [-50, -50], [-56, -66], [-61, -88], [-63, -108], [-64, -140]], 3.8, 'road', { lit: false, name: 'старая дорога' });
// Лагерь: дорога от кольца к воротам, дальше вдоль забора снаружи — к тому же разбитому блокпосту.
addPath([[33.5, 33.5], [42, 41], C(0, 20.5), C(-13, 22), C(-26.5, 17), C(-26.5, -20), C(-20, -27), [63, 108], [64, 140]], 3.8, 'road', { lit: false, name: 'дорога к лагерю' });
// Внутренние дорожки турбазы — с фонарями и лавочками.
addPath([[-50, -50], [-57, -51], [-63, -49], [-68.5, -45]], 1.9, 'trail', { lit: true, name: 'аллея турбазы' });
addPath([[-57, -51], [-61, -55.5], [-63.8, -57.6]], 1.7, 'trail', { lit: true, name: 'к корпусу' });
addPath([[-50, -50], [-48, -62], [-46.4, -71]], 1.7, 'trail', { lit: true, name: 'к домику' });
addPath([[-17.5, -40.4], [-17, -37.4]], 1.6, 'trail', { lit: true, name: 'к бане' });
// Дорожки лагеря: центральная аллея, линейка, боковые аллеи к корпусам, к столовой, умывальнику, туалетам.
// Фонари на них мерцают бледно-жёлтым.
addPath([C(0, 18), C(0, 7)], 2.6, 'trail', { lit: true, camp: true, name: 'аллея лагеря' });
addPath([C(0, 6), C(0, -3)], 8, 'trail', { lit: false, camp: true, name: 'линейка' });
addPath([C(0, -3), C(0, -8.2)], 2.4, 'trail', { lit: true, camp: true, name: 'к столовой' });
addPath([C(-10, 2), C(10, 2)], 2, 'trail', { lit: false, camp: true, name: 'поперечная аллея' });
addPath([C(-10, 13), C(-10, -12), C(-12, -15.6)], 1.8, 'trail', { lit: true, camp: true, name: 'левая аллея' });
addPath([C(10, 13), C(10, -12), C(13.5, -15.2)], 1.8, 'trail', { lit: true, camp: true, name: 'правая аллея' });
addPath([C(-10, -12), C(-16.5, -14.6)], 1.3, 'trail', { lit: false, camp: true, name: 'к туалетам' });
addPath([C(-10, 4), C(-17, 4.3), C(-24, 4)], 1.4, 'trail', { lit: false, camp: true, name: 'к калитке' });
addSym([[-39.5, -39.5], [-34, -31.5], [-30.6, -30.6]], 1.8, 'trail', { lit: true, name: 'к пирсу' });

// Тропы от баз. Три линии: левый фланг, центр, правый фланг.
addSym([[-84, 84], [-92, 58], [-90, 28], [-82, 0], [-72, -24], [-60, -40], [-50, -50]], 2.2, 'trail', { name: 'западная тропа' });
addSym([[-84, 84], [-70, 70], [-56, 56], [-42, 42], [-26, 26]], 2.4, 'trail', { name: 'центральная тропа' });
addPath([[84, -84], [58, -94], [30, -96], [2, -90], [-22, -80], [-40, -66], [-50, -50]], 2.2, 'trail', { name: 'южная тропа*' });
// у лагеря тропа выходит к калитке в заборе
addPath([[-84, 84], [-58, 94], [-30, 96], [-2, 90], [22, 80], [34, 79], C(-24, 4)], 2.2, 'trail', { name: 'южная тропа' });
// Поперечные связки между линиями.
addSym([[-82, 0], [-62, -2], [-41, -7]], 1.8, 'trail', { name: 'связка З' });
addSym([[-2, 90], [2, 66], [6.5, 41]], 1.8, 'trail', { name: 'связка Ю' });
addSym([[-70, 70], [-80, 60], [-90, 44]], 1.6, 'trail', { name: 'тыл A' });

/* ---------- Площадки под постройками ---------- */
export const PADS = [];   // {x,z,hw,hd,rot,y?,m}
export function addPad(x, z, hw, hd, rot = 0, m = 3) { const p = { x, z, hw, hd, rot, m }; PADS.push(p); return p; }

/* ============================================================================
   ПРОСТРАНСТВЕННЫЙ ИНДЕКС ОТРЕЗКОВ
   terrainH вызывается сотни тысяч раз при сборке: перебирать все тропы в
   каждой точке дорого, поэтому отрезки раскладываются по ячейкам 8 м.
============================================================================ */
const CELL = 8;
function makeIndex(lines, pad) {
  const grid = new Map();
  lines.forEach((ln, li) => {
    let acc = 0;
    for (let i = 0; i < ln.pts.length - 1; i++) {
      const [ax, az] = ln.pts[i], [bx, bz] = ln.pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const r = (ln.w ? ln.w * 0.5 : 0) + pad;
      const x0 = Math.floor((Math.min(ax, bx) - r) / CELL), x1 = Math.floor((Math.max(ax, bx) + r) / CELL);
      const z0 = Math.floor((Math.min(az, bz) - r) / CELL), z1 = Math.floor((Math.max(az, bz) + r) / CELL);
      const seg = { ax, az, bx, bz, L, s0: acc, li };
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const k = gx * 4096 + gz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(seg);
      }
      acc += L;
    }
  });
  return grid;
}
const PATH_IDX = makeIndex(PATHS, 3);
/* ---------- Окопы ----------
   Зигзаг (траверсы через 5 м) гасит продольный огонь. Линия, пересекающая
   тропу, автоматически рвётся: у тропы — пологие выходы-аппарели. Конец окопа,
   упирающийся в другой окоп, остаётся открытым (стык без аппарели и стенок). */
export const TRENCHES = [];
/** Воронки от взрывов в игре: {x, z, r, dep, rim}. */
export const DYN_CRATERS = [];
/** Профиль окопа: обшивка на TW.wall от оси, дно ровное до TW.floor, стенка грунта до TW.top. */
export const TW = { wall: 0.66, floor: 0.8, top: 1.1, cap: 1.08, ramp: 3.2 };
function zigzag(cx, cz, ax, az, t0, t1, amp, step = 5) {
  // ax,az — направление линии; нормаль — «к противнику»
  const nx = -az, nz = ax, pts = [];
  let k = 0;
  for (let t = t0; t <= t1 + 0.01; t += step, k++) {
    const o = (k % 2 ? amp : -amp) * (t === t0 || t + step > t1 + 0.01 ? 0 : 1);
    pts.push([cx + ax * t + nx * o, cz + az * t + nz * o]);
  }
  return pts;
}
function resample(pts, step) {
  const L = polyLength(pts), n = Math.max(2, Math.ceil(L / step)), out = [];
  for (let i = 0; i <= n; i++) { const a = polyAt(pts, L * i / n); out.push([a.x, a.z]); }
  return out;
}
const TRENCH_PLAN = [];
/** Окоп: сглаживание, затем разрез по тропам (куски короче 7 м отбрасываются). */
function addTrench(pts, opt = {}) {
  const sm = resample(chaikin(pts, opt.sharp ? 1 : 2), 0.9);
  let run = [];
  const flush = () => {
    if (run.length > 1 && polyLength(run) > 7) TRENCH_PLAN.push({ pts: run, opt });
    run = [];
  };
  for (const p of sm) {
    // проверка и в зеркальной точке: разрывы у A и D совпадают, рельеф остаётся симметричным
    if (pathInfluence(p[0], p[1], 1.5) > 0 || pathInfluence(-p[0], -p[1], 1.5) > 0) flush();
    else run.push(p);
  }
  flush();
}
function trenchSym(pts, opt) { addTrench(pts, opt); addTrench(mirrorPts(pts), { ...opt, mirror: true }); }
function arc(cx, cz, r, a0, a1, step, amp) {
  const pts = [], n = Math.max(2, Math.round(Math.abs(a1 - a0) * r / step));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n, rr = r + (i === 0 || i === n ? 0 : (i % 2 ? amp : -amp));
    pts.push([cx + Math.cos(a) * rr, cz + Math.sin(a) * rr]);
  }
  return pts;
}
{
  // Передний рубеж базы: поперёк оси A→центр, в 30 м от флага.
  const cx = -62.5, cz = 62.5, ax = S2, az = S2, fx = S2, fz = -S2;
  trenchSym(zigzag(cx, cz, ax, az, -28, -3, 1.6), { name: 'рубеж, левое крыло', dugout0: true, bays: true });
  trenchSym(zigzag(cx, cz, ax, az, 3, 28, 1.6), { name: 'рубеж, правое крыло', bays: true });
  // Ход сообщения от рубежа к базе.
  trenchSym([[-54.8, 70.2], [-58, 74], [-62, 76], [-66, 80], [-70.5, 83.5]], { name: 'ход сообщения', depth: 1.5 });
  // Вторая линия: дуга вокруг базы в 19 м, траверсы через 4 м.
  const A = SPAWNS.A;
  trenchSym(arc(A.x, A.z, 22, -1.74, 0.26, 4, 0.8), { name: 'вторая линия', depth: 1.55, bays: true, dugout1: true });
  // Передовые сапы от рубежа к противнику с пулемётной ячейкой на конце.
  const onPlan = (x, z) => {
    let best = null, bd = 1e9;
    for (const o of TRENCH_PLAN) {
      const q = {}, d = polyDist(x, z, o.pts, q);
      if (d < bd) { bd = d; const a = polyAt(o.pts, q.s); best = [a.x, a.z]; }
    }
    return best;
  };
  for (const t of [-18, 18]) {
    const b = onPlan(cx + ax * t, cz + az * t);
    trenchSym([b, [b[0] + fx * 4 + ax * 0.9, b[1] + fz * 4 + az * 0.9], [b[0] + fx * 9.5, b[1] + fz * 9.5]], { name: 'сапа', depth: 1.5, sharp: true, nest1: true });
  }
  // Фланговая позиция у западной тропы.
  trenchSym(zigzag(-80, 24, 0.34, -0.94, -10, 12, 1.3, 4.4), { name: 'фланговая позиция З', bays: true, dugout1: true });
  // Передовой окоп поперёк центральной тропы (разрыв под тропу — автоматически).
  trenchSym(zigzag(-40, 40, S2, S2, -15, 15, 1.2, 4), { name: 'окоп у кольцевой', depth: 1.5, bays: true });
  // Передовые ячейки на берегу.
  const a = lakeXZ(-9, -27), b = lakeXZ(0, -28.5), c = lakeXZ(9, -27);
  trenchSym([a, b, c], { name: 'береговые ячейки', depth: 1.6, lake: true });
  // Старые траншеи у турбазы.
  addTrench([[-85, -28], [-82, -33], [-83, -38], [-80, -43], [-81, -49]], { name: 'траншея турбазы З', depth: 1.5 });
  addTrench([[-52, -81], [-46, -84], [-40, -82], [-34, -85]], { name: 'траншея турбазы С', depth: 1.5 });
  // Лагерь: окопы за забором — с боков и у задних ворот, изломом.
  const Cz = (pts) => pts.map(([r, f]) => campXZ(r, f));
  addTrench(Cz([[26.5, 12], [28, 7], [26.5, 2], [28, -3], [26.5, -8], [28, -13]]), { name: 'окоп у лагеря В', depth: 1.6, bays: true });
  addTrench(Cz([[-31, 12], [-32.5, 6], [-31, 0], [-32.5, -6], [-31, -12]]), { name: 'окоп у лагеря З', depth: 1.6, bays: true });
  addTrench(Cz([[-6, -24.5], [0, -26], [6, -24.5], [12, -26], [18, -24.5]]), { name: 'окоп за лагерем', depth: 1.6, bays: true });
  // Берег озера: ячейки и траншеи между водой и кольцевой, у обеих баз — кромка
  // сырая, дно не ниже уровня воды (иначе окоп затопит), зато бруствер выше.
  for (const [p0, p1, off] of [[3.62, 3.98, 6.2], [4.18, 4.5, 6.4], [4.95, 5.3, 6.4], [5.86, 6.1, 6.2]]) {
    const pts = [];
    for (let k = 0, n = 7; k <= n; k++) pts.push(lakeContour(p0 + (p1 - p0) * k / n, off + (k % 2 ? 0.9 : -0.9) * (k > 0 && k < n ? 1 : 0)));
    trenchSym(pts, { name: 'береговая траншея', depth: 1.7, bays: true, lake: true });
  }
  // Ход сообщения: от правого крыла рубежа к берегу.
  trenchSym([[-40.5, 70], [-36, 62], [-33, 55], [-29, 49]], { name: 'ход к берегу', depth: 1.6 });
  // Секреты на фланге у минного поля и у связки Ю.
  trenchSym(zigzag(-96, 8, 0.2, -0.98, -6, 6, 1.1, 4), { name: 'секрет у минного поля', depth: 1.6, bays: true });
  trenchSym(zigzag(-12, 76, 0.94, 0.34, -7, 7, 1.1, 4.5), { name: 'окоп у связки Ю', depth: 1.6, bays: true });
}
// Концы: стык с другим окопом — открыт, иначе аппарель. Сторона противника — к центру карты.
for (let i = 0; i < TRENCH_PLAN.length; i++) {
  const { pts, opt } = TRENCH_PLAN[i];
  const near = (p) => {
    let best = 1e9;
    TRENCH_PLAN.forEach((o, j) => { if (j !== i) best = Math.min(best, polyDist(p[0], p[1], o.pts)); });
    return best;
  };
  const len = polyLength(pts);
  TRENCHES.push({
    pts, len, depth: opt.depth ?? 1.8, name: opt.name || '', open0: near(pts[0]) < 1.3, open1: near(pts[pts.length - 1]) < 1.3,
    bays: !!opt.bays, dugout0: !!opt.dugout0, dugout1: !!opt.dugout1, nest1: !!opt.nest1, lake: !!opt.lake
  });
}

const TRENCH_IDX = makeIndex(TRENCHES, 4);
const _q = { d: 0, s: 0, seg: null };
function nearestSeg(grid, x, z, out = _q) {
  const list = grid.get(Math.floor(x / CELL) * 4096 + Math.floor(z / CELL));
  out.d = 1e9; out.seg = null;
  if (!list) return out;
  for (const g of list) {
    const vx = g.bx - g.ax, vz = g.bz - g.az, L2 = vx * vx + vz * vz;
    let t = L2 > 0 ? ((x - g.ax) * vx + (z - g.az) * vz) / L2 : 0;
    t = clamp(t, 0, 1);
    const dx = x - g.ax - vx * t, dz = z - g.az - vz * t, d = Math.sqrt(dx * dx + dz * dz);
    if (d < out.d) { out.d = d; out.s = g.s0 + t * g.L; out.seg = g; }
  }
  return out;
}

/** Влияние дорожек 0..1. extra — расширение зоны (для раскладки деревьев). */
export function pathInfluence(x, z, extra = 0, info) {
  const list = PATH_IDX.get(Math.floor(x / CELL) * 4096 + Math.floor(z / CELL));
  let best = 0, road = 0, dist = 1e9;
  if (!list) { if (info) { info.road = 0; info.d = 1e9; } return 0; }
  for (const g of list) {
    const vx = g.bx - g.ax, vz = g.bz - g.az, L2 = vx * vx + vz * vz;
    let t = L2 > 0 ? ((x - g.ax) * vx + (z - g.az) * vz) / L2 : 0;
    t = clamp(t, 0, 1);
    const d = Math.hypot(x - g.ax - vx * t, z - g.az - vz * t);
    const p = PATHS[g.li];
    // край тропы рваный: ширина гуляет по шуму
    const hw = p.w * 0.5 * (1 + (vnoise(x * 0.35, z * 0.35) - 0.5) * 0.45) + extra;
    const v = 1 - smoothstep(hw * 0.55, hw, d);
    if (v > best) { best = v; road = p.kind === 'road' ? 1 : 0; }
    if (d < dist) dist = d;
  }
  if (info) { info.road = road; info.d = dist; }
  return best;
}
export function trenchDist(x, z, out) {
  const r = nearestSeg(TRENCH_IDX, x, z, out || { d: 0, s: 0, seg: null });
  return r.d;
}
/* ---------- Воронки ---------- */
export const CRATERS = [];
{
  const R = rng(771);
  let tries = 0;
  while (CRATERS.length < 44 && tries++ < 3000) {
    const x = R.range(-100, 100), z = R.range(-100, 100), r = R.range(1.6, 3.4);
    if (lakeRho(x, z) < 1.25) continue;
    if (pathInfluence(x, z, 2) > 0 || trenchDist(x, z) < r + 2.5) continue;
    if (Math.hypot(x - SPAWNS.A.x, z - SPAWNS.A.z) < 22 || Math.hypot(x - SPAWNS.D.x, z - SPAWNS.D.z) < 22) continue;
    if (Math.hypot(x - CLUSTERS.T.x, z - CLUSTERS.T.z) < 20 || Math.hypot(-x - CLUSTERS.T.x, -z - CLUSTERS.T.z) < 20 || inCamp(x, z, 8) || inCamp(-x, -z, 8)) continue;
    CRATERS.push({ x, z, r }, { x: -x, z: -z, r });
  }
  // минная полоса обстреляна плотнее (тоже парами — рельеф у обеих баз одинаковый)
  const Rm = rng(772);
  for (let i = 0; i < 35; i++) {
    const s = Rm.range(-118, 118), side = Rm.int(0, 3), d = Rm.range(MAP.PLAY + 2, MAP.MINE1 - 1);
    const [x, z] = side === 0 ? [s, -d] : side === 1 ? [s, d] : side === 2 ? [-d, s] : [d, s];
    const r = Rm.range(1.2, 2.8);
    CRATERS.push({ x, z, r, mine: true }, { x: -x, z: -z, r, mine: true });
  }
}

/** Расстояние до края игровой зоны (квадрат со скруглёнными углами). */
export function edgeDist(x, z) { return Math.max(Math.abs(x), Math.abs(z)); }
export const inMinefield = (x, z) => { const e = edgeDist(x, z); return e > MAP.PLAY && e < MAP.MINE1 + 0.5; };

/* ============================================================================
   РЕЛЬЕФ
============================================================================ */
function hills(x, z) {
  return (fbm(x * 0.0105 + 3.1, z * 0.0105 - 7.7, 4) - 0.5) * 7.5 + (fbm(x * 0.041 + 9, z * 0.041 - 3, 3) - 0.5) * 1.5;
}
/** Холмы симметризованы: рельеф у обеих баз одинаковый. */
export function baseH(x, z) {
  let h = 0.5 * (hills(x, z) + hills(-x, -z));
  // пригорки баз: защитникам немного выше
  for (const s of Object.values(SPAWNS)) {
    const d = Math.hypot(x - s.x, z - s.z);
    h += 2.4 * Math.exp(-(d * d) / (22 * 22));
  }
  // лес за минным полем поднимается к горизонту
  h += smoothstep(MAP.FENCE + 4, 250, edgeDist(x, z)) * 16;
  return h;
}
function padRectDist(p, x, z) {
  const c = Math.cos(p.rot), s = Math.sin(p.rot);
  const dx = x - p.x, dz = z - p.z;
  const lx = Math.abs(dx * c - dz * s) - p.hw, lz = Math.abs(dx * s + dz * c) - p.hd;
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
}
const _pi = { road: 0, d: 0 };
const _tq = { d: 0, s: 0, seg: null };

/** Глубина окопа вдоль оси: 1 в середине, 0 на выходе-аппарели. */
export function trenchTaper(tr, s) {
  return (tr.open0 ? 1 : smoothstep(0, TW.ramp, s)) * (tr.open1 ? 1 : smoothstep(0, TW.ramp, tr.len - s));
}
/** Итоговая высота. Слои: холмы → чаша озера → площадки → тропы → окопы → воронки. */
export function terrainH(x, z) {
  let h = baseH(x, z);
  // Чаша озера: берег опускается к воде, дно глубже к центру.
  const rho = lakeRho(x, z);
  if (rho < 2.2) {
    const shore = MAP.WATER_Y + 0.12 + Math.max(0, rho - 1) * 3.2;
    const land = lerp(shore, h, smoothstep(1.0, 2.2, rho));
    const bed = MAP.WATER_Y + 0.12 - 3.4 * smoothstep(1.0, 0.45, rho) - 0.35 * smoothstep(1.0, 0.9, rho);
    h = rho >= 1 ? land : bed;
    // островок в центре
    const di = Math.hypot(x - ISLAND.x, z - ISLAND.z);
    if (di < ISLAND.r + 3) h = Math.max(h, MAP.WATER_Y - 2.5 + 3.4 * (1 - smoothstep(2.2, ISLAND.r, di)));
  }
  // Площадки под домами и базами — выровнены.
  for (const p of PADS) {
    const d = padRectDist(p, x, z);
    if (d > p.m) continue;
    if (p.y === undefined) p.y = baseH(p.x, p.z);
    h = lerp(h, p.y, 1 - smoothstep(0, p.m, d));
  }
  // Окопы: ровное дно, почти отвесная стенка за обшивкой, бруствер.
  let carve = 0, parapet = 0;
  nearestSeg(TRENCH_IDX, x, z, _tq);
  if (_tq.seg && _tq.d < 3.2) {
    const tr = TRENCHES[_tq.seg.li];
    const s = _tq.s, taper = trenchTaper(tr, s);
    carve = (1 - smoothstep(TW.floor, TW.top, _tq.d)) * taper;
    parapet = (tr.lake ? 0.75 : 0.42) * Math.exp(-Math.pow((_tq.d - 1.6) / 0.5, 2)) * (0.4 + 0.6 * taper);
    // сырой берег: окоп в насыпи — грунт поднимается валом, дно остаётся выше воды
    if (tr.lake) h += Math.max(0, MAP.WATER_Y + 1.75 - h) * (1 - smoothstep(1.3, 3.2, _tq.d)) * smoothstep(0, 2, Math.min(s, tr.len - s) + 1);
    const cut = h - tr.depth * carve;
    // у озера дно не опускается ниже воды: окоп сырой, но не затоплен
    h = rho < 2.5 ? lerp(h, Math.max(cut, MAP.WATER_Y + 0.3), carve > 0 ? 1 : 0) : cut;
  }
  // Микрорельеф: кочки и корни — кроме троп и дна окопов.
  const pi = pathInfluence(x, z, 0, _pi);
  h += (vnoise(x * 0.55, z * 0.55) - 0.5) * 0.22 * (1 - pi) * (1 - carve) + parapet;
  if (pi > 0) {
    h -= pi * 0.07;
    // колея на дорогах
    if (_pi.road) h -= 0.07 * Math.exp(-Math.pow((_pi.d - 0.95) / 0.28, 2)) * pi;
  }
  // Воронки.
  for (const c of CRATERS) {
    const dx = x - c.x, dz = z - c.z;
    if (Math.abs(dx) > c.r * 1.6 || Math.abs(dz) > c.r * 1.6) continue;
    const d = Math.hypot(dx, dz) / c.r;
    if (d < 1.6) h += -0.55 * c.r * 0.32 * Math.max(0, 1 - d * d) + 0.16 * c.r * 0.3 * Math.exp(-Math.pow((d - 1.05) / 0.25, 2));
  }
  // Воронки, появившиеся в бою.
  for (let i = 0; i < DYN_CRATERS.length; i++) {
    const c = DYN_CRATERS[i], dx = x - c.x, dz = z - c.z, R = c.r * 1.6;
    if (dx > R || dx < -R || dz > R || dz < -R) continue;
    h += craterDelta(c, x, z);
  }
  return h;
}
export function craterDelta(c, x, z) {
  const d = Math.hypot(x - c.x, z - c.z) / c.r;
  if (d >= 1.6) return 0;
  return -c.dep * Math.max(0, 1 - d * d) * (1 - 0.25 * d * d) + c.rim * Math.exp(-Math.pow((d - 1.02) / 0.22, 2));
}
export function terrainNormal(x, z, out) {
  const e = 0.35;
  const hl = terrainH(x - e, z), hr = terrainH(x + e, z), hd = terrainH(x, z - e), hu = terrainH(x, z + e);
  const nx = hl - hr, ny = 2 * e, nz = hd - hu, l = Math.hypot(nx, ny, nz);
  out.x = nx / l; out.y = ny / l; out.z = nz / l;
  return out;
}

/** Веса слоёв грунта: [тропа, ил, перекопано]. Хвойная подстилка — остаток. */
export function splat(x, z, out) {
  const pi = pathInfluence(x, z);
  const rho = lakeRho(x, z);
  let mud = 1 - smoothstep(1.02, 1.28, rho);
  const di = Math.hypot(x, z);
  if (di < ISLAND.r + 2) mud = Math.max(mud * smoothstep(2, ISLAND.r - 1.5, di), 0);
  let dug = 0;
  const td = trenchDist(x, z);
  if (td < 2.6) dug = 1 - smoothstep(1.6, 2.6, td);
  for (const c of CRATERS) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < c.r * 1.5) dug = Math.max(dug, 1 - smoothstep(c.r * 0.8, c.r * 1.5, d));
  }
  const e = edgeDist(x, z);
  if (e > MAP.PLAY - 1 && e < MAP.MINE1 + 2) dug = Math.max(dug, 0.35 * smoothstep(0.35, 0.7, vnoise(x * 0.18, z * 0.18)));
  out[0] = pi; out[1] = mud; out[2] = dug;
  return out;
}

/* ---------- Реестр занятых мест: реквизит и деревья не ставятся друг на друга ---------- */
export const KEEPOUT = [];   // {x,z,r}
export const keep = (x, z, r) => KEEPOUT.push({ x, z, r });
export function isFree(x, z, r = 1, opt = {}) {
  if (lakeRho(x, z) < (opt.lake ?? 1.12)) return false;
  if (Math.hypot(x - ISLAND.x, z - ISLAND.z) < ISLAND.r && opt.island !== true) return false;
  if (pathInfluence(x, z, r + (opt.pathPad ?? 0.6)) > 0) return false;
  if (trenchDist(x, z) < r + (opt.trenchPad ?? 1.8)) return false;
  for (const k of KEEPOUT) { const dx = x - k.x, dz = z - k.z, R = k.r + r; if (dx * dx + dz * dz < R * R) return false; }
  for (const p of PADS) if (padRectDist(p, x, z) < r + 0.5) return false;
  return true;
}
export { polyDist, padRectDist };
