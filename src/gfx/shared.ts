import * as THREE from 'three';
import { LIGHTING_PROFILE } from '../world/lightingState';
import { registerEnvironmentMaterial } from './environmentMaterials';

/**
 * Uniforms shared by every material in the world (atmosphere, fog, time, wind, terrain lighting).
 * Updated once per frame by the sky/environment system; objects referenced by all materials.
 */
export const shared = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 1, 1) }, // radiance of direct light (sun or moon)
  uFogEnv: { value: null as THREE.CubeTexture | null },
  uFogEnvNext: { value: null as THREE.CubeTexture | null },
  uEnvBlend: { value: 0 },
  uPbrEnvNext: { value: null as THREE.Texture | null },
  uSkyShadowCoupling: { value: LIGHTING_PROFILE.skySpecularShadowCoupling as number },
  uFogDensity: { value: 0.000045 },
  uFogHeight: { value: 650 },
  uFogEnvScale: { value: 1 },
  uWindDir: { value: new THREE.Vector2(0, 1) },
  uWindStrength: { value: 0.5 },
  uNight: { value: 0 },
  // terrain lighting: heightfield (for sun shadows) and baked sky visibility
  uHeightTex: { value: null as THREE.Texture | null },
  uAOTex: { value: null as THREE.Texture | null },
  uSunShadowTex: { value: null as THREE.Texture | null },
  uCloudShadowTex: { value: null as THREE.Texture | null },
  uCloudShadowParams: { value: new THREE.Vector4(0, 0, 16000, 0) }, // centre x, z, size, enabled
  uTerrainSize: { value: 12000 },
  uTerrainMax: { value: 500 },
};

/** GLSL: aerial perspective using the sky environment cube along the view ray, with height falloff. */
export const FOG_PARS_GLSL = /* glsl */ `
#ifndef SKY_ENV_BLEND
#define SKY_ENV_BLEND 0
#endif
uniform samplerCube uFogEnv;
#if SKY_ENV_BLEND
uniform samplerCube uFogEnvNext;
uniform float uEnvBlend;
#endif
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFogEnvScale;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
vec3 sampleSkyEnv(vec3 rd, float lod) {
  vec3 currentRadiance = textureLod(uFogEnv, rd, lod).rgb;
#if SKY_ENV_BLEND
  vec3 nextEnv = textureLod(uFogEnvNext, rd, lod).rgb;
  return mix(currentRadiance, nextEnv, clamp(uEnvBlend, 0.0, 1.0));
#else
  return currentRadiance;
#endif
}
vec3 applyAerial(vec3 col, vec3 worldPos) {
  vec3 v = worldPos - cameraPosition;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-3);
  float hk = v.y / uFogHeight;
  float hInt = abs(hk) > 1e-3 ? (1.0 - exp(-hk)) / hk : 1.0;
  hInt *= exp(-max(cameraPosition.y, 0.0) / uFogHeight);
  float amt = 1.0 - exp(-uFogDensity * dist * hInt);
  vec3 fdir = normalize(vec3(dir.x, max(dir.y, 0.015), dir.z));
  vec3 fogCol = sampleSkyEnv(fdir, 4.0) * uFogEnvScale;
  // forward-scattered sunlight in the haze (warm glow toward the sun)
  float mu = max(dot(dir, uSunDir), 0.0);
  fogCol += uSunColor * (pow(mu, 12.0) * 0.025 + pow(mu, 64.0) * 0.06);
  return mix(col, fogCol, clamp(amt, 0.0, 1.0));
}
`;

/**
 * GLSL: sun shadows cast by the terrain, ray-marched through the heightfield toward the light, with a
 * penumbra that widens with distance to the occluder; plus baked sky visibility.
 * Works for every surface in the world (terrain, sea, ship, trees, houses), at any distance.
 */
export const TERRAIN_LIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
uniform sampler2D uAOTex;
uniform float uTerrainSize;
uniform float uTerrainMax;
uniform sampler2D uSunShadowTex;
uniform sampler2D uCloudShadowTex;
uniform vec4 uCloudShadowParams;
uniform float uSkyShadowCoupling;
float cloudShadow(vec3 wp) {
  if (uCloudShadowParams.w < 0.5) return 1.0;
  vec2 uv = (wp.xz - uCloudShadowParams.xy) / uCloudShadowParams.z + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  return texture2D(uCloudShadowTex, uv).r;
}
// baked horizon-height map (see SunShadowBake): R = shadow height, G = penumbra width
float terrainShadow(vec3 wp, vec3 L) {
  if (L.y < -0.02) return 0.0;
  float cs = cloudShadow(wp);
  vec2 uv = wp.xz / uTerrainSize + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return cs;
  vec2 s = texture2D(uSunShadowTex, uv).rg;
  float sh = clamp((wp.y - s.x) / max(s.y, 0.25), 0.0, 1.0);
  return sh * sh * (3.0 - 2.0 * sh) * cs;
}
float terrainAO(vec3 wp) {
  vec2 uv = wp.xz / uTerrainSize + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float ao = texture2D(uAOTex, uv).r;
  // occlusion matters near the ground; fades for things well above it
  float h = texture2D(uHeightTex, uv).r;
  float above = clamp((wp.y - h) / 25.0, 0.0, 1.0);
  return mix(ao, 1.0, above);
}
`;

/**
 * Patch a built-in three material: aerial-perspective fog, terrain sun shadows on the directional
 * light, terrain ambient occlusion on indirect light, and shared uniforms.
 * `extra` lets a caller chain additional shader edits.
 */
export function patchMaterial<T extends THREE.Material>(
  mat: T,
  extra?: (shader: THREE.WebGLProgramParametersWithUniforms) => void,
  key = '',
): T {
  if (!(mat instanceof THREE.MeshStandardMaterial)) {
    throw new Error(`patchMaterial expected MeshStandardMaterial-compatible input; received ${mat.type}`);
  }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAerialPos;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 awp = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            awp = batchingMatrix * awp;
          #endif
          #ifdef USE_INSTANCING
            awp = instanceMatrix * awp;
          #endif
          vAerialPos = (modelMatrix * awp).xyz;
        }`,
      );
    const lightsBegin = THREE.ShaderChunk.lights_fragment_begin.replace(
      'getDirectionalLightInfo( directionalLight, directLight );',
      'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= gTerrainShadow;',
    );
    const injectOnce = (source: string, needle: string, replacement: string, label: string): string => {
      const first = source.indexOf(needle);
      if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
        throw new Error(`patchMaterial shader hook missing or ambiguous: ${label}`);
      }
      return source.slice(0, first) + replacement + source.slice(first + needle.length);
    };
    let envmapPhysical = THREE.ShaderChunk.envmap_physical_pars_fragment;
    envmapPhysical = injectOnce(envmapPhysical, '#ifdef USE_ENVMAP', `#ifdef USE_ENVMAP
	#if defined(ENVMAP_TYPE_CUBE_UV)
#if SKY_ENV_BLEND
        uniform sampler2D uPbrEnvNext;
#endif
		vec3 samplePbrEnv( const in vec3 direction, const in float roughness ) {
			vec3 currentRadiance = textureCubeUV( envMap, direction, roughness ).rgb;
#if SKY_ENV_BLEND
			vec3 nextEnv = textureCubeUV( uPbrEnvNext, direction, roughness ).rgb;
			return mix( currentRadiance, nextEnv, clamp( uEnvBlend, 0.0, 1.0 ) );
#else
			return currentRadiance;
#endif
		}
	#endif`, 'PBR environment helper anchor');
    envmapPhysical = injectOnce(envmapPhysical,
      'vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );',
      'vec4 envMapColor = vec4( samplePbrEnv( envMapRotation * worldNormal, 1.0 ), 1.0 );',
      'IBL irradiance function');
    envmapPhysical = injectOnce(envmapPhysical,
      'vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );',
      'vec4 envMapColor = vec4( samplePbrEnv( envMapRotation * reflectVec, roughness ), 1.0 );',
      'IBL radiance function');
    envmapPhysical = injectOnce(envmapPhysical,
      'vec4 envMapColor = textureCubeUV( envMap, envMapRotation * retroVec, roughness );',
      'vec4 envMapColor = vec4( samplePbrEnv( envMapRotation * retroVec, roughness ), 1.0 );',
      'IBL retroreflection function');
    let fragment = shader.fragmentShader;
    fragment = injectOnce(fragment, '#include <envmap_physical_pars_fragment>', envmapPhysical, 'physical environment include');
    shader.fragmentShader = fragment
      .replace('#include <common>', '#include <common>\nvarying vec3 vAerialPos;\n' + FOG_PARS_GLSL + TERRAIN_LIGHT_GLSL)
      .replace('#include <lights_fragment_begin>', 'float gTerrainShadow = terrainShadow(vAerialPos, normalize(uSunDir));\n' + lightsBegin)
      .replace(
        '#include <aomap_fragment>',
        `{
           float tao = terrainAO(vAerialPos);
           reflectedLight.indirectDiffuse *= tao;
           reflectedLight.indirectSpecular *= mix(1.0, tao, 0.7) * mix(1.0, mix(0.35, 1.0, gTerrainShadow), uSkyShadowCoupling);
         }
         #include <aomap_fragment>`,
      )
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyAerial(gl_FragColor.rgb, vAerialPos);');
    extra?.(shader);
  };
  mat.customProgramCacheKey = () => 'aerial3' + key;
  registerEnvironmentMaterial(mat);
  return mat;
}
