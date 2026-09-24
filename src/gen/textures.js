import { clamp, srnd, sr, si, TAU } from '../core/math.js';
import { cv, TS, wrapDraw, grain, heightToNormal, sharpenAlpha, bleedColor, tex, rgba, blob } from './canvas.js';

/* Все текстуры карты рисуются кодом: файл самодостаточен и не тянет ассеты.
   Палитра приглушённая, северная: хвоя, мох, сырая земля, ржавчина, серое дерево. */

/* ---------- Лесная подстилка: хвоя, мох, шишки, веточки ---------- */
export function forestFloor() {
  const S = TS(1024), K = S / 1024;
  const [c, x] = cv(S), [h, hx] = cv(S);
  x.fillStyle = '#3a3122'; x.fillRect(0, 0, S, S);
  hx.fillStyle = '#808080'; hx.fillRect(0, 0, S, S);
  // крупные пятна: сырая земля, сухая хвоя, мох
  for (let i = 0; i < 520 * K; i++) {
    const px = srnd() * S, py = srnd() * S, r = sr(18, 120) * K;
    const k = srnd();
    const col = k < 0.35 ? [si(52, 78), si(66, 92), si(30, 44)]      // мох
      : k < 0.7 ? [si(92, 124), si(66, 88), si(38, 52)]              // рыжая хвоя
        : [si(40, 58), si(32, 44), si(24, 32)];                      // сырая земля
    wrapDraw(x, S, S, () => blob(x, px, py, r, col, sr(0.18, 0.5)));
    if (k < 0.35) wrapDraw(hx, S, S, () => blob(hx, px, py, r, [170, 170, 170], 0.35));
  }
  // опавшая хвоя: тысячи коротких штрихов разного цвета
  for (let i = 0; i < 16000 * K * K; i++) {
    const px = srnd() * S, py = srnd() * S, a = sr(0, TAU), L = sr(5, 15) * K;
    const v = si(70, 150), dry = srnd() < 0.7;
    x.strokeStyle = dry ? rgba(v, v * 0.7, v * 0.4, sr(0.35, 0.8)) : rgba(v * 0.55, v * 0.62, v * 0.32, sr(0.3, 0.6));
    x.lineWidth = sr(0.7, 1.6) * K;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); x.stroke();
    hx.strokeStyle = rgba(si(150, 210), si(150, 210), si(150, 210), 0.45);
    hx.lineWidth = x.lineWidth * 1.2;
    hx.beginPath(); hx.moveTo(px, py); hx.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); hx.stroke();
  }
  // веточки
  for (let i = 0; i < 90 * K; i++) {
    const px = srnd() * S, py = srnd() * S, a = sr(0, TAU), L = sr(20, 70) * K;
    const v = si(60, 100);
    wrapDraw(x, S, S, () => {
      x.strokeStyle = rgba(v, v * 0.78, v * 0.55, 0.9); x.lineWidth = sr(1.5, 3.5) * K;
      x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); x.stroke();
    });
    wrapDraw(hx, S, S, () => {
      hx.strokeStyle = 'rgba(235,235,235,.9)'; hx.lineWidth = sr(2, 4) * K;
      hx.beginPath(); hx.moveTo(px, py); hx.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); hx.stroke();
    });
  }
  // шишки
  for (let i = 0; i < 70 * K; i++) {
    const px = srnd() * S, py = srnd() * S, a = sr(0, TAU), r = sr(6, 11) * K;
    wrapDraw(x, S, S, () => {
      x.save(); x.translate(px, py); x.rotate(a);
      x.fillStyle = rgba(si(78, 104), si(54, 70), si(32, 42), 1);
      x.beginPath(); x.ellipse(0, 0, r, r * 0.45, 0, 0, 7); x.fill();
      x.strokeStyle = 'rgba(30,20,12,.7)'; x.lineWidth = K;
      for (let k = -2; k <= 2; k++) { x.beginPath(); x.moveTo(k * r * 0.3, -r * 0.4); x.lineTo(k * r * 0.3 + 2 * K, r * 0.4); x.stroke(); }
      x.restore();
    });
    wrapDraw(hx, S, S, () => blob(hx, px, py, r, [250, 250, 250], 0.9));
  }
  grain(x, S, S, 0.05);
  return { map: tex(c), normal: tex(heightToNormal(h, 2.6), 1, 1, false) };
}

/* ---------- Утоптанная тропа: плотный грунт, корни, мелкие камни ---------- */
export function dirtPath() {
  const S = TS(512), K = S / 512;
  const [c, x] = cv(S), [h, hx] = cv(S);
  x.fillStyle = '#5c4a36'; x.fillRect(0, 0, S, S);
  hx.fillStyle = '#909090'; hx.fillRect(0, 0, S, S);
  for (let i = 0; i < 260 * K; i++) {
    const px = srnd() * S, py = srnd() * S, r = sr(10, 70) * K;
    const wet = srnd() < 0.4, v = wet ? si(52, 70) : si(96, 128);
    wrapDraw(x, S, S, () => blob(x, px, py, r, [v, v * 0.82, v * 0.62], sr(0.2, 0.45)));
    if (wet) wrapDraw(hx, S, S, () => blob(hx, px, py, r, [90, 90, 90], 0.35));
  }
  for (let i = 0; i < 2600 * K * K; i++) {
    const px = srnd() * S, py = srnd() * S, r = sr(0.8, 3.2) * K, v = si(110, 170);
    wrapDraw(x, S, S, () => { x.fillStyle = rgba(v, v - 8, v - 22, sr(0.3, 0.8)); x.beginPath(); x.arc(px, py, r, 0, 7); x.fill(); });
    wrapDraw(hx, S, S, () => { hx.fillStyle = rgba(220, 220, 220, 0.8); hx.beginPath(); hx.arc(px, py, r, 0, 7); hx.fill(); });
  }
  // корни, пересекающие тропу
  for (let i = 0; i < 9; i++) {
    let px = srnd() * S, py = srnd() * S, a = sr(0, TAU);
    const w = sr(3, 7) * K, v = si(70, 96);
    const pts = [];
    for (let k = 0; k < 10; k++) { pts.push([px, py]); a += sr(-0.4, 0.4); px += Math.cos(a) * 14 * K; py += Math.sin(a) * 14 * K; }
    for (const [ctx, col, lw] of [[x, rgba(v, v * 0.72, v * 0.5, 0.95), w], [hx, 'rgba(240,240,240,1)', w * 1.1]]) {
      wrapDraw(ctx, S, S, () => {
        ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (const p of pts) ctx.lineTo(p[0], p[1]);
        ctx.stroke();
      });
    }
  }
  // хвоя, занесённая на тропу
  for (let i = 0; i < 1400 * K * K; i++) {
    const px = srnd() * S, py = srnd() * S, a = sr(0, TAU), L = sr(4, 10) * K, v = si(90, 140);
    x.strokeStyle = rgba(v, v * 0.7, v * 0.4, 0.5); x.lineWidth = K;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); x.stroke();
  }
  grain(x, S, S, 0.05);
  return { map: tex(c), normal: tex(heightToNormal(h, 2.2), 1, 1, false) };
}

/* ---------- Прибрежный ил и песок ---------- */
export function mud() {
  const S = TS(512), K = S / 512;
  const [c, x] = cv(S), [h, hx] = cv(S);
  x.fillStyle = '#3b3326'; x.fillRect(0, 0, S, S);
  hx.fillStyle = '#7a7a7a'; hx.fillRect(0, 0, S, S);
  for (let i = 0; i < 300 * K; i++) {
    const px = srnd() * S, py = srnd() * S, r = sr(12, 80) * K;
    const sand = srnd() < 0.35;
    const col = sand ? [si(110, 140), si(98, 122), si(70, 88)] : [si(34, 52), si(30, 44), si(22, 32)];
    wrapDraw(x, S, S, () => blob(x, px, py, r, col, sr(0.2, 0.5)));
    wrapDraw(hx, S, S, () => blob(hx, px, py, r, sand ? [150, 150, 150] : [60, 60, 60], 0.3));
  }
  // следы и лужицы
  for (let i = 0; i < 40 * K; i++) {
    const px = srnd() * S, py = srnd() * S, a = sr(0, TAU);
    wrapDraw(hx, S, S, () => {
      hx.save(); hx.translate(px, py); hx.rotate(a);
      hx.fillStyle = 'rgba(40,40,40,.6)'; hx.beginPath(); hx.ellipse(0, 0, 7 * K, 16 * K, 0, 0, 7); hx.fill();
      hx.restore();
    });
  }
  for (let i = 0; i < 1600 * K * K; i++) {
    const px = srnd() * S, py = srnd() * S, r = sr(0.6, 2) * K, v = si(100, 150);
    x.fillStyle = rgba(v, v - 6, v - 20, 0.6); x.beginPath(); x.arc(px, py, r, 0, 7); x.fill();
  }
  grain(x, S, S, 0.04);
  return { map: tex(c), normal: tex(heightToNormal(h, 1.8), 1, 1, false) };
}

/* ---------- Перекопанная земля: брустверы, воронки, минное поле ---------- */
export function dugEarth() {
  const S = TS(512), K = S / 512;
  const [c, x] = cv(S), [h, hx] = cv(S);
  x.fillStyle = '#4e3a28'; x.fillRect(0, 0, S, S);
  hx.fillStyle = '#808080'; hx.fillRect(0, 0, S, S);
  // комья глины
  for (let i = 0; i < 1800 * K * K; i++) {
    const px = srnd() * S, py = srnd() * S, r = sr(2, 12) * K;
    const v = si(56, 118), clay = srnd() < 0.3;
    const col = clay ? [v * 1.2, v * 0.86, v * 0.55] : [v, v * 0.78, v * 0.56];
    wrapDraw(x, S, S, () => {
      x.fillStyle = rgba(col[0], col[1], col[2], sr(0.5, 0.95));
      x.beginPath(); x.ellipse(px, py, r, r * sr(0.6, 1), sr(0, 3), 0, 7); x.fill();
    });
    const hv = si(120, 250);
    wrapDraw(hx, S, S, () => blob(hx, px, py, r * 1.2, [hv, hv, hv], 0.8));
  }
  // срезы лопаты
  for (let i = 0; i < 60 * K; i++) {
    const px = srnd() * S, py = srnd() * S, a = sr(-0.4, 0.4);
    wrapDraw(hx, S, S, () => {
      hx.save(); hx.translate(px, py); hx.rotate(a);
      hx.fillStyle = 'rgba(40,40,40,.5)'; hx.fillRect(-14 * K, -2 * K, 28 * K, 4 * K);
      hx.restore();
    });
  }
  grain(x, S, S, 0.06);
  return { map: tex(c), normal: tex(heightToNormal(h, 2.4), 1, 1, false) };
}

/* ---------- Кора ---------- */
export function bark(kind = 'spruce') {
  const W = TS(256), H = TS(512), K = W / 256;
  const [c, x] = cv(W, H), [h, hx] = cv(W, H);
  const base = kind === 'pine' ? [96, 70, 52] : [78, 68, 58];
  x.fillStyle = rgba(...base); x.fillRect(0, 0, W, H);
  hx.fillStyle = '#707070'; hx.fillRect(0, 0, W, H);
  const plates = kind === 'pine' ? 180 : 360;
  for (let i = 0; i < plates * K; i++) {
    const px = srnd() * W, py = srnd() * H;
    const w = (kind === 'pine' ? sr(14, 34) : sr(6, 16)) * K, hh = (kind === 'pine' ? sr(26, 80) : sr(8, 22)) * K;
    const v = sr(0.7, 1.25);
    wrapDraw(x, W, H, () => {
      x.save(); x.translate(px, py); x.rotate(sr(-0.1, 0.1));
      x.fillStyle = rgba(base[0] * v, base[1] * v, base[2] * v, sr(0.5, 0.95));
      x.beginPath(); x.roundRect(-w / 2, -hh / 2, w, hh, 3 * K); x.fill();
      x.restore();
    });
    wrapDraw(hx, W, H, () => {
      hx.save(); hx.translate(px, py); hx.rotate(sr(-0.1, 0.1));
      const hv = si(150, 230);
      hx.fillStyle = rgba(hv, hv, hv, 0.9); hx.beginPath(); hx.roundRect(-w / 2, -hh / 2, w, hh, 3 * K); hx.fill();
      hx.strokeStyle = 'rgba(10,10,10,.9)'; hx.lineWidth = (kind === 'pine' ? 3 : 1.6) * K; hx.stroke();
      hx.restore();
    });
  }
  // лишайник пятнами
  for (let i = 0; i < 40 * K; i++) {
    const px = srnd() * W, py = srnd() * H;
    wrapDraw(x, W, H, () => blob(x, px, py, sr(6, 22) * K, [110, 122, 96], sr(0.2, 0.45)));
  }
  grain(x, W, H, 0.06);
  return { map: tex(c), normal: tex(heightToNormal(h, 3.0), 1, 1, false) };
}
export function birchBark() {
  const W = TS(256), H = TS(512), K = W / 256;
  const [c, x] = cv(W, H), [h, hx] = cv(W, H);
  x.fillStyle = '#d8d4c8'; x.fillRect(0, 0, W, H);
  hx.fillStyle = '#909090'; hx.fillRect(0, 0, W, H);
  for (let i = 0; i < 160 * K; i++) {
    const px = srnd() * W, py = srnd() * H, w = sr(10, 60) * K, hh = sr(1.5, 5) * K;
    wrapDraw(x, W, H, () => {
      x.fillStyle = rgba(si(20, 50), si(20, 44), si(18, 36), sr(0.6, 0.95));
      x.beginPath(); x.ellipse(px, py, w / 2, hh, 0, 0, 7); x.fill();
    });
    wrapDraw(hx, W, H, () => { hx.fillStyle = 'rgba(40,40,40,.8)'; hx.beginPath(); hx.ellipse(px, py, w / 2, hh, 0, 0, 7); hx.fill(); });
  }
  for (let i = 0; i < 90 * K; i++) {
    const px = srnd() * W, py = srnd() * H;
    wrapDraw(x, W, H, () => blob(x, px, py, sr(8, 30) * K, [150, 140, 120], 0.25));
  }
  grain(x, W, H, 0.05);
  return { map: tex(c), normal: tex(heightToNormal(h, 1.6), 1, 1, false) };
}

/* ---------- Хвоя и листва: атласы карточек ---------- */
/** Еловая лапа: центральный побег, боковые веточки, плотная короткая хвоя.
    Рисуется слева направо: левый край карточки — у ствола. */
function spruceBranch(x, W, H, hue) {
  const cy = H * 0.5;
  const K = W / 256;
  const stem = (x0, y0, x1, y1, lw, depth) => {
    const col = rgba(hue[0] * 0.55, hue[1] * 0.5, hue[2] * 0.45, 1);
    x.strokeStyle = col; x.lineWidth = lw;
    x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke();
    const L = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    const n = Math.floor(L / ((depth ? 0.8 : 1.1) * K));
    for (let i = 0; i < n; i++) {
      const t = i / n, px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      const len = (depth ? 10 : 13) * (1 - t * 0.45) * K;
      for (const s of [-1, 1]) {
        const a = Math.atan2(uy, ux) + s * sr(0.7, 1.35);
        const v = sr(0.75, 1.2);
        x.strokeStyle = rgba(hue[0] * v, hue[1] * v, hue[2] * v, 1);
        x.lineWidth = sr(1.3, 2.2) * K;
        x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); x.stroke();
      }
    }
  };
  // главный побег
  const x0 = W * 0.02, x1 = W * 0.97;
  stem(x0, cy, x1, cy + sr(-3, 3), 2.6 * K, 0);
  // боковые веточки
  for (let i = 0; i < 13; i++) {
    const t = 0.06 + i * 0.07, px = x0 + (x1 - x0) * t;
    for (const s of [-1, 1]) {
      const L = Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.6 + 0.3) * (1 - t * 0.7) * H * 0.4 + H * 0.05;
      const a = s * sr(0.45, 0.8);
      stem(px, cy, px + Math.cos(a) * L, cy + Math.sin(a) * L, 1.5 * K, 1);
    }
  }
}
export function spruceAtlas() {
  // 2×2 варианта: разный тон, чтобы соседние лапы не повторялись
  const S = TS(512), [c, x] = cv(S);
  const hues = [[46, 74, 40], [40, 66, 42], [54, 80, 44], [38, 60, 36]];
  for (let q = 0; q < 4; q++) {
    x.save(); x.translate((q % 2) * S / 2, Math.floor(q / 2) * S / 2);
    x.beginPath(); x.rect(0, 0, S / 2, S / 2); x.clip();
    x.lineCap = 'round';
    spruceBranch(x, S / 2, S / 2, hues[q]);
    x.restore();
  }
  sharpenAlpha(c, 0.4); bleedColor(c, 3);
  return tex(c, 1, 1);
}
/** Сосновые пучки: длинные иглы веером из концов веточек. */
export function pineAtlas() {
  const S = TS(512), [c, x] = cv(S), K = S / 512;
  const hues = [[50, 74, 44], [46, 68, 44], [58, 80, 46], [44, 64, 40]];
  x.lineCap = 'round';
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * S / 2, oy = Math.floor(q / 2) * S / 2, W = S / 2;
    x.save(); x.translate(ox, oy); x.beginPath(); x.rect(0, 0, W, W); x.clip();
    const hue = hues[q];
    // редкие «звёзды» из длинных игл: сосна просвечивает, в отличие от ели
    for (let t = 0; t < 15; t++) {
      const cx = sr(0.2, 0.8) * W, cy2 = sr(0.16, 0.7) * W;
      // веточка к пучку
      x.strokeStyle = 'rgba(92,62,40,1)'; x.lineWidth = 2.2 * K;
      x.beginPath(); x.moveTo(W * 0.5, W * 0.95); x.quadraticCurveTo(W * 0.5, cy2 + 30 * K, cx, cy2); x.stroke();
      for (let i = 0; i < 64; i++) {
        // иглы растут вверх и в стороны, вниз — редко
        const a = -Math.PI / 2 + sr(-1.9, 1.9) * (srnd() < 0.8 ? 1 : 1.6), L = sr(22, 46) * K, v = sr(0.7, 1.3);
        x.strokeStyle = rgba(hue[0] * v, hue[1] * v, hue[2] * v, 1); x.lineWidth = sr(1.1, 1.8) * K;
        x.beginPath(); x.moveTo(cx, cy2); x.quadraticCurveTo(cx + Math.cos(a) * L * 0.5, cy2 + Math.sin(a) * L * 0.5 - 3 * K, cx + Math.cos(a) * L, cy2 + Math.sin(a) * L * 0.85); x.stroke();
      }
    }
    x.restore();
  }
  sharpenAlpha(c, 0.4); bleedColor(c, 3);
  return tex(c);
}
/** Листва берёзы: мелкие листочки-сердечки россыпью. */
export function birchAtlas() {
  const S = TS(512), [c, x] = cv(S), K = S / 512;
  const hues = [[96, 128, 52], [110, 140, 56], [88, 118, 50], [120, 138, 60]];
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * S / 2, oy = Math.floor(q / 2) * S / 2, W = S / 2;
    x.save(); x.translate(ox, oy); x.beginPath(); x.rect(0, 0, W, W); x.clip();
    for (let i = 0; i < 420; i++) {
      const a = sr(0, TAU), r = Math.sqrt(srnd()) * W * 0.44;
      const px = W / 2 + Math.cos(a) * r, py = W / 2 + Math.sin(a) * r * 0.9;
      const v = sr(0.7, 1.25), s = sr(5, 9) * K;
      x.save(); x.translate(px, py); x.rotate(sr(0, TAU));
      x.fillStyle = rgba(hues[q][0] * v, hues[q][1] * v, hues[q][2] * v, 1);
      x.beginPath(); x.moveTo(0, -s); x.quadraticCurveTo(s * 0.9, 0, 0, s); x.quadraticCurveTo(-s * 0.9, 0, 0, -s); x.fill();
      x.restore();
    }
    x.restore();
  }
  sharpenAlpha(c, 0.45); bleedColor(c, 3);
  return tex(c);
}
/** Пучок лесной травы: узкие стебли разной высоты. */
export function grassTex() {
  const W = TS(128), H = TS(256), [c, x] = cv(W, H);
  for (let k = 0; k < 9; k++) {
    const bx = W * sr(0.08, 0.92), bw = W * sr(0.025, 0.05), bh = H * sr(0.45, 0.98);
    const lean = sr(-0.25, 0.25) * W;
    const g = x.createLinearGradient(0, H, 0, H - bh);
    const dry = srnd() < 0.25;
    const top = dry ? [150, 138, 88] : [si(96, 124), si(110, 136), si(58, 74)];
    g.addColorStop(0, 'rgb(46,52,30)'); g.addColorStop(0.6, rgba(top[0] * 0.8, top[1] * 0.8, top[2] * 0.8));
    g.addColorStop(1, rgba(...top));
    x.fillStyle = g;
    x.beginPath(); x.moveTo(bx - bw, H);
    x.quadraticCurveTo(bx - bw * 0.3, H - bh * 0.6, bx + lean, H - bh);
    x.quadraticCurveTo(bx + bw * 0.4, H - bh * 0.55, bx + bw, H); x.closePath(); x.fill();
  }
  sharpenAlpha(c, 0.5); bleedColor(c, 2);
  return tex(c, 1, 1);
}
/** Папоротник: вайя с перистыми сегментами, вид сверху-сбоку. */
export function fernTex() {
  const S = TS(256), [c, x] = cv(S), K = S / 256;
  x.lineCap = 'round';
  const cx = S * 0.5, base = S * 0.98;
  x.strokeStyle = 'rgb(60,78,36)'; x.lineWidth = 2.4 * K;
  x.beginPath(); x.moveTo(cx, base); x.quadraticCurveTo(cx + 8 * K, S * 0.5, cx - 4 * K, S * 0.04); x.stroke();
  for (let i = 0; i < 26; i++) {
    const t = i / 26, py = base - (base - S * 0.05) * t, px = cx + Math.sin(t * 3) * 4 * K;
    const L = Math.sin(Math.min(1, t * 1.3) * Math.PI * 0.9) * S * 0.36 + 4 * K;
    for (const s of [-1, 1]) {
      const v = sr(0.8, 1.2);
      x.fillStyle = rgba(70 * v, 104 * v, 42 * v, 1);
      x.beginPath(); x.moveTo(px, py);
      x.quadraticCurveTo(px + s * L * 0.5, py - L * 0.28, px + s * L, py - L * 0.12);
      x.quadraticCurveTo(px + s * L * 0.5, py + 3 * K, px, py + 3 * K); x.fill();
    }
  }
  sharpenAlpha(c, 0.4); bleedColor(c, 2);
  return tex(c);
}
/** Кустики черники и брусники: низкая плотная зелень. */
export function shrubTex() {
  const S = TS(256), [c, x] = cv(S), K = S / 256;
  for (let i = 0; i < 360; i++) {
    const t = srnd(), px = S * 0.5 + (srnd() - 0.5) * S * 0.9 * (0.4 + t * 0.6), py = S - t * S * 0.8 - 6 * K;
    const v = sr(0.7, 1.2), s = sr(4, 8) * K;
    x.fillStyle = rgba(52 * v, 84 * v, 38 * v, 1);
    x.beginPath(); x.ellipse(px, py, s, s * 0.62, sr(0, 3), 0, 7); x.fill();
    if (srnd() < 0.05) { x.fillStyle = srnd() < 0.5 ? '#2b2e52' : '#8a2622'; x.beginPath(); x.arc(px, py, 2.4 * K, 0, 7); x.fill(); }
  }
  x.strokeStyle = 'rgba(70,50,34,1)'; x.lineWidth = 1.4 * K;
  for (let i = 0; i < 12; i++) { const px = S * sr(0.2, 0.8); x.beginPath(); x.moveTo(S / 2, S); x.lineTo(px, S * sr(0.3, 0.6)); x.stroke(); }
  sharpenAlpha(c, 0.45); bleedColor(c, 2);
  return tex(c);
}
/** Камыш: длинные узкие листья, стебли с рогозом. */
export function reedTex() {
  const W = TS(256), H = TS(512), [c, x] = cv(W, H), K = W / 256;
  x.lineCap = 'round';
  for (let k = 0; k < 16; k++) {
    const bx = W * sr(0.1, 0.9), bh = H * sr(0.55, 0.98), lean = sr(-0.3, 0.3) * W * 0.4;
    const v = sr(0.75, 1.2), dry = srnd() < 0.35;
    const col = dry ? [140 * v, 124 * v, 76 * v] : [86 * v, 108 * v, 54 * v];
    x.strokeStyle = rgba(...col); x.lineWidth = sr(2.5, 5) * K;
    x.beginPath(); x.moveTo(bx, H); x.quadraticCurveTo(bx + lean * 0.2, H - bh * 0.6, bx + lean, H - bh); x.stroke();
  }
  // рогоз: коричневые початки на прямых стеблях
  for (let k = 0; k < 4; k++) {
    const bx = W * sr(0.2, 0.8), top = H * sr(0.04, 0.2);
    x.strokeStyle = 'rgb(96,104,58)'; x.lineWidth = 2 * K;
    x.beginPath(); x.moveTo(bx, H); x.lineTo(bx + sr(-4, 4) * K, top); x.stroke();
    x.fillStyle = rgba(si(74, 96), si(48, 60), si(30, 38));
    x.beginPath(); x.roundRect(bx - 5 * K, top + 10 * K, 10 * K, 46 * K, 5 * K); x.fill();
  }
  sharpenAlpha(c, 0.45); bleedColor(c, 2);
  return tex(c);
}

/* ---------- Дерево, брёвна, металл ---------- */
/** Серые выветренные доски. Волокна вдоль U. */
export function planks(tint = [118, 108, 94], boards = 6) {
  const S = TS(512), [c, x] = cv(S), [h, hx] = cv(S), K = S / 512;
  x.fillStyle = rgba(...tint); x.fillRect(0, 0, S, S);
  hx.fillStyle = '#b0b0b0'; hx.fillRect(0, 0, S, S);
  const bh = S / boards;
  for (let b = 0; b < boards; b++) {
    const v = sr(0.78, 1.18), y0 = b * bh;
    x.fillStyle = rgba(tint[0] * v, tint[1] * v, tint[2] * v); x.fillRect(0, y0, S, bh);
    for (let i = 0; i < 70; i++) {
      const yy = y0 + srnd() * bh, w = sr(0.5, 1.6) * K, d = sr(0.6, 0.9);
      x.fillStyle = rgba(tint[0] * v * d, tint[1] * v * d, tint[2] * v * d, sr(0.3, 0.7));
      x.fillRect(0, yy, S, w);
      hx.fillStyle = `rgba(90,90,90,${sr(0.2, 0.5)})`; hx.fillRect(0, yy, S, w);
    }
    // сучки
    for (let i = 0; i < 2; i++) {
      const px = srnd() * S, py = y0 + sr(0.3, 0.7) * bh;
      blob(x, px, py, sr(4, 9) * K, [60, 44, 32], 0.8); blob(hx, px, py, 8 * K, [40, 40, 40], 0.6);
    }
    // щель между досками
    x.fillStyle = 'rgba(20,16,12,.9)'; x.fillRect(0, y0, S, 2.5 * K);
    hx.fillStyle = 'rgba(0,0,0,1)'; hx.fillRect(0, y0, S, 3 * K);
    // гвозди с ржавыми потёками
    for (const px of [S * 0.08, S * 0.58]) {
      x.fillStyle = 'rgb(60,40,28)'; x.beginPath(); x.arc(px, y0 + bh * 0.5, 2.5 * K, 0, 7); x.fill();
      const g = x.createLinearGradient(0, y0 + bh * 0.5, 0, y0 + bh);
      g.addColorStop(0, 'rgba(110,56,28,.5)'); g.addColorStop(1, 'rgba(110,56,28,0)');
      x.fillStyle = g; x.fillRect(px - 2 * K, y0 + bh * 0.5, 4 * K, bh * 0.5);
    }
  }
  // плесень и мох в нижней части
  for (let i = 0; i < 60; i++) blob(x, srnd() * S, srnd() * S, sr(10, 50) * K, [70, 80, 52], sr(0.08, 0.2));
  grain(x, S, S, 0.05);
  return { map: tex(c), normal: tex(heightToNormal(h, 2.0), 1, 1, false) };
}
/** Бревенчатая стена сруба: горизонтальные брёвна с тёмными пазами. */
export function logWall() {
  const S = TS(512), [c, x] = cv(S), [h, hx] = cv(S), K = S / 512;
  const logs = 4, lh = S / logs;
  for (let i = 0; i < logs; i++) {
    const y0 = i * lh, v = sr(0.8, 1.12);
    const g = x.createLinearGradient(0, y0, 0, y0 + lh);
    g.addColorStop(0, rgba(52 * v, 42 * v, 32 * v)); g.addColorStop(0.3, rgba(108 * v, 92 * v, 72 * v));
    g.addColorStop(0.7, rgba(96 * v, 80 * v, 62 * v)); g.addColorStop(1, rgba(40 * v, 32 * v, 24 * v));
    x.fillStyle = g; x.fillRect(0, y0, S, lh);
    const hg = hx.createLinearGradient(0, y0, 0, y0 + lh);
    hg.addColorStop(0, '#202020'); hg.addColorStop(0.5, '#e0e0e0'); hg.addColorStop(1, '#202020');
    hx.fillStyle = hg; hx.fillRect(0, y0, S, lh);
    // трещины вдоль бревна
    for (let k = 0; k < 14; k++) {
      const yy = y0 + lh * sr(0.25, 0.75), x0 = srnd() * S, L = sr(40, 200) * K;
      x.strokeStyle = 'rgba(30,22,16,.7)'; x.lineWidth = sr(0.8, 2) * K;
      x.beginPath(); x.moveTo(x0, yy); x.lineTo(x0 + L, yy + sr(-3, 3)); x.stroke();
      hx.strokeStyle = 'rgba(60,60,60,.9)'; hx.lineWidth = x.lineWidth;
      hx.beginPath(); hx.moveTo(x0, yy); hx.lineTo(x0 + L, yy); hx.stroke();
    }
    // мох-конопатка в пазу
    for (let k = 0; k < 30; k++) blob(x, srnd() * S, y0 + sr(-3, 3) * K, sr(3, 8) * K, [88, 90, 60], 0.7);
  }
  grain(x, S, S, 0.05);
  return { map: tex(c), normal: tex(heightToNormal(h, 2.2), 1, 1, false) };
}
/** Ржавый металл с остатками краски. paint — исходный цвет машины или бочки. */
export function rustMetal(paint = [72, 96, 110], rust = 0.6, size = 512) {
  const S = TS(size), [c, x] = cv(S), [h, hx] = cv(S), K = S / 512;
  x.fillStyle = rgba(...paint); x.fillRect(0, 0, S, S);
  hx.fillStyle = '#a0a0a0'; hx.fillRect(0, 0, S, S);
  // выгоревшая краска
  for (let i = 0; i < 80; i++) blob(x, srnd() * S, srnd() * S, sr(20, 90) * K, [paint[0] * 1.25, paint[1] * 1.2, paint[2] * 1.15], 0.25);
  // ржавые очаги: тёмное ядро, рыжий ореол, облупленный край
  for (let i = 0; i < 200 * rust; i++) {
    const px = srnd() * S, py = srnd() * S, r = sr(6, 70) * K * (0.5 + rust);
    wrapDraw(x, S, S, () => {
      blob(x, px, py, r * 1.4, [128, 70, 34], 0.55);
      blob(x, px, py, r, [88, 44, 22], 0.8);
      blob(x, px, py, r * 0.5, [52, 30, 18], 0.85);
    });
    wrapDraw(hx, S, S, () => blob(hx, px, py, r, [60, 60, 60], 0.6));
  }
  // потёки вниз
  for (let i = 0; i < 90 * rust; i++) {
    const px = srnd() * S, py = srnd() * S, L = sr(30, 160) * K, w = sr(2, 7) * K;
    const g = x.createLinearGradient(0, py, 0, py + L);
    g.addColorStop(0, 'rgba(120,58,26,.65)'); g.addColorStop(1, 'rgba(120,58,26,0)');
    x.fillStyle = g; x.fillRect(px, py, w, L);
  }
  for (let i = 0; i < 3000 * K * K; i++) {
    const px = srnd() * S, py = srnd() * S;
    x.fillStyle = rgba(si(60, 140), si(34, 66), si(16, 30), sr(0.2, 0.6)); x.fillRect(px, py, K * 1.5, K * 1.5);
    hx.fillStyle = 'rgba(200,200,200,.5)'; hx.fillRect(px, py, K * 1.5, K * 1.5);
  }
  grain(x, S, S, 0.06);
  return { map: tex(c), normal: tex(heightToNormal(h, 1.8), 1, 1, false) };
}
/** Профнастил с рёбрами — кровля и заборы. */
export function corrugated(paint = [96, 98, 92], rust = 0.8) {
  const r = rustMetal(paint, rust, 512);
  const S = r.map.image.width, [h, hx] = cv(S), ribs = 10;
  for (let i = 0; i < S; i++) {
    const v = 128 + Math.sin(i / S * ribs * TAU) * 110;
    hx.fillStyle = rgba(v, v, v); hx.fillRect(i, 0, 1, S);
  }
  const nrm = tex(heightToNormal(h, 4.0), 1, 1, false);
  return { map: r.map, normal: nrm };
}
/** Мешковина мешков с песком. */
export function sackcloth() {
  const S = TS(256), [c, x] = cv(S), [h, hx] = cv(S), K = S / 256;
  x.fillStyle = '#77694c'; x.fillRect(0, 0, S, S);
  hx.fillStyle = '#808080'; hx.fillRect(0, 0, S, S);
  for (let i = 0; i < S; i += 3 * K) {
    x.fillStyle = 'rgba(40,32,20,.18)'; x.fillRect(i, 0, K, S); x.fillRect(0, i, S, K);
    hx.fillStyle = 'rgba(40,40,40,.4)'; hx.fillRect(i, 0, K, S); hx.fillRect(0, i, S, K);
  }
  for (let i = 0; i < 40; i++) blob(x, srnd() * S, srnd() * S, sr(10, 50) * K, [60, 48, 32], 0.3);
  grain(x, S, S, 0.07);
  return { map: tex(c), normal: tex(heightToNormal(h, 1.5), 1, 1, false) };
}
/** Маскировочная сеть: рваные лоскуты на сетке, с прозрачностью. */
export function camoNet() {
  const S = TS(512), [c, x] = cv(S), K = S / 512;
  const cols = [[62, 72, 46], [84, 86, 58], [48, 54, 38], [98, 88, 62]];
  x.strokeStyle = 'rgba(40,42,30,1)'; x.lineWidth = 1.5 * K;
  for (let i = 0; i < S; i += 16 * K) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i + S * 0.1, S); x.stroke();
    x.beginPath(); x.moveTo(0, i); x.lineTo(S, i + S * 0.1); x.stroke();
  }
  for (let i = 0; i < 900 * K * K; i++) {
    const px = srnd() * S, py = srnd() * S, s = sr(5, 14) * K, col = cols[si(0, 3)];
    wrapDraw(x, S, S, () => {
      x.save(); x.translate(px, py); x.rotate(sr(0, TAU));
      x.fillStyle = rgba(...col);
      x.beginPath(); x.moveTo(-s, 0); x.lineTo(0, -s * 0.6); x.lineTo(s, 0); x.lineTo(s * 0.2, s * 0.7); x.closePath(); x.fill();
      x.restore();
    });
  }
  sharpenAlpha(c, 0.5); bleedColor(c, 2);
  return tex(c, 3, 3);
}

/* ---------- Знаки, надписи, эмблемы ---------- */
/** Знак «Мины»: красный треугольник с черепом, облезлая краска, пулевые пробоины. */
export function mineSign(variant = 0) {
  const W = 256, H = 256, [c, x] = cv(W, H);
  x.fillStyle = '#b8b0a0'; x.fillRect(0, 0, W, H);
  if (variant === 0) {
    x.fillStyle = '#9c1b14';
    x.beginPath(); x.moveTo(W / 2, 16); x.lineTo(W - 12, H - 30); x.lineTo(12, H - 30); x.closePath(); x.fill();
    x.fillStyle = '#ece6d6';
    x.beginPath(); x.moveTo(W / 2, 46); x.lineTo(W - 40, H - 46); x.lineTo(40, H - 46); x.closePath(); x.fill();
    // череп
    x.fillStyle = '#141414';
    x.beginPath(); x.arc(W / 2, 120, 30, 0, 7); x.fill();
    x.fillRect(W / 2 - 18, 138, 36, 26);
    x.fillStyle = '#ece6d6';
    x.beginPath(); x.arc(W / 2 - 12, 118, 8, 0, 7); x.arc(W / 2 + 12, 118, 8, 0, 7); x.fill();
    for (let i = -1; i <= 1; i++) x.fillRect(W / 2 + i * 10 - 2, 152, 4, 12);
    x.font = 'bold 34px Arial, sans-serif'; x.textAlign = 'center'; x.fillStyle = '#141414';
    x.fillText('МИНЫ', W / 2, H - 50);
    x.fillStyle = '#9c1b14'; x.font = 'bold 22px Arial, sans-serif'; x.fillText('MINES', W / 2, H - 8);
  } else {
    x.fillStyle = '#9c1b14'; x.fillRect(8, 8, W - 16, H - 16);
    x.fillStyle = '#ece6d6'; x.textAlign = 'center';
    x.font = 'bold 40px Arial, sans-serif'; x.fillText('СТОЙ!', W / 2, 70);
    x.font = 'bold 44px Arial, sans-serif'; x.fillText('МИНЫ', W / 2, 136);
    x.font = 'bold 24px Arial, sans-serif'; x.fillText('ПРОХОД', W / 2, 186); x.fillText('ЗАПРЕЩЁН', W / 2, 216);
  }
  // облезлость, ржавчина и пробоины
  for (let i = 0; i < 70; i++) blob(x, srnd() * W, srnd() * H, sr(3, 16), [120, 70, 40], sr(0.2, 0.6));
  for (let i = 0; i < si(2, 6); i++) {
    const px = sr(20, W - 20), py = sr(20, H - 20);
    blob(x, px, py, 9, [60, 40, 26], 0.9); x.fillStyle = '#050505'; x.beginPath(); x.arc(px, py, 3.2, 0, 7); x.fill();
  }
  grain(x, W, H, 0.08);
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}
/** Табличка турбазы и указатели. */
export function boardSign(lines, bg = '#2f4a3a', fg = '#e2dcc6', w = 512, h = 256) {
  const [c, x] = cv(w, h);
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  x.strokeStyle = fg; x.lineWidth = 6; x.strokeRect(14, 14, w - 28, h - 28);
  x.fillStyle = fg; x.textAlign = 'center';
  const n = lines.length;
  lines.forEach((ln, i) => {
    x.font = `bold ${i === 0 ? 54 : 34}px Arial, sans-serif`;
    x.fillText(ln, w / 2, h / 2 + (i - (n - 1) / 2) * 62 + 16);
  });
  for (let i = 0; i < 120; i++) blob(x, srnd() * w, srnd() * h, sr(4, 26), [90, 80, 64], sr(0.15, 0.5));
  grain(x, w, h, 0.08);
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}
/** Полотнище флага команды: поле, эмблема, название. Ткань потрёпана и выгорела. */
export function teamFlag(team) {
  const W = TS(1024), H = W * 0.64, [c, x] = cv(W, H), K = W / 1024;
  const A = team === 'A';
  const field = A ? ['#1f3f63', '#2c5680'] : ['#6e2419', '#94361f'];
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, field[0]); g.addColorStop(1, field[1]);
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // полосы у древка
  x.fillStyle = 'rgba(230,226,210,.9)'; x.fillRect(0, 0, 38 * K, H);
  x.fillStyle = field[0]; x.fillRect(46 * K, 0, 14 * K, H);
  const cx = W * 0.54, cy = H * 0.44;
  x.save(); x.translate(cx, cy);
  x.fillStyle = '#e8e2cc'; x.strokeStyle = '#e8e2cc'; x.lineWidth = 16 * K; x.lineJoin = 'round';
  if (A) {
    // щит с шевроном и литерой A
    x.beginPath(); x.moveTo(-150 * K, -170 * K); x.lineTo(150 * K, -170 * K); x.lineTo(150 * K, 20 * K);
    x.quadraticCurveTo(150 * K, 140 * K, 0, 200 * K); x.quadraticCurveTo(-150 * K, 140 * K, -150 * K, 20 * K); x.closePath(); x.stroke();
    x.font = `900 ${250 * K}px "Arial Black", Arial, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('A', 0, -10 * K);
    x.beginPath(); x.moveTo(-110 * K, 110 * K); x.lineTo(0, 60 * K); x.lineTo(110 * K, 110 * K); x.stroke();
  } else {
    // треугольник-дельта в круге
    x.beginPath(); x.arc(0, 10 * K, 190 * K, 0, 7); x.stroke();
    x.beginPath(); x.moveTo(0, -150 * K); x.lineTo(145 * K, 115 * K); x.lineTo(-145 * K, 115 * K); x.closePath();
    x.lineWidth = 26 * K; x.stroke();
    x.beginPath(); x.moveTo(0, -60 * K); x.lineTo(70 * K, 70 * K); x.lineTo(-70 * K, 70 * K); x.closePath(); x.fill();
  }
  x.restore();
  x.font = `900 ${96 * K}px "Arial Black", Arial, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  x.fillStyle = '#e8e2cc'; x.fillText(A ? 'ALPHA' : 'DELTA', cx, H - 44 * K);
  // выгорание, грязь, дыры по краю (дыры — прозрачные, флаг рисуется с alphaTest)
  for (let i = 0; i < 90; i++) blob(x, srnd() * W, srnd() * H, sr(20, 110) * K, [40, 36, 30], sr(0.05, 0.16));
  x.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const px = W - sr(0, 60) * K, py = srnd() * H;
    x.beginPath(); x.ellipse(px, py, sr(8, 40) * K, sr(4, 14) * K, sr(0, 3), 0, 7); x.fill();
  }
  for (let i = 0; i < 6; i++) { x.beginPath(); x.arc(sr(0.2, 0.9) * W, sr(0.1, 0.9) * H, sr(3, 7) * K, 0, 7); x.fill(); }
  x.globalCompositeOperation = 'source-over';
  grain(x, W, H, 0.06);
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}
/** Треугольный вымпел на колышке разметки зоны возрождения. */
export function pennant(team) {
  const [c, x] = cv(64, 64);
  x.fillStyle = team === 'A' ? '#2c5680' : '#94361f'; x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#e8e2cc'; x.font = 'bold 34px Arial'; x.textAlign = 'center'; x.fillText(team, 32, 45);
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}

/* ---------- Спрайты света и эффектов ---------- */
export function radial(stops, size = 128) {
  const [c, x] = cv(size);
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [p, col] of stops) g.addColorStop(p, col);
  x.fillStyle = g; x.fillRect(0, 0, size, size);
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}
/** Клуб дыма: несколько мягких пятен с шумом. */
export function smokeTex() {
  const S = 128, [c, x] = cv(S);
  for (let i = 0; i < 26; i++) {
    const a = sr(0, TAU), r = sr(0, 26);
    blob(x, 64 + Math.cos(a) * r, 64 + Math.sin(a) * r, sr(18, 40), [255, 255, 255], sr(0.12, 0.3));
  }
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}
/** Атлас огня 2×2: [0] огненный шар, [1], [2] языки пламени, [3] искра.
    Языки — капли, вытянутые вверх, с отростками; цвет от белого ядра к красной кайме. */
export function fireAtlas() {
  const S = 256, H = S / 2, [c, x] = cv(S);
  const cell = (i, fn) => { x.save(); x.translate((i % 2) * H, (i >> 1) * H); x.beginPath(); x.rect(0, 0, H, H); x.clip(); fn(); x.restore(); };
  const grad = (cx, cy, r) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,250,228,1)'); g.addColorStop(0.3, 'rgba(255,200,100,.92)');
    g.addColorStop(0.65, 'rgba(230,92,24,.45)'); g.addColorStop(1, 'rgba(130,24,0,0)');
    return g;
  };
  cell(0, () => { x.fillStyle = grad(64, 64, 60); x.fillRect(0, 0, H, H); });
  const tongue = (cx, base, w, h, lean) => {
    // капля: широкое основание, острый изогнутый кончик
    x.beginPath();
    x.moveTo(cx - w, base);
    x.bezierCurveTo(cx - w * 1.1, base - h * 0.45, cx + lean * 0.5 - w * 0.3, base - h * 0.75, cx + lean, base - h);
    x.bezierCurveTo(cx + lean * 0.5 + w * 0.4, base - h * 0.7, cx + w * 1.1, base - h * 0.4, cx + w, base);
    x.closePath(); x.fill();
  };
  for (const i of [1, 2]) cell(i, () => {
    x.filter = 'blur(5px)';
    const R = i === 1 ? [0.2, -0.3, 0.5] : [-0.4, 0.35, -0.1];
    x.fillStyle = grad(64, 100, 70);
    tongue(64, 118, 30, 96, R[0] * 20);
    x.fillStyle = grad(64, 104, 52);
    tongue(44, 116, 14, 66 + R[1] * 20, R[1] * 22);
    tongue(84, 116, 14, 62 - R[2] * 18, R[2] * 26);
    x.globalCompositeOperation = 'lighter';
    x.fillStyle = 'rgba(255,245,210,.55)';
    tongue(64, 116, 14, 46, R[0] * 8);
    x.globalCompositeOperation = 'source-over';
    x.filter = 'none';
  });
  cell(3, () => { const g = x.createRadialGradient(64, 64, 0, 64, 64, 24); g.addColorStop(0, 'rgba(255,255,240,1)'); g.addColorStop(0.4, 'rgba(255,210,140,.8)'); g.addColorStop(1, 'rgba(255,140,40,0)'); x.fillStyle = g; x.fillRect(0, 0, H, H); });
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}
/** Атлас дыма 2×2: четыре разных клуба. Сверху светлее, снизу темнее —
    клуб читается объёмом, а не плоским пятном. */
export function smokeAtlas() {
  const S = 256, H = S / 2, [c, x] = cv(S);
  for (let i = 0; i < 4; i++) {
    const ox = (i % 2) * H, oy = (i >> 1) * H;
    x.save(); x.beginPath(); x.rect(ox, oy, H, H); x.clip();
    for (let k = 0; k < 34; k++) {
      const a = sr(0, TAU), r = Math.sqrt(srnd()) * 30, px = 64 + Math.cos(a) * r, py = 64 + Math.sin(a) * r * 0.85;
      const light = clamp(0.62 + (64 - py) / 90 + (64 - px) / 260, 0.35, 1);
      const v = 150 + 105 * light;
      blob(x, ox + px, oy + py, sr(12, 30), [v, v, v * 0.98], sr(0.1, 0.24));
    }
    x.restore();
  }
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}
/** Воронка: выжженный центр, выброс грунта лучами. */
export function craterTex() {
  const S = 256, [c, x] = cv(S);
  blob(x, 128, 128, 120, [36, 28, 20], 0.85);
  blob(x, 128, 128, 60, [14, 12, 10], 0.95);
  for (let i = 0; i < 40; i++) {
    const a = sr(0, TAU), L = sr(50, 120);
    x.strokeStyle = rgba(70, 52, 36, sr(0.3, 0.7)); x.lineWidth = sr(3, 10);
    x.beginPath(); x.moveTo(128 + Math.cos(a) * 30, 128 + Math.sin(a) * 30); x.lineTo(128 + Math.cos(a) * L, 128 + Math.sin(a) * L); x.stroke();
  }
  x.globalCompositeOperation = 'destination-in';
  const g = x.createRadialGradient(128, 128, 40, 128, 128, 128);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}
/** Карта нормалей воды: сумма волн разных направлений, бесшовная. */
export function waterNormals() {
  const S = TS(512), [h, hx] = cv(S);
  const img = hx.createImageData(S, S), d = img.data;
  const waves = [];
  for (let i = 0; i < 18; i++) waves.push({ kx: si(-7, 7), ky: si(-7, 7), a: sr(0.3, 1), p: sr(0, TAU) });
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    for (const w of waves) v += Math.sin((w.kx * x + w.ky * y) / S * TAU + w.p) * w.a;
    const i = (y * S + x) * 4, g = clamp(128 + v * 12, 0, 255);
    d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255;
  }
  hx.putImageData(img, 0, 0);
  return tex(heightToNormal(h, 3.5), 1, 1, false);
}
/** Плетень: горизонтальные прутья, переплетённые через вертикальные колья. */
export function wattle() {
  const S = TS(256), [c, x] = cv(S), [h, hx] = cv(S), K = S / 256;
  x.fillStyle = '#2a2118'; x.fillRect(0, 0, S, S);
  hx.fillStyle = '#202020'; hx.fillRect(0, 0, S, S);
  const rod = 9 * K, stake = S / 4;
  for (let y = 0, r = 0; y < S; y += rod, r++) {
    for (let k = 0; k < 4; k++) {
      // прут то сверху кола, то снизу — перевязка шахматкой
      const front = (r + k) % 2 === 0, x0 = k * stake, v = sr(0.8, 1.15);
      const g = x.createLinearGradient(0, y, 0, y + rod);
      g.addColorStop(0, rgba(70 * v, 56 * v, 40 * v)); g.addColorStop(0.45, rgba(118 * v, 96 * v, 70 * v)); g.addColorStop(1, rgba(44 * v, 34 * v, 24 * v));
      x.fillStyle = g; x.fillRect(x0, y + 0.5 * K, stake, rod - 1 * K);
      const hg = hx.createLinearGradient(0, y, 0, y + rod);
      hg.addColorStop(0, '#404040'); hg.addColorStop(0.5, front ? '#f0f0f0' : '#b0b0b0'); hg.addColorStop(1, '#404040');
      hx.fillStyle = hg; hx.fillRect(x0, y + 0.5 * K, stake, rod - 1 * K);
    }
  }
  for (let k = 0; k < 4; k++) {
    x.fillStyle = 'rgba(30,22,16,.85)'; x.fillRect(k * stake - 3 * K, 0, 6 * K, S);
    hx.fillStyle = '#909090'; hx.fillRect(k * stake - 3 * K, 0, 6 * K, S);
  }
  grain(x, S, S, 0.08);
  return { map: tex(c), normal: tex(heightToNormal(h, 2.2), 1, 1, false) };
}
/** Вывеска лагеря: облупленная эмаль, ржавые потёки, выцветшие буквы. */
export function campSign(lines, o = {}) {
  const w = o.w ?? 1024, h = o.h ?? 256, [c, x] = cv(w, h);
  const bg = o.bg ?? '#b9302a', fg = o.fg ?? '#ece3c8';
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  // полосы старой краски
  for (let i = 0; i < 40; i++) { x.fillStyle = `rgba(${o.dark ? '20,20,18' : '255,240,210'},${sr(0.02, 0.07)})`; x.fillRect(0, srnd() * h, w, sr(2, 12)); }
  x.strokeStyle = fg; x.lineWidth = 8; x.strokeRect(18, 18, w - 36, h - 36);
  x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
  const n = lines.length;
  lines.forEach((ln, i) => {
    const sz = (o.sizes?.[i]) ?? (i === 0 ? h * 0.36 / Math.max(1, n * 0.7) : h * 0.2);
    x.font = `bold ${sz}px "Arial Narrow", Arial, sans-serif`;
    x.fillText(ln, w / 2, h / 2 + (i - (n - 1) / 2) * (h * 0.78 / n));
  });
  // облупилось до металла и ржавчины, потёки вниз
  for (let i = 0; i < 90; i++) blob(x, srnd() * w, srnd() * h, sr(4, 30), [110, 70, 40], sr(0.25, 0.8));
  for (let i = 0; i < 26; i++) {
    const px = srnd() * w, py = srnd() * h * 0.6, g = x.createLinearGradient(0, py, 0, py + sr(40, 160));
    g.addColorStop(0, 'rgba(90,50,24,.6)'); g.addColorStop(1, 'rgba(90,50,24,0)');
    x.fillStyle = g; x.fillRect(px, py, sr(3, 9), 160);
  }
  for (let i = 0; i < 40; i++) blob(x, srnd() * w, srnd() * h, sr(3, 14), [40, 36, 30], sr(0.3, 0.9));
  grain(x, w, h, 0.1);
  const t = tex(c); t.wrapS = t.wrapT = 1001; return t;
}
/** Голова волчонка для арки: простой силуэт, как на значках. */
export function wolfBadge() {
  const [c, x] = cv(256);
  x.fillStyle = '#d8cfb2'; x.beginPath(); x.arc(128, 128, 120, 0, 7); x.fill();
  x.fillStyle = '#9b2a22'; x.beginPath(); x.arc(128, 128, 104, 0, 7); x.fill();
  x.fillStyle = '#3a3530';
  x.beginPath(); x.moveTo(70, 70); x.lineTo(96, 118); x.lineTo(60, 128); x.closePath(); x.fill();
  x.beginPath(); x.moveTo(186, 70); x.lineTo(160, 118); x.lineTo(196, 128); x.closePath(); x.fill();
  x.beginPath(); x.moveTo(64, 120); x.quadraticCurveTo(128, 90, 192, 120); x.lineTo(150, 196); x.lineTo(128, 214); x.lineTo(106, 196); x.closePath(); x.fill();
  x.fillStyle = '#d8cfb2'; x.beginPath(); x.arc(106, 140, 7, 0, 7); x.arc(150, 140, 7, 0, 7); x.fill();
  for (let i = 0; i < 50; i++) blob(x, srnd() * 256, srnd() * 256, sr(3, 16), [100, 70, 44], sr(0.2, 0.7));
  grain(x, 256, 256, 0.1);
  return tex(c);
}
