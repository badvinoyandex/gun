import * as THREE from 'three';
import { clamp } from '../core/math.js';

/* ============================================================================
   ВЕТЕР И УДАРНАЯ ВОЛНА
   Один источник для травы, крон, камыша, флагов и частиц. Порывы — сумма
   синусов разной частоты, поэтому не читаются как цикл. Взрыв отправляет по
   растительности волну: она доходит с задержкой по расстоянию и затухает.
============================================================================ */
export const WIND = { dir: new THREE.Vector2(0.8, 0.6).normalize(), strength: 0.6, gust: 0.5, angle: 0.64, base: 0.6 };

export const windUniforms = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector2(0.8, 0.6) },
  uWindAmp: { value: 0.6 },
  uPlayer: { value: new THREE.Vector3(0, -999, 0) },
  uBlast: { value: new THREE.Vector4(0, -999, 0, 99) },
  uBlastStr: { value: 0 }
};

export function updateWind(t) {
  const g = 0.5 + 0.34 * Math.sin(t * 0.19) + 0.22 * Math.sin(t * 0.51 + 1.7) + 0.14 * Math.sin(t * 1.23 + 0.4);
  WIND.gust = clamp(g, 0, 1.4);
  WIND.strength = WIND.base * (0.45 + WIND.gust);
  WIND.angle = 0.64 + Math.sin(t * 0.06) * 0.28;
  WIND.dir.set(Math.cos(WIND.angle), Math.sin(WIND.angle));
  windUniforms.uTime.value = t;
  windUniforms.uWind.value.copy(WIND.dir);
  windUniforms.uWindAmp.value = WIND.strength;
}

const WIND_GLSL = /* glsl */`
uniform float uTime;
uniform vec2 uWind;
uniform float uWindAmp;
uniform vec3 uPlayer;
uniform vec4 uBlast;
uniform float uBlastStr;
`;

/** Врезка ветра в стандартный материал. Смещение считается в мировых
    координатах и переводится обратно в локальные: инстансы повёрнуты и
    масштабированы, а изгиб должен идти по ветру, а не по оси модели.
    amp — амплитуда (м) у вершины высотой refH; stiff — показатель изгиба;
    flutter — дрожь листвы; trample — приминание игроком. */
export function injectWind(mat, o = {}) {
  const amp = (o.amp ?? 0.3).toFixed(4), stiff = (o.stiff ?? 2.0).toFixed(3);
  const refH = (o.refH ?? 10).toFixed(3), flutter = (o.flutter ?? 0.02).toFixed(4);
  const blast = (o.blast ?? 1).toFixed(3);
  const trample = !!o.trample;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, windUniforms);
    sh.vertexShader = WIND_GLSL + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          mat4 mw = modelMatrix * instanceMatrix;
        #else
          mat4 mw = modelMatrix;
        #endif
        vec3 root = (mw * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 wp = (mw * vec4(transformed, 1.0)).xyz;
        float hh = max(wp.y - root.y, 0.0);
        float k = pow(hh / ${refH}, ${stiff});
        float ph = dot(root.xz, vec2(0.31, 0.27));
        float sway = sin(uTime * 1.05 + ph) * 0.55 + sin(uTime * 2.2 + ph * 1.7) * 0.25 + sin(uTime * 0.43 + ph * 0.5) * 0.35;
        vec3 disp = vec3(uWind.x, 0.0, uWind.y) * (0.55 + sway) * uWindAmp * ${amp} * k;
        float fl = ${flutter} * uWindAmp * min(k, 1.5);
        disp += vec3(sin(uTime * 6.1 + wp.x * 2.3 + wp.y * 1.3), sin(uTime * 5.3 + wp.z * 2.1) * 0.5,
                     cos(uTime * 6.7 + wp.z * 2.2 + wp.y * 1.1)) * fl;
        // ударная волна: фронт ~70 м/с, затухающее колебание после прохода
        vec2 bd = wp.xz - uBlast.xz;
        float bdist = length(bd);
        float tau = uBlast.w - bdist / 70.0;
        if (tau > 0.0 && tau < 2.5 && uBlastStr > 0.0) {
          float push = exp(-tau * 3.2) * sin(tau * 11.0 + 1.2) * uBlastStr * exp(-bdist / 24.0) * ${blast};
          disp.xz += (bdist > 0.01 ? bd / bdist : vec2(1.0, 0.0)) * push * min(k, 1.2);
          disp.y -= abs(push) * 0.2 * min(k, 1.0);
        }
        ${trample ? `
        vec2 pd = root.xz - uPlayer.xz;
        float pdist = length(pd);
        float press = (1.0 - smoothstep(0.2, 1.1, pdist)) * (1.0 - smoothstep(0.6, 1.8, abs(root.y - uPlayer.y)));
        if (press > 0.001) {
          disp.xz += (pdist > 0.001 ? pd / pdist : vec2(1.0, 0.0)) * press * hh * 0.7;
          disp.y -= press * hh * 0.55;
        }` : ''}
        transformed += inverse(mat3(mw)) * disp;
      }
    `);
  };
  const key = mat.customProgramCacheKey();
  mat.customProgramCacheKey = () => key + '|wind' + amp + stiff + refH + flutter + trample + blast;
  return mat;
}
