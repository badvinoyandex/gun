import * as THREE from 'three';

/* Общее окружение: рендерер, сцена, камера, пресеты качества и часы кадра.
   Пресеты меняют только бюджеты (тени, плотность, пост-эффекты), а не саму карту:
   на слабой машине игроки должны видеть те же укрытия, что и на сильной. */

export const PRESETS = {
  potato: {
    name: 'минимальное', shadow: 512, grass: 4000, grassR: 18, trees: 0.6, treeNearR: 28,
    bloom: false, smaa: false, pixel: 0.75, refl: 0, cloth: 6, lights: 2, tex: 0.35,
    ferns: 0.35, dust: 300, shadowTrees: false, tufts: false, shadowEvery: 3, rain: 0.35
  },
  low: {
    name: 'низкое', shadow: 1024, grass: 9000, grassR: 24, trees: 0.72, treeNearR: 42,
    bloom: false, smaa: false, pixel: 1.0, refl: 0, cloth: 10, lights: 4, tex: 0.5,
    ferns: 0.55, dust: 900, shadowTrees: false, tufts: true, shadowEvery: 2, rain: 0.6
  },
  medium: {
    name: 'среднее', shadow: 2048, grass: 26000, grassR: 34, trees: 0.9, treeNearR: 62,
    bloom: true, smaa: true, pixel: 1.25, refl: 384, cloth: 14, lights: 6, tex: 0.75,
    ferns: 0.8, dust: 1800, shadowTrees: true, tufts: true, shadowEvery: 1, rain: 0.85
  },
  high: {
    name: 'высокое', shadow: 4096, grass: 60000, grassR: 44, trees: 1.0, treeNearR: 85,
    bloom: true, smaa: true, pixel: 1.6, refl: 640, cloth: 18, lights: 8, tex: 1.0,
    ferns: 1.0, dust: 3000, shadowTrees: true, tufts: true, shadowEvery: 1, rain: 1
  }
};

function pickQuality() {
  const q = new URLSearchParams(location.search).get('q');
  if (q && PRESETS[q]) return q;
  const saved = localStorage.getItem('tikhiy_bor_q');
  if (saved && PRESETS[saved]) return saved;
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  if (mem <= 2 || cores <= 2) return 'potato';
  if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || mem <= 3 || cores <= 3) return 'low';
  if (mem <= 6 || cores <= 6) return 'medium';
  return 'high';
}
export const QNAME = pickQuality();
export const Q = PRESETS[QNAME];

export const renderer = new THREE.WebGLRenderer({
  antialias: false, powerPreference: 'high-performance', stencil: false
});
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pixel));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.06, 1400);
camera.rotation.order = 'YXZ';
scene.add(camera);

export const MAXA = () => renderer.capabilities.getMaxAnisotropy();

/** Часы кадра: доступны всем системам. */
export const FRAME = { t: 0, dt: 0.016, n: 0 };

/** Объекты, которые не нужны в отражении озера (трава, частицы): экономия кадра. */
export const NO_REFLECT = [];

export const $ = s => document.querySelector(s);
/** Динамическое разрешение: если кадр не укладывается в бюджет, рендер уменьшается,
    при запасе — возвращается. PERF.load (0..1) урезает бюджеты обломков и частиц. */
export const PERF = { pr: Math.min(devicePixelRatio, Q.pixel), minPr: Math.min(0.55, Q.pixel), maxPr: Math.min(devicePixelRatio, Q.pixel), acc: 0, n: 0, t: 0, load: 0, auto: true, frameMs: 16 };
