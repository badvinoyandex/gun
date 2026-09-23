import * as THREE from 'three';
import { scene, camera, Q } from '../core/env.js';
import { WIND, windUniforms } from './wind.js';

/* ============================================================================
   ТКАНЬ: флаги команд, маскировочные сети, брезент.
   Верле + релаксация связей (структурные, сдвиговые, изгибные). Ветер давит
   по нормали к полотну — отсюда живые хлопки, а не «доска на ветру».
   Ударная волна взрыва тоже доходит до ткани.
============================================================================ */
export const CLOTHS = [];
const G = -9.8;

/** pinFn(i,j) → true для закреплённых узлов. place(u,v) → мировая позиция узла. */
export function makeCloth({ nx, ny, place, pinFn, material, drag = 0.985, wind = 1, stiff = 5, uvScale = [1, 1] }) {
  const geo = new THREE.PlaneGeometry(1, 1, nx - 1, ny - 1);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale[0], uv.getY(i) * uvScale[1]);
  const N = nx * ny;
  const P = new Float32Array(N * 3), O = new Float32Array(N * 3), pin = new Uint8Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, p = place(i / (nx - 1), j / (ny - 1));
    P[k * 3] = O[k * 3] = p.x; P[k * 3 + 1] = O[k * 3 + 1] = p.y; P[k * 3 + 2] = O[k * 3 + 2] = p.z;
    pin[k] = pinFn(i, j) ? 1 : 0;
  }
  const links = [];
  const L = (a, b) => links.push(a, b, Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (i + 1 < nx) L(k, k + 1);
    if (j + 1 < ny) L(k, k + nx);
    if (i + 1 < nx && j + 1 < ny) { L(k, k + nx + 1); L(k + 1, k + nx); }
    if (i + 2 < nx) L(k, k + 2);
    if (j + 2 < ny) L(k, k + 2 * nx);
  }
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
  scene.add(mesh);
  const pos = geo.attributes.position;
  for (let k = 0; k < N; k++) pos.setXYZ(k, P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
  geo.computeVertexNormals();
  const c = { mesh, geo, P, O, pin, links: new Float32Array(links), N, drag, wind, stiff, frame: 0,
    center: new THREE.Vector3(P[0], P[1], P[2]), phase: Math.random() * 10 };
  CLOTHS.push(c);
  return c;
}

const _bl = new THREE.Vector4();
export function stepCloth(dt, t) {
  if (!(dt > 1e-4)) return;
  const h = Math.min(dt, 1 / 40);
  const wx0 = WIND.dir.x * WIND.strength * 9, wz0 = WIND.dir.y * WIND.strength * 9;
  _bl.copy(windUniforms.uBlast.value);
  const blastStr = windUniforms.uBlastStr.value;
  for (const c of CLOTHS) {
    const d2 = c.center.distanceToSquared(camera.position);
    // дальние полотна считаются реже: с 150 м рябь не видна
    const every = d2 > 22500 ? 4 : d2 > 3600 ? 2 : 1;
    if ((c.frame++ % every) !== 0) continue;
    const step = h * every, s2 = step * step;
    const { P, O, pin, N } = c;
    const nrm = c.geo.attributes.normal.array;
    const turbT = t + c.phase;
    for (let k = 0; k < N; k++) {
      if (pin[k]) continue;
      const i3 = k * 3;
      const x = P[i3], y = P[i3 + 1], z = P[i3 + 2];
      const vx = (x - O[i3]) * c.drag, vy = (y - O[i3 + 1]) * c.drag, vz = (z - O[i3 + 2]) * c.drag;
      O[i3] = x; O[i3 + 1] = y; O[i3 + 2] = z;
      // порывистый ветер с вихрями вдоль полотна
      const tb = Math.sin(turbT * 3.1 + k * 0.23) * 0.45 + Math.sin(turbT * 7.7 + k * 0.61) * 0.25;
      let wx = wx0 * (1 + tb) * c.wind, wz = wz0 * (1 + tb) * c.wind, wy = tb * 1.6 * c.wind;
      // ударная волна
      if (blastStr > 0) {
        const bx = x - _bl.x, bz = z - _bl.z, bd = Math.hypot(bx, bz) + 0.01, tau = _bl.w - bd / 70;
        if (tau > 0 && tau < 1.5) {
          const push = Math.exp(-tau * 4) * blastStr * 60 * Math.exp(-bd / 20);
          wx += bx / bd * push; wz += bz / bd * push; wy += push * 0.3;
        }
      }
      // давление по нормали: чем ровнее полотно стоит к ветру, тем сильнее толкает
      const nxv = nrm[i3], nyv = nrm[i3 + 1], nzv = nrm[i3 + 2];
      const rel = (wx - vx / step) * nxv + (wy - vy / step) * nyv + (wz - vz / step) * nzv;
      const fx = nxv * rel * 1.4 + wx * 0.12, fy = nyv * rel * 1.4 + G, fz = nzv * rel * 1.4 + wz * 0.12;
      P[i3] = x + vx + fx * s2; P[i3 + 1] = y + vy + fy * s2; P[i3 + 2] = z + vz + fz * s2;
    }
    const Lk = c.links, n = Lk.length;
    for (let it = 0; it < c.stiff; it++) {
      for (let q = 0; q < n; q += 3) {
        const a = Lk[q] * 3, b = Lk[q + 1] * 3, rest = Lk[q + 2];
        const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const pa = pin[Lk[q]], pb = pin[Lk[q + 1]];
        if (pa && pb) continue;
        const diff = (d - rest) / d * (pa || pb ? 1 : 0.5);
        if (!pa) { P[a] += dx * diff; P[a + 1] += dy * diff; P[a + 2] += dz * diff; }
        if (!pb) { P[b] -= dx * diff; P[b + 1] -= dy * diff; P[b + 2] -= dz * diff; }
      }
    }
    const pos = c.geo.attributes.position;
    pos.array.set(P);
    pos.needsUpdate = true;
    c.geo.computeVertexNormals();
  }
}
/** Толчок по ткани (граната упала рядом, дрон пролетел над флагом). */
export function nudgeCloth(x, y, z, r, power) {
  for (const c of CLOTHS) {
    if (c.center.distanceTo({ x, y, z }) > r + 8) continue;
    for (let k = 0; k < c.N; k++) {
      if (c.pin[k]) continue;
      const i3 = k * 3, dx = c.P[i3] - x, dy = c.P[i3 + 1] - y, dz = c.P[i3 + 2] - z, d = Math.hypot(dx, dy, dz);
      if (d > r) continue;
      const f = (1 - d / r) * power;
      c.O[i3] -= dx / (d + 0.1) * f * 0.02; c.O[i3 + 1] -= dy / (d + 0.1) * f * 0.02; c.O[i3 + 2] -= dz / (d + 0.1) * f * 0.02;
    }
  }
}
export const clothQuality = () => Q.cloth;
