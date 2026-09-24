import * as THREE from 'three';
import { renderer, scene, camera, Q, QNAME, PRESETS, FRAME, $, PERF } from './core/env.js';
import { COLLIDERS } from './core/colliders.js';
import { MAP, SPAWNS, PATHS, TRENCHES, terrainH, lakeRho, trenchDist, TW } from './world/layout.js';
import { buildMaterials } from './gen/materials.js';
import { buildHeightCache, hFast, heightGrid } from './world/heightcache.js';
import { initPhysics, buildStaticWorld, buildPlayerProxy, stepPhysics, movePlayerProxy, physStats, PHYS, addBody, setPhysCamera } from './core/physics.js';
import { buildTerrain } from './world/terrain.js';
import { buildSky, updateSky, SKY, TIME, nextPhase, fmtTime } from './world/sky.js';
import { buildForest, updateForestLOD, forestStats, TREES } from './world/forest.js';
import { buildGrass, buildUndergrowth, refreshGrass, GRASS, updateFlora, FLORA } from './world/groundcover.js';
import { buildLake, updateLake, planPiers } from './world/lake.js';
import { planBuildings, buildBuildings, HOUSES } from './world/buildings.js';
import { planMilitary, buildMilitary, updateMilitary, FIRES, MINES } from './world/military.js';
import { planProps, buildProps, updateBarrels, BARRELS } from './world/props.js';
import { planLamps, buildLamps, finishLamps, updateLamps, lampStats } from './world/lamps.js';
import { flushStatic } from './world/builders.js';
import { stepCloth, CLOTHS } from './world/cloth.js';
import { updateWind, WIND } from './world/wind.js';
import { buildParticles, updateParticles, emitFires } from './fx/particles.js';
import { buildExplosions, updateExplosions, explode, BLAST } from './fx/explosions.js';
import { initAudio, updateAudio, AUDIO } from './fx/audio.js';
import { buildPost, updatePost, resizePost, composer, bloom } from './fx/post.js';
import { PL, keys, spawnAt, setMode, look, updatePlayer, dropBomb, startCinematic, stopCinematic } from './game/player.js';
import { buildMapOverlay, updateHud, toast } from './game/hud.js';
import { buildFire, updateFire, heatAt, fireStats, FIRE, ignite } from './fx/fire.js';
import { buildGlass, updateGlass, glassStats } from './fx/glass.js';
import { buildDestruction, updateDestruction, destructionStats, lightningHit, warmupDestruction, endWarmup } from './fx/destruction.js';
import { buildWeather, updateWeather, collectWetMaterials, cycleWeather, setWeather, weatherStats, WEATHER, MODES, strikeNow } from './world/weather.js';
import { buildFootprints, updateFootprints } from './fx/footprints.js';
import { buildWeapons, updateWeapons, shoot, artillery, aimPoint } from './game/weapons.js';
import { flushBurn, FXU } from './core/fxu.js';
import { TERRAIN } from './world/terrain.js';
import { thunder, setLoops, setUnderwater } from './fx/audio.js';
import { burnPlayer, splashAt } from './game/player.js';
import { updateStructs, structStats, structHeatAt, igniteStruct, structAt, BURNING } from './fx/structures.js';
import { setSplashHandler } from './core/physics.js';
import { STRUCTS } from './world/builders.js';


/* ============================================================================
   «ТИХИЙ БОР» — сборка сцены и главный цикл
============================================================================ */
let locked = false, searchlight = null, draws = 0;

const STEPS = [
  ['Физика: ammo.js', () => initPhysics()],
  ['Текстуры и материалы', () => buildMaterials()],
  ['План карты', () => { planBuildings(); planMilitary(); planPiers(); planProps(); planLamps(); }],
  ['Рельеф: кэш высот', () => buildHeightCache()],
  ['Рельеф: сетка', () => buildTerrain()],
  ['Небо и свет', () => buildSky()],
  ['Хвойный лес', () => buildForest()],
  ['Подлесок и трава', () => { buildUndergrowth(); buildGrass(); }],
  ['Озеро, камыш, мостки', () => buildLake()],
  ['Турбаза и кордон', () => buildBuildings()],
  ['Окопы, базы, минное поле', () => buildMilitary()],
  ['Техника и укрытия', () => { buildProps(); buildGlass(); }],
  ['Физика: статический мир', () => { const g = heightGrid(); buildStaticWorld(g.H, g.HN, g.HS, g.R); buildPlayerProxy(); setPhysCamera(camera); }],
  ['Фонари', () => { buildLamps(); finishLamps(); }],
  ['Частицы и взрывы', () => { buildParticles(); buildExplosions(); buildDestruction(); buildWeapons(); buildFootprints(); }],
  ['Огонь и погода', () => { buildFire(); buildWeather(); }],
  ['Сборка геометрии', () => { draws = flushStatic(); buildPost(); buildMapOverlay(); collectWetMaterials(new Set([TERRAIN.mat])); }],
  ['Компиляция шейдеров', () => { spawnAt('A', 'drone'); updatePlayer(0); updateSky(0); warmupDestruction(); renderer.compile(scene, camera); endWarmup(); }]
];

async function build() {
  const bar = $('#bar i'), stage = $('#g_stage');
  const t0 = performance.now();
  for (let i = 0; i < STEPS.length; i++) {
    const [name, fn] = STEPS[i];
    stage.textContent = name + '…';
    bar.style.width = (i / STEPS.length * 100).toFixed(0) + '%';
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    const ts = performance.now();
    await fn();
    console.info(`[build] ${name}: ${(performance.now() - ts).toFixed(0)} мс`);
  }
  console.info(`[build] всего ${(performance.now() - t0).toFixed(0)} мс`);
  bar.style.width = '100%';
  finish();
}

function finish() {
  // прожектор дрона / фонарь бойца
  searchlight = new THREE.SpotLight(0xf2f4ff, 0, 70, 0.34, 0.5, 1.2);
  searchlight.position.set(0, -0.2, 0);
  searchlight.target.position.set(0, -0.35, -1);
  camera.add(searchlight, searchlight.target);
  TIME.h = 9.0;
  $('#help').textContent =
    'Мышь — обзор · WASD — полёт/ходьба · Space/E вверх · C/Q вниз · Shift быстрее · колесо — скорость дрона\n' +
    'ЛКМ — сброс гранаты / бросок · G — дрон ⇄ пешком · F — прожектор · M — карта · P — облёт · R — на базу\n' +
    'ПКМ — выстрел · B — артналёт по точке прицела · K — погода · J — молния\n' +
    'N — фаза суток · T — пауза · [ ] — скорость времени · 1..4 — утро/день/закат/ночь · U — звук · V — интерфейс';
  // гроза: гром с задержкой, близкий разряд может ударить в дерево
  WEATHER.onStrike = (x, y, z, dist) => { thunder(dist); if (dist < 150) lightningHit(x, z); };
  // упавшая головня поджигает постройку, у которой лежит; тела в воде — всплеск
  FIRE.onBrand = p => { for (const s of structAt(p.x, p.z, 0.8)) if (Math.random() < 0.3) igniteStruct(s, 0.12); };
  setSplashHandler((x, z, k) => splashAt(x, z, k));
  // проверка раскладки: машины и постройки не должны стоять в окопах, в домах и друг в друге
  const validate = () => {
    const out = [];
    const boxPts = c => { const pts = [[c.x, c.z]]; if (c.t === 1) for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pts.push([c.x + (a * c.hw * c.c + b * c.hd * c.s), c.z + (-a * c.hw * c.s + b * c.hd * c.c)]); return pts; };
    const houses = COLLIDERS.filter(c => c.panel && c.panel.kind === 'wall' && c.panel.s.kind === 'house');
    for (const c of COLLIDERS) {
      if (!c.car) continue;
      for (const [x, z] of boxPts(c)) {
        if (trenchDist(x, z) < TW.cap) { out.push(['машина в окопе', c.car, x.toFixed(1), z.toFixed(1)]); break; }
        if (houses.some(h => { const dx = x - h.x, dz = z - h.z; return Math.abs(dx * h.c - dz * h.s) < h.hw + 0.3 && Math.abs(dx * h.s + dz * h.c) < h.hd + 0.3; })) { out.push(['машина в доме', c.car, x.toFixed(1), z.toFixed(1)]); break; }
      }
    }
    for (const s of STRUCTS) {
      if (!s.center || s.kind === 'fence' || s.kind === 'bench') continue;
      if (trenchDist(s.center.x, s.center.z) < TW.cap + Math.min(s.w ?? 1, s.d ?? 1) / 2) out.push(['постройка в окопе', s.kind, s.name || '', s.center.x.toFixed(1), s.center.z.toFixed(1)]);
    }
    for (const t of TREES) for (const s of STRUCTS) {
      if (s.kind !== 'house' || t.broken) continue;
      const dx = t.x - s.x, dz = t.z - s.z, c = Math.cos(s.rot), n = Math.sin(s.rot);
      if (Math.abs(dx * c - dz * n) < s.w / 2 + 0.2 && Math.abs(dx * n + dz * c) < s.d / 2 + 0.2) out.push(['дерево в доме', s.name, t.x.toFixed(1), t.z.toFixed(1)]);
    }
    return out;
  };
  window.MAP_API = {
    validate,
    THREE, scene, camera, renderer, composer, player: PL, keys, time: TIME, sky: SKY, wind: WIND,
    setTime: h => { TIME.h = h; updateSky(0); },
    teleport: (x, y, z, yaw = PL.yaw, pitch = PL.pitch) => { PL.pos.set(x, y, z); PL.vel.set(0, 0, 0); PL.yaw = yaw; PL.pitch = pitch; stopCinematic(); },
    lookAt: (x, y, z) => { const dx = x - PL.pos.x, dy = y - PL.pos.y, dz = z - PL.pos.z; PL.yaw = Math.atan2(-dx, -dz); PL.pitch = Math.atan2(dy, Math.hypot(dx, dz)); },
    step: dt => frame(dt), tick: (dt, n = 1) => { for (let i = 0; i < n; i++) frame(dt, false); }, explode, ignite, shoot, artillery, aimPoint, weather: WEATHER, setWeather, strikeNow, fire: FIRE, setMode, spawnAt, startCinematic, terrainH, map: MAP, spawns: SPAWNS, trenches: TRENCHES, trees: TREES, structs: STRUCTS, igniteStruct,
    // логика без отрисовки: для автотестов на медленных машинах
    addBody, simulate: (dt, n = 1) => { for (let i = 0; i < n; i++) { FRAME.t += dt; updatePlayer(dt); updateExplosions(dt); stepPhysics(dt); } return PL; }, phys: PHYS,
    perf: PERF, stats: () => ({
      calls: renderer.info.render.calls, tris: renderer.info.render.triangles, grass: GRASS.count, floraTiles: FLORA.tiles.length, floraDrawn: FLORA.drawn,
      ...forestStats(), colliders: COLLIDERS.length, houses: HOUSES.length, cloths: CLOTHS.length, barrels: BARRELS.length,
      mines: MINES.list.length, paths: PATHS.length, ...physStats(), ...fireStats(), ...weatherStats(), ...glassStats(), ...destructionStats(), ...structStats(), trenches: TRENCHES.length, staticDraws: draws, ...lampStats(), quality: QNAME
    })
  };
  $('#g_load').style.display = 'none';
  $('#g_ready').style.display = 'block';
  for (const b of document.querySelectorAll('#teams button')) b.onclick = () => {
    PL.team = b.dataset.t;
    for (const o of document.querySelectorAll('#teams button')) o.classList.toggle('on', o === b);
  };
  const qrow = $('#qrow');
  for (const k of Object.keys(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = PRESETS[k].name; b.classList.toggle('on', k === QNAME);
    b.onclick = () => { if (k === QNAME) return; localStorage.setItem('tikhiy_bor_q', k); location.search = '?q=' + k; };
    qrow.appendChild(b);
  }
  const wrow = $('#wrow');
  for (const k of Object.keys(MODES)) {
    const b = document.createElement('button');
    b.textContent = MODES[k].name; b.classList.toggle('on', k === WEATHER.mode);
    b.onclick = () => { setWeather(k, true); WEATHER.auto = false; for (const o of wrow.children) o.classList.toggle('on', o === b); };
    wrow.appendChild(b);
  }
  $('#g_go').onclick = () => { spawnAt(PL.team, 'drone'); enter(); };
  $('#g_cine').onclick = () => { spawnAt(PL.team, 'drone'); startCinematic(); enter(); };
  window.MAP_READY = true;
  // ?test — без собственного цикла: кадры шагает автотест через MAP_API.step/tick
  if (!new URLSearchParams(location.search).has('test')) requestAnimationFrame(loop);
}
function enter() {
  initAudio();
  renderer.domElement.requestPointerLock?.();
  $('#gate').classList.add('hide');
  $('#hud').classList.add('on');
}

/* ---------- Ввод ---------- */
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['Space', 'Tab', 'KeyC', 'ControlLeft', 'F2', 'F3'].includes(e.code)) e.preventDefault();
  if (!window.MAP_READY) return;
  if (PL.cine && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyG'].includes(e.code)) { stopCinematic(); toast('облёт прерван — управление ваше'); }
  switch (e.code) {
    case 'KeyG': setMode(PL.mode === 'drone' ? 'walk' : 'drone'); toast(PL.mode === 'drone' ? 'дрон' : 'пешком'); break;
    case 'KeyF': PL.light = !PL.light; toast('прожектор: ' + (PL.light ? 'вкл' : 'выкл')); break;
    case 'KeyM': $('#map').classList.toggle('on'); break;
    case 'KeyP': if (PL.cine) stopCinematic(); else { startCinematic(); toast('облёт карты · WASD — прервать'); } break;
    case 'KeyR': spawnAt(PL.team, PL.mode); toast('на базу ' + (PL.team === 'A' ? 'ALPHA' : 'DELTA')); break;
    case 'KeyN': nextPhase(); updateSky(0); toast(fmtTime(TIME.h) + ' · ' + SKY.label); break;
    case 'KeyT': TIME.paused = !TIME.paused; toast(TIME.paused ? 'время остановлено' : 'время идёт'); break;
    case 'BracketLeft': TIME.speed = Math.max(1 / 900, TIME.speed / 2); toast('скорость времени ×' + (TIME.speed * 45).toFixed(2)); break;
    case 'BracketRight': TIME.speed = Math.min(2, TIME.speed * 2); toast('скорость времени ×' + (TIME.speed * 45).toFixed(2)); break;
    case 'Digit1': TIME.h = 7.2; toast('утро'); break;
    case 'Digit2': TIME.h = 13; toast('день'); break;
    case 'Digit3': TIME.h = 19.7; toast('закат'); break;
    case 'Digit4': TIME.h = 23.3; toast('ночь'); break;
    case 'KeyK': toast('погода: ' + cycleWeather()); WEATHER.auto = false; break;
    case 'KeyJ': strikeNow(); break;
    case 'KeyB': toast(artillery(aimPoint()) ? 'артналёт по точке прицела' : 'нет цели'); break;
    case 'KeyU': AUDIO.on = !AUDIO.on; toast('звук: ' + (AUDIO.on ? 'вкл' : 'выкл')); break;
    case 'KeyV': $('#hud').classList.toggle('clean'); break;
    case 'KeyH': $('#help').classList.toggle('on'); break;
    case 'F3': { const f = $('#fps'); f.style.display = f.style.display === 'block' ? 'none' : 'block'; break; }
    case 'Escape': $('#map').classList.remove('on'); break;
  }
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
addEventListener('mousemove', e => { if (locked) look(e.movementX, e.movementY); });
addEventListener('wheel', e => { if (locked && PL.mode === 'drone') PL.speed = Math.min(60, Math.max(2, PL.speed * (e.deltaY > 0 ? 0.88 : 1.14))); }, { passive: true });
renderer.domElement.addEventListener('mousedown', e => {
  if (!locked) { renderer.domElement.requestPointerLock?.(); return; }
  if (e.button === 0) dropBomb();
  if (e.button === 2) shoot();
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (!locked && window.MAP_READY) { $('#gate').classList.remove('hide'); $('#hud').classList.remove('on'); for (const k in keys) keys[k] = false; }
});
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (composer) resizePost();
});

/** Камера под крышей: дождь почти не виден. */
function indoor() {
  const c = camera.position;
  for (const h of HOUSES) {
    const dx = c.x - h.x, dz = c.z - h.z, co = Math.cos(h.rot), si = Math.sin(h.rot);
    if (Math.abs(dx * co - dz * si) < h.w / 2 && Math.abs(dx * si + dz * co) < h.d / 2 && c.y < (h.top ?? h.fy + 3) && c.y > h.fy - 0.5) return true;
  }
  return false;
}
/* ---------- Кадр ---------- */
const clock = new THREE.Clock();
let fpsAcc = 0, fpsN = 0, fpsT = 0;
function frame(dt, render = true) {
  FRAME.dt = dt; FRAME.t += dt; FRAME.n++;
  updatePlayer(dt);
  updateWind(FRAME.t);
  updateSky(dt);
  updateWeather(dt, { night: SKY.night, fogColor: SKY.fogColor, indoor: indoor() });
  updateLamps(SKY.lampOn);
  updateMilitary(SKY);
  updateForestLOD();
  refreshGrass();
  updateFlora(dt);
  stepCloth(dt, FRAME.t);
  updateBarrels(dt);
  movePlayerProxy(PL.pos.x, PL.pos.y, PL.pos.z, PL.mode === 'walk' && PL.dead <= 0);
  stepPhysics(dt);
  emitFires(FIRES, dt, SKY);
  updateExplosions(dt);
  updateDestruction(dt);
  updateGlass();
  updateFire(dt);
  updateWeapons(dt);
  updateFootprints(PL);
  flushBurn(FRAME.t);
  updateStructs(dt);
  burnPlayer(dt, Math.max(heatAt(PL.pos.x, PL.pos.z), structHeatAt(PL.pos.x, PL.pos.z)));
  const ground = hFast(camera.position.x, camera.position.z);
  updateParticles(dt, { night: SKY.night, h: TIME.h, fogColor: SKY.fogColor, ground, light: Math.max(0.12, (0.2 + 0.8 * (1 - SKY.night)) * (1 - WEATHER.ov * 0.3)) });
  updateLake(SKY);
  searchlight.intensity = PL.light ? (PL.mode === 'drone' ? 260 : 60) : 0;
  searchlight.angle = PL.mode === 'drone' ? 0.34 : 0.5;
  setLoops(WEATHER.rain * (PL.agl < 60 ? 1 : 0.3), Math.min(1, FIRE.near / 60 + FIRE.trees.length * 0.15));
  updateAudio(dt, { night: SKY.night, wind: WIND.strength, agl: PL.agl, drone: PL.mode === 'drone' && PL.dead <= 0, speed: PL.vel.length() });
  // под водой: густая торфяная муть вместо тумана, глухой звук
  const camUnder = camera.position.y < MAP.WATER_Y - 0.02 && lakeRho(camera.position.x, camera.position.z) < 1;
  if (camUnder) {
    const l = 0.12 + 0.6 * (1 - SKY.night) * (1 - WEATHER.ov * 0.6);
    scene.fog.color.setRGB(0.03 * l, 0.07 * l, 0.055 * l);
    scene.fog.density = 0.16 + (MAP.WATER_Y - camera.position.y) * 0.02;
  }
  setUnderwater(camUnder);
  FXU.uCaus.value = SKY.sunI * (1 - WEATHER.ov * 0.8) * 0.12;
  updatePost(SKY, Math.min(1, BLAST.shake * 0.8 + (PL.dead > 0 ? 0.6 : 0) + PL.burn * 0.3), WEATHER.flash, camUnder ? 1 : 0);
  if (!render) return;
  // тени на слабых пресетах — раз в несколько кадров (солнце движется медленно)
  const se = PERF.shadowEvery;
  renderer.shadowMap.autoUpdate = se <= 1;
  if (se > 1 && (FRAME.n % se === 0 || BLAST.shake > 0.05)) renderer.shadowMap.needsUpdate = true;
  composer.render();
  updateHud(dt);
}
function adaptResolution(dt) {
  PERF.acc += dt; PERF.n++; PERF.t += dt;
  if (PERF.t < 1.5) return;
  const ms = PERF.acc / PERF.n * 1000;
  PERF.frameMs = ms; PERF.acc = PERF.n = PERF.t = 0;
  PERF.load = Math.min(1, Math.max(0, (ms - 22) / 20));
  if (!PERF.auto) return;
  let pr = PERF.pr;
  // сначала снижается разрешение; если и на минимуме кадр тяжёлый — лестница упрощений
  // (реже тени, без блума, реже трава). При запасе всё возвращается в обратном порядке.
  if (ms > 36) {
    if (pr > PERF.minPr) pr = Math.max(PERF.minPr, pr - 0.1);
    else if (PERF.lvl < 3) setLevel(PERF.lvl + 1);
  } else if (ms < 19) {
    if (PERF.lvl > 0) { if (++PERF.calm >= 3) setLevel(PERF.lvl - 1); }
    else if (pr < PERF.maxPr) pr = Math.min(PERF.maxPr, pr + 0.05);
  } else PERF.calm = 0;
  if (pr !== PERF.pr) { PERF.pr = pr; renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight); resizePost(); }
}
function setLevel(l) {
  PERF.lvl = l; PERF.calm = 0;
  PERF.shadowEvery = Math.max(Q.shadowEvery, [1, 2, 3, 4][l]);
  bloom.enabled = Q.bloom && l < 2;
  const cap = [1, 1, 0.7, 0.5][l];
  if (GRASS.cap !== cap) { GRASS.cap = cap; refreshGrass(true); }
}
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  frame(dt);
  adaptResolution(dt);
  fpsAcc += dt; fpsN++; fpsT += dt;
  if (fpsT > 0.5) {
    const el = $('#fps');
    if (el.style.display === 'block') {
      const s = window.MAP_API.stats();
      el.textContent = `${(fpsN / fpsAcc).toFixed(0)} fps · ${QNAME} · разрешение ×${PERF.pr.toFixed(2)}\n${s.calls} вызовов · ${(s.tris / 1000).toFixed(0)}k треуг.\n` +
        `деревья ${s.trees} (детальных ${s.hi}) · трава ${s.grass}\nфонари ${s.working}/${s.lamps} · мины ${s.mines}\n` +
        `${PL.pos.x.toFixed(1)}, ${PL.pos.y.toFixed(1)}, ${PL.pos.z.toFixed(1)} · ${fmtTime(TIME.h)}`;
    }
    fpsAcc = 0; fpsN = 0; fpsT = 0;
  }
}

build().catch(err => {
  console.error(err);
  window.MAP_ERROR = String(err && err.stack || err);
  $('#g_load').innerHTML = '<p style="color:#d9736b">Ошибка сборки: ' + String(err && err.message || err) + '</p>';
});
