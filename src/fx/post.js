import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { renderer, scene, camera, Q, FRAME } from '../core/env.js';
import { lerp } from '../core/math.js';

/* Пост-обработка: блум (ночью сильнее — фонари «дышат» в тумане), цветокор
   с ночным сдвигом в холодное и потерей насыщенности, виньетка, зерно. */
const Grade = {
  uniforms: { tDiffuse: { value: null }, uFlash: { value: 0 }, uUnder: { value: 0 }, uNight: { value: 0 }, uSat: { value: 1.05 }, uVig: { value: 0.25 }, uT: { value: 0 }, uHit: { value: 0 }, uWarm: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uNight, uSat, uVig, uT, uHit, uWarm, uFlash, uUnder; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      // под водой: колышущаяся картинка
      if (uUnder > 0.0) uv += vec2(sin(vUv.y * 24.0 + uT * 2.1), cos(vUv.x * 21.0 + uT * 1.7)) * 0.0025 * uUnder;
      vec4 c = texture2D(tDiffuse, uv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      // ночное зрение: холоднее и беднее цветом, но тёплые огни остаются тёплыми
      vec3 scot = vec3(l * 0.78, l * 0.92, l * 1.2);
      float keep = smoothstep(0.25, 0.9, l);
      c.rgb = mix(c.rgb, scot, uNight * 0.55 * (1.0 - keep));
      // лёгкий «плёночный» тон: тени в зелень, света в тепло
      c.rgb += vec3(-0.004, 0.003, -0.002) * (1.0 - l) + vec3(0.012, 0.006, -0.01) * l * uWarm;
      vec2 d = vUv - 0.5;
      c.rgb *= clamp(1.0 - dot(d, d) * uVig * 3.0, 0.0, 1.0);
      c.rgb += (h(vUv * 1000.0 + uT) - 0.5) * (0.018 + uNight * 0.02);
      // контузия: красный край и смаз
      c.rgb = mix(c.rgb, c.rgb * vec3(1.2, 0.55, 0.5), uHit * smoothstep(0.1, 0.7, length(d) * 1.4));
      // под водой: торфяная муть, тёмные края
      if (uUnder > 0.0) {
        float lu = dot(c.rgb, vec3(0.3, 0.55, 0.15));
        c.rgb = mix(c.rgb, vec3(lu * 0.55, lu * 0.8, lu * 0.62) + vec3(0.0, 0.012, 0.01), 0.65 * uUnder);
        c.rgb *= 1.0 - dot(d, d) * 1.6 * uUnder;
      }
      // вспышка молнии: холодный засвет кадра
      c.rgb += vec3(0.5, 0.55, 0.7) * uFlash * 0.06 + c.rgb * uFlash * 0.25;
      gl_FragColor = c;
    }`
};
export let composer, bloom, grade, smaa;
export function buildPost() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 0.6, 0.88);
  bloom.enabled = Q.bloom;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  grade = new ShaderPass(Grade);
  composer.addPass(grade);
  smaa = new SMAAPass(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
  smaa.enabled = Q.smaa;
  composer.addPass(smaa);
}
export function updatePost(sky, hit, flash = 0, under = 0) {
  grade.uniforms.uFlash.value = flash;
  grade.uniforms.uUnder.value = under;
  grade.uniforms.uNight.value = sky.night;
  grade.uniforms.uSat.value = lerp(1.06, 0.88, sky.night);
  grade.uniforms.uVig.value = lerp(0.22, 0.42, sky.night);
  grade.uniforms.uT.value = FRAME.t % 100;
  grade.uniforms.uHit.value = hit;
  grade.uniforms.uWarm.value = 1 - sky.night;
  bloom.strength = lerp(0.26, 0.85, sky.night);
  bloom.threshold = lerp(0.9, 0.62, sky.night);
}
export function resizePost() {
  composer.setSize(innerWidth, innerHeight);
  smaa.setSize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
}
