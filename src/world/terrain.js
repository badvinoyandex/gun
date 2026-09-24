import * as THREE from 'three';
import { FXU, FXU_GLSL } from '../core/fxu.js';
import { scene, Q } from '../core/env.js';
import { MAP, terrainH, splat, edgeDist, TRENCHES, CRATERS, PADS, lakeRho, pathInfluence, DIGS, STREAMS, BOGS, FORDS } from './layout.js';
import { TEX } from '../gen/materials.js';
import { forestDensity } from './forest.js';
import { hFast } from './heightcache.js';

/* ============================================================================
   МЕШ РЕЛЬЕФА
   Чанки 16 м со своим шагом сетки: у окопов и воронок мелкий (стенки траншей
   должны быть крутыми), на ровном лесу — метр. Стыки разных шагов закрыты
   «юбками». Нормали — по сетке высот с запасом в одну клетку, поэтому на
   границах чанков нет швов освещения.
============================================================================ */
const CH = 16, INNER = 136;
export const TERRAIN = { chunks: [], mat: null };

function chunkStep(x0, z0) {
  const pad = 3.5, x1 = x0 + CH, z1 = z0 + CH;
  const inBox = (x, z) => x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad;
  for (const t of TRENCHES) for (const p of t.pts) if (inBox(p[0], p[1])) return Q.tex < 0.6 ? 0.32 : 0.25;
  for (const c of CRATERS) if (inBox(c.x, c.z)) return 0.5;
  // погреб под домом: откосы ямы короче метра
  for (const g of DIGS) if (inBox(g.x, g.z)) return 0.35;
  for (const st of STREAMS) for (let i = 0; i < st.pts.length; i += 2) if (inBox(st.pts[i][0], st.pts[i][1])) return 0.5;
  for (const b of BOGS) if (b.x > x0 - b.r - 2 && b.x < x1 + b.r + 2 && b.z > z0 - b.r - 2 && b.z < z1 + b.r + 2) return 0.6;
  for (const f of FORDS) for (let t = 0; t <= 1; t += 0.1) if (inBox(f.a[0] + (f.b[0] - f.a[0]) * t, f.a[1] + (f.b[1] - f.a[1]) * t)) return 0.6;
  // берег острова и уреза — плавнее
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    const r = lakeRho(x0 + i * 4, z0 + j * 4);
    if (r > 0.85 && r < 1.4) return 0.6;
    if (pathInfluence(x0 + i * 4, z0 + j * 4, 2) > 0) return 0.8;
  }
  for (const p of PADS) if (inBox(p.x, p.z)) return 0.8;
  return 1.0;
}

/** Затенение ямы: насколько точка ниже окружения (дно окопа, воронки, низины). */
export function aoAt(x, z, h) {
  let s = 0;
  for (const [dx, dz] of [[1.3, 0], [-1.3, 0], [0, 1.3], [0, -1.3], [0.9, 0.9], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9]]) s += Math.max(0, hFast(x + dx, z + dz) - h);
  return Math.max(0.42, 1 - s / 8 * 0.55);
}
function gridChunk(x0, z0, size, step, skirt) {
  const n = Math.round(size / step), s = size / n;
  const N = n + 3;                       // +1 клетка с каждой стороны для нормалей
  const H = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = terrainH(x0 + (i - 1) * s, z0 + (j - 1) * s);
  const V = n + 1, pos = [], nrm = [], spl = [], idx = [], ao = [];
  const sp = [0, 0, 0];
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const x = x0 + i * s, z = z0 + j * s, gi = (j + 1) * N + (i + 1);
    pos.push(x, H[gi], z);
    const nx = H[gi - 1] - H[gi + 1], nz = H[gi - N] - H[gi + N], ny = 2 * s, l = Math.hypot(nx, ny, nz);
    nrm.push(nx / l, ny / l, nz / l);
    splat(x, z, sp);
    spl.push(sp[0], sp[1], sp[2], forestDensity(x, z));
    ao.push(aoAt(x, z, H[gi]));
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    // диагональ по склону: меньше «ступенек» на стенках окопов
    if ((i + j) % 2) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
  }
  if (skirt) {
    // юбка: опущенная кромка по периметру чанка
    const edges = [];
    for (let i = 0; i < n; i++) edges.push([i, 0, i + 1, 0], [i + 1, n, i, n], [0, i + 1, 0, i], [n, i, n, i + 1]);
    for (const [ia, ja, ib, jb] of edges) {
      const a = ja * V + ia, b = jb * V + ib, base = pos.length / 3;
      for (const k of [a, b]) {
        pos.push(pos[k * 3], pos[k * 3 + 1] - 1.2, pos[k * 3 + 2]);
        nrm.push(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]);
        spl.push(spl[k * 4], spl[k * 4 + 1], spl[k * 4 + 2], spl[k * 4 + 3]);
        ao.push(ao[k]);
      }
      idx.push(a, b, base, b, base + 1, base);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aSplat', new THREE.Float32BufferAttribute(spl, 4));
  g.setIndex(idx);
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
}

/** Внешний лес: одна крупная сетка вокруг игровой зоны, без дыр и швов. */
function outerRing() {
  const step = 6, R = MAP.WORLD, n = Math.ceil(R * 2 / step);
  const pos = [], nrm = [], spl = [], idx = [];
  const map = new Int32Array((n + 1) * (n + 1)).fill(-1);
  const inside = (x, z) => Math.max(Math.abs(x), Math.abs(z)) < INNER - step;
  const sp = [0, 0, 0];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = -R + i * step, z = -R + j * step;
    if (inside(x, z) && inside(x + step, z + step) && inside(x - step, z - step)) continue;
    map[j * (n + 1) + i] = pos.length / 3;
    const h = terrainH(x, z);
    pos.push(x, h - (edgeDist(x, z) < INNER + 1 ? 0.25 : 0), z);
    const nx = terrainH(x - 2, z) - terrainH(x + 2, z), nz = terrainH(x, z - 2) - terrainH(x, z + 2), l = Math.hypot(nx, 4, nz);
    nrm.push(nx / l, 4 / l, nz / l);
    splat(x, z, sp);
    spl.push(0, 0, sp[2], forestDensity(x, z));
  }
  const aoOuter = new Float32Array(pos.length / 3).fill(1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = map[j * (n + 1) + i], b = map[j * (n + 1) + i + 1], c = map[(j + 1) * (n + 1) + i], d = map[(j + 1) * (n + 1) + i + 1];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    const cx = -R + (i + 0.5) * step, cz = -R + (j + 0.5) * step;
    if (Math.max(Math.abs(cx), Math.abs(cz)) < INNER - 0.5) continue;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aSplat', new THREE.Float32BufferAttribute(spl, 4));
  g.setAttribute('aAO', new THREE.BufferAttribute(aoOuter, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Материал земли: четыре слоя (подстилка, тропа, ил, перекопанный грунт) плюс
    макро-вариации мха и сухой хвои, чтобы с высоты дрона не читался тайл. */
function groundMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const U = {
    tFloor: { value: TEX.floor.map }, tFloorN: { value: TEX.floor.normal },
    tPath: { value: TEX.path.map }, tPathN: { value: TEX.path.normal },
    tMud: { value: TEX.mud.map }, tMudN: { value: TEX.mud.normal },
    tDug: { value: TEX.dug.map }, tDugN: { value: TEX.dug.normal },
    uWet: { value: 0 }
  };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    Object.assign(sh.uniforms, FXU);
    sh.vertexShader = 'attribute vec4 aSplat;\nattribute float aAO;\nvarying vec4 vSplat;\nvarying vec3 vWPos;\nvarying vec3 vWN;\nvarying float vAO;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = aSplat;\nvAO = aAO;\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = /* glsl */`
      uniform sampler2D tFloor, tFloorN, tPath, tPathN, tMud, tMudN, tDug, tDugN;
      uniform float uWet;
      varying vec4 vSplat; varying vec3 vWPos; varying vec3 vWN; varying float vAO;
      ${FXU_GLSL}
      vec4 gBurn; float gPuddle; float gWetK; vec2 gRipple;
      float gHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float gNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(gHash(i), gHash(i+vec2(1,0)), f.x), mix(gHash(i+vec2(0,1)), gHash(i+vec2(1,1)), f.x), f.y); }
      vec3 gW; float gMacro;
    ` + sh.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
        vec2 wuv = vWPos.xz;
        float macro = gNoise(wuv * 0.018) * 0.6 + gNoise(wuv * 0.07) * 0.4;
        gMacro = macro;
        vec3 cF = texture2D(tFloor, wuv * 0.21).rgb;
        vec3 cF2 = texture2D(tFloor, wuv * 0.047 + 0.37).rgb;
        cF = mix(cF, cF2, 0.4 + 0.3 * (macro - 0.5));
        // мох на открытых местах, сухая рыжая хвоя под плотными кронами
        float canopy = vSplat.w;
        vec3 moss = vec3(0.075, 0.105, 0.035);
        vec3 needles = vec3(0.16, 0.085, 0.035);
        cF = mix(cF, cF * moss / 0.07, smoothstep(0.45, 0.8, macro) * (1.0 - canopy) * 0.55);
        cF = mix(cF, cF * needles / 0.1, smoothstep(0.5, 0.9, canopy) * 0.35);
        vec3 cP = texture2D(tPath, wuv * 0.33).rgb;
        vec3 cM = texture2D(tMud, wuv * 0.28).rgb;
        vec3 cD = texture2D(tDug, wuv * 0.3).rgb;
        // шум на границах слоёв: переходы рваные, а не градиентные
        float edgeN = gNoise(wuv * 0.9) - 0.5;
        float wP = smoothstep(0.15, 0.75, vSplat.x + edgeN * 0.35);
        float wM = smoothstep(0.1, 0.8, vSplat.y + edgeN * 0.3);
        float wD = smoothstep(0.1, 0.7, vSplat.z + edgeN * 0.4);
        vec3 col = cF;
        col = mix(col, cD, wD);
        col = mix(col, cP, wP);
        col = mix(col, cM, wM);
        gW = vec3(wP, wM, wD);
        // затопленный берег темнее, дно под водой — ещё темнее
        col *= mix(1.0, 0.55, smoothstep(0.35, 0.95, vSplat.y) * (1.0 - wP));
        // гарь: копоть с пятнами пепла
        gBurn = burnAt(wuv);
        float ash = gNoise(wuv * 2.3);
        col = mix(col, mix(vec3(0.028, 0.025, 0.022), vec3(0.16, 0.15, 0.14), smoothstep(0.62, 0.9, ash) * 0.6), gBurn.r * 0.92);
        // мокрая земля темнее; лужи — в колеях, низинах, воронках и на дне окопов
        gWetK = uWetG * (1.0 - smoothstep(0.35, 0.9, vSplat.w) * 0.35);
        float low = smoothstep(0.92, 0.6, vAO);
        float pn = gNoise(wuv * 0.23) * 0.65 + gNoise(wuv * 0.9) * 0.35;
        gPuddle = smoothstep(0.58, 0.68, pn + low * 0.28 + wP * 0.12 + wD * 0.1 + gBurn.b * 0.6) * smoothstep(0.25, 0.8, uWetG) * (1.0 - wM * 0.5);
        col *= mix(1.0, 0.6 - wP * 0.1, gWetK);
        col = mix(col, col * vec3(0.55, 0.52, 0.5) + vec3(0.012, 0.014, 0.016), gPuddle);
        diffuseColor.rgb *= col;
        diffuseColor.rgb *= mix(1.0, vAO, 0.55);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = roughness;
        roughnessFactor = mix(roughnessFactor, 0.82, gW.x);
        roughnessFactor = mix(roughnessFactor, 0.48 - uWet * 0.2, smoothstep(0.4, 1.0, gW.y));
        roughnessFactor = mix(roughnessFactor, 0.97, gW.z);
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.5, gWetK);
        roughnessFactor = mix(roughnessFactor, 0.04, gPuddle);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        {
          vec2 wuv = vWPos.xz;
          vec3 nF = texture2D(tFloorN, wuv * 0.21).xyz * 2.0 - 1.0;
          vec3 nP = texture2D(tPathN, wuv * 0.33).xyz * 2.0 - 1.0;
          vec3 nM = texture2D(tMudN, wuv * 0.28).xyz * 2.0 - 1.0;
          vec3 nD = texture2D(tDugN, wuv * 0.3).xyz * 2.0 - 1.0;
          vec3 nt = nF;
          nt = mix(nt, nD, gW.z); nt = mix(nt, nP, gW.x); nt = mix(nt, nM * vec3(0.6, 0.6, 1.0), gW.y);
          vec3 nW = normalize(normalize(vWN) + vec3(nt.x, 0.0, nt.y) * 0.9 * (1.0 - gPuddle * 0.9));
          // капли по лужам: расходящиеся кольца в ячейках со случайной фазой
          if (gPuddle > 0.01 && uRain > 0.01) {
            vec2 rp = vec2(0.0);
            for (int k = 0; k < 2; k++) {
              vec2 cuv = wuv * (2.6 + float(k) * 1.7) + float(k) * 7.3;
              vec2 ci = floor(cuv), cf = fract(cuv) - 0.5;
              float h = gHash(ci + float(k) * 13.0);
              vec2 o = vec2(gHash(ci + 3.1), gHash(ci + 5.7)) - 0.5;
              float ph = fract(uFxT * (0.9 + h * 0.6) + h);
              vec2 d = cf - o * 0.6; float r = length(d);
              float ring = sin((r - ph * 0.5) * 60.0) * smoothstep(0.0, 0.05, ph * 0.5 - r + 0.05) * (1.0 - ph) * step(h, uRain * 0.9 + 0.1);
              rp += d / max(r, 1e-3) * ring;
            }
            nW = normalize(nW + vec3(rp.x, 0.0, rp.y) * 0.35 * gPuddle);
          }
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }
      `)
      .replace('#include <aomap_fragment>', /* glsl */`
        reflectedLight.indirectDiffuse *= vAO;
        reflectedLight.indirectSpecular *= mix(vAO, 1.0, gPuddle * 0.6);
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        // тлеющие угли: мерцают под пеплом, ночью заметно подсвечивают землю
        float emb = gBurn.g * (0.6 + 0.4 * sin(uFxT * 7.0 + gNoise(vWPos.xz * 3.0) * 12.0)) * smoothstep(0.45, 0.85, gNoise(vWPos.xz * 4.3 + uFxT * 0.2));
        totalEmissiveRadiance += vec3(1.0, 0.3, 0.05) * emb * emb * 1.4;
        // каустики: пляшущая сетка света на дне у берега
        float uw = clamp((${MAP.WATER_Y.toFixed(3)} - vWPos.y) * 3.0, 0.0, 1.0) * clamp(1.0 - (${MAP.WATER_Y.toFixed(3)} - vWPos.y) * 0.35, 0.0, 1.0);
        if (uw > 0.0 && uCaus > 0.0) {
          vec2 cp = vWPos.xz * 0.9;
          float c1 = abs(sin(cp.x * 2.1 + sin(cp.y * 1.7 + uFxT * 0.9) * 1.6 + uFxT * 0.7));
          float c2 = abs(sin(cp.y * 2.3 + sin(cp.x * 1.3 - uFxT * 0.8) * 1.8 - uFxT * 0.6));
          float caus = pow(1.0 - min(c1, c2), 6.0);
          totalEmissiveRadiance += diffuseColor.rgb * caus * uw * uCaus * 2.5;
        }
      `);
  };
  m.customProgramCacheKey = () => 'ground-v2';
  return m;
}

export function buildTerrain() {
  const mat = groundMaterial();
  TERRAIN.mat = mat;
  for (let z0 = -INNER; z0 < INNER; z0 += CH) for (let x0 = -INNER; x0 < INNER; x0 += CH) {
    const step = chunkStep(x0, z0);
    const g = gridChunk(x0, z0, CH, step, true);
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    scene.add(mesh);
    TERRAIN.chunks.push(mesh);
  }
  const outer = new THREE.Mesh(outerRing(), mat);
  outer.receiveShadow = true; outer.name = 'terrain_outer';
  scene.add(outer);
  TERRAIN.chunks.push(outer);
}
