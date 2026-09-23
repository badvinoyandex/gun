import * as THREE from 'three';
import { scene, camera, renderer, Q, FRAME, NO_REFLECT } from '../core/env.js';
import { rng, TAU, lerp, smoothstep, fbm } from '../core/math.js';
import { MAP, lakeRho, lakeContour, lakeXZ, terrainH, ISLAND, pathInfluence, trenchDist, keep, CLUSTERS } from './layout.js';
import { M, TEX } from '../gen/materials.js';
import { injectWind } from './wind.js';
import { addBox } from '../core/colliders.js';

/* ============================================================================
   ОЗЕРО
   Лесное озеро с тёмной «чайной» водой: отражение леса и неба (зеркальная
   камера с косой плоскостью отсечения), френель, блик солнца, рябь от ветра
   и кольца от взрывов. Берег — камыш с рогозом, у кромки — кувшинки.
============================================================================ */
export const LAKE = { mesh: null, mat: null, ripples: [], mirror: null };

const WATER_VS = /* glsl */`
  attribute float aDepth;
  uniform mat4 uTexMat;
  varying vec3 vW; varying vec4 vRUV; varying float vDepth;
  #include <fog_pars_vertex>
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz; vDepth = aDepth;
    vRUV = uTexMat * vec4(position, 1.0);
    vec4 mvPosition = viewMatrix * w;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const WATER_FS = /* glsl */`
  uniform sampler2D tRefl, tNormal;
  uniform float uTime, uHasRefl, uNight, uWind;
  uniform vec3 uSunDir, uSunCol, uSky, uDeep, uShallow, uMoonDir;
  uniform vec4 uRip[4];
  varying vec3 vW; varying vec4 vRUV; varying float vDepth;
  #include <common>
  #include <fog_pars_fragment>
  void main(){
    vec2 uv = vW.xz;
    float wspd = 0.6 + uWind;
    vec3 n1 = texture2D(tNormal, uv * 0.055 + vec2(uTime * 0.011, uTime * 0.007) * wspd).xyz * 2.0 - 1.0;
    vec3 n2 = texture2D(tNormal, uv * 0.14 - vec2(uTime * 0.009, -uTime * 0.013) * wspd).xyz * 2.0 - 1.0;
    vec3 n3 = texture2D(tNormal, uv * 0.43 + vec2(-uTime * 0.03, uTime * 0.02)).xyz * 2.0 - 1.0;
    vec2 slope = (n1.xy + n2.xy) * (0.35 + uWind * 0.5) + n3.xy * 0.12;
    // кольца от взрывов и от дрона над водой
    for (int i = 0; i < 4; i++) {
      vec4 r = uRip[i];
      float age = uTime - r.z;
      if (age < 0.0 || age > 6.0 || r.w <= 0.0) continue;
      vec2 d = uv - r.xy; float dist = length(d);
      float front = age * 3.2;
      float ring = sin((dist - front) * 5.5) * exp(-abs(dist - front) * 0.9) * exp(-age * 0.7) * r.w;
      slope += (dist > 0.01 ? d / dist : vec2(0.0)) * ring * 0.9;
    }
    vec3 n = normalize(vec3(slope.x, 1.0, slope.y));
    vec3 V = normalize(cameraPosition - vW);
    float ndv = max(dot(V, n), 0.0);
    float fres = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
    vec3 refl = uSky;
    if (uHasRefl > 0.5) {
      vec4 ruv = vRUV; ruv.xy += slope * 0.09 * ruv.w;
      refl = texture2DProj(tRefl, ruv).rgb;
    }
    vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 2.4, vDepth));
    vec3 col = mix(body, refl, clamp(fres * 0.92 + 0.1, 0.0, 1.0));
    vec3 H = normalize(uSunDir + V);
    col += uSunCol * pow(max(dot(n, H), 0.0), 320.0) * 7.0 * step(0.0, uSunDir.y);
    vec3 Hm = normalize(uMoonDir + V);
    col += vec3(0.55, 0.65, 0.85) * pow(max(dot(n, Hm), 0.0), 420.0) * 1.6 * uNight * step(0.0, uMoonDir.y);
    // пена и муть у самого берега
    float edge = 1.0 - smoothstep(0.0, 0.22, vDepth);
    col = mix(col, uShallow * 1.6 + 0.02, edge * 0.35);
    float a = smoothstep(-0.02, 0.28, vDepth) * 0.96;
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

/** Зеркальная камера — та же логика, что у Reflector из three/addons, но с
    исключением травы и частиц: их отражение не видно, а кадр дорогой. */
function makeMirror(size) {
  const rt = new THREE.WebGLRenderTarget(size, Math.round(size * 0.6), { type: THREE.HalfFloatType, samples: 0 });
  const vcam = new THREE.PerspectiveCamera();
  const texMat = new THREE.Matrix4();
  const plane = new THREE.Plane(), clip = new THREE.Vector4(), q = new THREE.Vector4();
  const n = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), camPos = new THREE.Vector3();
  const view = new THREE.Vector3(), target = new THREE.Vector3(), look = new THREE.Vector3(), rot = new THREE.Matrix4();
  let frame = 0;
  return {
    rt, texMat,
    render(mesh) {
      pos.set(0, MAP.WATER_Y, 0);
      camPos.setFromMatrixPosition(camera.matrixWorld);
      view.subVectors(pos, camPos);
      if (view.dot(n) > 0) return;               // камера под водой
      if (Q.refl < 500 && (frame++ & 1)) return;  // на среднем качестве — через кадр
      view.reflect(n).negate().add(pos);
      rot.extractRotation(camera.matrixWorld);
      look.set(0, 0, -1).applyMatrix4(rot).add(camPos);
      target.subVectors(pos, look).reflect(n).negate().add(pos);
      vcam.position.copy(view);
      vcam.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
      vcam.lookAt(target);
      vcam.far = camera.far;
      vcam.updateMatrixWorld();
      vcam.projectionMatrix.copy(camera.projectionMatrix);
      texMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      texMat.multiply(vcam.projectionMatrix).multiply(vcam.matrixWorldInverse).multiply(mesh.matrixWorld);
      plane.setFromNormalAndCoplanarPoint(n, pos).applyMatrix4(vcam.matrixWorldInverse);
      clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      const P = vcam.projectionMatrix.elements;
      q.x = (Math.sign(clip.x) + P[8]) / P[0]; q.y = (Math.sign(clip.y) + P[9]) / P[5]; q.z = -1; q.w = (1 + P[10]) / P[14];
      clip.multiplyScalar(2 / clip.dot(q));
      P[2] = clip.x; P[6] = clip.y; P[10] = clip.z + 1 - 0.003; P[14] = clip.w;
      mesh.visible = false;
      const hidden = NO_REFLECT.filter(o => o.visible);
      for (const o of hidden) o.visible = false;
      const prevRT = renderer.getRenderTarget(), prevAuto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(rt);
      renderer.state.buffers.depth.setMask(true);
      renderer.clear();
      renderer.render(scene, vcam);
      renderer.setRenderTarget(prevRT);
      renderer.shadowMap.autoUpdate = prevAuto;
      for (const o of hidden) o.visible = true;
      mesh.visible = true;
    }
  };
}

function waterGeometry() {
  const rings = 26, segs = 128, pos = [], depth = [], idx = [];
  pos.push(0, 0, 0); depth.push(MAP.WATER_Y - terrainH(0, 0));
  for (let r = 1; r <= rings; r++) {
    const k = Math.pow(r / rings, 0.8) * 1.16;
    for (let s = 0; s < segs; s++) {
      const [cx, cz] = lakeContour(s / segs * TAU, 0);
      const x = cx * k, z = cz * k;
      pos.push(x, 0, z); depth.push(MAP.WATER_Y - terrainH(x, z));
    }
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + s, 1 + (s + 1) % segs);
  for (let r = 1; r < rings; r++) for (let s = 0; s < segs; s++) {
    const a = 1 + (r - 1) * segs + s, b = 1 + (r - 1) * segs + (s + 1) % segs, c = a + segs, d = b + segs;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function buildLake() {
  const mirror = Q.refl ? makeMirror(Q.refl) : null;
  LAKE.mirror = mirror;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    tRefl: { value: null }, tNormal: { value: TEX.water }, uTexMat: { value: new THREE.Matrix4() },
    uTime: { value: 0 }, uHasRefl: { value: mirror ? 1 : 0 }, uNight: { value: 0 }, uWind: { value: 0.5 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uSky: { value: new THREE.Color(0.5, 0.6, 0.7) }, uDeep: { value: new THREE.Color(0.012, 0.018, 0.014) },
    uShallow: { value: new THREE.Color(0.06, 0.055, 0.035) },
    uRip: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, -99, 0)) }
  }]);
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: WATER_VS, fragmentShader: WATER_FS, transparent: true, fog: true, depthWrite: true });
  mat.uniforms.tNormal.value = TEX.water;
  if (mirror) { mat.uniforms.tRefl.value = mirror.rt.texture; mat.uniforms.uTexMat.value = mirror.texMat; }
  const mesh = new THREE.Mesh(waterGeometry(), mat);
  mesh.position.y = MAP.WATER_Y;
  mesh.renderOrder = 2;
  mesh.name = 'lake';
  if (mirror) mesh.onBeforeRender = () => mirror.render(mesh);
  scene.add(mesh);
  LAKE.mesh = mesh; LAKE.mat = mat;
  buildReeds();
  buildLilies();
  buildPiers();
  buildIsland();
}

export function addRipple(x, z, strength = 1) {
  const u = LAKE.mat?.uniforms.uRip.value;
  if (!u) return;
  let slot = u[0];
  for (const r of u) if (r.z < slot.z) slot = r;
  slot.set(x, z, FRAME.t, strength);
}

/* ---------- Камыш и рогоз ---------- */
function buildReeds() {
  const R = rng(5150);
  injectWind(M.reed, { amp: 0.35, stiff: 1.7, refH: 2.2, flutter: 0.05, trample: true, blast: 1.3 });
  const planes = [];
  for (let p = 0; p < 3; p++) {
    const g = new THREE.PlaneGeometry(1.1, 2.2, 1, 3);
    g.translate(0, 1.1, 0); g.rotateY(p * Math.PI / 3);
    const nn = g.attributes.normal;
    for (let i = 0; i < nn.count; i++) nn.setXYZ(i, nn.getX(i) * 0.3, 0.9, nn.getZ(i) * 0.3);
    planes.push(g);
  }
  const geo = mergeSimple(planes);
  const pts = [];
  for (let k = 0; k < 26000 && pts.length < 3600; k++) {
    const phi = R() * TAU, rr = R.range(0.9, 1.09);
    const [cx, cz] = lakeContour(phi, 0);
    const x = cx * rr + R.range(-1, 1), z = cz * rr + R.range(-1, 1);
    const rho = lakeRho(x, z);
    if (rho < 0.9 || rho > 1.1) continue;
    // заросли пятнами: есть и чистые заходы к воде
    if (fbm(x * 0.09 + 3, z * 0.09 - 5, 2) < 0.47) continue;
    if (pathInfluence(x, z, 2.5) > 0 || trenchDist(x, z) < 2) continue;
    if (nearPier(x, z, 3.5)) continue;
    pts.push([x, z]);
  }
  // заросли вокруг острова
  for (let k = 0; k < 240; k++) {
    const a = R() * TAU, r = R.range(ISLAND.r - 1.2, ISLAND.r + 0.8);
    pts.push([ISLAND.x + Math.cos(a) * r, ISLAND.z + Math.sin(a) * r]);
  }
  const im = new THREE.InstancedMesh(geo, M.reed, pts.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
  pts.forEach(([x, z], i) => {
    const y = Math.max(terrainH(x, z), MAP.WATER_Y - 0.5) - 0.05;
    const h = R.range(0.7, 1.15);
    p.set(x, y, z); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * TAU); s.set(R.range(0.8, 1.2), h, R.range(0.8, 1.2));
    m.compose(p, q, s); im.setMatrixAt(i, m);
    const v = R.range(0.8, 1.15); c.setRGB(v, v, v * 0.9); im.setColorAt(i, c);
  });
  im.receiveShadow = true; im.castShadow = Q.shadowTrees; im.frustumCulled = false;
  im.name = 'reeds';
  scene.add(im);
}
function mergeSimple(geos) {
  const pos = [], nrm = [], uv = [], idx = [];
  let off = 0;
  for (const g of geos) {
    pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); uv.push(...g.attributes.uv.array);
    for (const i of g.index.array) idx.push(i + off);
    off += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

/* ---------- Кувшинки ---------- */
function buildLilies() {
  const R = rng(6161);
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  for (let i = 0; i <= 24; i++) { const a = 0.35 + i / 24 * (TAU - 0.7); shape.lineTo(Math.cos(a) * 0.22, Math.sin(a) * 0.22); }
  shape.lineTo(0, 0);
  const g = new THREE.ShapeGeometry(shape, 1); g.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3f5a2a, roughness: 0.45, side: THREE.DoubleSide });
  const pts = [];
  for (let k = 0; k < 9000 && pts.length < 700; k++) {
    const phi = R() * TAU, rr = R.range(0.72, 0.92);
    const [cx, cz] = lakeContour(phi, 0);
    const x = cx * rr, z = cz * rr;
    if (fbm(x * 0.12 + 11, z * 0.12, 2) < 0.55 || nearPier(x, z, 2)) continue;
    pts.push([x, z]);
  }
  const im = new THREE.InstancedMesh(g, mat, pts.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
  pts.forEach(([x, z], i) => {
    const sc = R.range(0.6, 1.4);
    p.set(x, MAP.WATER_Y + 0.012, z); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * TAU); s.set(sc, 1, sc);
    m.compose(p, q, s); im.setMatrixAt(i, m);
    const v = R.range(0.7, 1.2); c.setRGB(v, v, v * 0.85); im.setColorAt(i, c);
  });
  im.receiveShadow = true; im.frustumCulled = false; im.name = 'lilies';
  scene.add(im);
}

/* ---------- Мостки турбазы и кордона ---------- */
export const PIERS = [];
{
  // от берега на кончике озера к центру; второй — симметрично
  for (const sgn of [-1, 1]) {
    let a = null;
    for (let t = 55; t > 15; t -= 0.25) {
      const x = sgn * t * Math.SQRT1_2, z = sgn * t * Math.SQRT1_2;
      if (lakeRho(x, z) < 1.03) { a = [x, z]; break; }
    }
    const L = 11, dir = [-sgn * Math.SQRT1_2, -sgn * Math.SQRT1_2];
    const x0 = a[0] - dir[0] * 2.5, z0 = a[1] - dir[1] * 2.5;
    PIERS.push({ x0, z0, x1: x0 + dir[0] * L, z1: z0 + dir[1] * L, rot: Math.atan2(dir[0], dir[1]), L });
  }
}
function nearPier(x, z, r) {
  for (const p of PIERS) {
    const vx = p.x1 - p.x0, vz = p.z1 - p.z0, t = Math.max(0, Math.min(1, ((x - p.x0) * vx + (z - p.z0) * vz) / (vx * vx + vz * vz)));
    if (Math.hypot(x - p.x0 - vx * t, z - p.z0 - vz * t) < r) return true;
  }
  return false;
}
export function planPiers() { for (const p of PIERS) keep((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2, 3); }
function buildPiers() {
  const R = rng(7272);
  const deckY = MAP.WATER_Y + 0.55;
  const plankG = new THREE.BoxGeometry(1.9, 0.05, 0.22);
  const postG = new THREE.CylinderGeometry(0.09, 0.1, 1, 7);
  for (const p of PIERS) {
    const g = new THREE.Group();
    g.position.set(p.x0, 0, p.z0); g.rotation.y = p.rot;
    const n = Math.floor(p.L / 0.26);
    for (let i = 0; i < n; i++) {
      if (R() < 0.08 && i > 4) continue;                       // выпавшие доски
      const pl = new THREE.Mesh(plankG, R() < 0.5 ? M.planks : M.planksDark);
      const sag = i > n * 0.8 ? -(i - n * 0.8) * 0.02 : 0;       // конец просел
      pl.position.set(R.range(-0.04, 0.04), deckY + sag + R.range(-0.01, 0.01), i * 0.26 + 0.13);
      pl.rotation.set(R.range(-0.02, 0.02), R.range(-0.04, 0.04), sag * 2 + R.range(-0.02, 0.02));
      pl.castShadow = true; pl.receiveShadow = true;
      g.add(pl);
    }
    for (let i = 0; i <= p.L; i += 2.2) for (const sx of [-0.85, 0.85]) {
      const wx = p.x0 + Math.sin(p.rot) * i + Math.cos(p.rot) * sx, wz = p.z0 + Math.cos(p.rot) * i - Math.sin(p.rot) * sx;
      const bot = Math.min(terrainH(wx, wz), MAP.WATER_Y) - 0.4, top = deckY - 0.03 + (i > p.L * 0.8 ? -0.1 : 0);
      const post = new THREE.Mesh(postG, M.deadwood);
      post.scale.y = top - bot + 0.15; post.position.set(sx, (top + bot) / 2 + 0.07, i);
      post.castShadow = true; g.add(post);
    }
    // перила с одной стороны — наполовину обломаны
    for (let i = 0.5; i < p.L * 0.55; i += 1.1) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.9, 0.07), M.planksDark);
      post.position.set(-0.9, deckY + 0.45, i); g.add(post);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, p.L * 0.52), M.planksDark);
    rail.position.set(-0.9, deckY + 0.88, p.L * 0.28); rail.rotation.x = 0.02; g.add(rail);
    scene.add(g);
    // опора для пешего режима: настил мостков
    const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
    addBox(cx, deckY - 0.3, cz, 1.9, 0.62, p.L, p.rot);
    // лодка у мостков: наполовину затоплена
    buildBoat(p.x0 + Math.sin(p.rot) * 7 + Math.cos(p.rot) * 2.2, p.z0 + Math.cos(p.rot) * 7 - Math.sin(p.rot) * 2.2, p.rot + 0.3, 0.35);
  }
}
/** Деревянная лодка: корпус из профиля, скамьи. sink — насколько затоплена. */
export function buildBoat(x, z, rot, sink = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.7, 0.45); shape.quadraticCurveTo(-0.72, -0.05, 0, -0.1); shape.quadraticCurveTo(0.72, -0.05, 0.7, 0.45);
  shape.lineTo(0.62, 0.45); shape.quadraticCurveTo(0.6, 0.02, 0, 0); shape.quadraticCurveTo(-0.6, 0.02, -0.62, 0.45); shape.closePath();
  const hull = new THREE.ExtrudeGeometry(shape, { depth: 3.6, bevelEnabled: false, steps: 1 });
  hull.translate(0, 0, -1.8);
  // сужаем нос
  const pa = hull.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const zz = pa.getZ(i), k = zz > 1.0 ? 1 - (zz - 1.0) / 0.8 * 0.85 : 1;
    pa.setX(i, pa.getX(i) * k);
  }
  hull.computeVertexNormals();
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(hull, M.planksPaint);
  mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh);
  for (const zz of [-0.9, 0.4]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.26), M.planks);
    seat.position.set(0, 0.34, zz); g.add(seat);
  }
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.03, 3.0), M.planksDark);
  floor.position.set(0, 0.06, -0.1); g.add(floor);
  const y = Math.max(terrainH(x, z) + 0.1, MAP.WATER_Y - sink);
  g.position.set(x, y, z); g.rotation.set(sink * 0.25, rot, sink * 0.3);
  scene.add(g);
  return g;
}

/* ---------- Остров: старая сосна, камни, останки беседки ---------- */
function buildIsland() {
  const R = rng(8383);
  const y = terrainH(ISLAND.x, ISLAND.z);
  const post = new THREE.CylinderGeometry(0.07, 0.08, 2.4, 6);
  for (let i = 0; i < 6; i++) {
    if (i === 4) continue;
    const a = i / 6 * TAU, x = ISLAND.x - 1.4 + Math.cos(a) * 1.5, z = ISLAND.z + 1 + Math.sin(a) * 1.5;
    const m = new THREE.Mesh(post, M.planksDark);
    const tilt = i === 2 ? 0.25 : R.range(-0.04, 0.04);
    m.position.set(x, terrainH(x, z) + 1.15, z); m.rotation.set(tilt, 0, R.range(-0.05, 0.05));
    m.castShadow = true; scene.add(m);
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.1, 0.9, 6, 1, true), M.roofRust);
  roof.position.set(ISLAND.x - 1.4, y + 2.6, ISLAND.z + 1); roof.rotation.set(0.12, 0.3, 0.2);
  roof.castShadow = true; scene.add(roof);
  for (let i = 0; i < 7; i++) {
    const a = R() * TAU, r = R.range(2.5, ISLAND.r - 0.6), x = ISLAND.x + Math.cos(a) * r, z = ISLAND.z + Math.sin(a) * r;
    const s = R.range(0.3, 0.8);
    const g = new THREE.DodecahedronGeometry(1, 1);
    const pa = g.attributes.position;
    for (let k = 0; k < pa.count; k++) pa.setXYZ(k, pa.getX(k) * (1 + R.range(-0.15, 0.15)), pa.getY(k) * 0.6, pa.getZ(k) * (1 + R.range(-0.15, 0.15)));
    g.computeVertexNormals();
    const cols = new Float32Array(pa.count * 3).fill(0.85);
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const m = new THREE.Mesh(g, M.stone);
    m.scale.setScalar(s); m.position.set(x, terrainH(x, z) + s * 0.2, z); m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }
}

/** Обновление воды: цвета берутся из текущего неба. */
export function updateLake(sky) {
  if (!LAKE.mat) return;
  const u = LAKE.mat.uniforms;
  u.uTime.value = FRAME.t;
  u.uSunDir.value.copy(sky.sunDir);
  u.uMoonDir.value.copy(sky.sunDir).multiplyScalar(-1);
  u.uSunCol.value.copy(sky.sunColor).multiplyScalar(sky.sunI * 0.25);
  u.uSky.value.copy(sky.fogColor).multiplyScalar(0.9);
  u.uNight.value = sky.night;
  u.uWind.value = sky.wind;
  // вода темнеет к ночи, днём — торфяная
  u.uDeep.value.setRGB(lerp(0.014, 0.004, sky.night), lerp(0.02, 0.006, sky.night), lerp(0.016, 0.01, sky.night));
  u.uShallow.value.setRGB(lerp(0.07, 0.012, sky.night), lerp(0.062, 0.013, sky.night), lerp(0.04, 0.016, sky.night));
}
