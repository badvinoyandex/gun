import * as THREE from 'three';
import * as TX from './textures.js';
import { injectWind, injectStructFX } from '../world/wind.js';

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
  M.roofRust = surf(TX.corrugated([88, 92, 86], 0.7, 1), { rough: 0.7, metal: 0.35, extra: { side: THREE.DoubleSide } });
  M.roofTar = surf(TX.rustMetal([42, 42, 40], 0.05), { rough: 0.95, extra: { side: THREE.DoubleSide } });
  M.concrete = surf(TX.rustMetal([122, 120, 114], 0.12), { rough: 0.95, nscale: 0.6 });
  M.brick = std({ color: 0x7e4a36, roughness: 0.95 });

  const paints = [[78, 104, 118], [124, 118, 92], [104, 44, 36], [72, 88, 62], [150, 146, 136]];
  M.carPaint = paints.map(p => surf(TX.rustMetal(p, 0.9), { rough: 0.62, metal: 0.4 }));
  M.burnt = surf(TX.rustMetal([48, 40, 34], 0.8), { rough: 0.9, metal: 0.25, color: 0x8c8580 });
  M.barrel = [[60, 84, 110], [120, 40, 32], [70, 86, 58], [118, 104, 60]].map(p => surf(TX.rustMetal(p, 0.8, 256), { rough: 0.6, metal: 0.45 }));
  M.steel = std({ color: 0x3c3e3e, roughness: 0.55, metalness: 0.7 });
  M.rust = surf(TX.rustMetal([96, 60, 40], 1.0, 256), { rough: 0.8, metal: 0.4 });
  M.dark = std({ color: 0x1c1d1c, roughness: 0.7, metalness: 0.3 });
  M.rubber = std({ color: 0x151515, roughness: 0.92 });
  M.glass = std({ color: 0x1c2428, roughness: 0.08, metalness: 0.9, transparent: true, opacity: 0.55 });
  M.sack = surf(TX.sackcloth(), { rough: 0.98 });
  M.wattle = surf(TX.wattle(), { rough: 0.97, nscale: 1.2 });
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
  TEX.smokeAtlas = TX.smokeAtlas();
  TEX.fireAtlas = TX.fireAtlas();
  TEX.fire = TX.radial([[0, 'rgba(255,250,220,1)'], [0.25, 'rgba(255,190,90,.9)'], [0.6, 'rgba(220,80,20,.35)'], [1, 'rgba(120,20,0,0)']]);
  TEX.crater = TX.craterTex();
  TEX.water = TX.waterNormals();
  TEX.board = TX.boardSign(['ТУРБАЗА', '«ЛЕСНОЕ»', 'добро пожаловать']);
  TEX.boardK = TX.boardSign(['ЛЕСНИЧЕСТВО', 'КОРДОН №4', 'берегите лес'], '#3b3a2c');
  // пионерлагерь «Волчонок»: выцветшая голубая и белая краска, облупленные вывески
  M.planksCamp = surf(TX.planks([92, 118, 128]), { rough: 0.9 });
  M.planksWhite = surf(TX.planks([176, 172, 158]), { rough: 0.88 });
  M.planksCream = surf(TX.planks([150, 132, 96]), { rough: 0.9 });
  M.roofCamp = surf(TX.corrugated([88, 102, 96], 0.55, 1), { rough: 0.72, metal: 0.35, extra: { side: THREE.DoubleSide } });
  M.plaster = std({ color: 0xb4b0a4, roughness: 0.97 });
  M.paintRed = surf(TX.rustMetal([140, 44, 36], 0.9, 256), { rough: 0.65, metal: 0.3 });
  M.steelPipe = surf(TX.rustMetal([110, 116, 112], 1.1, 256), { rough: 0.6, metal: 0.55 });
  M.barkLog = surf(TX.planks([96, 78, 60], 3), { rough: 0.95 });
  const sign = (t) => std({ map: t, roughness: 0.8, side: THREE.DoubleSide });
  M.signGate = sign(TX.campSign(['ПИОНЕРСКИЙ ЛАГЕРЬ', '«ВОЛЧОНОК»'], { w: 1024, h: 200, sizes: [52, 84] }));
  M.signDining = sign(TX.campSign(['СТОЛОВАЯ'], { w: 512, h: 128, bg: '#e2dccb', fg: '#9b2a22', sizes: [80] }));
  M.signWC = sign(TX.campSign(['М', 'Ж'], { w: 256, h: 128, bg: '#dcd6c4', fg: '#2c4f6e', sizes: [70, 70] }));
  M.signWash = sign(TX.campSign(['УМЫВАЛЬНИК'], { w: 512, h: 96, bg: '#2f5a6e', fg: '#e8e0c8', sizes: [60] }));
  M.signShower = sign(TX.campSign(['ДУШ'], { w: 256, h: 96, bg: '#2f5a6e', fg: '#e8e0c8', sizes: [64] }));
  M.signMotto = sign(TX.campSign(['БУДЬ ГОТОВ!', 'ВСЕГДА ГОТОВ!'], { w: 1024, h: 256, bg: '#a82a22', fg: '#efe6c8', sizes: [96, 96] }));
  M.signCabin = [1, 2, 3, 4, 5, 6].map(n => sign(TX.campSign([`ОТРЯД ${n}`], { w: 256, h: 96, bg: '#e2dccb', fg: '#2c4f6e', sizes: [58] })));
  M.wolf = sign(TX.wolfBadge());
  M.flagRag = std({ color: 0x8e2a22, roughness: 0.95, side: THREE.DoubleSide });
  // --- наполнение карты: вышки, мосты, обломки фронта, записки ---
  M.stumpTop = std({ map: TX.stumpTop(), roughness: 0.95 });
  M.holes = std({ map: TX.bulletHoles(), transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  // записки — одним атласом 2×2 (один материал на все листы: меньше вызовов отрисовки)
  {
    const sheets = [
      ['#ПОЗЫВНЫЕ', 'Берёза-1 — КП', 'Гром — миномёт', 'Сокол — птичка (дрон)', 'Ветер-2 — лев. фланг', 'Ветер-3 — прав. фланг', 'Лесник — разведка', 'Кедр — эвакуация', '', 'не путать Ветер с Вепрем!'],
      ['#СВЯЗЬ', 'осн. 146.500', 'зап. 147.225', 'шифр. таблица — у ст.', '', '#ПАРОЛЬ', 'ЗВЕЗДА — отзыв МАЯК', 'с 00:00 — ИВОЛГА /', '                     КОСТЁР'],
      ['#ОРИЕНТИРЫ', '1 — вышка (пожарная)', '2 — водокачка лагеря', '3 — сгоревшая БМП', '4 — остров, беседка', '5 — мост (заминир.?)'],
      ['#СХЕМА', 'наши —', 'они — >', 'X — пулемёт']
    ].map((l, i) => TX.paperSheet(l, { grid: i === 3, sketch: i === 3, bg: i === 1 ? '#e2dcc6' : undefined, ink: i === 2 ? '#2a2a2a' : undefined }).image);
    const W = sheets[0].width, H = sheets[0].height, c = document.createElement('canvas');
    c.width = W * 2; c.height = H * 2;
    const x = c.getContext('2d');
    sheets.forEach((im, i) => x.drawImage(im, (i % 2) * W, (i >> 1) * H));
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    M.paperAtlas = std({ map: t, roughness: 0.9, side: THREE.DoubleSide });
    M.paper = [0, 1, 2, 3].map(i => ({ atlas: i }));
  }
  M.towerSteel = surf(TX.rustMetal([88, 98, 90], 0.55, 256), { rough: 0.62, metal: 0.55 });
  M.towerRed = surf(TX.rustMetal([150, 58, 44], 0.45, 256), { rough: 0.6, metal: 0.45 });
  M.tankCamp = surf(TX.rustMetal([96, 130, 150], 0.5), { rough: 0.55, metal: 0.5 });
  M.tankGrey = surf(TX.rustMetal([104, 112, 104], 0.6), { rough: 0.55, metal: 0.5 });
  M.grate = std({ color: 0x3f403c, roughness: 0.6, metalness: 0.6 });
  M.armor = surf(TX.rustMetal([66, 72, 50], 0.35), { rough: 0.7, metal: 0.4 });
  M.armorBurnt = surf(TX.rustMetal([40, 38, 36], 0.45), { rough: 0.88, metal: 0.3, color: 0x77726c });
  M.heli = surf(TX.rustMetal([78, 88, 64], 0.18), { rough: 0.62, metal: 0.35 });
  M.heliBelly = surf(TX.rustMetal([120, 136, 140], 0.3), { rough: 0.6, metal: 0.35 });
  M.brass = std({ color: 0xb08a3c, roughness: 0.35, metalness: 0.9 });
  M.olive = std({ color: 0x4a5236, roughness: 0.6, metalness: 0.3 });
  M.peat = new THREE.MeshStandardMaterial({ color: 0x2a2918, roughness: 0.1, metalness: 0.2 });
  // обугливание и дрожь от взрывов — для всего, что строится из досок, брёвен, жести
  for (const m of [M.planks, M.planksDark, M.planksPaint, M.logWall, M.logEnd, M.roofRust, M.roofTar, M.deadwood, M.crate, M.wattle, M.sack, M.canvas,
    M.brick, M.concrete, M.planksCamp, M.planksWhite, M.planksCream, M.roofCamp, M.plaster, M.paintRed, M.steelPipe, M.barkLog, M.rust, M.burnt, M.dark, ...M.carPaint, M.towerSteel, M.towerRed, M.tankCamp, M.tankGrey, M.grate, M.armor, M.armorBurnt, M.heli, M.heliBelly, M.stumpTop, M.stone]) injectStructFX(m);
}
