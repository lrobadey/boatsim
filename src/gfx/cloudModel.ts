import { CLOUD_FLOW_GLSL } from './cloudFlow';

/** Shared cloud geometry, weather density, and light integration. */
export const CLOUD_MODEL_GLSL = /* glsl */ `
${CLOUD_FLOW_GLSL}
uniform highp sampler3D uCloudShape;
uniform highp sampler3D uCloudDetail;
uniform sampler2D uCloudCover; // RGBA weather: coverage, type, thickness, density
uniform vec3 uCloudOrigin;   // world position rays start from (the main camera)
uniform vec2 uCloudWind;     // accumulated drift (m)
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudErosion;
uniform vec3 uCloudSunDir;
uniform vec3 uCloudSunColor;
uniform vec3 uCloudAmbTop;
uniform vec3 uCloudAmbBottom;
const float C_EARTH = 6360000.0;
const float C_BOTTOM = 1400.0;
const float C_TOP = 3600.0;

vec2 vcRaySphere(vec3 ro, vec3 rd, float r) {
  // ro relative to the Earth's centre
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
// Nearest forward segment of the cloud shell. A ray from below the base may reach the
// distant layer only if the Earth itself does not occlude it.
// Kept uncapped so light rays can find the true shell exit; view rays apply their own range cap.
vec2 vcCloudInterval(vec3 roE, vec3 rd) {
  float radius = length(roE);
  vec2 inner = vcRaySphere(roE, rd, C_EARTH + C_BOTTOM);
  vec2 outer = vcRaySphere(roE, rd, C_EARTH + C_TOP);
  if (outer.y <= 0.0) return vec2(-1.0);
  float t0, t1;
  if (radius < C_EARTH + C_BOTTOM) {
    if (inner.y <= 0.0) return vec2(-1.0);
    vec2 ground = vcRaySphere(roE, rd, C_EARTH);
    if (ground.x >= 0.0 && ground.y > ground.x && ground.x < inner.y) return vec2(-1.0);
    t0 = inner.y;
    t1 = outer.y;
  } else if (radius < C_EARTH + C_TOP) {
    t0 = 0.0;
    bool entersInner = inner.x > 0.0 || (inner.x == 0.0 && dot(roE, rd) < 0.0);
    t1 = entersInner ? min(inner.x, outer.y) : outer.y;
  } else {
    if (outer.x < 0.0) return vec2(-1.0);
    t0 = outer.x;
    t1 = inner.x > t0 ? min(inner.x, outer.y) : outer.y;
  }
  return t1 > t0 ? vec2(t0, t1) : vec2(-1.0);
}
float vcHeightFrac(vec3 p) {
  return (length(p + vec3(0.0, C_EARTH, 0.0) - vec3(uCloudOrigin.x, 0.0, uCloudOrigin.z)) - C_EARTH - C_BOTTOM) / (C_TOP - C_BOTTOM);
}
// One shape value drives both the horizontal mass and its crown. The two height profiles
// share a flat base, but shallow clouds spread into a low shoulder while towers keep a
// narrower, shape-dependent upper body. Blending profiles preserves intermediate types.
float vcMass(float cover, float shape, float hf, float threshold) {
  float field = cover + (shape - 0.5) * 0.28 - 0.04 * smoothstep(0.30, 0.90, hf);
  return smoothstep(threshold - 0.075, threshold + 0.075, field);
}
float vcProfile(vec4 weather, float shape, float hf) {
  float type = smoothstep(0.37, 0.72, weather.g);
  float thickness = smoothstep(0.32, 0.70, weather.b);
  float shallowTop = 0.36 + 0.32 * thickness;
  float towerTop = min(0.98, 0.54 + 0.38 * thickness + 0.12 * (shape - 0.5));
  float shallow = 1.0 - smoothstep(shallowTop - 0.13, shallowTop, hf);
  float crown = smoothstep(0.23, 0.67, shape);
  float upper = smoothstep(0.30, 0.70, hf);
  float tower = (1.0 - smoothstep(towerTop - 0.20, towerTop, hf)) * mix(1.0, crown, upper);
  return smoothstep(0.0, 0.035, hf) * mix(shallow, tower, type);
}
float vcBody(vec4 weather, float shape, float hf, float threshold) {
  return vcMass(weather.r, shape, hf, threshold) * vcProfile(weather, shape, hf);
}
// Density at world position p (m). The weather channels control independent properties: R gates
// broad cloud masses, G favours tall cumulus towers, B sets layer thickness, A sets optical density.
// shapeLod filters the same morphology over a footprint without another 3D sample.
// cheap retains the mass silhouette and skips only the edge detail erosion.
float vcDensityLod(vec3 p, float hf, bool cheap, float shapeLod) {
  if (hf < 0.0 || hf > 1.0 || uCloudCoverage <= 0.0) return 0.0;
  vec2 flow = vcFlowOffset(hf, uCloudWind);
  vec3 q = p + vec3(flow.x, 0.0, flow.y);
  vec4 weather = texture(uCloudCover, q.xz / 42000.0);
  float threshold = mix(0.73, 0.43, clamp(uCloudCoverage, 0.0, 1.0));
  if (weather.r < threshold - 0.215) return 0.0;

  float shape = textureLod(uCloudShape, q / 7200.0, shapeLod).r;
  float body = vcBody(weather, shape, hf, threshold);
  if (body <= 0.0) return 0.0;

  // Erode only the wispy silhouette. Solid interiors and the cheap light/shadow path do not pay
  // for the detail texture. uCloudErosion can be set to zero to inspect the primary form.
  float detailFade = 1.0 - smoothstep(0.5, 2.5, shapeLod);
  if (!cheap && uCloudErosion > 0.0 && body < 0.46 && detailFade > 0.0) {
    float edge = 1.0 - smoothstep(0.14, 0.46, body);
    float detail = texture(uCloudDetail, q / 1500.0).r;
    body = max(0.0, body - uCloudErosion * edge * detail * detailFade);
  }
  float localDensity = mix(0.18, 0.42, weather.a);
  float coverageFade = smoothstep(0.0, 0.08, clamp(uCloudCoverage, 0.0, 1.0));
  return body * localDensity * uCloudDensity * coverageFade;
}
float vcDensity(vec3 p, float hf, bool cheap) { return vcDensityLod(p, hf, cheap, 0.0); }
float vcHG(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

// Estimate mean extinction over a long interval. Mips give its mean weather and shape;
// evaluating the nonlinear cloud gate at four representative values retains some occupied
// fraction when that mean lies in a gap. This is statistical quadrature, not an exact line
// integral: it cannot recover correlations or a particular unresolved cloud placement.
float vcFarMeanDensity(vec3 p, float hf, float segmentLength, float horizontalLength) {
  if (hf < 0.0 || hf > 1.0 || uCloudCoverage <= 0.0) return 0.0;
  vec2 flow = vcFlowOffset(hf, uCloudWind);
  vec3 q = p + vec3(flow.x, 0.0, flow.y);
  float weatherLod = clamp(log2(max(horizontalLength * 0.5, 164.0) / 164.0), 0.0, 8.0);
  float shapeLod = clamp(log2(max(segmentLength * 0.5, 56.0) / 56.0), 0.0, 7.0);
  vec4 weather = textureLod(uCloudCover, q.xz / 42000.0, weatherLod);
  float threshold = mix(0.73, 0.43, clamp(uCloudCoverage, 0.0, 1.0));
  // Spread only grows when the interval contains structure that mip filtering removed.
  // The weather field varies on kilometre scales; the shape texture has ~56 m voxels.
  float dw = 0.11 * smoothstep(1.0, 4.5, weatherLod);
  float ds = 0.16 * smoothstep(1.0, 5.0, shapeLod);
  // Even the largest possible shape value cannot occupy a clearly empty weather interval.
  if (weather.r + dw + 0.14 < threshold - 0.075) return 0.0;
  float shape = textureLod(uCloudShape, q / 7200.0, shapeLod).r;
  float lowCover = clamp(weather.r - dw, 0.0, 1.0);
  float highCover = clamp(weather.r + dw, 0.0, 1.0);
  float sLow = clamp(shape - ds, 0.0, 1.0);
  float sHigh = clamp(shape + ds, 0.0, 1.0);
  float lowProfile = vcProfile(weather, sLow, hf);
  float highProfile = vcProfile(weather, sHigh, hf);
  float body = 0.25 * (lowProfile * (vcMass(lowCover, sLow, hf, threshold) + vcMass(highCover, sLow, hf, threshold))
                     + highProfile * (vcMass(lowCover, sHigh, hf, threshold) + vcMass(highCover, sHigh, hf, threshold)));
  float coverageFade = smoothstep(0.0, 0.08, clamp(uCloudCoverage, 0.0, 1.0));
  return body * mix(0.18, 0.42, weather.a) * uCloudDensity * coverageFade;
}

// Optical depth to the first cloud-shell exit. Three detailed samples start close to the
// shaded point; four expanding far intervals cover a grazing ray at bounded texture cost.
float vcLightOpticalDepth(vec3 p, float localDensity) {
  vec3 pE = p - vec3(uCloudOrigin.x, -C_EARTH, uCloudOrigin.z);
  vec2 lightInterval = vcCloudInterval(pE, uCloudSunDir);
  // An invalid forward segment is blocked by the inner sphere (Earth), not clear air.
  if (lightInterval.x < 0.0) return 1000.0;
  float exitT = lightInterval.y;

  const float sigma = 0.045;
  float localT = min(exitT, 4.0);
  float od = localDensity * localT;
  // Midpoints are ~12, 52, and 192 m from the shaded point for a full 300 m span.
  float bounds[4] = float[4](4.0, 20.0, 84.0, 300.0);
  for (int j = 0; j < 3; j++) {
    float a = min(exitT, bounds[j]);
    float b = min(exitT, bounds[j + 1]);
    if (b <= a) break;
    vec3 lp = p + uCloudSunDir * (0.5 * (a + b));
    od += vcDensity(lp, vcHeightFrac(lp), false) * (b - a);
    if (od * sigma >= 20.0) return od;
  }

  float farLength = exitT - 300.0;
  if (farLength > 0.0 && od * sigma < 20.0) {
    float horizontal = length(uCloudSunDir.xz);
    const float cuts[5] = float[5](0.0, 0.100000, 0.260000, 0.530000, 1.0);
    for (int j = 0; j < 4; j++) {
      // Expanding partition: shorter segments next to the surface, longer ones far away.
      float a = cuts[j], b = cuts[j + 1];
      float stepLength = farLength * (b - a);
      vec3 lp = p + uCloudSunDir * (300.0 + farLength * (a + b) * 0.5);
      od += vcFarMeanDensity(lp, vcHeightFrac(lp), stepLength, stepLength * horizontal) * stepLength;
      if (od * sigma >= 20.0) break;
    }
  }
  return od;
}

`;
