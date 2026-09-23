import * as THREE from 'three';
import { scene, camera, Q } from '../core/env.js';
import { clamp, lerp, smoothstep, fbm, rng, TAU, srnd, sr } from '../core/math.js';
import { MAP, SPAWNS, CLUSTERS, terrainH, lakeRho, edgeDist, isFree, ISLAND } from './layout.js';
import { M, depthFor } from '../gen/materials.js';
import { injectWind } from './wind.js';
import { cv, tex, sharpenAlpha, bleedColor, rgba } from '../gen/canvas.js';
import { addCircle } from '../core/colliders.js';

/* ============================================================================
   ХВОЙНЫЙ ЛЕС
   Ель — ярусы изогнутых лап-карточек, сосна — рыжий ствол и шапка пучков
   на верхней трети, берёза — редкие белые стволы у опушек и воды.
   У каждого вида несколько вариантов геометрии высотой 1; инстанс только
   масштабирует и поворачивает. Два уровня детализации меняются по дистанции
   до камеры, за минным полем — плоские «силуэты» до горизонта.
============================================================================ */

/** Плотность полога 0..1. Симметризована, как и рельеф: укрытий у баз поровну. */
function rawDensity(x, z) {
  return 0.3 + 0.7 * smoothstep(0.3, 0.64, fbm(x * 0.02 + 4.2, z * 0.02 - 8.1, 3));
}
export function forestDensity(x, z) {
  let d = 0.5 * (rawDensity(x, z) + rawDensity(-x, -z));
  d *= smoothstep(1.2, 1.95, lakeRho(x, z));                     // луговина у воды
  for (const s of Object.values(SPAWNS)) d *= 0.12 + 0.88 * smoothstep(15, 30, Math.hypot(x - s.x, z - s.z));
  for (const c of Object.values(CLUSTERS)) d *= 0.3 + 0.7 * smoothstep(14, 32, Math.hypot(x - c.x, z - c.z));
  const e = edgeDist(x, z);
  if (e > MAP.PLAY - 3 && e < MAP.FENCE + 4) d *= 0.16;          // выжженная и расчищенная полоса
  if (e > MAP.FENCE + 4) d = Math.max(d, 0.85);                  // стена леса снаружи
  return clamp(d, 0, 1);
}

/* ---------- Накопитель геометрии ---------- */
class Geo {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.i = []; }
  get count() { return this.p.length / 3; }
  v(x, y, z, nx, ny, nz, u, vv, r, g, b) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, vv); this.c.push(r, g, b);
    return this.count - 1;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}
const V3 = THREE.Vector3;

/** Ствол: кольца по высоте с комлевым расширением, лёгким изгибом и
    вертикальным градиентом цвета (у сосны — рыжая верхняя кора). */
function trunk(G, R, o) {
  const segs = o.segs ?? 7, rings = o.rings ?? 6;
  const bendA = R.range(0, TAU), bend = o.bend ?? 0.012;
  const base = G.count;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings, y = t * o.h;
    const r = lerp(o.r0, o.r1, Math.pow(t, 0.8)) * (1 + 0.9 * Math.exp(-t * 26));
    const ox = Math.cos(bendA) * Math.sin(t * Math.PI) * bend, oz = Math.sin(bendA) * Math.sin(t * Math.PI) * bend;
    const col = o.color(t);
    for (let i = 0; i <= segs; i++) {
      const a = i / segs * TAU, cx = Math.cos(a), cz = Math.sin(a);
      G.v(ox + cx * r, y, oz + cz * r, cx, 0.15, cz, i / segs * 2, y * (o.vScale ?? 6), col[0], col[1], col[2]);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
    const a = base + j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
    G.i.push(a, c, b, b, c, d);
  }
}
/** Карточка-лапа: три сечения вдоль длины, провисание нарастает к концу.
    Нормали «сферические» от центра кроны — крона освещается как объём. */
const _a = new V3(), _b = new V3(), _n = new V3();
function branchCard(G, org, dir, side, L, W, droop, quad, center, ao) {
  const base = G.count;
  for (let k = 0; k <= 2; k++) {
    const s = k / 2;
    const dy = -droop * L * s * s;
    _a.copy(org).addScaledVector(dir, L * s); _a.y += dy;
    for (let e = 0; e <= 1; e++) {
      const w = (e - 0.5) * W * (k === 0 ? 0.55 : 1);
      _b.copy(_a).addScaledVector(side, w);
      _n.copy(_b).sub(center).normalize(); _n.y = _n.y * 0.6 + 0.5; _n.normalize();
      const shade = lerp(ao, 1, s) ;
      G.v(_b.x, _b.y, _b.z, _n.x, _n.y, _n.z, quad[0] + s * 0.5, quad[1] + e * 0.5, shade, shade, shade);
    }
  }
  for (let k = 0; k < 2; k++) {
    const a = base + k * 2, b = a + 1, c = a + 2, d = a + 3;
    G.i.push(a, c, b, b, c, d);
  }
}
/** Пучок: крестовые карточки вокруг точки, «верх» пучка — по направлению ветки. */
function clump(G, c, up, size, quad, center, ao, planes = 3) {
  const t1 = new V3(up.z, 0, -up.x);
  if (t1.lengthSq() < 1e-4) t1.set(1, 0, 0);
  t1.normalize();
  const t2 = new V3().crossVectors(up, t1).normalize();
  for (let p = 0; p < planes; p++) {
    const a = p / planes * Math.PI + srnd() * 0.4;
    const side = new V3().copy(t1).multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a));
    const base = G.count;
    for (let k = 0; k <= 1; k++) for (let e = 0; e <= 1; e++) {
      _b.copy(c).addScaledVector(up, (k - 0.5) * size).addScaledVector(side, (e - 0.5) * size);
      _n.copy(_b).sub(center).normalize(); _n.y = _n.y * 0.6 + 0.45; _n.normalize();
      const shade = lerp(ao, 1, 0.5 + k * 0.5);
      G.v(_b.x, _b.y, _b.z, _n.x, _n.y, _n.z, quad[0] + e * 0.5, quad[1] + k * 0.5, shade, shade, shade);
    }
    G.i.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
}
const QUADS = [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]];

/* ---------- Ель ---------- */
function spruceVariant(seed, lod) {
  const R = rng(seed);
  const T = new Geo(), F = new Geo();
  const hi = lod === 0;
  trunk(T, R, {
    h: 1, r0: 0.02, r1: 0.003, segs: hi ? 7 : 5, rings: hi ? 6 : 3, bend: 0.006,
    color: t => [lerp(0.62, 0.9, t), lerp(0.56, 0.8, t), lerp(0.5, 0.72, t)]
  });
  const y0 = R.range(0.06, 0.13), whorls = hi ? 21 : 11, center = new V3(0, 0.42, 0);
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1), y = lerp(y0, 0.96, Math.pow(t, 0.92));
    const L = (0.26 * Math.pow(1 - t, 0.9) + 0.035) * R.range(0.88, 1.12) * (hi ? 1 : 1.1);
    const n = hi ? R.int(6, 7) : 5, a0 = R.range(0, TAU);
    for (let b = 0; b < n; b++) {
      const a = a0 + b / n * TAU + R.range(-0.25, 0.25);
      const dir = new V3(Math.cos(a), R.range(-0.05, 0.12), Math.sin(a)).normalize();
      const side = new V3(-Math.sin(a), R.range(-0.2, 0.2), Math.cos(a)).normalize();
      const W = L * (hi ? 1.0 : 1.3);
      branchCard(F, new V3(0, y, 0), dir, side, L, W, R.range(0.35, 0.6) + (1 - t) * 0.25, QUADS[R.int(0, 3)], center, 0.42 + t * 0.2);
    }
  }
  // верхушка — вертикальный пучок
  clump(F, new V3(0, 0.98, 0), new V3(0, 1, 0), 0.07, QUADS[0], center, 0.8, 2);
  return { trunk: T.build(), crown: F.build() };
}
/* ---------- Сосна ---------- */
function pineVariant(seed, lod) {
  const R = rng(seed);
  const T = new Geo(), F = new Geo();
  const hi = lod === 0;
  const orange = R.range(0.42, 0.55);
  const bendA = R.range(0, TAU), bend = R.range(0.008, 0.02);
  trunk(T, R, {
    h: 1, r0: 0.019, r1: 0.005, segs: hi ? 7 : 5, rings: hi ? 8 : 4, bend,
    color: t => {
      const k = smoothstep(orange - 0.12, orange + 0.08, t);
      return [lerp(0.66, 1.25, k), lerp(0.56, 0.72, k), lerp(0.5, 0.5, k)];
    }
  });
  const center = new V3(0, 0.82, 0);
  const nb = hi ? R.int(10, 12) : 7;
  for (let b = 0; b < nb; b++) {
    const t = b / (nb - 1);
    const y = lerp(0.6, 0.95, t) + R.range(-0.02, 0.02);
    const a = b * 2.4 + R.range(-0.4, 0.4);
    const reach = lerp(0.17, 0.06, t) * R.range(0.8, 1.2);
    const rise = R.range(0.04, 0.1);
    const tip = new V3(Math.cos(a) * reach, y + rise, Math.sin(a) * reach);
    // ветка — тонкий четырёхгранник
    if (hi) {
      const org = new V3(0, y, 0), d = tip.clone().sub(org), L = d.length();
      d.normalize();
      const s1 = new V3(-d.z, 0, d.x).normalize().multiplyScalar(0.0035), s2 = new V3().crossVectors(d, s1).normalize().multiplyScalar(0.0035);
      const base = T.count;
      for (const p of [org, tip]) for (const s of [s1, s2, s1.clone().negate(), s2.clone().negate()]) {
        T.v(p.x + s.x, p.y + s.y, p.z + s.z, s.x, s.y, s.z, 0, p === org ? 0 : L * 6, 0.8, 0.6, 0.48);
      }
      for (let k = 0; k < 4; k++) { const a0 = base + k, a1 = base + (k + 1) % 4; T.i.push(a0, a0 + 4, a1, a1, a0 + 4, a1 + 4); }
    }
    // пучки на конце и вдоль ветки
    const nc = hi ? R.int(4, 5) : 3;
    for (let c = 0; c < nc; c++) {
      const k = 1 - c * 0.22;
      const p = new V3(tip.x * k, lerp(y, tip.y, k) + R.range(-0.01, 0.02), tip.z * k);
      p.x += R.range(-0.025, 0.025); p.z += R.range(-0.025, 0.025);
      const up = new V3(tip.x * 0.4, 1, tip.z * 0.4).normalize();
      clump(F, p, up, R.range(0.1, 0.135) * (hi ? 1 : 1.25), QUADS[R.int(0, 3)], center, 0.55, hi ? 3 : 2);
    }
  }
  clump(F, new V3(0, 0.98, 0), new V3(0, 1, 0), 0.12, QUADS[1], center, 0.8, 3);
  return { trunk: T.build(), crown: F.build() };
}
/* ---------- Берёза ---------- */
function birchVariant(seed, lod) {
  const R = rng(seed);
  const T = new Geo(), F = new Geo();
  const hi = lod === 0;
  trunk(T, R, { h: 1, r0: 0.014, r1: 0.004, segs: hi ? 6 : 4, rings: hi ? 6 : 3, bend: 0.03, vScale: 3, color: t => [1, 1, 1] });
  const center = new V3(0, 0.66, 0);
  const n = hi ? 34 : 14;
  for (let i = 0; i < n; i++) {
    const t = R();
    const y = lerp(0.42, 1.0, Math.sqrt(t));
    const rr = Math.sin(lerp(0.2, 1, 1 - t) * Math.PI * 0.8) * 0.16 * R.range(0.6, 1.1);
    const a = R.range(0, TAU);
    const p = new V3(Math.cos(a) * rr, y, Math.sin(a) * rr);
    const up = new V3(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3).normalize();
    clump(F, p, up, R.range(0.1, 0.15) * (hi ? 1 : 1.35), QUADS[R.int(0, 3)], center, 0.5, 2);
  }
  return { trunk: T.build(), crown: F.build() };
}

/* ---------- Силуэты дальнего леса ---------- */
function silhouetteAtlas() {
  // 4 силуэта: 2 ели, сосна, ель в тени. Рисуются теми же штрихами хвои.
  const S = 512, [c, x] = cv(S);
  x.lineCap = 'round';
  const spruce = (ox, oy, W, H, hue) => {
    const cx = ox + W / 2;
    x.strokeStyle = 'rgb(60,48,38)'; x.lineWidth = 3;
    x.beginPath(); x.moveTo(cx, oy + H); x.lineTo(cx, oy + 4); x.stroke();
    for (let k = 0; k < 34; k++) {
      const t = k / 33, y = oy + H * (0.9 - t * 0.88), L = (1 - t) * W * 0.46 + 4;
      for (const s of [-1, 1]) {
        for (let q = 0; q < 16; q++) {
          const u = q / 16, px = cx + s * L * u, py = y + u * u * L * 0.35;
          const v = sr(0.7, 1.2);
          x.strokeStyle = rgba(hue[0] * v, hue[1] * v, hue[2] * v, 1); x.lineWidth = 2.2;
          x.beginPath(); x.moveTo(px, py); x.lineTo(px + s * 4, py + sr(3, 7)); x.stroke();
        }
      }
    }
  };
  const pine = (ox, oy, W, H) => {
    const cx = ox + W / 2;
    x.strokeStyle = 'rgb(150,92,60)'; x.lineWidth = 4;
    x.beginPath(); x.moveTo(cx, oy + H); x.lineTo(cx + 3, oy + H * 0.2); x.stroke();
    for (let k = 0; k < 16; k++) {
      const px = cx + sr(-W * 0.36, W * 0.36), py = oy + sr(H * 0.04, H * 0.36);
      for (let q = 0; q < 70; q++) {
        const a = sr(0, TAU), L = sr(4, 14), v = sr(0.7, 1.2);
        x.strokeStyle = rgba(58 * v, 80 * v, 44 * v, 1); x.lineWidth = 2;
        x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L * 0.7); x.stroke();
      }
    }
  };
  spruce(0, 0, 256, 256, [44, 70, 40]);
  spruce(256, 0, 256, 256, [38, 60, 38]);
  pine(0, 256, 256, 256);
  // крона сверху: круглое пятно лап (для горизонтальной карточки)
  for (let k = 0; k < 900; k++) {
    const a = sr(0, TAU), r = Math.sqrt(srnd()) * 110, px = 384 + Math.cos(a) * r, py = 384 + Math.sin(a) * r;
    const v = sr(0.6, 1.2) * (1 - r / 200);
    x.strokeStyle = rgba(44 * v, 70 * v, 40 * v, 1); x.lineWidth = 2.4;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * 8, py + Math.sin(a) * 8); x.stroke();
  }
  sharpenAlpha(c, 0.4); bleedColor(c, 3);
  return tex(c);
}
/** quad — угол квадранта силуэта в атласе; w — ширина относительно высоты. */
function farGeo(quad = [0, 0.5], w = 0.62, cap = true) {
  // две вертикальные карточки крестом + горизонтальная «шапка» для вида с дрона
  const G = new Geo();
  for (let p = 0; p < 2; p++) {
    const a = p * Math.PI / 2, cx = Math.cos(a), cz = Math.sin(a);
    const base = G.count;
    for (let k = 0; k <= 1; k++) for (let e = 0; e <= 1; e++) {
      const s = e - 0.5;
      G.v(cx * s * w, k, cz * s * w, -cz * 0.5, 0.8, cx * 0.5, quad[0] + e * 0.5, quad[1] + k * 0.5, 0.6 + k * 0.4, 0.6 + k * 0.4, 0.6 + k * 0.4);
    }
    G.i.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  if (!cap) return G.build();
  const base = G.count;
  for (let k = 0; k <= 1; k++) for (let e = 0; e <= 1; e++) {
    G.v((e - 0.5) * w * 0.8, 0.42, (k - 0.5) * w * 0.8, 0, 1, 0, 0.5 + e * 0.5, k * 0.5, 0.7, 0.7, 0.7);
  }
  G.i.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  return G.build();
}
let SIL = null;
function silMaterial() {
  if (SIL) return SIL;
  SIL = new THREE.MeshStandardMaterial({ map: silhouetteAtlas(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, vertexColors: true });
  SIL.emissive = new THREE.Color(0x060a05);
  injectWind(SIL, { amp: 0.5, stiff: 2.2, refH: 18, flutter: 0, blast: 0.5 });
  return SIL;
}

/* ---------- Раскладка ---------- */
export const TREES = [];          // {x,y,z,h,sp,v,r}
const TREE_GRID = new Map();
const tkey = (x, z) => Math.floor(x / 6) * 4096 + Math.floor(z / 6);
/** Есть ли ствол ближе r — чтобы реквизит не вставал в дерево. */
export function treeNear(x, z, r) {
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const L = TREE_GRID.get(tkey(x + i * 6, z + j * 6));
    if (!L) continue;
    for (const t of L) { const dx = t.x - x, dz = t.z - z, R = r + t.r; if (dx * dx + dz * dz < R * R) return t; }
  }
  return null;
}

const SPECIES = {
  spruce: { make: spruceVariant, n: 3, bark: 'barkSpruce', foliage: 'spruce' },
  pine: { make: pineVariant, n: 3, bark: 'barkPine', foliage: 'pine' },
  birch: { make: birchVariant, n: 2, bark: 'barkBirch', foliage: 'birch' }
};
const LODS = [];                 // по варианту: {trunkIM, hiIM, loIM, trees:[]}
let farIM = null;

function chooseSpecies(x, z, R) {
  const dry = fbm(x * 0.013 + 40, z * 0.013 - 12, 2);        // сухие гривы — сосняк
  const nearWater = lakeRho(x, z) < 2.3;
  if ((nearWater || forestDensity(x, z) < 0.35) && R() < 0.22) return 'birch';
  return R() < smoothstep(0.35, 0.65, dry) * 0.85 + 0.08 ? 'pine' : 'spruce';
}

export function buildForest() {
  const R = rng(9001);
  M.spruce.vertexColors = M.pine.vertexColors = M.birch.vertexColors = true;
  const windCrown = { amp: 0.55, stiff: 2.2, refH: 18, flutter: 0.035, blast: 0.6 };
  const windTrunk = { amp: 0.55, stiff: 2.2, refH: 18, flutter: 0, blast: 0.6 };
  for (const k of ['spruce', 'pine', 'birch']) injectWind(M[k], windCrown);
  for (const k of ['barkSpruce', 'barkPine', 'barkBirch']) injectWind(M[k], windTrunk);

  // 1) точки: джиттер-сетка с вероятностью по плотности
  const cell = 3.4, lim = MAP.FENCE + 14;
  const spots = [];
  let rejD = 0, rejF = 0;
  for (let gx = -lim; gx < lim; gx += cell) for (let gz = -lim; gz < lim; gz += cell) {
    const x = gx + R() * cell, z = gz + R() * cell;
    const d = forestDensity(x, z);
    // плотный бор: в густых местах ствол через 3–4 м, на прогалинах — редкие деревья
    if (R() > smoothstep(0.05, 0.75, d) * 0.9 * Q.trees + 0.02) { rejD++; continue; }
    if (!isFree(x, z, 0.8, { lake: 1.08, pathPad: 1.2, trenchPad: 1.4 })) { rejF++; continue; }
    spots.push([x, z]);
  }
  console.info(`[forest] точек ${spots.length}, отказ по плотности ${rejD}, по занятости ${rejF}`);
  // остров: одна старая сосна
  spots.push([ISLAND.x + 1.2, ISLAND.z - 0.8, 'pine', 23]);

  // 2) варианты геометрии
  const variants = {};
  let seed = 100;
  for (const [name, sp] of Object.entries(SPECIES)) {
    variants[name] = [];
    for (let v = 0; v < sp.n; v++) {
      const hi = sp.make(seed, 0), lo = sp.make(seed, 1); seed += 17;
      variants[name].push({ hi, lo, species: name, trees: [] });
    }
  }
  for (const s of spots) {
    const [x, z] = s;
    const sp = s[2] || chooseSpecies(x, z, R);
    const e = edgeDist(x, z);
    const deadZone = e > MAP.PLAY - 3 && e < MAP.FENCE + 4;
    const h = s[3] || (sp === 'birch' ? R.range(9, 15) : sp === 'pine' ? R.range(16, 26) : R.range(9, 22)) * (deadZone ? 0.75 : 1);
    const vi = R.int(0, SPECIES[sp].n - 1);
    const t = { x, y: terrainH(x, z) - 0.15, z, h, sp, vi, rot: R.range(0, TAU), r: h * 0.019, tint: R.range(0.8, 1.15), dead: deadZone && R() < 0.5 };
    TREES.push(t);
    variants[sp][vi].trees.push(t);
    const k = tkey(x, z);
    if (!TREE_GRID.has(k)) TREE_GRID.set(k, []);
    TREE_GRID.get(k).push(t);
    if (e < MAP.FENCE + 1) addCircle(x, z, Math.max(0.18, t.r * 1.05), t.y, t.y + h);
  }

  // 3) инстанс-меши: ствол (все деревья варианта), крона hi и lo
  for (const [name, list] of Object.entries(variants)) {
    const sp = SPECIES[name];
    for (const v of list) {
      const n = v.trees.length;
      if (!n) continue;
      const trunkIM = new THREE.InstancedMesh(v.hi.trunk, M[sp.bark], n);
      const hiIM = new THREE.InstancedMesh(v.hi.crown, M[sp.foliage], n);
      const loIM = new THREE.InstancedMesh(v.lo.crown, M[sp.foliage], n);
      for (const im of [trunkIM, hiIM, loIM]) {
        im.castShadow = Q.shadowTrees; im.receiveShadow = true; im.frustumCulled = false;
        scene.add(im);
      }
      hiIM.customDepthMaterial = loIM.customDepthMaterial = depthFor(M[sp.foliage], windCrown);
      trunkIM.receiveShadow = true;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new V3(), sc = new V3(), col = new THREE.Color();
      v.trees.forEach((t, i) => {
        p.set(t.x, t.y, t.z); q.setFromAxisAngle(new V3(0, 1, 0), t.rot); sc.setScalar(t.h);
        m.compose(p, q, sc);
        t.matrix = m.clone();
        trunkIM.setMatrixAt(i, m);
        const k = t.tint;
        col.setRGB(k, k, k);
        if (t.dead) col.setRGB(0.55, 0.5, 0.45);
        trunkIM.setColorAt(i, col);
        // тон кроны: ель холоднее, сосна теплее, мёртвые — рыжие
        if (t.dead) col.setRGB(0.95, 0.62, 0.32);
        else if (name === 'spruce') col.setRGB(0.66 * k, 0.8 * k, 0.76 * k);
        else if (name === 'pine') col.setRGB(0.78 * k, 0.86 * k, 0.72 * k);
        else col.setRGB(1.0 * k, 1.02 * k, 0.8 * k);
        t.color = col.clone();
      });
      trunkIM.instanceMatrix.needsUpdate = true;
      if (trunkIM.instanceColor) trunkIM.instanceColor.needsUpdate = true;
      for (const im of [hiIM, loIM]) { im.count = 0; im.setColorAt(0, col); }
      LODS.push({ trunkIM, hiIM, loIM, trees: v.trees, dead: false });
    }
  }
  // мёртвые деревья минной полосы остаются голыми стволами (крона не выводится в LOD)
  buildCores(variants);
  buildFarForest(R);
  updateForestLOD(true);
}

/** Сердцевина кроны: крестовые силуэты внутри лап закрывают просветы,
    и ель читается сплошным тёмным конусом, как в настоящем ельнике. */
function buildCores(variants) {
  const mat = silMaterial();
  for (const [name, quad, w] of [['spruce', [0, 0.5], 0.46], ['pine', [0, 0], 0.4]]) {
    const trees = variants[name].flatMap(v => v.trees).filter(t => !t.dead);
    if (!trees.length) continue;
    const im = new THREE.InstancedMesh(farGeo(quad, w, false), mat, trees.length);
    const col = new THREE.Color();
    trees.forEach((t, i) => {
      im.setMatrixAt(i, t.matrix);
      col.copy(t.color).multiplyScalar(0.85); im.setColorAt(i, col);
    });
    im.castShadow = Q.shadowTrees; im.receiveShadow = true; im.frustumCulled = false;
    im.customDepthMaterial = depthFor(mat, { amp: 0.5, stiff: 2.2, refH: 18, flutter: 0, blast: 0.5 });
    im.name = 'tree_cores_' + name;
    scene.add(im);
  }
}

function buildFarForest(R) {
  const mat = silMaterial();
  const pts = [];
  const inner = MAP.FENCE + 14, outer = MAP.WORLD - 20, step = 5.2;
  for (let x = -outer; x < outer; x += step) for (let z = -outer; z < outer; z += step) {
    const px = x + R() * step, pz = z + R() * step, e = edgeDist(px, pz);
    if (e < inner || e > outer) continue;
    if (R() > 0.78) continue;
    pts.push([px, pz]);
  }
  // ельник и сосняк — два набора силуэтов
  const groups = [[], [], []];
  for (const p of pts) groups[R() < 0.45 ? 0 : R() < 0.6 ? 1 : 2].push(p);
  const geos = [farGeo([0, 0.5]), farGeo([0.5, 0.5]), farGeo([0, 0], 0.5)];
  let total = 0;
  groups.forEach((list, gi) => {
    const im = new THREE.InstancedMesh(geos[gi], mat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new V3(), sc = new V3(), col = new THREE.Color();
    list.forEach(([x, z], i) => {
      const h = gi === 2 ? R.range(18, 27) : R.range(13, 24);
      p.set(x, terrainH(x, z) - 0.3, z); q.setFromAxisAngle(new V3(0, 1, 0), R.range(0, TAU)); sc.set(h * R.range(0.8, 1.1), h, h * R.range(0.8, 1.1));
      m.compose(p, q, sc); im.setMatrixAt(i, m);
      const k = R.range(0.7, 1.05); col.setRGB(k * 0.9, k, k * 0.9); im.setColorAt(i, col);
    });
    im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false;
    im.name = 'far_forest';
    scene.add(im);
    total += list.length;
  });
  farIM = { count: total };
}

/** Перераспределение деревьев между детальной и простой кроной. */
let lastLOD = new V3(1e9, 0, 0);
export function updateForestLOD(force) {
  const cp = camera.position;
  if (!force && lastLOD.distanceToSquared(cp) < 16) return;
  lastLOD.copy(cp);
  const R2 = Q.treeNearR * Q.treeNearR;
  for (const L of LODS) {
    let hi = 0, lo = 0;
    for (const t of L.trees) {
      if (t.dead) continue;
      const dx = t.x - cp.x, dy = t.y + t.h * 0.5 - cp.y, dz = t.z - cp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < R2) { L.hiIM.setMatrixAt(hi, t.matrix); L.hiIM.setColorAt(hi, t.color); hi++; }
      else { L.loIM.setMatrixAt(lo, t.matrix); L.loIM.setColorAt(lo, t.color); lo++; }
    }
    L.hiIM.count = hi; L.loIM.count = lo;
    L.hiIM.instanceMatrix.needsUpdate = true; L.loIM.instanceMatrix.needsUpdate = true;
    if (L.hiIM.instanceColor) L.hiIM.instanceColor.needsUpdate = true;
    if (L.loIM.instanceColor) L.loIM.instanceColor.needsUpdate = true;
  }
}
export function forestStats() {
  let hi = 0, lo = 0;
  for (const L of LODS) { hi += L.hiIM.count; lo += L.loIM.count; }
  return { trees: TREES.length, hi, lo, far: farIM ? farIM.count : 0 };
}

/** Подрост: маленькая ель (только лапы, ствол под ними не виден). */
export function saplingGeo() { return spruceVariant(555, 1).crown; }
