import * as THREE from 'three';
import { scene, camera, Q, FRAME, NO_REFLECT } from '../core/env.js';
import { clamp, lerp, smoothstep, sr, srnd, TAU } from '../core/math.js';
import { hFast, heightGrid } from './heightcache.js';
import { MAP } from './layout.js';
import { WIND } from './wind.js';
import { FXU } from '../core/fxu.js';

/* ============================================================================
   ПОГОДА: ясно → пасмурно → дождь → гроза
   • Дождь — штрихи на GPU вокруг камеры (наклон по ветру, размытие движения),
     обрезаются по карте высот: сквозь землю не идут. Всплески на земле.
   • Намокание копится под дождём и медленно сохнет: земля темнеет, в колеях,
     низинах, воронках и на дне окопов встают лужи с кольцами от капель;
     дерево, мешки, металл темнеют и начинают блестеть. Мокрая трава не горит,
     дождь гасит пожар.
   • Гроза: разряды с ветвлением, вспышка освещает весь лес, гром приходит
     с задержкой по скорости звука; близкая молния может ударить в дерево.
   • Небо затягивает, солнце гаснет, туман гуще, ветер сильнее.
============================================================================ */
export const MODES = {
  clear: { name: 'ясно', ov: 0.05, rain: 0, storm: 0, wind: 0.6, fog: 0 },
  cloudy: { name: 'пасмурно', ov: 0.7, rain: 0, storm: 0, wind: 0.8, fog: 0.25 },
  rain: { name: 'дождь', ov: 0.88, rain: 0.6, storm: 0, wind: 0.95, fog: 0.55 },
  storm: { name: 'гроза', ov: 1.0, rain: 1.0, storm: 1, wind: 1.45, fog: 0.8 }
};
export const WEATHER = {
  mode: 'clear', auto: true, next: 240, ov: 0.05, rain: 0, storm: 0, fogK: 0, wet: 0, flash: 0,
  flashDir: new THREE.Vector3(0, 1, 0), onStrike: null, strikes: 0
};
let rainMesh = null, splashMesh = null, bolts = [], flashLight = null, heightTex = null, matList = null, lastWet = -1, nextBolt = 5;

export function setWeather(mode, instant = false) {
  if (!MODES[mode]) return;
  WEATHER.mode = mode;
  WEATHER.next = 200 + Math.random() * 260;
  if (instant) {
    const m = MODES[mode];
    WEATHER.ov = m.ov; WEATHER.rain = m.rain; WEATHER.storm = m.storm; WEATHER.fogK = m.fog;
    WIND.base = m.wind;
    if (m.rain > 0.3) WEATHER.wet = Math.max(WEATHER.wet, 0.85);
  }
}
export function cycleWeather() {
  const order = ['clear', 'cloudy', 'rain', 'storm'];
  setWeather(order[(order.indexOf(WEATHER.mode) + 1) % order.length]);
  return MODES[WEATHER.mode].name;
}

/* ---------- Карта высот в текстуре: дождь и всплески не проходят сквозь землю ---------- */
function buildHeightTex() {
  const G = heightGrid();
  heightTex = new THREE.DataTexture(G.H, G.HN, G.HN, THREE.RedFormat, THREE.FloatType);
  heightTex.magFilter = heightTex.minFilter = THREE.NearestFilter;
  heightTex.needsUpdate = true;
  return { tex: heightTex, box: new THREE.Vector3(-G.R, -G.R, 1 / (G.HN * G.HS)) };
}
export function refreshRainHeights() { if (heightTex) heightTex.needsUpdate = true; }

const RAIN_VS = /* glsl */`
  attribute vec4 aR;
  uniform float uT, uI; uniform vec3 uC; uniform vec2 uW; uniform sampler2D uH; uniform vec3 uHB;
  varying float vA; varying vec2 vUv;
  #include <fog_pars_vertex>
  void main(){
    vUv = uv;
    vec3 box = vec3(30.0, 22.0, 30.0);
    float speed = 8.5 + aR.w * 3.0;
    vec3 vel = vec3(uW.x * 2.2, -speed, uW.y * 2.2);
    vec3 p = aR.xyz * box + vel * uT;
    vec3 w = uC + mod(p - uC + box * 0.5, box) - box * 0.5;
    float ground = max(texture2D(uH, (w.xz - uHB.xy) * uHB.z).r, WATER_Y);
    // капля видна, если её «номер» укладывается в текущую силу дождя и она выше земли
    float on = step(aR.w, uI) * step(ground, w.y);
    vec3 axis = normalize(vel);
    vec3 toCam = normalize(cameraPosition - w);
    vec3 side = normalize(cross(axis, toCam));
    float len = 0.5 + speed * 0.035, wid = 0.011 + aR.x * 0.006;
    vec3 pos = w + axis * (uv.y - 0.5) * len + side * (uv.x - 0.5) * wid;
    vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
    float d = -mvPosition.z;
    vA = on * smoothstep(0.3, 1.5, d) * smoothstep(15.0, 6.0, d) * (0.5 + 0.5 * aR.y);
    gl_Position = on > 0.5 ? projectionMatrix * mvPosition : vec4(2.0, 2.0, 2.0, 1.0);
    #include <fog_vertex>
  }`;
const RAIN_FS = /* glsl */`
  uniform vec3 uL; uniform float uFlashR;
  varying float vA; varying vec2 vUv;
  #include <fog_pars_fragment>
  void main(){
    float a = vA * smoothstep(0.5, 0.2, abs(vUv.x - 0.5)) * smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y) * 0.3;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uL + uFlashR * vec3(0.8, 0.85, 1.0), a);
    #include <fog_fragment>
  }`;
const SPLASH_VS = /* glsl */`
  attribute vec4 aR;
  uniform float uT, uI; uniform vec3 uC; uniform sampler2D uH; uniform vec3 uHB;
  varying float vA; varying vec2 vUv; varying float vK;
  #include <fog_pars_vertex>
  float h1(float n){ return fract(sin(n) * 43758.5453); }
  void main(){
    vUv = uv;
    float rate = 2.2 + aR.w * 2.0;
    float cyc = uT * rate + aR.z * 10.0, id = floor(cyc);
    float k = fract(cyc);
    vK = k;
    vec2 off = (vec2(h1(id * 1.7 + aR.x * 91.0), h1(id * 2.3 + aR.y * 57.0)) - 0.5) * 28.0;
    vec2 xz = uC.xz + off;
    float y = max(texture2D(uH, (xz - uHB.xy) * uHB.z).r, WATER_Y) + 0.03;
    float on = step(aR.w, uI) * step(k, 0.35);
    vec3 toCam = normalize(cameraPosition - vec3(xz.x, y, xz.y));
    vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    float s = 0.06 + k * 0.4;
    vec3 pos = vec3(xz.x, y, xz.y) + side * (uv.x - 0.5) * s + vec3(0.0, 1.0, 0.0) * uv.y * s * 0.45;
    vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
    vA = on * smoothstep(16.0, 4.0, -mvPosition.z);
    gl_Position = on > 0.5 ? projectionMatrix * mvPosition : vec4(2.0, 2.0, 2.0, 1.0);
    #include <fog_vertex>
  }`;
const SPLASH_FS = /* glsl */`
  uniform vec3 uL;
  varying float vA; varying vec2 vUv; varying float vK;
  #include <fog_pars_fragment>
  void main(){
    vec2 d = vec2(vUv.x - 0.5, vUv.y);
    float crown = smoothstep(0.5, 0.35, abs(d.x)) * smoothstep(1.0, 0.2, d.y) * (0.5 + 0.5 * sin(d.x * 40.0));
    float a = vA * crown * (1.0 - vK / 0.35) * 0.55;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uL * 1.2, a);
    #include <fog_fragment>
  }`;
function quadsIG(n) {
  const g = new THREE.InstancedBufferGeometry();
  const q = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
  g.index = q.index; g.attributes.position = q.attributes.position; g.attributes.uv = q.attributes.uv;
  const r = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { r[i * 4] = srnd(); r[i * 4 + 1] = srnd(); r[i * 4 + 2] = srnd(); r[i * 4 + 3] = i / n; }
  g.setAttribute('aR', new THREE.InstancedBufferAttribute(r, 4));
  g.instanceCount = n;
  return g;
}
export function buildWeather() {
  const H = buildHeightTex();
  const common = { uT: { value: 0 }, uI: { value: 0 }, uC: { value: new THREE.Vector3() }, uW: { value: new THREE.Vector2() }, uH: { value: null }, uHB: { value: H.box }, uL: { value: new THREE.Color(0.5, 0.52, 0.55) }, uFlashR: { value: 0 } };
  const mk = (vs, fs) => {
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, common]), vertexShader: '#define WATER_Y ' + MAP.WATER_Y.toFixed(3) + '\n' + vs, fragmentShader: fs,
      transparent: true, depthWrite: false, fog: true
    });
    m.uniforms.uH.value = H.tex;   // merge клонирует текстуры — возвращаем общую
    return m;
  };
  rainMesh = new THREE.Mesh(quadsIG(Math.round(24000 * (Q.rain ?? 1))), mk(RAIN_VS, RAIN_FS));
  rainMesh.frustumCulled = false; rainMesh.renderOrder = 9;
  splashMesh = new THREE.Mesh(quadsIG(Math.round(300 + 500 * Q.tex)), mk(SPLASH_VS, SPLASH_FS));
  splashMesh.frustumCulled = false; splashMesh.renderOrder = 9;
  scene.add(rainMesh, splashMesh);
  NO_REFLECT.push(rainMesh, splashMesh);
  flashLight = new THREE.DirectionalLight(0xc8d4ff, 0);
  flashLight.position.set(0, 100, 0);
  scene.add(flashLight, flashLight.target);
  const q = new URLSearchParams(location.search).get('weather');
  if (q && MODES[q]) setWeather(q, true);
}

/* ---------- Мокрые материалы: темнее и глянцевее ---------- */
export function collectWetMaterials(skip) {
  matList = [];
  const seen = new Set();
  scene.traverse(o => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || seen.has(m) || skip.has(m) || !m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || (m.transparent && m.opacity < 0.9)) continue;
      seen.add(m);
      matList.push({ m, r: m.roughness, c: m.color.clone(), leaf: m.alphaTest > 0 });
    }
  });
}
function applyWet(w) {
  if (!matList || Math.abs(w - lastWet) < 0.01) return;
  lastWet = w;
  for (const e of matList) {
    e.m.roughness = Math.max(e.m.metalness > 0.3 ? 0.15 : 0.22, e.r * (1 - (e.leaf ? 0.35 : 0.5) * w));
    e.m.color.copy(e.c).multiplyScalar(1 - (e.leaf ? 0.12 : 0.24) * w);
  }
}

/* ---------- Молния ---------- */
function boltGeo(a, b, spread, depth, out, width) {
  // смещение средней точки: ломаная с убывающим разбросом, редкие отростки
  let pts = [a.clone(), b.clone()];
  let s = spread;
  for (let k = 0; k < depth; k++) {
    const np = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const m = pts[i].clone().lerp(pts[i + 1], 0.5).add(new THREE.Vector3(sr(-s, s), sr(-s, s) * 0.3, sr(-s, s)));
      np.push(m, pts[i + 1]);
      if (k > 1 && k < depth - 1 && Math.random() < 0.08 && width > 0.3) {
        const dir = pts[i + 1].clone().sub(pts[i]).multiplyScalar(sr(1.5, 4)).add(new THREE.Vector3(sr(-s, s) * 2, -s, sr(-s, s) * 2));
        boltGeo(m, m.clone().add(dir), s * 0.6, Math.max(2, depth - k - 1), out, width * 0.45);
      }
    }
    pts = np; s *= 0.52;
  }
  out.push({ pts, width });
}
function makeBolt(from, to) {
  const segs = [];
  boltGeo(from, to, from.distanceTo(to) * 0.12, 7, segs, 1);
  const pos = [], al = [];
  const cam = camera.position;
  for (const { pts, width } of segs) for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i], p1 = pts[i + 1];
    const axis = p1.clone().sub(p0).normalize(), view = p0.clone().sub(cam).normalize();
    const side = new THREE.Vector3().crossVectors(axis, view).normalize().multiplyScalar(0.9 * width * (1 + p0.distanceTo(cam) * 0.004));
    const a = p0.clone().add(side), b = p0.clone().sub(side), c = p1.clone().add(side), d = p1.clone().sub(side);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z);
    for (let k = 0; k < 6; k++) al.push(width);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aW', new THREE.Float32BufferAttribute(al, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uA: { value: 1 } },
    vertexShader: `attribute float aW; varying float vW; void main(){ vW = aW; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uA; varying float vW; void main(){ gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * (1.5 + vW * 3.0) * uA, uA); }`
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false; mesh.renderOrder = 10;
  scene.add(mesh);
  return mesh;
}
function lightning() {
  const cp = camera.position;
  // далёкие разряды чаще, близкие — редко
  const dist = Math.random() < 0.18 ? sr(40, 140) : sr(160, 700);
  const a = srnd() * TAU;
  const x = cp.x + Math.cos(a) * dist, z = cp.z + Math.sin(a) * dist;
  const g = Math.abs(x) < 130 && Math.abs(z) < 130 ? hFast(x, z) : 6;
  const top = new THREE.Vector3(x + sr(-60, 60), 230 + sr(0, 80), z + sr(-60, 60));
  const mesh = makeBolt(top, new THREE.Vector3(x, g, z));
  bolts.push({ mesh, age: 0, life: 0.35 + Math.random() * 0.2, flick: Math.floor(sr(2, 4)) });
  WEATHER.flashDir.set(x - cp.x, 180, z - cp.z).normalize();
  WEATHER.flash = clamp(1.4 - dist / 900, 0.35, 1.2);
  WEATHER.strikes++;
  if (WEATHER.onStrike) WEATHER.onStrike(x, g, z, dist);
}
export const strikeNow = () => lightning();

/* ---------- Кадр ---------- */
export function updateWeather(dt, sky) {
  const W = WEATHER;
  if (W.auto) {
    W.next -= dt;
    if (W.next <= 0) {
      const r = Math.random();
      setWeather(W.mode === 'storm' ? 'rain' : r < 0.35 ? 'clear' : r < 0.6 ? 'cloudy' : r < 0.85 ? 'rain' : 'storm');
    }
  }
  const m = MODES[W.mode], k = Math.min(1, dt * 0.08);
  W.ov = lerp(W.ov, m.ov, k); W.rain = lerp(W.rain, m.rain, Math.min(1, dt * 0.12)); W.storm = lerp(W.storm, m.storm, k); W.fogK = lerp(W.fogK, m.fog, k);
  WIND.base = lerp(WIND.base, m.wind, Math.min(1, dt * 0.1));
  // намокание: под сильным дождём около минуты, высыхание — несколько минут (днём быстрее)
  if (W.rain > 0.05) W.wet = Math.min(1, W.wet + dt * W.rain / 55);
  else W.wet = Math.max(0, W.wet - dt * (1 - sky.night * 0.6) / 260);
  applyWet(W.wet);
  FXU.uWetG.value = W.wet; FXU.uRain.value = W.rain; FXU.uFxT.value = FRAME.t;
  // молнии
  if (W.storm > 0.6) {
    nextBolt -= dt;
    if (nextBolt <= 0) { lightning(); nextBolt = sr(5, 18) * (Q.tex < 0.6 ? 1.3 : 1); }
  }
  W.flash = Math.max(0, W.flash - dt * 3.2);
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i];
    b.age += dt;
    const t = b.age / b.life;
    // двойное-тройное мерцание канала
    const f = t > 1 ? 0 : (0.5 + 0.5 * Math.sign(Math.sin(t * Math.PI * 2 * b.flick))) * (1 - t);
    b.mesh.material.uniforms.uA.value = f;
    if (f > 0.4) W.flash = Math.max(W.flash, f * 0.8);
    if (t > 1) { scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); bolts.splice(i, 1); }
  }
  FXU.uFlash.value = W.flash;
  flashLight.intensity = W.flash * 1.8;
  flashLight.position.copy(camera.position).addScaledVector(W.flashDir, 100);
  flashLight.target.position.copy(camera.position);
  flashLight.target.updateMatrixWorld();
  // дождь следует за камерой
  const cp = camera.position;
  const I = W.rain * (sky.indoor ? 0.15 : 1);
  for (const mesh of [rainMesh, splashMesh]) {
    const u = mesh.material.uniforms;
    u.uT.value = FRAME.t; u.uI.value = I; u.uC.value.copy(cp);
    u.uW.value.set(WIND.dir.x * WIND.strength, WIND.dir.y * WIND.strength);
    u.uL.value.copy(sky.fogColor).multiplyScalar(1.5).addScalar(0.05 * (1 - sky.night));
    u.uFlashR.value = W.flash;
    mesh.visible = I > 0.01 && cp.y - hFast(cp.x, cp.z) < 60 && !(cp.y < MAP.WATER_Y && hFast(cp.x, cp.z) < MAP.WATER_Y);
  }
  return W;
}
export const weatherStats = () => ({ weather: WEATHER.mode, rain: +WEATHER.rain.toFixed(2), wet: +WEATHER.wet.toFixed(2) });
