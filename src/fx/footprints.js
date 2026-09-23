import * as THREE from 'three';
import { scene, FRAME } from '../core/env.js';
import { clamp, sr } from '../core/math.js';
import { terrainH, trenchDist, pathInfluence, lakeRho, terrainNormal } from '../world/layout.js';
import { cv, tex } from '../gen/canvas.js';
import { WEATHER } from '../world/weather.js';
import { FX } from './particles.js';
import { squelch } from './audio.js';

/* Следы: отпечатки подошвы остаются на земле при ходьбе. На сухой подстилке
   еле заметны, на тропе, в грязи и после дождя — глубокие и блестящие.
   Держатся пару минут и тают; по мокрому шаг чавкает и брызжет. */
const MAX = 360;
let im = null, aA = null, n = 0, lastStep = 0, side = 1;
const LIFE = 150;
const born = new Float32Array(MAX), base = new Float32Array(MAX);
function soleTex() {
  const [c, x] = cv(64, 128);
  x.fillStyle = '#fff';
  x.beginPath(); x.ellipse(32, 40, 17, 30, 0, 0, 7); x.fill();     // носок
  x.beginPath(); x.ellipse(32, 100, 14, 18, 0, 0, 7); x.fill();    // каблук
  x.globalCompositeOperation = 'destination-out';
  for (let y = 16; y < 118; y += 9) { x.fillRect(12, y, 40, 3); }  // протектор
  const t = tex(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
export function buildFootprints() {
  const m = new THREE.MeshStandardMaterial({ map: soleTex(), color: 0x1d160f, transparent: true, depthWrite: false, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  m.onBeforeCompile = sh => {
    sh.vertexShader = 'attribute float aA;\nvarying float vA;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvA = aA;');
    sh.fragmentShader = 'varying float vA;\n' + sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vA;');
  };
  const g = new THREE.PlaneGeometry(0.13, 0.29).rotateX(-Math.PI / 2);
  aA = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
  g.setAttribute('aA', aA);
  im = new THREE.InstancedMesh(g, m, MAX);
  im.count = 0; im.frustumCulled = false; im.receiveShadow = true; im.renderOrder = 2;
  scene.add(im);
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _n = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _qy = new THREE.Quaternion();
/** Каждый кадр: pl — состояние игрока (позиция, шаг, курс, режим). */
export function updateFootprints(pl) {
  if (!im) return;
  const wet = WEATHER.wet;
  if (pl.mode === 'walk' && pl.onGround && !pl.swim && Math.floor(pl.step) !== lastStep) {
    lastStep = Math.floor(pl.step);
    side = -side;
    const x = pl.pos.x + Math.cos(pl.yaw) * 0.12 * side, z = pl.pos.z - Math.sin(pl.yaw) * 0.12 * side;
    const g = terrainH(x, z);
    // на настиле окопа, на досках и в воде следов нет
    if (Math.abs(pl.pos.y - terrainH(pl.pos.x, pl.pos.z)) < 0.06 && trenchDist(x, z) > 0.9 && lakeRho(x, z) > 1.01) {
      const soil = Math.max(pathInfluence(x, z), lakeRho(x, z) < 1.3 ? 1 : 0);
      const a = clamp(0.12 + soil * 0.35 + wet * 0.55, 0, 0.92);
      const i = n % MAX; n++;
      terrainNormal(x, z, _n);
      _q.setFromUnitVectors(_up, _n); _qy.setFromAxisAngle(_up, pl.yaw); _q.multiply(_qy);
      im.setMatrixAt(i, _m.compose(_p.set(x, g + 0.015, z), _q, _s.set(side < 0 ? -1 : 1, 1, 1)));
      born[i] = FRAME.t; base[i] = a; aA.array[i] = a;
      im.count = Math.min(MAX, n);
      im.instanceMatrix.needsUpdate = true;
      if (wet > 0.35) {
        squelch(wet);
        for (let k = 0; k < 3; k++) FX.alpha.spawn({ x, y: g + 0.05, z, vx: sr(-0.5, 0.5), vy: sr(0.6, 1.4), vz: sr(-0.5, 0.5), size: 0.06, grow: 0.2, life: 0.35, col: [0.3, 0.28, 0.25], a: 0.5 * wet, grav: 9.8 });
      }
    }
  }
  // таяние и блеск: мокрые следы глянцевые
  im.material.roughness = 0.85 - wet * 0.6;
  if (FRAME.n % 10 === 0) {
    for (let i = 0; i < im.count; i++) aA.array[i] = base[i] * clamp(1 - (FRAME.t - born[i]) / LIFE, 0, 1) * (WEATHER.rain > 0.7 ? 0.995 : 1);
    aA.needsUpdate = true;
  }
}
