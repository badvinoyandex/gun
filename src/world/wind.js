import * as THREE from 'three';
import { clamp } from '../core/math.js';
import { FXU, FXU_GLSL } from '../core/fxu.js';

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
  const burn = !!o.burn;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, windUniforms);
    if (burn) {
      // гарь: растение оседает и чернеет, в огне — светится
      Object.assign(sh.uniforms, FXU);
      sh.fragmentShader = FXU_GLSL + 'varying vec2 vBurn;\n' + sh.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.03, 0.025), clamp(vBurn.x * 1.2, 0.0, 1.0));')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = totalEmissiveRadiance * (1.0 - vBurn.x) + vec3(1.0, 0.36, 0.06) * vBurn.y * (0.7 + 0.3 * sin(uFxT * 11.0 + vBurn.y * 20.0)) * 1.6;');
    }
    sh.vertexShader = WIND_GLSL + (burn ? FXU_GLSL + 'varying vec2 vBurn;\n' : '') + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          mat4 mw = modelMatrix * instanceMatrix;
        #else
          mat4 mw = modelMatrix;
        #endif
        vec3 root = (mw * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        ${burn ? `vec4 bm = burnAt(root.xz); vBurn = vec2(bm.a, bm.g); transformed.y *= 1.0 - bm.a * 0.88;` : ''}
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
  mat.customProgramCacheKey = () => key + '|wind' + amp + stiff + refH + flutter + trample + blast + burn;
  return mat;
}

/** Врезка для построек и реквизита: обугливание и тлеющие угли по карте uChar,
    лёгкая дрожь от ударной волны (дом «вздрагивает», когда проходит фронт). */
export function injectStructFX(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, windUniforms, FXU);
    sh.vertexShader = (sh.vertexShader.includes('uniform vec4 uBlast') ? '' : WIND_GLSL) + 'varying vec3 vSW;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec4 sw = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
        #else
          vec4 sw = modelMatrix * vec4(transformed, 1.0);
        #endif
        vSW = sw.xyz;
        vec2 bd = sw.xz - uBlast.xz; float bdist = length(bd);
        float tau = uBlast.w - bdist / 340.0;
        if (tau > 0.0 && tau < 0.8 && uBlastStr > 0.0) {
          float push = exp(-tau * 7.0) * sin(tau * 60.0) * uBlastStr * exp(-bdist / 9.0) * 0.035;
          vec3 d = vec3(bdist > 0.01 ? bd / bdist : vec2(1.0, 0.0), 0.0).xzy;
          #ifdef USE_INSTANCING
            transformed += inverse(mat3(modelMatrix * instanceMatrix)) * d * push;
          #else
            transformed += inverse(mat3(modelMatrix)) * d * push;
          #endif
        }
      }`);
    sh.fragmentShader = (sh.fragmentShader.includes('uniform sampler2D uBurn') ? 'varying vec3 vSW;\n' : FXU_GLSL + 'varying vec3 vSW;\n') + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec4 chS = charAt(vSW.xz);
        float chn = 0.5 + 0.5 * sin(vSW.x * 3.7 + vSW.z * 2.9 + vSW.y * 5.1) * sin(vSW.x * 1.3 - vSW.y * 2.2 + vSW.z * 4.4);
        float chK = smoothstep(0.02, 0.55, chS.r + (chn - 0.5) * 0.3 * chS.r);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.022, 0.02) * (0.6 + chn * 0.8), chK * 0.96);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // тлеющие трещины: тонкие прожилки по обугленному, мерцают
          float fl = 0.65 + 0.35 * sin(uFxT * 7.0 + vSW.x * 3.1 + vSW.z * 2.3);
          float cr = abs(sin(vSW.x * 6.3 + vSW.y * 9.1 + sin(vSW.z * 4.7) * 2.0) * sin(vSW.z * 5.9 - vSW.y * 7.7 + sin(vSW.x * 3.3) * 2.0));
          cr = smoothstep(0.975, 1.0, 1.0 - cr);
          float g = chS.g * chS.g * smoothstep(0.45, 0.95, chS.r);
          totalEmissiveRadiance += vec3(1.0, 0.3, 0.05) * g * (0.03 + cr * 0.55) * fl;
        }`);
  };
  const key = mat.customProgramCacheKey();
  mat.customProgramCacheKey = () => key + '|sfx';
  return mat;
}

