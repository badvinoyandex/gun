import * as THREE from 'three';
import { scene, camera, Q, FRAME, NO_REFLECT } from '../core/env.js';
import { srnd, sr, TAU, clamp, lerp } from '../core/math.js';
import { MAP, lakeRho } from '../world/layout.js';
import { TEX } from '../gen/materials.js';
import { WIND } from '../world/wind.js';
import { cv, tex } from '../gen/canvas.js';

/* ============================================================================
   ЧАСТИЦЫ
   • Пул билбордов (огонь, дым, земля) — два инстанс-меша: аддитивный и обычный.
   • Пыль/пыльца в воздухе, падающая хвоя — целиком на GPU, без обновлений с CPU.
   • Туман над озером и низинами — встаёт к ночи и на рассвете.
============================================================================ */
const POOL = 700;
const BB_VS = /* glsl */`
  attribute vec4 aP;   // xyz, размер
  attribute vec4 aC;   // rgb, альфа
  attribute float aR;  // поворот
  varying vec4 vC; varying vec2 vUv;
  #include <fog_pars_vertex>
  void main(){
    vUv = uv; vC = aC;
    vec4 mvPosition = viewMatrix * vec4(aP.xyz, 1.0);
    float c = cos(aR), s = sin(aR);
    vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
    mvPosition.xy += q * aP.w;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const BB_FS = /* glsl */`
  uniform sampler2D tMap; uniform float uAdd;
  varying vec4 vC; varying vec2 vUv;
  #include <fog_pars_fragment>
  void main(){
    vec4 t = texture2D(tMap, vUv);
    float a = t.a * vC.a;
    if (a < 0.004) discard;
    gl_FragColor = uAdd > 0.5 ? vec4(vC.rgb * t.rgb * a, a) : vec4(vC.rgb * t.rgb, a);
    #include <fog_fragment>
  }`;
class Billboards {
  constructor(map, additive) {
    const g = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(1, 1);
    g.index = q.index; g.attributes.position = q.attributes.position; g.attributes.uv = q.attributes.uv;
    this.P = new Float32Array(POOL * 4); this.C = new Float32Array(POOL * 4); this.R = new Float32Array(POOL);
    g.setAttribute('aP', new THREE.InstancedBufferAttribute(this.P, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aC', new THREE.InstancedBufferAttribute(this.C, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aR', new THREE.InstancedBufferAttribute(this.R, 1).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { tMap: { value: map }, uAdd: { value: additive ? 1 : 0 } }]),
      vertexShader: BB_VS, fragmentShader: BB_FS, transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    m.uniforms.tMap.value = map;
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = additive ? 7 : 6;
    scene.add(this.mesh);
    this.g = g; this.list = [];
  }
  /** p: {x,y,z,vx,vy,vz,size,grow,life,col:[r,g,b],a,fade,drag,grav,rot,spin} */
  spawn(p) {
    if (this.list.length >= POOL) this.list.shift();
    p.age = 0; p.rot ??= srnd() * TAU; p.spin ??= sr(-0.6, 0.6);
    this.list.push(p);
  }
  update(dt) {
    const L = this.list;
    let n = 0;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      const dr = Math.exp(-(p.drag ?? 0.5) * dt);
      p.vx *= dr; p.vy *= dr; p.vz *= dr;
      p.vy -= (p.grav ?? 0) * dt;
      p.vx += WIND.dir.x * WIND.strength * (p.windK ?? 0) * dt; p.vz += WIND.dir.y * WIND.strength * (p.windK ?? 0) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.floor !== undefined && p.y < p.floor) { p.y = p.floor; p.vy *= -0.2; p.vx *= 0.5; p.vz *= 0.5; }
      p.rot += p.spin * dt;
      const t = p.age / p.life;
      const size = p.size + (p.grow ?? 0) * p.age;
      const a = p.a * (p.fadeIn ? Math.min(1, p.age / p.fadeIn) : 1) * Math.pow(1 - t, p.fade ?? 1);
      const c = p.col, ci = n * 4;
      this.P[ci] = p.x; this.P[ci + 1] = p.y; this.P[ci + 2] = p.z; this.P[ci + 3] = size;
      const k = p.cool ? lerp(1, p.cool, t) : 1;
      this.C[ci] = c[0] * k; this.C[ci + 1] = c[1] * (p.cool ? lerp(1, p.cool * 0.7, t) : 1); this.C[ci + 2] = c[2] * (p.cool ? lerp(1, p.cool * 0.4, t) : 1); this.C[ci + 3] = a;
      this.R[n] = p.rot;
      L[n] = p; n++;
    }
    L.length = n;
    this.g.instanceCount = n;
    this.g.attributes.aP.needsUpdate = true; this.g.attributes.aC.needsUpdate = true; this.g.attributes.aR.needsUpdate = true;
  }
}
export const FX = { add: null, alpha: null, dirt: null };

function dirtTex() {
  const [c, x] = cv(64);
  for (let i = 0; i < 18; i++) {
    const px = 32 + sr(-14, 14), py = 32 + sr(-14, 14), r = sr(3, 10);
    x.fillStyle = `rgba(255,255,255,${sr(0.5, 1)})`; x.beginPath(); x.ellipse(px, py, r, r * sr(0.5, 1), sr(0, 3), 0, 7); x.fill();
  }
  const t = tex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
}

/* ---------- Пыль и падающая хвоя: всё считается в шейдере ---------- */
let motes, needles, mist;
function buildMotes() {
  const N = Q.dust, pos = new Float32Array(N * 3), rnd = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { pos[i * 3] = srnd(); pos[i * 3 + 1] = srnd(); pos[i * 3 + 2] = srnd(); rnd[i * 3] = srnd(); rnd[i * 3 + 1] = srnd(); rnd[i * 3 + 2] = srnd(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aR', new THREE.BufferAttribute(rnd, 3));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uT: { value: 0 }, uC: { value: new THREE.Vector3() }, uW: { value: new THREE.Vector2() }, uO: { value: 0.4 }, uTint: { value: new THREE.Color(0xfff0d4) } },
    vertexShader: `attribute vec3 aR; uniform float uT; uniform vec3 uC; uniform vec2 uW; varying float vA;
      void main(){
        vec3 box = vec3(36.0, 14.0, 36.0);
        vec3 p = position * box;
        p.xz += uW * uT * (0.4 + aR.x * 0.6) * 1.5;
        p.y += sin(uT * (0.3 + aR.y) + aR.z * 6.0) * 0.6;
        p.x += sin(uT * 0.7 + aR.y * 9.0) * 0.4;
        vec3 w = uC + mod(p - uC + box * 0.5, box) - box * 0.5;
        w.y = uC.y + mod(p.y - uC.y + 7.0, 14.0) - 7.0;
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        gl_PointSize = clamp(38.0 / d, 1.0, 5.0);
        vA = smoothstep(34.0, 6.0, d) * (0.5 + 0.5 * sin(uT * 2.0 + aR.x * 30.0));
      }`,
    fragmentShader: `uniform float uO; uniform vec3 uTint; varying float vA;
      void main(){ float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)) * vA * uO; gl_FragColor = vec4(uTint * a, a); }`
  });
  motes = new THREE.Points(g, m); motes.frustumCulled = false; motes.renderOrder = 8;
  scene.add(motes); NO_REFLECT.push(motes);
}
function buildNeedles() {
  // иглы и чешуйки коры, падающие с крон: медленно, кружась, с порывами ветра
  const N = Math.round(Q.dust * 0.35);
  const base = new THREE.PlaneGeometry(0.035, 0.12);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
  const r = new Float32Array(N * 4);
  for (let i = 0; i < N * 4; i++) r[i] = srnd();
  g.setAttribute('aR', new THREE.InstancedBufferAttribute(r, 4));
  g.instanceCount = N;
  const m = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
    uniforms: { uT: { value: 0 }, uC: { value: new THREE.Vector3() }, uW: { value: new THREE.Vector2() }, uWA: { value: 0.5 }, uL: { value: new THREE.Color(1, 1, 1) }, uO: { value: 1 } },
    vertexShader: `attribute vec4 aR; uniform float uT, uWA; uniform vec3 uC; uniform vec2 uW; varying float vA; varying float vS;
      mat3 rot(vec3 a){ vec3 s = sin(a), c = cos(a);
        return mat3(c.y*c.z, c.y*s.z, -s.y, s.x*s.y*c.z - c.x*s.z, s.x*s.y*s.z + c.x*c.z, s.x*c.y, c.x*s.y*c.z + s.x*s.z, c.x*s.y*s.z - s.x*c.z, c.x*c.y); }
      void main(){
        float H = 16.0, B = 28.0;
        float fall = 0.35 + aR.w * 0.45;
        float y = H - mod(uT * fall + aR.y * H, H);
        vec3 p = vec3((aR.x - 0.5) * B, y - 3.0, (aR.z - 0.5) * B);
        p.xz += uW * (H - y) * (0.6 + uWA * 1.6);
        p.x += sin(uT * 1.3 + aR.w * 20.0) * 0.5; p.z += cos(uT * 1.1 + aR.x * 20.0) * 0.5;
        vec3 w = vec3(uC.x + mod(p.x - uC.x + B * 0.5, B) - B * 0.5, uC.y + p.y, uC.z + mod(p.z - uC.z + B * 0.5, B) - B * 0.5);
        vec3 v = rot(vec3(uT * (1.0 + aR.x * 3.0), uT * (0.7 + aR.z * 2.0), aR.y * 6.28)) * position;
        vS = aR.w;
        vA = smoothstep(0.0, 2.0, y) * smoothstep(H, H - 2.0, y);
        gl_Position = projectionMatrix * viewMatrix * vec4(w + v, 1.0);
      }`,
    fragmentShader: `uniform vec3 uL; uniform float uO; varying float vA; varying float vS;
      void main(){ vec3 c = mix(vec3(0.34, 0.22, 0.1), vec3(0.3, 0.33, 0.16), step(0.6, vS)); gl_FragColor = vec4(c * uL, vA * uO); }`
  });
  needles = new THREE.Mesh(g, m); needles.frustumCulled = false;
  scene.add(needles); NO_REFLECT.push(needles);
}
function buildMist() {
  // слои тумана над водой и прибрежной низиной
  const g = new THREE.PlaneGeometry(190, 150, 1, 1); g.rotateX(-Math.PI / 2); g.rotateY(-Math.PI / 4);
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uT: { value: 0 }, uO: { value: 0 }, uC: { value: new THREE.Color() }, uK: { value: 0 } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uT, uO, uK; uniform vec3 uC; varying vec3 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main(){
        vec2 p = vW.xz * 0.045 + vec2(uT * 0.012, uT * 0.007) + uK * 3.1;
        float d = n(p) * 0.55 + n(p * 2.3 + 4.0) * 0.3 + n(p * 5.1 - uT * 0.02) * 0.15;
        vec2 q = vec2((vW.x + vW.z) * 0.7071 / 62.0, (vW.x - vW.z) * 0.7071 / 44.0);
        float edge = 1.0 - smoothstep(0.55, 1.0, length(q));
        float a = smoothstep(0.35, 0.75, d) * edge * uO;
        vec3 V = normalize(cameraPosition - vW);
        a *= smoothstep(0.0, 0.3, abs(V.y) + 0.05) * 0.8 + 0.2;
        gl_FragColor = vec4(uC, a);
      }`
  });
  mist = [];
  for (let i = 0; i < 3; i++) {
    const mm = m.clone(); mm.uniforms.uK.value = i;
    const mesh = new THREE.Mesh(g, mm);
    mesh.position.y = MAP.WATER_Y + 0.35 + i * 0.55;
    mesh.renderOrder = 9 + i;
    scene.add(mesh); NO_REFLECT.push(mesh);
    mist.push(mesh);
  }
}

export function buildParticles() {
  FX.add = new Billboards(TEX.fire, true);
  FX.alpha = new Billboards(TEX.smoke, false);
  FX.dirt = new Billboards(dirtTex(), false);
  NO_REFLECT.push(FX.dirt.mesh);
  buildMotes(); buildNeedles(); buildMist();
}

/* ---------- Огонь в бочках и дым из печных труб ---------- */
const _acc = new Map();
export function emitFires(fires, dt, sky) {
  for (const f of fires) {
    if (f.pos === undefined) f.pos = new THREE.Vector3(f.x, f.y, f.z);
    if (camera.position.distanceToSquared(f.pos) > 160 * 160) continue;
    let a = (_acc.get(f) || 0) + dt;
    while (a > 0.05) {
      a -= 0.05;
      FX.add.spawn({ x: f.x + sr(-f.r, f.r) * 0.6, y: f.y, z: f.z + sr(-f.r, f.r) * 0.6, vx: sr(-0.1, 0.1), vy: sr(0.8, 1.5), vz: sr(-0.1, 0.1), size: sr(0.25, 0.45), grow: -0.2, life: sr(0.4, 0.8), col: [1.6, 0.9, 0.45], a: 0.9, cool: 0.5, windK: 0.3 });
      if (srnd() < 0.35) FX.alpha.spawn({ x: f.x, y: f.y + 0.6, z: f.z, vx: 0, vy: sr(0.6, 1.1), vz: 0, size: sr(0.4, 0.7), grow: 0.55, life: sr(3, 5), col: [0.26, 0.25, 0.24].map(v => v * lerp(1, 0.25, sky.night)), a: 0.35, fadeIn: 0.5, windK: 1.2, drag: 0.3 });
      if (srnd() < 0.08) FX.add.spawn({ x: f.x, y: f.y + 0.3, z: f.z, vx: sr(-0.4, 0.4), vy: sr(2, 4), vz: sr(-0.4, 0.4), size: 0.05, life: sr(0.8, 1.6), col: [2.5, 1.2, 0.4], a: 1, grav: 1.5, windK: 0.6, drag: 0.4 });
    }
    _acc.set(f, a);
  }
}

export function updateParticles(dt, sky) {
  FX.add.update(dt); FX.alpha.update(dt); FX.dirt.update(dt);
  const t = FRAME.t, cp = camera.position;
  const mu = motes.material.uniforms;
  mu.uT.value = t; mu.uC.value.copy(cp); mu.uW.value.copy(WIND.dir).multiplyScalar(WIND.strength);
  mu.uO.value = lerp(0.45, 0.12, sky.night);
  mu.uTint.value.setHex(sky.night > 0.5 ? 0x9fb4d0 : 0xfff0d4);
  const nu = needles.material.uniforms;
  nu.uT.value = t; nu.uC.value.copy(cp); nu.uW.value.copy(WIND.dir); nu.uWA.value = WIND.strength;
  nu.uL.value.setScalar(lerp(1.0, 0.12, sky.night));
  // хвоя сыплется только под пологом: над кронами и над озером её нет
  nu.uO.value = cp.y - (sky.ground ?? 0) < 20 && lakeRho(cp.x, cp.z) > 1.3 ? 1 : 0;
  // туман: к ночи и на рассвете, днём рассеивается
  const h = sky.h;
  const fogAmt = clamp(Math.max(1 - smoothstepF(4.0, 8.5, h) * (1 - smoothstepF(20.3, 23.0, h)), 0), 0, 1);
  for (const m of mist) {
    const u = m.material.uniforms;
    u.uT.value = t; u.uO.value = 0.02 + fogAmt * 0.42;
    u.uC.value.copy(sky.fogColor).lerp(new THREE.Color(0.7, 0.72, 0.74), 0.35 * (1 - sky.night));
  }
}
const smoothstepF = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
