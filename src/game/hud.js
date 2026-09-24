import { $ } from '../core/env.js';
import { MAP, SPAWNS, PATHS, TRENCHES, CLUSTERS, lakeContour, ISLAND, CRATERS } from '../world/layout.js';
import { HOUSES } from '../world/buildings.js';
import { LAMPS } from '../world/lamps.js';
import { PL, zoneInfo } from './player.js';
import { fmtTime, TIME, SKY } from '../world/sky.js';
import { lerp } from '../core/math.js';

/* Интерфейс: минимальный OSD дрона, тактическая карта (M), тост-сообщения,
   экран гибели. Всё — обычный DOM поверх канваса. */
let mapCanvas = null, mapBase = null, toastT = 0;
const MS = 560, SCALE = MS / (MAP.FENCE * 2 + 12);
const P = (x, z) => [MS / 2 + x * SCALE, MS / 2 + z * SCALE];

export function toast(msg, t = 2.2) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('on'); toastT = t;
}
/** Статичный слой тактической карты рисуется один раз. */
export function buildMapOverlay() {
  mapBase = document.createElement('canvas'); mapBase.width = mapBase.height = MS;
  const x = mapBase.getContext('2d');
  x.fillStyle = '#1b231b'; x.fillRect(0, 0, MS, MS);
  // минная полоса
  const [a0] = P(-MAP.MINE1, 0), [a1] = P(-MAP.PLAY, 0);
  x.fillStyle = 'rgba(150,40,30,.35)'; x.fillRect(a0, a0, MS - a0 * 2, MS - a0 * 2);
  x.fillStyle = '#1f2a1f'; x.fillRect(a1, a1, MS - a1 * 2, MS - a1 * 2);
  x.strokeStyle = 'rgba(210,70,50,.8)'; x.setLineDash([5, 4]); x.lineWidth = 1.5; x.strokeRect(a1, a1, MS - a1 * 2, MS - a1 * 2); x.setLineDash([]);
  // озеро
  x.fillStyle = '#20384a'; x.beginPath();
  for (let i = 0; i <= 96; i++) { const [px, pz] = lakeContour(i / 96 * Math.PI * 2, 0); const [u, v] = P(px, pz); i ? x.lineTo(u, v) : x.moveTo(u, v); }
  x.fill();
  x.fillStyle = '#2b3b28'; x.beginPath(); { const [u, v] = P(ISLAND.x, ISLAND.z); x.arc(u, v, ISLAND.r * SCALE * 0.7, 0, 7); } x.fill();
  // воронки
  x.fillStyle = 'rgba(80,60,40,.6)';
  for (const c of CRATERS) { const [u, v] = P(c.x, c.z); x.beginPath(); x.arc(u, v, Math.max(1.2, c.r * SCALE), 0, 7); x.fill(); }
  // дороги и тропы
  for (const p of PATHS) {
    x.strokeStyle = p.kind === 'road' ? '#8b7b5e' : '#6d6450'; x.lineWidth = p.kind === 'road' ? 3 : 1.6;
    x.beginPath(); p.pts.forEach(([px, pz], i) => { const [u, v] = P(px, pz); i ? x.lineTo(u, v) : x.moveTo(u, v); }); x.stroke();
  }
  // окопы
  x.strokeStyle = '#c9b27a'; x.lineWidth = 2.2;
  for (const t of TRENCHES) { x.beginPath(); t.pts.forEach(([px, pz], i) => { const [u, v] = P(px, pz); i ? x.lineTo(u, v) : x.moveTo(u, v); }); x.stroke(); }
  // постройки
  x.fillStyle = '#b8b0a0';
  for (const h of HOUSES) {
    const [u, v] = P(h.x, h.z);
    x.save(); x.translate(u, v); x.rotate(-h.rot); x.fillRect(-h.w / 2 * SCALE, -h.d / 2 * SCALE, h.w * SCALE, h.d * SCALE); x.restore();
  }
  // фонари (рабочие)
  for (const L of LAMPS) { if (!L.on) continue; const [u, v] = P(L.pos.x, L.pos.z); x.fillStyle = 'rgba(255,200,120,.9)'; x.fillRect(u - 1, v - 1, 2, 2); }
  // базы
  for (const s of Object.values(SPAWNS)) {
    const [u, v] = P(s.x, s.z);
    x.strokeStyle = s.team === 'A' ? '#6f9ed4' : '#e07a52'; x.lineWidth = 2;
    x.beginPath(); x.arc(u, v, s.r * SCALE, 0, 7); x.stroke();
    x.fillStyle = x.strokeStyle; x.font = 'bold 18px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(s.team, u, v);
  }
  x.fillStyle = '#d9d2bf'; x.font = '11px system-ui, sans-serif';
  for (const c of Object.values(CLUSTERS)) { const [u, v] = P(c.x, c.z); x.fillText(c.name, u, v + 26); }
  x.fillStyle = 'rgba(210,90,70,.9)'; x.font = 'bold 10px system-ui'; x.fillText('МИННОЕ ПОЛЕ', MS / 2, a0 + 11); x.fillText('МИННОЕ ПОЛЕ', MS / 2, MS - a0 - 5);
  x.fillStyle = '#9aa69c'; x.font = '10px system-ui'; x.textAlign = 'left'; x.fillText('N ↑   сетка 50 м', 8, MS - 8);
  x.strokeStyle = 'rgba(255,255,255,.05)'; x.lineWidth = 1;
  for (let g = -100; g <= 100; g += 50) { const [u] = P(g, 0); x.beginPath(); x.moveTo(u, 0); x.lineTo(u, MS); x.stroke(); x.beginPath(); x.moveTo(0, u); x.lineTo(MS, u); x.stroke(); }
  mapCanvas = $('#map canvas');
  mapCanvas.width = mapCanvas.height = MS;
}
function drawMap() {
  const x = mapCanvas.getContext('2d');
  x.drawImage(mapBase, 0, 0);
  const [u, v] = P(PL.pos.x, PL.pos.z);
  x.save(); x.translate(u, v); x.rotate(-PL.yaw);
  x.fillStyle = PL.mode === 'drone' ? '#f4e9a8' : '#ffffff';
  x.beginPath(); x.moveTo(0, -9); x.lineTo(6, 6); x.lineTo(0, 3); x.lineTo(-6, 6); x.closePath(); x.fill();
  x.restore();
}
const DIRS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
export function updateHud(dt) {
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('#toast').classList.remove('on'); }
  const cl = $('#clock');
  cl.firstElementChild.textContent = fmtTime(TIME.h);
  cl.lastElementChild.textContent = SKY.label + (TIME.paused ? ' · пауза' : '');
  // OSD: высота над землёй, скорость, курс
  const heading = ((-PL.yaw * 180 / Math.PI) % 360 + 360) % 360;
  const spd = Math.hypot(PL.vel.x, PL.vel.y, PL.vel.z) * 3.6;
  const osd = $('#osd');
  osd.innerHTML = PL.mode === 'drone'
    ? `<b>${PL.cine ? 'ОБЛЁТ' : 'ДРОН'}</b>${PL.under ? ' · ПОД ВОДОЙ' : ''} · ALT ${PL.agl.toFixed(1)} м · ${spd.toFixed(0)} км/ч · ${DIRS[Math.round(heading / 45) % 8]} ${heading.toFixed(0)}°<br><span>скорость ${PL.speed.toFixed(0)} м/с · ${PL.team === 'A' ? 'ALPHA' : 'DELTA'}</span>`
    : `<b>ПЕШКОМ</b> · ${spd.toFixed(1)} км/ч · ${DIRS[Math.round(heading / 45) % 8]} ${heading.toFixed(0)}°${PL.swim ? (PL.under ? ' · под водой' : ' · вплавь') : ''}${PL.air < 0.999 ? ` · воздух <b style="color:${PL.air < 0.3 ? '#ff7a5c' : '#cfe'}">${Math.round(PL.air * 100)}%</b>` : ''}${PL.burn > 0.2 ? ' · <b style="color:#ff9a5c">ОГОНЬ</b>' : ''}<br><span>${PL.team === 'A' ? 'ALPHA' : 'DELTA'}</span>`;
  const z = zoneInfo(), zel = $('#zone');
  zel.textContent = z ? z.text : '';
  zel.className = z && z.warn ? 'warn' : '';
  const dead = $('#dead');
  if (PL.dead > 0) {
    dead.classList.add('on');
    dead.firstElementChild.textContent = PL.deathMsg;
    dead.lastElementChild.textContent = 'возрождение на базе ' + (PL.team === 'A' ? 'ALPHA' : 'DELTA') + ' через ' + Math.ceil(PL.dead) + ' с';
    dead.style.background = `rgba(10,4,3,${lerp(0.25, 0.9, Math.min(1, (3.2 - PL.dead) / 1.2))})`;
  } else dead.classList.remove('on');
  if ($('#map').classList.contains('on')) drawMap();
}
