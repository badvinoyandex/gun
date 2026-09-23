import * as THREE from 'three';
import { clamp, srnd } from '../core/math.js';
import { Q, MAXA } from '../core/env.js';

/* Инструменты процедурных текстур. Каждая поверхность отдаёт albedo и карту высот;
   нормали считаются из высот — без них земля и кора читаются как наклейка. */

export function cv(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })];
}
/** Размер карты с учётом пресета. */
export const TS = n => Math.max(64, Math.round(n * Q.tex / 64) * 64);

/** Рисование с обёрткой через край — тайл без шва. */
export function wrapDraw(x, w, h, fn) {
  for (const [ox, oy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    x.save(); x.translate(ox * w, oy * h); fn(); x.restore();
  }
}
export function grain(x, w, h, amt) {
  const img = x.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (srnd() - 0.5) * amt * 255;
    d[i] = clamp(d[i] + n, 0, 255); d[i + 1] = clamp(d[i + 1] + n, 0, 255); d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  x.putImageData(img, 0, 0);
}
export function heightToNormal(hc, strength = 2.0) {
  const w = hc.width, h = hc.height, [o, ox] = cv(w, h);
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = ox.createImageData(w, h), d = out.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
    const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1);
    const i = (y * w + x) * 4;
    d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  ox.putImageData(out, 0, 0);
  return o;
}
/** Жёсткая альфа: карточки листвы с alphaTest не мерцают и не дают ореолов. */
export function sharpenAlpha(c, cut = 0.45) {
  const x = c.getContext('2d');
  const img = x.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] / 255 < cut ? 0 : 255;
  x.putImageData(img, 0, 0);
  return c;
}
/** Заливка прозрачных пикселей цветом соседей: при мипмапах край листвы не светлеет. */
export function bleedColor(c, passes = 4) {
  const x = c.getContext('2d'), w = c.width, h = c.height;
  const img = x.getImageData(0, 0, w, h), d = img.data;
  for (let p = 0; p < passes; p++) {
    const src = new Uint8ClampedArray(d);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
      const i = (y * w + xx) * 4;
      if (src[i + 3] > 0 || d[i] + d[i + 1] + d[i + 2] > 0) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = xx + ox, Y = y + oy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = (Y * w + X) * 4;
        if (src[j] + src[j + 1] + src[j + 2] === 0) continue;
        r += src[j]; g += src[j + 1]; b += src[j + 2]; n++;
      }
      if (n) { d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n; }
    }
  }
  x.putImageData(img, 0, 0);
  return c;
}
export function tex(canvas, rx = 1, ry = 1, srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = Math.min(8, MAXA());
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
export const rgba = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

/** Круглое пятно с мягким краем. */
export function blob(x, px, py, r, col, a0 = 1) {
  const g = x.createRadialGradient(px, py, 0, px, py, r);
  g.addColorStop(0, rgba(col[0], col[1], col[2], a0));
  g.addColorStop(1, rgba(col[0], col[1], col[2], 0));
  x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill();
}
