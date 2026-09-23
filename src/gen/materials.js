import * as THREE from 'three';
import * as TX from './textures.js';
import { injectWind } from '../world/wind.js';

/* Общий набор материалов. Всё — MeshStandardMaterial: один закон освещения
   для всей сцены, чтобы закат и фонари одинаково ложились на кору, ржавчину и мох. */
export const M = {};
export const TEX = {};

const std = (o) => new THREE.MeshStandardMaterial(o);
function surf(maps, o = {}) {
  const m = std({ map: maps.map, normalMap: maps.normal, roughness: o.rough ?? 0.9, metalness: o.metal ?? 0, color: o.color ?? 0xffffff, ...o.extra });
  if (o.nscale) m.normalScale.set(o.nscale, o.nscale);
  return m;
}
function foliage(map, o = {}) {
  const m = std({
    map, alphaTest: o.alphaTest ?? 0.5, side: THREE.DoubleSide, roughness: o.rough ?? 0.85,
    color: o.color ?? 0xffffff, metalness: 0
  });
  // Лёгкая «просвечиваемость»: тыльная сторона карточки не проваливается в черноту.
  m.emissive = new THREE.Color(o.glow ?? 0x0b1206);
  return m;
}
/** Материал глубины для теней листвы: учитывает альфу и тот же ветер. */
export function depthFor(mat, wind) {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: mat.map, alphaTest: mat.alphaTest, side: THREE.DoubleSide });
  if (wind) injectWind(d, wind);
  return d;
}

export function buildMaterials() {
  TEX.floor = TX.forestFloor();
  TEX.path = TX.dirtPath();
  TEX.mud = TX.mud();
  TEX.dug = TX.dugEarth();
  {
    const m = TEX.dug.map.clone(), n = TEX.dug.normal.clone();
    m.repeat.set(4, 2); n.repeat.set(4, 2); m.needsUpdate = n.needsUpdate = true;
    M.dirtMound = new THREE.MeshStandardMaterial({ map: m, normalMap: n, roughness: 1 });
  }

  const spruceBark = TX.bark('spruce'), pineBark = TX.bark('pine'), birch = TX.birchBark();
  M.barkSpruce = surf(spruceBark, { rough: 0.95, nscale: 1.2, extra: { vertexColors: true } });
  M.barkPine = surf(pineBark, { rough: 0.92, nscale: 1.4, extra: { vertexColors: true } });
  M.barkBirch = surf(birch, { rough: 0.8, extra: { vertexColors: true } });
  M.deadwood = surf(spruceBark, { rough: 0.98, color: 0x9a948a });

  TEX.spruce = TX.spruceAtlas();
  TEX.pine = TX.pineAtlas();
  TEX.birch = TX.birchAtlas();
  M.spruce = foliage(TEX.spruce, { rough: 0.9, glow: 0x070d06 });
  M.pine = foliage(TEX.pine, { rough: 0.85, glow: 0x0a1007 });
  M.birch = foliage(TEX.birch, { rough: 0.8, glow: 0x101806 });

  M.grass = foliage(TX.grassTex(), { alphaTest: 0.45, rough: 0.95, glow: 0x0a1206 });
  M.fern = foliage(TX.fernTex(), { alphaTest: 0.45, glow: 0x0a1406 });
  M.shrub = foliage(TX.shrubTex(), { alphaTest: 0.45, glow: 0x081006 });
  M.reed = foliage(TX.reedTex(), { alphaTest: 0.45, rough: 0.8, glow: 0x0c1206 });

  const pl = TX.planks([116, 108, 96]);
  M.planks = surf(pl, { rough: 0.92 });
  M.planksDark = surf(TX.planks([84, 72, 60]), { rough: 0.95 });
  M.planksPaint = surf(TX.planks([88, 104, 90]), { rough: 0.9 });   // выцветшая зелёная краска турбазы
  M.logWall = surf(TX.logWall(), { rough: 0.95, nscale: 1.3 });
  M.logEnd = std({ color: 0x8a7458, roughness: 0.95 });
  M.roofRust = surf(TX.corrugated([92, 96, 90], 1.0), { rough: 0.7, metal: 0.35, extra: { side: THREE.DoubleSide } });
  M.roofTar = surf(TX.rustMetal([42, 42, 40], 0.05), { rough: 0.95, extra: { side: THREE.DoubleSide } });
  M.concrete = surf(TX.rustMetal([122, 120, 114], 0.12), { rough: 0.95, nscale: 0.6 });
  M.brick = std({ color: 0x7e4a36, roughness: 0.95 });

  const paints = [[78, 104, 118], [124, 118, 92], [104, 44, 36], [72, 88, 62], [150, 146, 136]];
  M.carPaint = paints.map(p => surf(TX.rustMetal(p, 0.9), { rough: 0.62, metal: 0.4 }));
  M.burnt = surf(TX.rustMetal([52, 38, 30], 1.2), { rough: 0.9, metal: 0.25 });
  M.barrel = [[60, 84, 110], [120, 40, 32], [70, 86, 58], [118, 104, 60]].map(p => surf(TX.rustMetal(p, 0.8, 256), { rough: 0.6, metal: 0.45 }));
  M.steel = std({ color: 0x3c3e3e, roughness: 0.55, metalness: 0.7 });
  M.rust = surf(TX.rustMetal([96, 60, 40], 1.0, 256), { rough: 0.8, metal: 0.4 });
  M.dark = std({ color: 0x1c1d1c, roughness: 0.7, metalness: 0.3 });
  M.rubber = std({ color: 0x151515, roughness: 0.92 });
  M.glass = std({ color: 0x1c2428, roughness: 0.08, metalness: 0.9, transparent: true, opacity: 0.55 });
  M.sack = surf(TX.sackcloth(), { rough: 0.98 });
  M.canvas = std({ color: 0x5d5e44, roughness: 0.95, side: THREE.DoubleSide });
  M.camo = std({ map: TX.camoNet(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95 });
  M.wire = std({ color: 0x4a4038, roughness: 0.6, metalness: 0.6 });
  M.rope = std({ color: 0x6d6250, roughness: 0.95 });
  M.stone = surf(TX.rustMetal([108, 110, 104], 0.0, 256), { rough: 0.95, nscale: 1.4, extra: { vertexColors: true } });
  M.crate = surf(TX.planks([98, 102, 70], 4), { rough: 0.92 });
  M.bone = std({ color: 0xd8d2c0, roughness: 0.8 });

  // Стекло светильников: эмиссия управляется циклом суток (у каждого фонаря свой клон).
  M.lampGlass = std({ color: 0x8d8f8a, emissive: 0xffc27a, emissiveIntensity: 0, roughness: 0.3 });

  TEX.mineSign = [TX.mineSign(0), TX.mineSign(1)];
  TEX.flagA = TX.teamFlag('A');
  TEX.flagD = TX.teamFlag('D');
  TEX.pennantA = TX.pennant('A');
  TEX.pennantD = TX.pennant('D');
  TEX.glow = TX.radial([[0, 'rgba(255,236,200,1)'], [0.18, 'rgba(255,200,130,.55)'], [0.5, 'rgba(255,170,90,.12)'], [1, 'rgba(255,160,80,0)']]);
  TEX.pool = TX.radial([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,.55)'], [0.7, 'rgba(255,255,255,.14)'], [1, 'rgba(255,255,255,0)']], 256);
  TEX.smoke = TX.smokeTex();
  TEX.fire = TX.radial([[0, 'rgba(255,250,220,1)'], [0.25, 'rgba(255,190,90,.9)'], [0.6, 'rgba(220,80,20,.35)'], [1, 'rgba(120,20,0,0)']]);
  TEX.crater = TX.craterTex();
  TEX.water = TX.waterNormals();
  TEX.board = TX.boardSign(['ТУРБАЗА', '«ЛЕСНОЕ»', 'добро пожаловать']);
  TEX.boardK = TX.boardSign(['ЛЕСНИЧЕСТВО', 'КОРДОН №4', 'берегите лес'], '#3b3a2c');
}
