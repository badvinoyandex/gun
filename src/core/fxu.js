import * as THREE from 'three';

/* Общие для шейдеров данные «состояния мира», которые меняются в игре:
   карта гари/огня (R — копоть, G — жар, B — лужи в воронках, A — выжженная трава),
   намокание, дождь, вспышка молнии. Один набор юниформов подключается к рельефу,
   траве, подлеску — поэтому пожар и дождь видны на всех слоях одинаково. */
export const BURN = { N: 256, X0: -128, SIZE: 256 };
export const burnData = new Uint8Array(BURN.N * BURN.N * 4);
export const burnTex = new THREE.DataTexture(burnData, BURN.N, BURN.N, THREE.RGBAFormat);
burnTex.magFilter = THREE.LinearFilter; burnTex.minFilter = THREE.LinearFilter;
burnTex.wrapS = burnTex.wrapT = THREE.ClampToEdgeWrapping;
burnTex.needsUpdate = true;

/** Карта обугливания построек (R — копоть на стенах, G — жар/пламя): тот же охват, 1 м. */
export const charData = new Uint8Array(BURN.N * BURN.N * 4);
export const charTex = new THREE.DataTexture(charData, BURN.N, BURN.N, THREE.RGBAFormat);
charTex.magFilter = THREE.LinearFilter; charTex.minFilter = THREE.LinearFilter;
charTex.needsUpdate = true;
export const FXU = {
  uBurn: { value: burnTex },
  uChar: { value: charTex },
  uBurnBox: { value: new THREE.Vector3(BURN.X0, BURN.X0, 1 / BURN.SIZE) },
  uWetG: { value: 0 },      // намокание поверхностей 0..1
  uRain: { value: 0 },      // сила дождя сейчас 0..1
  uFxT: { value: 0 },
  uFlash: { value: 0 },     // вспышка молнии 0..1
  uCaus: { value: 0 }       // сила бликов-каустик на дне (от солнца)
};
export const FXU_GLSL = /* glsl */`
uniform sampler2D uBurn, uChar; uniform vec3 uBurnBox; uniform float uWetG, uRain, uFxT, uFlash, uCaus;
vec4 burnAt(vec2 xz) { return texture2D(uBurn, (xz - uBurnBox.xy) * uBurnBox.z); }
vec4 charAt(vec2 xz) { return texture2D(uChar, (xz - uBurnBox.xy) * uBurnBox.z); }
`;
export const burnIndex = (x, z) => {
  const i = Math.floor(x - BURN.X0), j = Math.floor(z - BURN.X0);
  return i < 0 || j < 0 || i >= BURN.N || j >= BURN.N ? -1 : j * BURN.N + i;
};
let dirty = false, lastUp = 0, cdirty = false;
export const markBurnDirty = () => { dirty = true; };
export const markCharDirty = () => { cdirty = true; };
/** Загрузка карт в GPU не чаще 6 раз в секунду. */
export function flushBurn(t) {
  if ((!dirty && !cdirty) || t - lastUp < 0.16) return;
  if (dirty) burnTex.needsUpdate = true;
  if (cdirty) charTex.needsUpdate = true;
  dirty = cdirty = false; lastUp = t;
}
