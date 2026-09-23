import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { scene, camera, renderer, Q, FRAME } from '../core/env.js';
import { clamp, lerp, smoothstep, DEG, srnd, TAU } from '../core/math.js';
import { cv, tex, blob } from '../gen/canvas.js';
import { WIND } from './wind.js';
import { hFast } from './heightcache.js';

/* ============================================================================
   СУТКИ: утро → день → закат → сумерки → ночь → рассвет
   Солнце и луна на общей орбите; цвет, туман и экспозиция интерполируются
   по ключам. Один направленный источник с тенью работает и за солнце, и за
   луну: они меняются у горизонта, где свет почти нулевой, — шов не виден.
   Облака — купол с fbm-шумом, подсвечены текущим цветом солнца.
============================================================================ */
const KEYS = [
  { h: 0.0, sun: [0.55, 0.65, 0.9], sunI: 0.34, hs: [0.05, 0.08, 0.15], hg: [0.02, 0.03, 0.035], hI: 0.42, fog: [0.022, 0.034, 0.058], fogD: 0.018, exp: 1.45, turb: 2, ray: 0.5, mie: 0.004, label: 'ночь' },
  { h: 4.4, sun: [0.55, 0.62, 0.85], sunI: 0.2, hs: [0.12, 0.14, 0.24], hg: [0.04, 0.045, 0.05], hI: 0.5, fog: [0.08, 0.09, 0.13], fogD: 0.024, exp: 1.35, turb: 3, ray: 1.6, mie: 0.012, label: 'предрассвет' },
  { h: 6.2, sun: [1.0, 0.5, 0.28], sunI: 1.7, hs: [0.54, 0.45, 0.44], hg: [0.24, 0.19, 0.14], hI: 0.7, fog: [0.6, 0.47, 0.42], fogD: 0.021, exp: 1.12, turb: 5.5, ray: 3.2, mie: 0.03, label: 'рассвет' },
  { h: 8.3, sun: [1.0, 0.84, 0.66], sunI: 3.8, hs: [0.64, 0.68, 0.74], hg: [0.42, 0.38, 0.28], hI: 0.86, fog: [0.64, 0.68, 0.7], fogD: 0.0078, exp: 1.02, turb: 3, ray: 1.6, mie: 0.01, label: 'утро' },
  { h: 13, sun: [1.0, 0.96, 0.9], sunI: 4.9, hs: [0.64, 0.7, 0.78], hg: [0.46, 0.41, 0.3], hI: 0.92, fog: [0.66, 0.72, 0.78], fogD: 0.0048, exp: 0.95, turb: 1.9, ray: 1.1, mie: 0.005, label: 'день' },
  { h: 17.3, sun: [1.0, 0.87, 0.68], sunI: 4.0, hs: [0.64, 0.66, 0.7], hg: [0.46, 0.4, 0.29], hI: 0.88, fog: [0.68, 0.68, 0.66], fogD: 0.0066, exp: 1.0, turb: 2.8, ray: 1.5, mie: 0.01, label: 'день' },
  { h: 19.5, sun: [1.0, 0.45, 0.19], sunI: 3.1, hs: [0.58, 0.4, 0.34], hg: [0.24, 0.17, 0.12], hI: 0.62, fog: [0.62, 0.38, 0.26], fogD: 0.0105, exp: 1.02, turb: 6.5, ray: 3.6, mie: 0.042, label: 'закат' },
  { h: 20.8, sun: [0.85, 0.3, 0.16], sunI: 0.6, hs: [0.3, 0.28, 0.42], hg: [0.11, 0.1, 0.1], hI: 0.54, fog: [0.34, 0.24, 0.28], fogD: 0.016, exp: 1.18, turb: 5, ray: 3, mie: 0.03, label: 'сумерки' },
  { h: 22.0, sun: [0.55, 0.64, 0.88], sunI: 0.26, hs: [0.1, 0.13, 0.22], hg: [0.035, 0.045, 0.055], hI: 0.44, fog: [0.07, 0.08, 0.12], fogD: 0.02, exp: 1.38, turb: 3, ray: 1.2, mie: 0.008, label: 'ночь' },
  { h: 24, sun: [0.55, 0.65, 0.9], sunI: 0.34, hs: [0.05, 0.08, 0.15], hg: [0.02, 0.03, 0.035], hI: 0.42, fog: [0.022, 0.034, 0.058], fogD: 0.018, exp: 1.45, turb: 2, ray: 0.5, mie: 0.004, label: 'ночь' }
];
export const PHASES = [9.0, 13.0, 18.6, 19.9, 21.0, 23.5, 3.0, 5.9];
export const TIME = { h: 9.0, speed: 1 / 45, paused: false };
export const SKY = {
  night: 0, label: 'день', sunDir: new THREE.Vector3(), sunColor: new THREE.Color(), sunI: 0,
  fogColor: new THREE.Color(), wind: 0.5, lampOn: 0, moonUp: 0
};
const SUNRISE = 6.2, SUNSET = 20.8;

function keysAt(h) {
  h = ((h % 24) + 24) % 24;
  let a = KEYS[0], b = KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) if (h >= KEYS[i].h && h <= KEYS[i + 1].h) { a = KEYS[i]; b = KEYS[i + 1]; break; }
  const t = smoothstep(0, 1, (h - a.h) / (b.h - a.h || 1));
  const L3 = (p, q) => [lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t)];
  const o = { label: t < 0.5 ? a.label : b.label };
  for (const k of ['sun', 'hs', 'hg', 'fog']) o[k] = L3(a[k], b[k]);
  for (const k of ['sunI', 'hI', 'fogD', 'exp', 'turb', 'ray', 'mie']) o[k] = lerp(a[k], b[k], t);
  return o;
}
/** Высота солнца проходит через ноль ровно в SUNRISE/SUNSET — ключи и геометрия согласованы. */
export function sunDir(h, out) {
  h = ((h % 24) + 24) % 24;
  const day = SUNSET - SUNRISE;
  let ph;
  if (h >= SUNRISE && h <= SUNSET) ph = (h - SUNRISE) / day * Math.PI;
  else ph = Math.PI + (h < SUNRISE ? h + 24 - SUNSET : h - SUNSET) / (24 - day) * Math.PI;
  const el = Math.sin(ph) * 54 * DEG;
  // восход на северо-востоке, полдень на юге, закат на северо-западе (летний день
  // средней полосы): вечерние тени тянутся через озеро к юго-востоку
  const az = -Math.PI / 4 + (h - SUNRISE) * (1.5 * Math.PI / (SUNSET - SUNRISE));
  return out.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
}

let sky, hemi, amb, dir, stars, moonMesh, sunMesh, clouds;
export function buildSky() {
  sky = new Sky();
  sky.scale.setScalar(4000);
  scene.add(sky);
  hemi = new THREE.HemisphereLight(0x9ab0c8, 0x40402f, 0.8);
  amb = new THREE.AmbientLight(0xc8d4e0, 0.12);
  scene.add(hemi, amb);
  dir = new THREE.DirectionalLight(0xffffff, 3);
  dir.castShadow = true;
  dir.shadow.mapSize.set(Q.shadow, Q.shadow);
  dir.shadow.bias = -0.0005; dir.shadow.normalBias = 0.04;
  dir.shadow.camera.near = 1; dir.shadow.camera.far = 420;
  scene.add(dir, dir.target);
  SKY.light = dir;
  scene.fog = new THREE.FogExp2(0xa0b0b8, 0.007);
  buildStars(); buildMoon(); buildClouds();
}
function buildStars() {
  const N = 2600, pos = new Float32Array(N * 3), mag = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = srnd() * 2 - 1, a = srnd() * TAU, r = Math.sqrt(1 - u * u);
    const y = Math.abs(u);
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(a) * r;
    mag[i] = Math.pow(srnd(), 3.2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uO: { value: 0 }, uT: { value: 0 } }, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aMag; uniform float uT; varying float vA;
      void main(){ vec4 p = modelViewMatrix * vec4(position * 1800.0, 1.0); gl_Position = projectionMatrix * p;
        float tw = 0.75 + 0.25 * sin(uT * (2.0 + aMag * 5.0) + position.x * 400.0);
        vA = (0.25 + aMag * 0.9) * tw * smoothstep(0.0, 0.15, position.y); gl_PointSize = 1.2 + aMag * 2.2; }`,
    fragmentShader: `uniform float uO; varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)) * vA * uO; gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a, a); }`
  });
  stars = new THREE.Points(g, m);
  stars.frustumCulled = false; stars.renderOrder = -9;
  scene.add(stars);
}
function buildMoon() {
  const [c, x] = cv(256);
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 120);
  g.addColorStop(0, '#f2f0e8'); g.addColorStop(0.92, '#d8d8d2'); g.addColorStop(1, '#b8bcc4');
  x.fillStyle = g; x.beginPath(); x.arc(128, 128, 120, 0, 7); x.fill();
  x.save(); x.beginPath(); x.arc(128, 128, 120, 0, 7); x.clip();
  for (let i = 0; i < 40; i++) blob(x, 40 + srnd() * 176, 40 + srnd() * 176, 6 + srnd() * 30, [120, 124, 132], 0.35);
  x.restore();
  moonMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex(c), transparent: true, fog: false, depthWrite: false }));
  moonMesh.scale.setScalar(46); moonMesh.renderOrder = -8;
  scene.add(moonMesh);
  const glowC = cv(128);
  const gg = glowC[1].createRadialGradient(64, 64, 0, 64, 64, 64);
  gg.addColorStop(0, 'rgba(200,215,255,.35)'); gg.addColorStop(1, 'rgba(200,215,255,0)');
  glowC[1].fillStyle = gg; glowC[1].fillRect(0, 0, 128, 128);
  sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex(glowC[0]), transparent: true, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }));
  sunMesh.scale.setScalar(260); sunMesh.renderOrder = -7;
  scene.add(sunMesh);
}
function buildClouds() {
  const g = new THREE.SphereGeometry(1500, 48, 16, 0, TAU, 0, Math.PI * 0.5);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
    uniforms: { uT: { value: 0 }, uSun: { value: new THREE.Vector3() }, uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uCover: { value: 0.45 }, uWind: { value: new THREE.Vector2() } },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uT, uCover; uniform vec3 uSun, uLit, uShade; uniform vec2 uWind; varying vec3 vP;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      float fbm(vec2 p){ float s = 0.0, a = 0.5; for(int i = 0; i < 5; i++){ s += a * n(p); p *= 2.07; a *= 0.5; } return s; }
      void main(){
        if (vP.y < 0.02) discard;
        vec2 uv = vP.xz / (vP.y + 0.12) * 1.6 + uWind * uT * 0.004;
        float d = fbm(uv) * 0.65 + fbm(uv * 3.1 + 7.0) * 0.35;
        float c = smoothstep(1.0 - uCover, 1.0 - uCover + 0.28, d);
        // освещённость: солнце подсвечивает края, низ облака темнее
        float sunFacing = pow(max(dot(normalize(vP), normalize(uSun)), 0.0), 6.0);
        float thick = smoothstep(0.4, 0.9, d);
        vec3 col = mix(uLit * (1.0 + sunFacing * 1.6), uShade, thick * 0.65);
        float a = c * smoothstep(0.02, 0.2, vP.y) * 0.92;
        gl_FragColor = vec4(col, a);
      }`
  });
  clouds = new THREE.Mesh(g, m);
  clouds.renderOrder = -6; clouds.frustumCulled = false;
  scene.add(clouds);
}

const _d = new THREE.Vector3(), _m = new THREE.Vector3(), _tgt = new THREE.Vector3();
export function updateSky(dt) {
  if (!TIME.paused) TIME.h = (TIME.h + dt * TIME.speed) % 24;
  const k = keysAt(TIME.h);
  sunDir(TIME.h, _d);
  SKY.label = k.label;
  const night = clamp(1 - smoothstep(-0.1, 0.08, _d.y), 0, 1);
  SKY.night = night;
  SKY.sunDir.copy(_d);
  SKY.wind = WIND.strength;
  SKY.lampOn = clamp(smoothstep(0.1, -0.05, _d.y), 0, 1);
  const u = sky.material.uniforms;
  u.turbidity.value = k.turb; u.rayleigh.value = k.ray; u.mieCoefficient.value = k.mie; u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(_d);
  sky.position.copy(camera.position);

  // свет: днём солнце, ночью — луна (противофаза)
  _m.copy(_d).multiplyScalar(-1);
  const sunUp = smoothstep(-0.03, 0.1, _d.y), moonUp = smoothstep(-0.03, 0.15, _m.y);
  SKY.moonUp = moonUp;
  const useSun = _d.y > -0.02;
  const L = useSun ? _d : _m;
  const I = useSun ? k.sunI * sunUp : 0.36 * moonUp;
  dir.color.setRGB(...(useSun ? k.sun : [0.55, 0.65, 0.9]));
  dir.intensity = I;
  SKY.sunColor.copy(dir.color); SKY.sunI = useSun ? I : 0;
  // тень едет за камерой; с высоты дрона — шире (иначе лес под ним без теней)
  const agl = Math.max(0, camera.position.y - hFast(camera.position.x, camera.position.z));
  const ext = clamp(55 + agl * 1.1, 55, 190);
  const sc = dir.shadow.camera;
  if (sc.right !== ext) { sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.updateProjectionMatrix(); }
  camera.getWorldDirection(_tgt);
  _tgt.y = 0; _tgt.normalize().multiplyScalar(ext * 0.45).add(camera.position);
  _tgt.y = hFast(_tgt.x, _tgt.z);
  // привязка к текселю тени: без неё края теней «ползут» при движении
  const texel = (ext * 2) / Q.shadow;
  _tgt.x = Math.round(_tgt.x / texel) * texel; _tgt.z = Math.round(_tgt.z / texel) * texel;
  dir.target.position.copy(_tgt);
  dir.position.copy(_tgt).addScaledVector(L, 200);
  dir.target.updateMatrixWorld();

  hemi.color.setRGB(...k.hs); hemi.groundColor.setRGB(...k.hg); hemi.intensity = k.hI;
  amb.intensity = 0.1 + night * 0.06;
  scene.fog.color.setRGB(...k.fog);
  SKY.fogColor.copy(scene.fog.color);
  // с высоты видно дальше: туман в лесу гуще, чем над кронами
  scene.fog.density = k.fogD * lerp(1, 0.22, smoothstep(8, 90, agl));
  renderer.toneMappingExposure = k.exp;

  // светила
  sunMesh.position.copy(camera.position).addScaledVector(_d, 1300);
  sunMesh.lookAt(camera.position);
  sunMesh.material.opacity = clamp(smoothstep(-0.08, 0.05, _d.y), 0, 1) * 0.55;
  sunMesh.material.color.setRGB(k.sun[0], k.sun[1], k.sun[2]);
  moonMesh.position.copy(camera.position).addScaledVector(_m, 1300);
  moonMesh.lookAt(camera.position);
  moonMesh.material.opacity = clamp(smoothstep(-0.05, 0.1, _m.y), 0, 1) * (0.25 + night * 0.75);
  stars.position.copy(camera.position);
  stars.material.uniforms.uO.value = night * night;
  stars.material.uniforms.uT.value = FRAME.t;
  clouds.position.copy(camera.position); clouds.position.y -= 60;
  const cu = clouds.material.uniforms;
  cu.uT.value = FRAME.t; cu.uSun.value.copy(_d); cu.uWind.value.copy(WIND.dir);
  const lit = new THREE.Color(k.sun[0], k.sun[1], k.sun[2]).multiplyScalar(lerp(1.0, 0.05, night) * (0.35 + sunUp * 0.9));
  lit.lerp(new THREE.Color(k.fog[0], k.fog[1], k.fog[2]), 0.45);
  cu.uLit.value.copy(lit);
  cu.uShade.value.setRGB(k.fog[0] * 0.55, k.fog[1] * 0.55, k.fog[2] * 0.6);
  cu.uCover.value = 0.42 + 0.08 * Math.sin(FRAME.t * 0.01);
  return k;
}
export function fmtTime(h) {
  const hh = Math.floor(((h % 24) + 24) % 24), mm = Math.floor((h - Math.floor(h)) * 60);
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
export function nextPhase() {
  let n = PHASES.slice().sort((a, b) => a - b).find(p => p > TIME.h + 0.01);
  if (n === undefined) n = Math.min(...PHASES);
  TIME.h = n;
}
