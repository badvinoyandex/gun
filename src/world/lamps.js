import * as THREE from 'three';
import { scene, camera, Q, FRAME, NO_REFLECT } from '../core/env.js';
import { rng, clamp, lerp, smoothstep, polyAt, TAU } from '../core/math.js';
import { PATHS, terrainH, isFree, keep, lakeRho, pathInfluence } from './layout.js';
import { hFast } from './heightcache.js';
import { M, TEX } from '../gen/materials.js';
import { box, cyl, beam, place, beginStruct, panel, noPanel, endStruct } from './builders.js';
import { addCircle } from '../core/colliders.js';

/* ============================================================================
   ФОНАРИ
   Освещение турбазы на старых деревянных опорах: кольцевая грунтовка, аллеи,
   мостки. Часть ламп разбита, часть моргает — генератор еле тянет.
   Ночью светится только сеть троп у озера и базы; фланги и окопы — во тьме.

   Каждый фонарь: светящийся плафон, ореол, пятно света на земле и конус в
   тумане (всё — по одному вызову отрисовки на все фонари). Настоящие
   источники (SpotLight с тенью у ближайших) получают только фонари рядом
   с камерой — пул фиксированного размера, шейдеры не пересобираются.
============================================================================ */
export const LAMPS = [];
const KIND = {
  post: { power: 45, range: 24, color: 0xffc27e, glow: 1.6, pool: 8.5, weight: 1.0, cone: true },
  flood: { power: 160, range: 44, color: 0xf2f0ff, glow: 2.2, pool: 13, weight: 1.6, cone: true },
  window: { power: 5, range: 9, color: 0xffa860, glow: 0.9, pool: 2.6, weight: 0.4, cone: false },
  fire: { power: 14, range: 14, color: 0xff8a3a, glow: 1.4, pool: 5, weight: 0.8, cone: false },
  bulb: { power: 4, range: 8, color: 0xffd9a0, glow: 0.45, pool: 2.4, weight: 0.3, cone: false }
};

/** Регистрация источника. dir — направление луча для прожекторов. */
export function addLamp(o) {
  const k = KIND[o.kind];
  const L = {
    pos: new THREE.Vector3(o.x, o.y, o.z), kind: o.kind, on: o.on ?? true, flick: o.flick ?? 0,
    ground: o.ground ?? hFast(o.x, o.z), color: new THREE.Color(o.color ?? k.color), dir: o.dir || null,
    power: o.power ?? k.power, range: o.range ?? k.range, lens: o.lens || null, level: 0, seed: LAMPS.length * 13.7,
    pool: o.pool ?? k.pool, camp: !!o.camp, blink: !!o.blink, breakable: o.breakable !== false
  };
  LAMPS.push(L);
  return L;
}

/* ---------- План: где стоят столбы вдоль освещённых троп ---------- */
const POSTS = [];
export function planLamps() {
  const R = rng(3131);
  for (const p of PATHS) {
    if (!p.lit) continue;
    const spacing = p.kind === 'road' ? 19 : 13;
    let side = R() < 0.5 ? -1 : 1, prev = null;
    for (let s = spacing * 0.5; s < p.len - 2; s += spacing * R.range(0.9, 1.1)) {
      const a = polyAt(p.pts, s);
      const nx = -a.tz, nz = a.tx, off = p.w * 0.5 + 0.9;
      let x = a.x + nx * off * side, z = a.z + nz * off * side;
      // со стороны воды столбы не ставим — переносим на другую обочину
      if (lakeRho(x, z) < 1.25) { side = -side; x = a.x + nx * off * side; z = a.z + nz * off * side; }
      if (!isFree(x, z, 0.25, { pathPad: -0.55, trenchPad: 1.0, lake: 1.06 })) {
        // вторая попытка — по другой обочине
        const x2 = a.x - nx * off * side, z2 = a.z - nz * off * side;
        if (!isFree(x2, z2, 0.25, { pathPad: -0.55, trenchPad: 1.0, lake: 1.06 })) continue;
        x = x2; z = z2; side = -side;
      }
      const post = { x, z, rot: Math.atan2(-nx * side, -nz * side), path: p, prev, on: R() < (p.camp ? 0.75 : 0.8), flick: p.camp ? R.range(0.5, 1) : R() < 0.22 ? R.range(0.4, 1) : 0, bench: !p.camp && R() < 0.3, camp: !!p.camp };
      POSTS.push(post);
      keep(x, z, 0.6);
      if (post.bench) {
        const bx = a.x + nx * (off + 0.2) * side + a.tx * 1.8, bz = a.z + nz * (off + 0.2) * side + a.tz * 1.8;
        post.benchAt = { x: bx, z: bz, rot: post.rot };
        keep(bx, bz, 1.2);
      }
      prev = post;
      side = -side;
    }
  }
}

/** Деревянный столб с изогнутым кронштейном и эмалированным «колоколом». */
function buildPost(p) {
  const y = terrainH(p.x, p.z), H = 4.4;
  cyl(M.deadwood, p.x, y + H / 2 - 0.3, p.z, 0.11, 0.08, H + 0.6, { seg: 7, tile: 1.2 });
  addCircle(p.x, p.z, 0.14, y, y + H);
  // подкос у основания — на старых опорах их ставили от ветровала
  const fx = Math.sin(p.rot), fz = Math.cos(p.rot);
  beam(M.deadwood, new THREE.Vector3(p.x - fx * 0.9, y - 0.1, p.z - fz * 0.9), new THREE.Vector3(p.x - fx * 0.08, y + 1.6, p.z - fz * 0.08), 0.06);
  // кронштейн к тропе
  const ax = p.x + fx * 1.1, az = p.z + fz * 1.1, ay = y + H - 0.1;
  beam(M.steel, new THREE.Vector3(p.x, y + H - 0.5, p.z), new THREE.Vector3(ax, ay, az), 0.025);
  beam(M.steel, new THREE.Vector3(p.x, y + H - 0.05, p.z), new THREE.Vector3(ax, ay, az), 0.02);
  // плафон
  const shade = new THREE.ConeGeometry(0.26, 0.2, 12, 1, true);
  place(p.camp ? M.bone : M.carPaint[3], shade, ax, ay - 0.12, az, 0);
  place(M.dark, new THREE.CylinderGeometry(0.04, 0.05, 0.1, 8), ax, ay, az, 0);
  const lens = M.lampGlass.clone();
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), lens);
  bulb.position.set(ax, ay - 0.2, az);
  scene.add(bulb);
  // изоляторы и провод на соседний столб
  place(M.bone, new THREE.CylinderGeometry(0.03, 0.04, 0.08, 6), p.x, y + H + 0.02, p.z, 0);
  if (p.prev) {
    const a = new THREE.Vector3(p.prev.x, terrainH(p.prev.x, p.prev.z) + H + 0.05, p.prev.z), b = new THREE.Vector3(p.x, y + H + 0.05, p.z);
    if (a.distanceTo(b) < 30) {
      const pts = [];
      for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(new THREE.Vector3().lerpVectors(a, b, t).add(new THREE.Vector3(0, -Math.sin(t * Math.PI) * 0.55, 0))); }
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.008, 3), M.dark);
      scene.add(tube);
    }
  }
  addLamp({ kind: 'post', x: ax, y: ay - 0.22, z: az, ground: hFast(ax, az), on: p.on, flick: p.flick, lens, dir: new THREE.Vector3(0, -1, 0), camp: p.camp, color: p.camp ? 0xe6e2a2 : undefined, power: p.camp ? 26 : undefined });
}
/** Лавочка: бетонные опоры, рейки; у некоторых — выломана спинка. */
export function bench(x, z, rot, R, o = {}) {
  const y = hFast(x, z);
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  beginStruct({ kind: 'bench', x, z, rot, w: 1.8, d: 0.6, h: 0.9, fy: y, fuel: 0.35 });
  noPanel();
  for (const lx of [-0.75, 0.75]) {
    const [px, pz] = P(lx, 0);
    box(o.leg ?? M.concrete, px, y + 0.22, pz, 0.12, 0.45, 0.46, { rot, tile: 0.8 });
  }
  // сиденье и спинка — одним телом: взрывом лавку срывает с опор
  panel('prop', { hp: 0.3, density: 500 });
  const broken = R() < 0.35, slat = o.slat ?? M.planksDark;
  for (let i = 0; i < 3; i++) {
    const [px, pz] = P(0, -0.15 + i * 0.15);
    if (broken && i === 2 && R() < 0.5) continue;
    box(slat, px, y + 0.47, pz, 1.8, 0.04, 0.11, { rot, tile: 1.2 });
  }
  if (!broken) for (let i = 0; i < 2; i++) {
    const [px, pz] = P(0, -0.27);
    box(slat, px, y + 0.68 + i * 0.16, pz, 1.8, 0.1, 0.035, { rot, rx: -0.15, tile: 1.2 });
  }
  const [cx, cz] = P(0, 0);
  addCircle(cx, cz, 0.45, y, y + 0.5);
  // урна
  if (R() < 0.6) {
    const [ux, uz] = P(1.35, 0);
    panel('prop', { hp: 0.25, density: 700, float: 0, burnable: false });
    cyl(M.rust, ux, y + 0.33, uz, 0.2, 0.24, 0.66, { seg: 10, open: true });
  }
  endStruct();
}

/* ---------- Визуальные слои света ---------- */
let glowIM, coneIM, poolMesh, poolU;
const SPOTS = [], POINTS = [];

const GLOW_VS = /* glsl */`
  attribute float aI; attribute vec3 aCol; attribute float aSize;
  varying float vI; varying vec3 vCol; varying vec2 vUv;
  void main(){
    vUv = uv; vI = aI; vCol = aCol;
    vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // ореол не меньше пары пикселей вдали — фонари видны с дрона цепочкой огней
    float dist = -c.z;
    float s = aSize * max(1.0, dist * 0.012);
    c.xy += position.xy * s;
    gl_Position = projectionMatrix * c;
  }`;
const GLOW_FS = /* glsl */`
  uniform sampler2D tMap; uniform float uFog;
  varying float vI; varying vec3 vCol; varying vec2 vUv;
  void main(){
    vec4 t = texture2D(tMap, vUv);
    gl_FragColor = vec4(vCol * t.rgb * vI, t.a * vI);
    if (gl_FragColor.a < 0.003) discard;
  }`;
const CONE_VS = /* glsl */`
  attribute float aI; attribute vec3 aCol;
  varying float vI; varying vec3 vCol; varying float vH; varying vec3 vN; varying vec3 vV;
  void main(){
    vI = aI; vCol = aCol; vH = -position.y;
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    vV = normalize(cameraPosition - w.xyz);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const CONE_FS = /* glsl */`
  varying float vI; varying vec3 vCol; varying float vH; varying vec3 vN; varying vec3 vV;
  void main(){
    // луч в сыром воздухе: гуще у плафона, мягкий край по силуэту
    float edge = pow(abs(dot(normalize(vN), vV)), 1.6);
    float a = vI * edge * (1.0 - smoothstep(0.0, 1.0, vH)) * 0.14;
    gl_FragColor = vec4(vCol * a, a);
  }`;

export function buildLamps() {
  const R = rng(3232);
  for (const p of POSTS) {
    buildPost(p);
    if (p.benchAt) bench(p.benchAt.x, p.benchAt.z, p.benchAt.rot, R);
  }
}
/** Слои света собираются после того, как все системы зарегистрировали фонари. */
export function finishLamps() {
  const n = LAMPS.length;
  // ореолы
  const quad = new THREE.PlaneGeometry(1, 1);
  const gm = new THREE.ShaderMaterial({ uniforms: { tMap: { value: TEX.glow }, uFog: { value: 0 } }, vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  glowIM = new THREE.InstancedMesh(quad, gm, n);
  const aI = new Float32Array(n), aCol = new Float32Array(n * 3), aSize = new Float32Array(n);
  const m = new THREE.Matrix4();
  LAMPS.forEach((L, i) => {
    m.makeTranslation(L.pos.x, L.pos.y, L.pos.z); glowIM.setMatrixAt(i, m);
    aCol[i * 3] = L.color.r; aCol[i * 3 + 1] = L.color.g; aCol[i * 3 + 2] = L.color.b;
    aSize[i] = KIND[L.kind].glow;
  });
  quad.setAttribute('aI', new THREE.InstancedBufferAttribute(aI, 1));
  quad.setAttribute('aCol', new THREE.InstancedBufferAttribute(aCol, 3));
  quad.setAttribute('aSize', new THREE.InstancedBufferAttribute(aSize, 1));
  glowIM.frustumCulled = false; glowIM.renderOrder = 5;
  scene.add(glowIM);

  // конусы света в воздухе
  const coneLamps = LAMPS.filter(L => KIND[L.kind].cone);
  const cg = new THREE.ConeGeometry(1, 1, 18, 1, true);
  cg.translate(0, -0.5, 0);
  const cm = new THREE.ShaderMaterial({ vertexShader: CONE_VS, fragmentShader: CONE_FS, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  coneIM = new THREE.InstancedMesh(cg, cm, coneLamps.length);
  const cI = new Float32Array(coneLamps.length), cC = new Float32Array(coneLamps.length * 3);
  const q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  coneLamps.forEach((L, i) => {
    const h = Math.max(1, L.pos.y - L.ground);
    const dir = L.dir || new THREE.Vector3(0, -1, 0);
    q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
    const len = L.kind === 'flood' ? 16 : h;
    s.set(len * (L.kind === 'flood' ? 0.45 : 0.62), len, len * (L.kind === 'flood' ? 0.45 : 0.62));
    coneIM.setMatrixAt(i, m.compose(p.copy(L.pos), q, s));
    cC[i * 3] = L.color.r; cC[i * 3 + 1] = L.color.g; cC[i * 3 + 2] = L.color.b;
    L.coneIndex = i;
  });
  cg.setAttribute('aI', new THREE.InstancedBufferAttribute(cI, 1));
  cg.setAttribute('aCol', new THREE.InstancedBufferAttribute(cC, 3));
  coneIM.frustumCulled = false; coneIM.renderOrder = 4;
  scene.add(coneIM);
  NO_REFLECT.push(coneIM);

  // пятна на земле — одна сетка, повторяющая рельеф; яркость по индексу фонаря
  const pos = [], uv = [], li = [], idx = [];
  const G = 10;
  LAMPS.forEach((L, i) => {
    const r = L.pool, base = pos.length / 3;
    let cx = L.pos.x, cz = L.pos.z;
    if (L.kind === 'flood' && L.dir) { cx += L.dir.x * 9; cz += L.dir.z * 9; }
    for (let j = 0; j <= G; j++) for (let k = 0; k <= G; k++) {
      const x = cx + (k / G - 0.5) * 2 * r, z = cz + (j / G - 0.5) * 2 * r;
      pos.push(x, hFast(x, z) + 0.06, z); uv.push(k / G, j / G); li.push(i);
    }
    for (let j = 0; j < G; j++) for (let k = 0; k < G; k++) {
      const a = base + j * (G + 1) + k;
      idx.push(a, a + G + 1, a + 1, a + 1, a + G + 1, a + G + 2);
    }
  });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  pg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  pg.setAttribute('aLamp', new THREE.Float32BufferAttribute(li, 1));
  pg.setIndex(idx);
  poolU = { tMap: { value: TEX.pool }, uI: { value: new Float32Array(Math.max(1, n)) }, uC: { value: LAMPS.map(L => L.color.clone()) } };
  const pm = new THREE.ShaderMaterial({
    uniforms: poolU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: `attribute float aLamp; uniform float uI[${Math.max(1, n)}]; uniform vec3 uC[${Math.max(1, n)}];
      varying vec2 vUv; varying float vI; varying vec3 vC;
      void main(){ vUv = uv; int k = int(aLamp + 0.5); vI = uI[k]; vC = uC[k] * vec3(1.0, 0.78, 0.55);
        // вблизи пятно рисует настоящий источник света, декаль нужна для дальнего плана
        vI *= 0.25 + 0.75 * smoothstep(12.0, 45.0, distance(cameraPosition, position));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D tMap; varying vec2 vUv; varying float vI; varying vec3 vC;
      void main(){ float t = texture2D(tMap, vUv).a; float a = t * t * vI * 0.62; gl_FragColor = vec4(vC * a, a); }`
  });
  poolMesh = new THREE.Mesh(pg, pm);
  poolMesh.frustumCulled = false; poolMesh.renderOrder = 3;
  scene.add(poolMesh);

  // пул реальных источников
  for (let i = 0; i < Q.lights; i++) {
    const sp = new THREE.SpotLight(0xffc98a, 0, 24, 1.05, 0.65, 1.6);
    sp.castShadow = i < Q.spotShadows;
    // карта тени перерисовывается, только пока фонарь горит (днём спот стоит под землёй)
    if (sp.castShadow) { sp.shadow.mapSize.set(512, 512); sp.shadow.bias = -0.0008; sp.shadow.camera.near = 0.3; sp.shadow.camera.far = 30; sp.shadow.autoUpdate = false; }
    sp.position.set(0, -500, 0); sp.target.position.set(0, -501, 0);
    scene.add(sp, sp.target);
    SPOTS.push(sp);
  }
  for (let i = 0; i < Q.lampPoints; i++) {
    const pl = new THREE.PointLight(0xffa860, 0, 10, 1.8);
    pl.position.set(0, -500, 0); scene.add(pl); POINTS.push(pl);
  }
}

const SPOT_C = [], PT_C = [], DOWN = new THREE.Vector3(0, -1, 0);
const byRank = (a, b) => a.rank - b.rank;
/** Каждый кадр: включение по сумеркам, мигание, распределение пула. */
export function updateLamps(lampOn) {
  if (!glowIM) return;
  const t = FRAME.t, cp = camera.position;
  const aI = glowIM.geometry.attributes.aI, cI = coneIM.geometry.attributes.aI;
  for (let i = 0; i < LAMPS.length; i++) {
    const L = LAMPS[i];
    if (L.panel?.dead && L.on) L.on = false;
    let lv = L.on ? 1 : 0;
    if (L.kind === 'fire') lv = 0.75 + 0.18 * Math.sin(t * 7.1 + L.seed) + 0.12 * Math.sin(t * 13.3 + L.seed * 2) + 0.08 * Math.sin(t * 23.1);
    if (L.camp && L.on) {
      // лагерь: старые лампы еле живы — дрожат, гаснут на секунды, вспыхивают
      const n1 = Math.sin(t * 2.3 + L.seed) * Math.sin(t * 0.7 + L.seed * 1.3), n2 = Math.sin(t * 17 + L.seed * 3) * Math.sin(t * 29 + L.seed);
      lv *= n1 > 0.72 ? 0.02 : (0.45 + 0.25 * n2 + 0.2 * Math.sin(t * 3.1 + L.seed));
      if (Math.sin(t * 0.37 + L.seed * 2.1) > 0.93) lv *= Math.abs(Math.sin(t * 43 + L.seed)) > 0.5 ? 1.3 : 0.05;
    } else if (L.blink && L.on) {
      // заградительный огонь вышки: ровное мигание раз в полторы секунды
      lv *= Math.sin(t * 4.2 + L.seed) > 0.35 ? 1 : 0.04;
    } else if (L.flick && L.on) {
      // неисправная лампа: короткие провалы и дрожь накала
      const f = Math.sin(t * 1.7 + L.seed) * Math.sin(t * 5.3 + L.seed * 0.7);
      if (f > 0.55 * L.flick + 0.2) lv *= 0.08 + 0.3 * Math.abs(Math.sin(t * 41 + L.seed));
      else lv *= 0.92 + 0.08 * Math.sin(t * 60 + L.seed);
    }
    const on = L.kind === 'fire' ? Math.max(lampOn, 0.35) : lampOn;
    L.level = lv * on;
    aI.array[i] = L.level * (L.kind === 'flood' ? 1.4 : 1);
    if (L.coneIndex !== undefined) cI.array[L.coneIndex] = L.level;
    poolU.uI.value[i] = L.level * (L.kind === 'flood' ? 1.5 : 1);
    if (L.lens) {
      L.lens.emissiveIntensity = L.level * (L.kind === 'flood' ? 6 : 3.2);
      L.lens.color.setHex(L.level > 0.05 ? 0xfff2dc : 0x6d6f6a);
      L.lens.emissive.copy(L.color);
    }
    const w = KIND[L.kind].weight;
    L.rank = L.level > 0.01 ? L.pos.distanceToSquared(cp) / (w * w) : 1e12;
  }
  aI.needsUpdate = true; cI.needsUpdate = true;
  // пул: прожекторы и фонари — спот-светом, окна и огонь — точечным
  SPOT_C.length = 0; PT_C.length = 0;
  for (const L of LAMPS) if (L.rank < 1e12) (L.kind === 'post' || L.kind === 'flood' ? SPOT_C : PT_C).push(L);
  const spotC = SPOT_C.sort(byRank);
  SPOTS.forEach((S, i) => {
    const L = spotC[i];
    if (!L || L.rank > 140 * 140) { S.intensity = 0; S.position.set(0, -500, 0); if (S.castShadow) S.shadow.needsUpdate = false; return; }
    if (S.castShadow) S.shadow.needsUpdate = true;
    S.position.copy(L.pos);
    const dir = L.dir || DOWN;
    S.target.position.copy(L.pos).addScaledVector(dir, 5);
    S.target.updateMatrixWorld();
    S.color.copy(L.color);
    S.distance = L.range; S.angle = L.kind === 'flood' ? 0.62 : 1.08; S.penumbra = L.kind === 'flood' ? 0.45 : 0.7;
    // плавное появление при смене фонаря — без щелчков
    const d = Math.sqrt(L.rank) * (L.kind === 'flood' ? 1.6 : 1);
    S.intensity = L.power * L.level * clamp(1.3 - d / 120, 0, 1);
  });
  const ptC = PT_C.sort(byRank);
  POINTS.forEach((P, i) => {
    const L = ptC[i];
    if (!L || L.rank > 90 * 90) { P.intensity = 0; return; }
    P.position.copy(L.pos); P.color.copy(L.color); P.distance = L.range;
    P.intensity = L.power * L.level;
  });
}
export const lampStats = () => ({ lamps: LAMPS.length, working: LAMPS.filter(l => l.on).length, posts: POSTS.length });
