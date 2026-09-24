import * as THREE from 'three';
import { scene, Q } from '../core/env.js';
import { rng, TAU } from '../core/math.js';
import { addPad, keep, terrainH, CLUSTERS, pathInfluence, addDig } from './layout.js';
import { addDoor, holeCluster } from '../fx/interact.js';
import { sheet } from './wrecks.js';
import { M, TEX } from '../gen/materials.js';
import { box, cyl, place, frame, beginStruct, panel, noPanel, endStruct } from './builders.js';
import { addBox, addCircle as addCircle2 } from '../core/colliders.js';
import { addLamp } from './lamps.js';
import { addPane } from '../fx/glass.js';
import { vehicle } from './vehicles.js';
import { makeCloth } from './cloth.js';
import { campHouses, campItems, planCamp, buildCampItem, buildCampExtras } from './camp.js';

/* ============================================================================
   ПОСТРОЙКИ ТУРБАЗЫ И КОРДОНА
   Срубы и дощатые домики со снятыми дверями, выбитыми окнами и дырявой
   кровлей. Внутри можно пройти: пол, пороги, печь, стол — укрытие для боя
   на короткой дистанции. Кордон — зеркальная копия турбазы по габаритам
   (баланс), но в другом облике: дом лесника, амбар, пилорама.
============================================================================ */
const WALL_T = 0.2;
export const HOUSES = [];

/** Разбиение стены с проёмами на прямоугольники [u0,u1,y0,y1]. */
function wallPieces(len, h, openings) {
  const out = [], ops = openings.map(o => ({ u0: o.at - o.w / 2 + len / 2, u1: o.at + o.w / 2 + len / 2, y0: o.y0, y1: o.y1 })).sort((a, b) => a.u0 - b.u0);
  let u = 0;
  for (const o of ops) {
    if (o.u0 > u + 0.01) out.push([u, o.u0, 0, h]);
    if (o.y0 > 0.01) out.push([o.u0, o.u1, 0, o.y0]);
    if (o.y1 < h - 0.01) out.push([o.u0, o.u1, o.y1, h]);
    u = o.u1;
  }
  if (u < len - 0.01) out.push([u, len, 0, h]);
  return out;
}

/** Дом. Локально: x — ширина, z — глубина, фасад смотрит в +z.
    Разрушаемая постройка: каждый кусок стены, скат кровли, дверь, наличник, мебель —
    отдельная панель. Кровля держится на стенах: выбито больше половины — проваливается. */
export function house(o) {
  const R = rng(o.seed ?? 1);
  const F = frame(o.x, o.z, o.rot);
  const { w, d } = o, h = o.h ?? 2.5;
  const base = o.pad.y ?? terrainH(o.x, o.z);
  const fy = base + 0.42;
  const wallMat = o.wallMat ?? (o.style === 'log' ? M.logWall : o.style === 'paint' ? M.planksPaint : M.planks);
  const trimMat = o.trimMat ?? M.planks;
  const tile = o.style === 'log' ? 0.9 : 1.5;
  const P = (lx, lz) => F.p(lx, lz);
  const B = (mat, lx, ly, lz, sx, sy, sz, extra = {}) => {
    const [x, z] = P(lx, lz);
    box(mat, x, ly, z, sx, sy, sz, { rot: o.rot + (extra.r ?? 0), rx: extra.rx, rz: extra.rz, tile: extra.tile ?? tile, collide: extra.collide, walk: extra.walk, vertical: extra.vertical, uvOff: extra.uvOff });
  };
  const S = beginStruct({ kind: 'house', name: o.id, x: o.x, z: o.z, rot: o.rot, w, d, h, fy, fuel: o.style === 'log' ? 1.4 : 1, log: o.style === 'log' });
  noPanel();
  // фундамент: столбики и цоколь
  for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [0, -d / 2], [0, d / 2]])
    B(M.concrete, lx * 0.96, base + 0.12, lz * 0.96, 0.4, 0.62, 0.4, { tile: 0.8 });
  B(M.planksDark, 0, base + 0.2, d / 2 - 0.05, w, 0.36, 0.06, { tile: 1.2 });
  B(M.planksDark, 0, base + 0.2, -d / 2 + 0.05, w, 0.36, 0.06, { tile: 1.2 });
  // цоколь и с торцов: под дом не заглянуть (там может быть погреб)
  for (const sx of [-1, 1]) B(M.planksDark, sx * (w / 2 - 0.05), base + 0.2, 0, 0.06, 0.36, d - 0.1, { tile: 1.2 });
  // пол; над погребом — с люком
  const C = o.cellar;
  if (!C) B(M.planksDark, 0, fy - 0.05, 0, w - 0.1, 0.1, d - 0.1, { tile: 1.2, collide: true });
  else {
    const X0 = -w / 2 + 0.05, X1 = w / 2 - 0.05, Z0 = -d / 2 + 0.05, Z1 = d / 2 - 0.05;
    for (const [a0, a1, b0, b1] of [[X0, X1, C.hz1, Z1], [X0, X1, Z0, C.hz0], [X0, C.hx0, C.hz0, C.hz1], [C.hx1, X1, C.hz0, C.hz1]])
      if (a1 - a0 > 0.02 && b1 - b0 > 0.02) B(M.planksDark, (a0 + a1) / 2, fy - 0.05, (b0 + b1) / 2, a1 - a0, 0.1, b1 - b0, { tile: 1.2, collide: true });
    cellarRoom(o, C, fy, B, R, F);
  }

  // стены с проёмами
  const openings = { front: [], back: [], left: [], right: [] };
  const door = o.door ?? { side: 'front', at: 0 };
  openings[door.side].push({ at: door.at, w: 1.0, y0: 0, y1: 2.05, door: true });
  if (o.door2) openings[o.door2.side].push({ at: o.door2.at, w: 1.0, y0: 0, y1: 2.05, door: true });
  for (const win of o.windows || []) openings[win.side].push({ at: win.at, w: win.w ?? 1.0, y0: 0.85, y1: 1.85, win: true });
  const sides = {
    front: { len: w, c: [0, d / 2 - WALL_T / 2], r: 0, axis: [1, 0] },
    back: { len: w, c: [0, -d / 2 + WALL_T / 2], r: 0, axis: [1, 0] },
    left: { len: d - 2 * WALL_T, c: [-w / 2 + WALL_T / 2, 0], r: Math.PI / 2, axis: [0, -1] },
    right: { len: d - 2 * WALL_T, c: [w / 2 - WALL_T / 2, 0], r: Math.PI / 2, axis: [0, -1] }
  };
  const walls = [], bySide = {};
  for (const [name, S2] of Object.entries(sides)) {
    bySide[name] = [];
    // куски стены между проёмами режутся на секции ~1.3 м и на два яруса: взрыв выбивает
    // дыру в стене, а не всю стену; верхний ярус без опоры под собой падает следом
    const pieces = [];
    for (const [u0, u1, y0, y1] of wallPieces(S2.len, h, openings[name])) {
      const nu = Math.max(1, Math.round((u1 - u0) / 1.3));
      let ys = [y0, y1];
      if (y1 - y0 > 1.5) { let m = (y0 + y1) / 2; if (o.style === 'log') m = Math.round(m / 0.225) * 0.225; ys = [y0, m, y1]; }
      for (let a = 0; a < nu; a++) {
        const a0 = u0 + (u1 - u0) * a / nu, a1 = u0 + (u1 - u0) * (a + 1) / nu;
        let below = null;
        for (let r = 0; r < ys.length - 1; r++) { const pc = [a0, a1, ys[r], ys[r + 1], below]; pieces.push(pc); below = pc; }
      }
    }
    for (const pc of pieces) {
      const [u0, u1, y0, y1, below] = pc;
      const uc = (u0 + u1) / 2 - S2.len / 2;
      const lx = S2.c[0] + S2.axis[0] * uc, lz = S2.c[1] + S2.axis[1] * uc;
      const [wx, wz] = P(lx, lz);
      const pn = panel('wall', { hp: o.style === 'log' ? 1.7 : 1.0, load: true, mat: wallMat, sup: below ? { list: [below.pn], frac: 0.99 } : null,
        dims: { x: wx, y: fy + (y0 + y1) / 2, z: wz, sx: u1 - u0, sy: y1 - y0, sz: WALL_T, rot: o.rot + S2.r, log: o.style === 'log' } });
      pn.u0 = u0; pn.u1 = u1; pn.y0 = y0; pn.y1 = y1; pc.pn = pn;
      B(wallMat, lx, fy + (y0 + y1) / 2, lz, u1 - u0, y1 - y0, WALL_T, { r: S2.r, collide: true, walk: false, uvOff: [u0, y0] });
      walls.push(pn); bySide[name].push(pn);
      // следы перестрелки: очередь по стене снаружи (пропадёт вместе с куском стены)
      if (R() < (o.camp ? 0.1 : 0.14) && y1 - y0 > 0.8) {
        const nO = name === 'front' ? [0, 1] : name === 'back' ? [0, -1] : name === 'left' ? [-1, 0] : [1, 0];
        const [hx, hz] = P(lx + nO[0] * (WALL_T / 2 + 0.004), lz + nO[1] * (WALL_T / 2 + 0.004)), [ox, oz] = P(nO[0], nO[1]);
        holeCluster(hx, fy + (y0 + y1) / 2 + R.range(-0.2, 0.3), hz, Math.atan2(ox - o.x, oz - o.z), R.int(4, 11), Math.min(0.5, (u1 - u0) * 0.4), o.style === 'log' || !o.camp ? 0 : 2, R);
      }
    }
    // оформление проёмов: держится на соседних кусках стены
    for (const op of openings[name]) {
      const lx = S2.c[0] + S2.axis[0] * op.at, lz = S2.c[1] + S2.axis[1] * op.at;
      const ax = S2.axis[0], az = S2.axis[1];
      const nOut = name === 'front' ? [0, 1] : name === 'back' ? [0, -1] : name === 'left' ? [-1, 0] : [1, 0];
      const fw = op.w, fh = op.y1 - op.y0, cy = fy + (op.y0 + op.y1) / 2;
      const ou0 = op.at - fw / 2 + S2.len / 2, ou1 = op.at + fw / 2 + S2.len / 2;
      const around = bySide[name].filter(q => q.u1 > ou0 - 0.05 && q.u0 < ou1 + 0.05);
      panel('trim', { hp: 0.5, sup: { list: around, frac: 0.99 }, density: 450 });
      for (const s2 of [-1, 1]) B(trimMat, lx + ax * s2 * (fw / 2 + 0.04) + nOut[0] * 0.11, cy, lz + az * s2 * (fw / 2 + 0.04) + nOut[1] * 0.11, 0.08, fh + 0.1, 0.04, { r: S2.r, tile: 1 });
      B(trimMat, lx + nOut[0] * 0.11, fy + op.y1 + 0.06, lz + nOut[1] * 0.11, fw + 0.2, 0.1, 0.05, { r: S2.r, tile: 1 });
      if (op.win) {
        B(trimMat, lx + nOut[0] * 0.12, fy + op.y0 - 0.03, lz + nOut[1] * 0.12, fw + 0.2, 0.06, 0.12, { r: S2.r, tile: 1 });
        const state = R();
        // ставни: распахнуты под разными углами, одна может висеть на петле
        if (o.style !== 'camp' && state >= 0.28 && R() < 0.55) {
          for (const e of [-1, 1]) {
            if (R() < 0.18) continue;
            const hang = R() < 0.2;
            const [hx, hz] = P(lx + ax * e * (fw / 2 + 0.06) + nOut[0] * 0.14, lz + az * e * (fw / 2 + 0.06) + nOut[1] * 0.14);
            const [ox, oz] = P(nOut[0], nOut[1]), nx0 = ox - o.x, nz0 = oz - o.z;
            const base = o.rot + S2.r, sw = fw / 2, amt = R.range(0.4, 1.4);
            // знак поворота выбираем так, чтобы свободный край уходил наружу, а не в стену
            const endAt = sg => { const a = base + sg * amt; return [e * Math.cos(a), -e * Math.sin(a)]; };
            const [ex1, ez1] = endAt(1), sg = ex1 * nx0 + ez1 * nz0 > 0 ? 1 : -1;
            const ang = base + sg * amt, c = Math.cos(ang), s3 = Math.sin(ang);
            box(o.style === 'log' ? M.planksPaint : trimMat, hx + c * e * sw / 2, cy - (hang ? 0.15 : 0), hz - s3 * e * sw / 2, sw, fh * 0.98, 0.035, { rot: ang, rz: hang ? e * 0.3 : 0, tile: 1, vertical: true });
          }
        }
        if (state < 0.28) {
          // заколочено крест-накрест
          const [x, z] = P(lx + nOut[0] * 0.14, lz + nOut[1] * 0.14);
          for (const a of [0.7, -0.6]) box(M.planksDark, x, cy, z, fw * 1.25, 0.12, 0.03, { rot: o.rot + S2.r, rz: a * (R() < 0.3 ? 0.4 : 1), tile: 1 });
          if (R() < 0.5) box(M.planksDark, x, cy + 0.25, z, fw * 1.1, 0.12, 0.03, { rot: o.rot + S2.r, rz: 0.08, tile: 1 });
        } else {
          // рама с остатками стекла
          B(trimMat, lx, cy, lz, 0.05, fh, 0.06, { r: S2.r, tile: 1 });
          B(trimMat, lx, cy + 0.15, lz, fw, 0.05, 0.06, { r: S2.r, tile: 1 });
          if (state < 0.45) B(M.glass, lx + ax * fw * 0.25, cy - 0.2, lz + az * fw * 0.25, fw * 0.4, 0.5, 0.01, { r: S2.r });
          else {
            // целая рама: четыре стекла (две створки, фрамуги сверху) — бьются взрывом и пулей
            const yb = cy + 0.15, yTop = fy + op.y1, yBot = fy + op.y0;
            for (const e of [-1, 1]) for (const [ya, yb2] of [[yBot, yb - 0.025], [yb + 0.025, yTop]]) {
              if (R() < 0.12) continue;
              const [px, pz] = P(lx + ax * e * fw * 0.25, lz + az * e * fw * 0.25);
              addPane(px, (ya + yb2) / 2, pz, [0, o.rot + S2.r, 0], fw / 2 - 0.05, yb2 - ya - 0.02);
            }
          }
        }
      }
      if (op.door) {
        const st = R();
        const [hx, hz] = P(lx - ax * fw / 2 + nOut[0] * 0.05, lz - az * fw / 2 + nOut[1] * 0.05);
        panel('door', { hp: 0.4, density: 450 });
        if (st < 0.62) {
          // дверь на петлях — открывается и закрывается (E); распахивается наружу
          const a = o.rot + S2.r, amt = R.range(1.0, 1.7);
          const [ox, oz] = P(nOut[0], nOut[1]), nwx = ox - o.x, nwz = oz - o.z;
          const sgn = Math.cos(a + 1) * nwx - Math.sin(a + 1) * nwz > 0 ? 1 : -1;
          addDoor({ hx, hz, y: fy + 0.01, closed: a, openBy: sgn * amt, w: 0.9, h: 2.0, mat: M.planksDark, startOpen: R() < 0.6 });
        } else if (st < 0.8) {
          // сорвана и лежит у крыльца
          const [x, z] = P(lx + nOut[0] * 1.6, lz + nOut[1] * 1.6);
          box(M.planksDark, x, terrainH(x, z) + 0.06, z, 0.9, 0.05, 2.0, { rot: o.rot + S2.r + R.range(-0.4, 0.4), rx: 0.05, tile: 1.2 });
        }
        noPanel();
        // ступени крыльца
        for (let k = 0; k < 2; k++) {
          const off = 0.35 + k * 0.32;
          B(M.planksDark, lx + nOut[0] * off, base + 0.1 + (1 - k) * 0.16, lz + nOut[1] * off, name === 'front' || name === 'back' ? 1.3 : 0.32, 0.18 + (1 - k) * 0.16, name === 'front' || name === 'back' ? 0.32 : 1.3, { collide: true, tile: 1 });
        }
      }
    }
  }
  const edge = (name, atStart) => bySide[name].filter(q => atStart ? q.u0 < 0.05 : q.u1 > sides[name].len - 0.05);
  const corners = { '-1,1': [...edge('front', true), ...edge('left', true)], '1,1': [...edge('front', false), ...edge('right', true)], '-1,-1': [...edge('back', true), ...edge('left', false)], '1,-1': [...edge('back', false), ...edge('right', false)] };
  // дощатые дома: угловые доски и нижний отлив — держатся на своих углах
  if (o.style !== 'log') {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      panel('trim', { hp: 0.6, sup: { list: corners[sx + ',' + sz], frac: 0.5 }, density: 450 });
      B(trimMat, sx * (w / 2 + 0.015), fy + h / 2, sz * (d / 2 - 0.06), 0.05, h + 0.05, 0.14, { tile: 1, vertical: true });
      B(trimMat, sx * (w / 2 - 0.06), fy + h / 2, sz * (d / 2 + 0.015), 0.14, h + 0.05, 0.05, { tile: 1, vertical: true });
    }
    for (const [name, sgn] of [['front', 1], ['back', -1]]) {
      panel('trim', { hp: 0.5, sup: { list: bySide[name].filter(q => q.y0 < 0.05), frac: 0.5 }, density: 450 });
      B(trimMat, 0, fy + 0.06, sgn * (d / 2 + 0.03), w + 0.04, 0.12, 0.05, { tile: 1 });
    }
  }
  // углы сруба: выпуски брёвен держатся на крайних кусках двух стен
  if (o.style === 'log') {
    const stub = new THREE.CylinderGeometry(0.12, 0.12, 0.62, 7);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      panel('trim', { hp: 1.2, sup: { list: corners[sx + ',' + sz], frac: 0.99 }, density: 500 });
      for (let y = 0.1; y < h; y += 0.225) {
        const [x, z] = P(sx * (w / 2 - 0.1), sz * (d / 2 - 0.1));
        // венцы вперевязку: чётные — вдоль ширины, нечётные — вдоль глубины
        const dir = Math.round(y / 0.225) % 2 ? o.rot : o.rot + Math.PI / 2;
        place(M.logEnd, stub, x, fy + y, z, [0, dir, Math.PI / 2]);
      }
    }
  }

  // кровля: двускатная, конёк вдоль ширины; каждый лист — отдельная панель
  const pitch = o.pitch ?? 0.6, over = 0.38, top = fy + h;
  const D2 = d / 2 + over, hr = (d / 2) * Math.tan(pitch), Ls = D2 / Math.cos(pitch);
  const roofMat = o.roofMat ?? (o.roof === 'tar' ? M.roofTar : M.roofRust);
  const nP = Math.ceil((w + 0.8) / 1.05), pw = (w + 0.8) / nP;
  const damage = o.damage ?? 0.3;
  const roofSup = { list: walls, frac: 0.5 };
  for (let i = 0; i < nP; i++) {
    const lx = -w / 2 - 0.4 + pw * (i + 0.5);
    for (const s2 of [-1, 1]) {
      if (R() < damage * 0.4) continue;                        // дыра в кровле
      const sag = R() < damage * 0.3 ? R.range(0.05, 0.14) : 0;
      panel('roof', { hp: 0.6, sup: { list: walls, frac: R.range(0.4, 0.62) }, density: 1400, float: 0, burnable: o.roof === 'tar' });
      B(roofMat, lx, top + hr - (D2 / 2) * Math.tan(pitch) - sag, s2 * D2 / 2, pw - 0.02, 0.03, Ls, { rx: s2 * pitch + R.range(-0.02, 0.02), tile: 1.2 });
    }
  }
  // стропила: пара на каждом шаге — одна панель
  for (let i = 0; i <= nP; i += 1) {
    const lx = -w / 2 - 0.4 + pw * i;
    panel('roof', { hp: 0.8, sup: roofSup, density: 500 });
    for (const s2 of [-1, 1]) B(M.planksDark, lx, top + hr - (D2 / 2) * Math.tan(pitch) - 0.08, s2 * D2 / 2, 0.08, 0.12, Ls, { rx: s2 * pitch, tile: 1 });
  }
  panel('roof', { hp: 1, sup: roofSup, density: 500 });
  B(M.planksDark, 0, top + hr - 0.02, 0, w + 0.8, 0.14, 0.14, { tile: 1 });
  // лобовые доски по свесам кровли и ветровые по фронтонам
  for (const s2 of [-1, 1]) {
    panel('roof', { hp: 0.6, sup: roofSup, density: 450 });
    B(trimMat, 0, top + hr - D2 * Math.tan(pitch) - 0.07, s2 * (D2 - 0.02), w + 0.84, 0.16, 0.035, { tile: 1 });
    for (const e of [-1, 1]) B(trimMat, e * (w / 2 + 0.42), top + hr - (D2 / 2) * Math.tan(pitch) - 0.03, s2 * D2 / 2, 0.035, 0.16, Ls, { rx: s2 * pitch, tile: 1 });
  }
  // кровля для коллизий: ступенчатый «конёк» из боксов (без геометрии), падает вместе с кровлей
  panel('roofcol', { mode: 'none', sup: roofSup });
  for (let k = 0; k < 4; k++) {
    const y0 = top + hr * k / 4 - 0.05, y1 = top + hr * (k + 1) / 4 + 0.05;
    const half = D2 * (1 - (k + 0.5) / 4);
    const [cx, cz] = P(0, 0);
    addBox(cx, (y0 + y1) / 2, cz, w + 0.8, y1 - y0, half * 2, o.rot, { walk: true });
  }
  // фронтоны стоят на боковых стенах
  const tri = new THREE.Shape();
  tri.moveTo(-d / 2, 0); tri.lineTo(d / 2, 0); tri.lineTo(0, hr); tri.closePath();
  const tg = new THREE.ExtrudeGeometry(tri, { depth: 0.08, bevelEnabled: false });
  const tuv = tg.attributes.uv;
  for (let i = 0; i < tuv.count; i++) tuv.setXY(i, tuv.getX(i) / 1.5, tuv.getY(i) / 1.5);
  for (const s2 of [-1, 1]) {
    const [x, z] = P(s2 * (w / 2 - 0.04) - 0.04, 0);
    panel('wall', { hp: 0.9, sup: { list: bySide[s2 < 0 ? 'left' : 'right'], frac: 0.5 }, mode: 'rigid', density: 450 });
    place(o.style === 'log' ? M.planksDark : wallMat, tg, x, top, z, [0, o.rot + Math.PI / 2, 0]);
  }
  noPanel();
  // печь с трубой — кирпич переживает пожар и взрыв
  if (o.stove) {
    const sx = o.stove[0], sz = o.stove[1];
    B(M.brick, sx, fy + 0.5, sz, 1.0, 1.0, 1.1, { collide: true, tile: 0.6 });
    B(M.brick, sx, fy + 1.6, sz - 0.2, 0.5, 1.2, 0.5, { tile: 0.6 });
    // труба над кровлей — отдельная деталь: прямое попадание сбивает её, пожар — нет
    B(M.brick, sx, (fy + 2.2 + top) / 2, sz - 0.2, 0.42, top - fy - 2.2 + 0.02, 0.42, { tile: 0.6 });
    const [cx, cz] = P(sx, sz - 0.2);
    addBox(cx, (fy + 1 + top) / 2, cz, 0.5, top - fy - 1, 0.5, o.rot);
    panel('prop', { hp: 2.4, mode: 'rigid', density: 1800, float: 0, burnable: false });
    B(M.brick, sx, top + (hr * 1.4 + 0.3) / 2, sz - 0.2, 0.42, hr * 1.4 + 0.3, 0.42, { tile: 0.6 });
    B(M.concrete, sx, top + hr * 1.4 + 0.34, sz - 0.2, 0.54, 0.08, 0.54, { tile: 0.6 });
    addBox(cx, top + (hr * 1.4 + 0.3) / 2, cz, 0.5, hr * 1.4 + 0.3, 0.5, o.rot);
    noPanel();
  }
  // обстановка
  if (o.interior !== false) (o.furnish ?? furnish)(o, R, F, fy, B);
  noPanel();
  // окна, где ночью теплится свет (кто-то жжёт свечу)
  if (o.glow) {
    const [x, z] = P(o.glow[0], o.glow[1]);
    S.glowLamp = addLamp({ kind: 'window', x, y: fy + 1.2, z, flick: 0.3, on: true, ground: fy });
    place(M.dark, new THREE.CylinderGeometry(0.06, 0.07, 0.22, 8), x, fy + 0.86, z, 0);
  }
  if (o.decor) o.decor(o, R, F, fy, B, S);
  endStruct();
  HOUSES.push({ ...o, fy, top: top + hr, struct: S });
  return S;
}

/* ---------- Погреб / подвал ----------
   Яма под полом (рельеф вынут в плане), кирпичные или дощатые стены, пол из
   досок, крутая лестница из люка. Внутри тусклая лампочка, полки, бочки;
   в подвале турбазы — штаб: нары, стол с рацией, карта и позывные на стене. */
function cellarRoom(o, C, fy, B, R, F) {
  const bottom = o.pad.y - C.depth, fl = bottom + 0.12, ceil = fy - 0.1;
  const cx = (C.rx0 + C.rx1) / 2, cz = (C.rz0 + C.rz1) / 2, rw = C.rx1 - C.rx0, rd = C.rz1 - C.rz0, hh = ceil - fl;
  const wmat = C.kind === 'basement' ? M.brick : M.planksDark, tile = C.kind === 'basement' ? 0.6 : 1.2;
  B(M.planksDark, cx, fl - 0.05, cz, rw, 0.1, rd, { tile: 1.2, collide: true });
  for (const [lx, lz, sx, sz] of [[cx, C.rz0 - 0.1, rw + 0.4, 0.2], [cx, C.rz1 + 0.1, rw + 0.4, 0.2], [C.rx0 - 0.1, cz, 0.2, rd], [C.rx1 + 0.1, cz, 0.2, rd]])
    B(wmat, lx, fl + hh / 2, lz, sx, hh, sz, { tile, collide: true, walk: false, vertical: wmat !== M.brick });
  // балки перекрытия и столбы
  for (let x = C.rx0 + 0.6; x < C.rx1; x += 1.2) B(M.planksDark, x, ceil - 0.09, cz, 0.14, 0.16, rd, { tile: 1 });
  if (C.kind === 'basement') for (const x of [cx - rw * 0.22, cx + rw * 0.22]) B(M.brick, x, fl + hh / 2, cz - 0.4, 0.38, hh, 0.38, { tile: 0.6, collide: true, walk: false });
  // лестница: марш вниз вдоль −z из люка
  const n = C.steps, rise = (fy - fl) / n, run = C.run;
  const sx = (C.hx0 + C.hx1) / 2, sw = C.hx1 - C.hx0 - 0.06;
  for (let k = 0; k < n; k++) {
    const top = fy - rise * (k + 1), z = C.hz1 - run * (k + 0.5);
    B(M.planks, sx, top - 0.03, z, sw, 0.06, run + 0.02, { tile: 1, collide: true });
  }
  for (const e of [-1, 1]) {
    const x = sx + e * (sw / 2 + 0.03), L = run * n, zc = C.hz1 - L / 2, yc = (fy + fl) / 2 - 0.1;
    const [wx, wz] = F.p(x, zc);
    box(M.planksDark, wx, yc, wz, 0.05, 0.22, Math.hypot(L, fy - fl), { rot: o.rot, rx: -Math.atan2(fy - fl, L), tile: 1 });
  }
  // крышка люка откинута на пол
  B(M.planksDark, sx + sw / 2 + 0.55, fy + 0.03, (C.hz0 + C.hz1) / 2, 0.85, 0.05, C.hz1 - C.hz0, { tile: 1, rz: 0.12 });
  // обстановка
  const shelves = (x, z) => {
    for (let k = 0; k < 3; k++) B(M.planks, x, fl + 0.5 + k * 0.55, z, 0.4, 0.04, 1.6, { tile: 1 });
    for (const e of [-0.75, 0.75]) B(M.planksDark, x, fl + 0.8, z + e, 0.05, 1.6, 0.05, { tile: 1 });
    for (let k = 0; k < 7; k++) { const [jx, jz] = F.p(x + R.range(-0.12, 0.12), z + R.range(-0.7, 0.7)); cyl(M.glass, jx, fl + 0.6 + R.int(0, 2) * 0.55, jz, 0.05, 0.05, 0.16, { seg: 8 }); }
  };
  shelves(C.rx0 + 0.25, cz - rd * 0.2);
  for (let k = 0; k < 3; k++) { const [bx, bz] = F.p(C.rx0 + 0.45 + k * 0.62, C.rz0 + 0.45); cyl(M.planksDark, bx, fl + 0.4, bz, 0.26, 0.26, 0.8, { seg: 12, tile: 1 }); cyl(M.rust, bx, fl + 0.62, bz, 0.27, 0.27, 0.04, { seg: 12 }); }
  const [lx, lz] = F.p(cx, cz);
  addLamp({ kind: 'bulb', x: lx, y: ceil - 0.35, z: lz, flick: 0.45, on: true, ground: fl, power: 3.5, range: 7 });
  place(M.lampGlass, new THREE.SphereGeometry(0.05, 8, 6), lx, ceil - 0.32, lz, 0);
  cyl(M.dark, lx, ceil - 0.18, lz, 0.004, 0.004, 0.3, { seg: 3 });
  if (C.kind === 'basement') {
    // штаб: стол с рацией и картой, нары, позывные на стене
    const tx = C.rx1 - 1.2, tz = cz + 1.0;
    B(M.planks, tx, fl + 0.74, tz, 1.4, 0.05, 0.8, { tile: 1, collide: true });
    for (const [a, b] of [[-0.62, -0.32], [0.62, -0.32], [-0.62, 0.32], [0.62, 0.32]]) B(M.planksDark, tx + a, fl + 0.37, tz + b, 0.06, 0.72, 0.06, { tile: 1 });
    B(M.olive, tx + 0.35, fl + 0.9, tz - 0.1, 0.4, 0.26, 0.3, { tile: 1 });
    const [ax, az] = F.p(tx + 0.45, tz - 0.1); cyl(M.dark, ax, fl + 1.3, az, 0.006, 0.006, 0.6, { seg: 3 });
    const [mx, mz] = F.p(tx - 0.3, tz); sheet(3, mx, fl + 0.77, mz, o.rot + 0.2, { flat: true, w: 0.42, h: 0.56 });
    for (let k = 0; k < 3; k++) { const [px, pz] = F.p(C.rx1 - 0.005, cz - 1.2 + k * 0.4); sheet(k, px, fl + 1.35 + (k % 2) * 0.12, pz, o.rot - Math.PI / 2); }
    for (const y2 of [0.45, 1.3]) B(M.planks, C.rx0 + 1.9, fl + y2, C.rz1 - 0.45, 1.9, 0.06, 0.75, { tile: 1, collide: y2 < 1 });
    B(M.canvas, C.rx0 + 1.9, fl + 0.5, C.rz1 - 0.45, 1.8, 0.05, 0.7, { tile: 1 });
    B(M.crate, cx + 0.3, fl + 0.2, C.rz0 + 0.35, 1.0, 0.4, 0.55, { tile: 0.8, collide: true });
  } else {
    const [px, pz] = F.p(C.rx1 - 0.005, cz); sheet(1, px, fl + 1.3, pz, o.rot - Math.PI / 2);
    B(M.sack, C.rx1 - 0.5, fl + 0.22, C.rz0 + 0.5, 0.7, 0.45, 0.5, { tile: 1 });
    B(M.sack, C.rx1 - 0.6, fl + 0.6, C.rz0 + 0.5, 0.6, 0.35, 0.45, { tile: 1, r: 0.3 });
  }
}
/** Стол, лавки, кровать, мусор на полу. */
function furnish(o, R, F, fy, B) {
  const { w, d } = o;
  const tx = R.range(-w * 0.2, w * 0.2), tz = R.range(-d * 0.15, d * 0.1);
  const flipped = R() < 0.35;
  panel('prop', { hp: 0.35, density: 450 });
  if (!flipped) {
    B(M.planks, tx, fy + 0.74, tz, 1.3, 0.05, 0.75, { tile: 1, collide: true });
    for (const [a, b] of [[-0.58, -0.3], [0.58, -0.3], [-0.58, 0.3], [0.58, 0.3]]) B(M.planksDark, tx + a, fy + 0.36, tz + b, 0.06, 0.72, 0.06, { tile: 1 });
  } else {
    // опрокинутый стол — готовое укрытие
    B(M.planks, tx, fy + 0.38, tz, 1.3, 0.75, 0.05, { tile: 1, collide: true, walk: false });
    for (const a of [-0.58, 0.58]) for (const b of [0.2, 0.55]) B(M.planksDark, tx + a, fy + 0.72 - 0.35 + b * 0, tz + b, 0.06, 0.06, 0.72, { tile: 1 });
  }
  panel('prop', { hp: 0.3, density: 450 });
  B(M.planksDark, tx, fy + 0.42, tz + 0.7, 1.2, 0.05, 0.3, { tile: 1, rz: R.range(-0.1, 0.1) });
  // кровать с панцирной сеткой
  if (w > 4) {
    panel('prop', { hp: 0.5, density: 1200, float: 0, burnable: false });
    const bx = -w / 2 + 1.1, bz = -d / 2 + 0.6;
    B(M.rust, bx, fy + 0.45, bz, 1.9, 0.05, 0.85, { tile: 1 });
    for (const [a, b] of [[-0.9, -0.4], [0.9, -0.4], [-0.9, 0.4], [0.9, 0.4]]) B(M.rust, bx + a, fy + 0.3, bz + b, 0.05, 0.6, 0.05, { tile: 1 });
  }
  // доски и обломки
  noPanel();
  for (let i = 0; i < 4; i++) {
    const px = R.range(-w * 0.35, w * 0.35), pz = R.range(-d * 0.35, d * 0.35), L = R.range(0.8, 1.8);
    if (o.cellar && px > o.cellar.hx0 - 1 && px < o.cellar.hx1 + 1 && pz > o.cellar.hz0 - 1 && pz < o.cellar.hz1 + 1) continue;
    B(M.planksDark, px, fy + 0.04, pz, L, 0.03, 0.14, { r: R.range(0, TAU), rz: R.range(-0.08, 0.08), tile: 1 });
  }
}

/** Колодец-журавль нет смысла тащить в бой: сруб, двускатный козырёк, ворот. */
function well(x, z, rot) {
  const y = terrainH(x, z);
  for (let k = 0; k < 5; k++) for (let s = 0; s < 4; s++) {
    const a = rot + s * Math.PI / 2, c = Math.cos(a), sn = Math.sin(a);
    place(M.logEnd, new THREE.CylinderGeometry(0.1, 0.1, 1.3, 7), x + sn * 0.55, y + 0.1 + k * 0.19, z + c * 0.55, [0, a + Math.PI / 2, Math.PI / 2]);
  }
  addBox(x, y + 0.5, z, 1.3, 1.0, 1.3, rot);
  for (const s of [-1, 1]) cyl(M.planksDark, x + Math.cos(rot) * s * 0.62, y + 1.1, z - Math.sin(rot) * s * 0.62, 0.05, 0.05, 1.3, { seg: 6 });
  box(M.roofRust, x, y + 1.85, z, 1.6, 0.03, 1.0, { rot, rx: 0.5, tile: 1.2 });
  cyl(M.planksDark, x, y + 1.35, z, 0.09, 0.09, 1.2, { seg: 8, rot: [0, rot, Math.PI / 2] });
}
/** Поленница: торцы поленьев — инстансы в общем буфере. */
function woodpile(x, z, rot, len = 3, rows = 5) {
  const R = rng(Math.floor(x * 31 + z * 17));
  const y = terrainH(x, z);
  const c = Math.cos(rot), s = Math.sin(rot);
  const g = new THREE.CylinderGeometry(0.08, 0.08, 0.5, 6);
  for (let r = 0; r < rows; r++) for (let i = 0; i < len / 0.17; i++) {
    if (r === rows - 1 && R() < 0.5) continue;
    const lx = -len / 2 + i * 0.17 + (r % 2) * 0.08 + R.range(-0.02, 0.02);
    place(M.logEnd, g, x + lx * c, y + 0.09 + r * 0.155, z - lx * s, [Math.PI / 2 + R.range(-0.08, 0.08), rot, 0]);
  }
  box(M.roofRust, x, y + rows * 0.16 + 0.1, z, len + 0.3, 0.03, 0.8, { rot, rx: 0.12, tile: 1.2 });
  addBox(x, y + rows * 0.08, z, len, rows * 0.16, 0.55, rot);
}
function outhouse(x, z, rot) {
  const y = terrainH(x, z), F = frame(x, z, rot);
  beginStruct({ kind: 'shed', x, z, rot, w: 1.2, d: 1.2, h: 2.1, fy: y, fuel: 0.5 });
  const walls = [];
  for (const [lx, lz, sx, sz] of [[0, -0.6, 1.2, 0.05], [-0.6, 0, 0.05, 1.2], [0.6, 0, 0.05, 1.2]]) {
    const [px, pz] = F.p(lx, lz);
    walls.push(panel('wall', { hp: 0.5, mode: 'rigid', density: 450 }));
    box(M.planks, px, y + 1.05, pz, sx, 2.1, sz, { rot, tile: 1.5, vertical: true, collide: true, walk: false });
  }
  const [dx, dz] = F.p(0.2, 0.9);
  panel('door', { hp: 0.3, density: 450 });
  box(M.planks, dx, y + 1.0, dz, 1.0, 2.0, 0.04, { rot: rot + 0.9, tile: 1.5, vertical: true });
  panel('roof', { hp: 0.4, sup: { list: walls, frac: 0.6 }, density: 900, float: 0 });
  box(M.roofRust, x, y + 2.2, z, 1.5, 0.03, 1.5, { rot, rx: -0.15, tile: 1.2 });
  addBox(x, y + 2.2, z, 1.5, 0.2, 1.5, rot, { walk: true });
  endStruct();
}
/** Навес-пилорама кордона: столбы, односкатная крыша, бревна на козлах. */
function sawShed(x, z, rot) {
  const y = terrainH(x, z), F = frame(x, z, rot);
  for (const lx of [-3.5, 0, 3.5]) for (const lz of [-2, 2]) {
    const [px, pz] = F.p(lx, lz);
    cyl(M.deadwood, px, y + 1.4 + (lz > 0 ? 0.3 : 0), pz, 0.1, 0.09, 2.8 + (lz > 0 ? 0.6 : 0), { seg: 7 });
    addCircle2(px, pz, 0.12, y, y + 3);
  }
  box(M.roofRust, x, y + 3.05, z, 7.8, 0.03, 4.8, { rot, rx: -0.12, tile: 1.2 });
  for (let i = 0; i < 7; i++) {
    const [px, pz] = F.p(-2.5, -1.4 + i * 0.42);
    cyl(M.barkPine, px + 2.5, y + 0.9, pz, 0.18, 0.18, 6, { seg: 8, rot: [0, rot, Math.PI / 2] });
  }
  for (const lx of [-2.2, 2.2]) {
    const [px, pz] = F.p(lx, 0);
    box(M.planksDark, px, y + 0.35, pz, 0.2, 0.7, 3.2, { rot, tile: 1 });
  }
  addBox(x, y + 0.85, z, 6, 0.9, 3.2, rot);
}
/* ---------- План кластеров ---------- */
const T_PLAN = [
  { kind: 'house', id: 'lodge', x: -68, z: -60, faceT: true, w: 12, d: 7, style: 'paint', roof: 'tar', porch: true, stove: [3.8, -1.8],
    cellar: { kind: 'basement', rx0: -4.9, rx1: 3.0, rz0: -2.4, rz1: 2.4, hx0: -4.9, hx1: -4.0, hz0: -1.45, hz1: 1.0, depth: 2.35, steps: 10, run: 0.27 },
    windows: [{ side: 'front', at: -4 }, { side: 'front', at: -1.8 }, { side: 'front', at: 2.4 }, { side: 'front', at: 4.4 }, { side: 'back', at: -3 }, { side: 'back', at: 3 }, { side: 'left', at: 0 }],
    door: { side: 'front', at: 0.3 }, door2: { side: 'right', at: 1.5 }, damage: 0.35, sign: true, glow: [-3.2, 1.8], alt: { style: 'log', roof: 'rust' } },
  { kind: 'house', id: 'cabin1', x: -46, z: -74, faceT: true, w: 4.6, d: 5.4, style: 'plank', roof: 'rust', stove: [-1.2, -1.6],
    windows: [{ side: 'front', at: 1.3, w: 0.9 }, { side: 'left', at: 0.6 }, { side: 'right', at: -0.8 }], door: { side: 'front', at: -0.9 }, damage: 0.5, alt: { style: 'log' } },
  { kind: 'house', id: 'cabin2', x: -36, z: -46, faceT: true, w: 4.6, d: 5.4, style: 'paint', roof: 'rust',
    windows: [{ side: 'front', at: 1.2, w: 0.9 }, { side: 'back', at: 0 }, { side: 'right', at: 0.5 }], door: { side: 'front', at: -1 }, damage: 0.65, glow: [0.8, 1.2], alt: { style: 'plank', roof: 'tar' } },
  { kind: 'house', id: 'cabin3', x: -72, z: -44, faceT: true, w: 4.6, d: 5.4, style: 'log', roof: 'rust', stove: [1.3, -1.6],
    windows: [{ side: 'front', at: 1.2, w: 0.9 }, { side: 'left', at: 0 }, { side: 'back', at: 0.8 }], door: { side: 'front', at: -1 }, damage: 0.25, alt: { style: 'plank' } },
  { kind: 'house', id: 'banya', x: -16.4, z: -35.2, face: [-17.5, -40.4], w: 3.6, d: 3.2, h: 2.2, style: 'log', roof: 'rust', stove: [0.9, -0.8], interior: false,
    windows: [{ side: 'left', at: 0.3, w: 0.6 }], door: { side: 'front', at: -0.8 }, damage: 0.2, alt: {} },
  { kind: 'well', x: -45, z: -52.5 },
  { kind: 'woodpile', x: -62.5, z: -67, faceT: true },
  { kind: 'woodpile', x: -20.5, z: -34, rotAdd: 1.2 },
  { kind: 'outhouse', x: -77, z: -54, faceT: true, alt: 'saw' },
  { kind: 'bus', x: -59.5, z: -63.5, rot: -2.78 + 0.1 }
];

/** Все постройки обоих кластеров: турбаза как есть, кордон — поворот на 180°. */
function clusterItems() {
  const out = [];
  for (const it of T_PLAN) {
    // вторая половина карты — пионерлагерь (camp.js), турбаза не зеркалится
    for (const mir of [false]) {
      const s = mir ? -1 : 1;
      const c = mir ? CLUSTERS.K : CLUSTERS.T;
      const x = it.x * s, z = it.z * s;
      let rot = it.rot !== undefined ? it.rot + (mir ? Math.PI : 0) : 0;
      if (it.faceT) rot = Math.atan2(c.x - x, c.z - z);
      if (it.face) rot = Math.atan2(it.face[0] * s - x, it.face[1] * s - z);
      rot += it.rotAdd ?? 0;
      out.push({ ...it, ...(mir && typeof it.alt === 'object' ? it.alt : {}), kind: mir && it.alt === 'saw' ? 'saw' : mir && it.kind === 'bus' ? 'truck' : it.kind, x, z, rot, mir, seed: Math.abs(Math.round(it.x * 13 + it.z * 7)) + (mir ? 999 : 0) });
    }
  }
  return [...out, ...campHouses(), ...campItems()];
}
let ITEMS = [];
export function planBuildings() {
  ITEMS = clusterItems();
  planCamp(ITEMS.filter(it => it.kind.startsWith('camp')));
  for (const it of ITEMS) {
    if (it.kind === 'house') it.pad = addPad(it.x, it.z, it.w / 2 + 0.6, it.d / 2 + (it.porch ? 2.4 : 1.2), it.rot, 3);
    // погреб: яма под полом, чуть шире комнаты — откосы прячутся за стенами
    if (it.kind === 'house' && it.cellar) {
      const C = it.cellar, lx = (C.rx0 + C.rx1) / 2, lz = (C.rz0 + C.rz1) / 2, c = Math.cos(it.rot), s = Math.sin(it.rot);
      addDig({ x: it.x + lx * c + lz * s, z: it.z - lx * s + lz * c, hw: (C.rx1 - C.rx0) / 2 + 0.3, hd: (C.rz1 - C.rz0) / 2 + 0.3, rot: it.rot, depth: C.depth, pad: it.pad });
    }
    else if (it.kind === 'bus' || it.kind === 'truck') keep(it.x, it.z, 4.2);
    else if (it.kind === 'saw') it.pad = addPad(it.x, it.z, 4.2, 2.6, it.rot, 2.5);
    else if (!it.kind.startsWith('camp')) keep(it.x, it.z, it.kind === 'woodpile' ? 2 : 1.3);
    // тропы подходят к дверям — проверяем только сердцевину дома
    if (it.kind === 'house' && pathInfluence(it.x, it.z, Math.min(it.w, it.d) * 0.3) > 0.3)
      console.warn('[layout] дом на тропе:', it.id, it.x, it.z);
  }
}
export function buildBuildings() {
  for (const it of ITEMS) {
    if (it.kind === 'house') {
      house(it);
      if (it.porch) porch(it);
      if (it.sign) sign(it);
    } else if (it.kind === 'well') well(it.x, it.z, it.rot);
    else if (it.kind === 'woodpile') woodpile(it.x, it.z, it.rot);
    else if (it.kind === 'outhouse') outhouse(it.x, it.z, it.rot);
    else if (it.kind === 'saw') sawShed(it.x, it.z, it.rot);
    else if (it.kind === 'bus') vehicle('bus', it.x, it.z, it.rot, { seed: 11, paint: 1, tilt: 0.06 });
    else if (it.kind === 'truck') vehicle('truck', it.x, it.z, it.rot, { seed: 12, paint: 3, tilt: 0.04 });
    else buildCampItem(it);
  }
  buildCampExtras();
}
/** Веранда главного корпуса: настил, столбы, навес — и драный брезент на нём. */
function porch(o) {
  const F = frame(o.x, o.z, o.rot);
  const fy = o.pad.y + 0.42, dep = 2.0;
  const [cx, cz] = F.p(0, o.d / 2 + dep / 2);
  beginStruct({ kind: 'porch', x: cx, z: cz, rot: o.rot, w: o.w - 1, d: dep, h: 2.5, fy, fuel: 0.6 });
  noPanel();
  box(M.planksDark, cx, fy - 0.05, cz, o.w - 1, 0.1, dep, { rot: o.rot, tile: 1.2, collide: true });
  const posts = [];
  for (const lx of [-o.w / 2 + 0.7, -o.w / 4, o.w / 4, o.w / 2 - 0.7]) {
    const [px, pz] = F.p(lx, o.d / 2 + dep - 0.1);
    posts.push(panel('prop', { hp: 0.5, density: 450 }));
    cyl(M.planksPaint, px, fy + 1.2, pz, 0.08, 0.08, 2.4, { seg: 6 });
    addCircle2(px, pz, 0.1, fy, fy + 2.4);
  }
  const [rx, rz] = F.p(0, o.d / 2 + dep / 2);
  panel('roof', { hp: 0.6, sup: { list: posts, frac: 0.5 }, density: 900, float: 0 });
  box(M.roofTar, rx, fy + 2.5, rz, o.w - 0.6, 0.04, dep + 0.5, { rot: o.rot, rx: 0.18, tile: 1.2 });
  addBox(rx, fy + 2.5, rz, o.w - 0.6, 0.2, dep + 0.5, o.rot, { walk: true });
  endStruct();
  // брезент, сорванный с одного края
  const ux = Math.cos(o.rot), uz = -Math.sin(o.rot), fx = Math.sin(o.rot), fz = Math.cos(o.rot);
  const [ax, az] = F.p(-o.w / 2 + 0.8, o.d / 2 + dep + 0.1);
  makeCloth({
    nx: Math.max(6, Math.round(Q.cloth * 0.6)), ny: Math.max(5, Math.round(Q.cloth * 0.45)), material: M.canvas, wind: 0.8,
    place: (u, v) => new THREE.Vector3(ax + ux * u * 3.2 + fx * 0.05, fy + 2.35 - v * 1.4, az + uz * u * 3.2 + fz * 0.05),
    pinFn: (i, j) => j === 0 && (i < 3 || i % 3 === 0)
  });
}
function sign(o) {
  const F = frame(o.x, o.z, o.rot);
  const [x, z] = F.p(-2.4, o.d / 2 + 3.2);
  const y = terrainH(x, z);
  beginStruct({ kind: 'sign', x, z, rot: o.rot, w: 2.4, d: 0.3, h: 2.5, fy: y, fuel: 0.3 });
  panel('prop', { hp: 0.5, density: 400 });
  for (const s2 of [-1, 1]) cyl(M.deadwood, x + Math.cos(o.rot) * s2 * 1.1, y + 1.2, z - Math.sin(o.rot) * s2 * 1.1, 0.07, 0.07, 2.4, { seg: 6 });
  M.boardT ??= new THREE.MeshStandardMaterial({ map: TEX.board, roughness: 0.85, side: THREE.DoubleSide });
  place(M.boardT, new THREE.PlaneGeometry(2.4, 1.2), x, y + 1.9, z, [0, o.rot, 0.04]);
  endStruct();
}
