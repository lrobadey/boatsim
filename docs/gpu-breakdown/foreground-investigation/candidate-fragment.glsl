
        precision highp float;
        uniform sampler2D uScene;
        uniform sampler2D uSceneDepth;
        uniform sampler2D uCloud;
        uniform sampler2D uCloudDepth;
        uniform vec2 uCloudSize;
        uniform mat4 uInvViewProj;
        uniform float uReversedDepth;
        in vec2 vUv;
        out vec4 fragColor;
        
#ifndef SKY_ENV_BLEND
#define SKY_ENV_BLEND 0
#endif


vec2 vcFlowOffset(float hf, vec2 wind) {
  float h = clamp(hf, 0.0, 1.0);
  float shearHeight = smoothstep(0.12, 0.90, h);
  float upper = smoothstep(0.32, 0.82, h);
  // Bounded height shear has at most an 8% drift-speed perturbation per axis.
  vec2 shear = 600.0 * shearHeight * sin(wind / 7500.0);
  // Long wind periods keep the upper-body warp slow and coherent across frames.
  vec2 warp = 60.0 * upper * vec2(
    sin(wind.x / 18000.0 + h * 4.3),
    sin(wind.y / 21000.0 - h * 3.7)
  );
  return wind + shear + warp;
}

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


uniform samplerCube uCloudHazeSky;
#if SKY_ENV_BLEND && !defined(CLOUD_HAZE_SINGLE_SOURCE)
uniform samplerCube uCloudHazeSkyNext;
uniform float uCloudHazeBlend;
#endif
uniform float uCloudHazeReady;
vec3 vcHazeSkySample(samplerCube sky, vec3 rd) {
#if __VERSION__ >= 300
  return textureLod(sky, rd, 1.0).rgb;
#else
  return textureCube(sky, rd).rgb;
#endif
}
vec3 vcHazeSky(vec3 rd) {
  vec3 currentRadiance = vcHazeSkySample(uCloudHazeSky, rd);
#if SKY_ENV_BLEND && !defined(CLOUD_HAZE_SINGLE_SOURCE)
  vec3 nextEnv = vcHazeSkySample(uCloudHazeSkyNext, rd);
  return mix(currentRadiance, nextEnv, clamp(uCloudHazeBlend, 0.0, 1.0));
#else
  return currentRadiance;
#endif
}
// march a view ray; returns premultiplied radiance (rgb) and transmittance (a).
// Representative distance is the opacity-weighted centre of the visible cloud (metres).
vec4 vcMarch(vec3 rd, float steps, float jitter, float maxDistance, out float representativeDistance) {
  representativeDistance = 0.0;
  // A grazing ray can reach clouds hundreds of kilometres away. Filter morphology
  // over its pixel cone as well as the integration interval; LOD0 aliases into bands.
  // Derivatives also account for reduced-resolution and environment-cube captures.
  float rayCone = max(length(dFdx(rd)), length(dFdy(rd)));
  vec3 ro = uCloudOrigin;
  vec3 roE = vec3(0.0, ro.y + C_EARTH, 0.0);
  vec2 interval = vcCloudInterval(roE, rd);
  if (interval.x < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = interval.x;
  float t1 = interval.y;
  t1 = min(min(t1, t0 + 26000.0), maxDistance);
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  float len = t1 - t0;
  // Every coarse cell is visited unless opacity ends the ray. A long dense stretch cannot
  // exhaust a global fine-step loop before the far silhouette. Empty cells use two cheap
  // probes; occupied cells are refined, and refinement persists across adjacent cells.
  // Short crossings (such as a downward ray from 1500 m) need fewer cells; about 40 m
  // per coarse cell is already much finer than the 1500 m detail field.
  float maxCells = clamp(floor(steps + 0.5), 1.0, 72.0);
  int cellCount = int(clamp(ceil(len / 40.0), 1.0, maxCells));
  float coarse = len / float(cellCount);
  float cosT = dot(rd, uCloudSunDir);
  float directPhase = mix(vcHG(cosT, 0.78), vcHG(cosT, -0.25), 0.3) * 12.566 * 0.55 + 0.45;
  float softPhase = 0.75 + 0.25 * max(cosT, 0.0);
  float lightStrength = max(max(uCloudSunColor.r, uCloudSunColor.g), uCloudSunColor.b);
  vec3 col = vec3(0.0);
  float T = 1.0;
  float firstHit = -1.0;
  float weightedDistance = 0.0;
  float opacityWeight = 0.0;
  bool refining = false;
  for (int i = 0; i < 72; i++) {
    if (i >= cellCount || T < 0.015) break;
    float cellStart = t0 + float(i) * coarse;
    float cellLen = min(coarse, t1 - cellStart);
    if (!refining) {
      float shift = (jitter - 0.5) * 0.2;
      vec3 pa = ro + rd * (cellStart + (0.25 + shift) * cellLen);
      vec3 pb = ro + rd * (cellStart + (0.75 + shift) * cellLen);
      float probeLod = clamp(log2(max(max(cellLen * 0.25, (cellStart + cellLen) * rayCone), 56.25) / 56.25), 0.0, 4.0);
      if (vcDensityLod(pa, vcHeightFrac(pa), true, probeLod) <= 0.0 &&
          vcDensityLod(pb, vcHeightFrac(pb), true, probeLod) <= 0.0) continue;
    }
    // Three samples per cell through 60 cells. Above that, distribute a fixed 180
    // sample budget over the actual cell count, including short clipped rays.
    int fineCount = cellCount <= 60 ? 3 :
      int(floor(float(i + 1) * 180.0 / float(cellCount)) - floor(float(i) * 180.0 / float(cellCount)));
    float fineStep = cellLen / float(fineCount);
    bool cellHit = false;
    for (int j = 0; j < 3; j++) {
      if (j >= fineCount || T < 0.015) break;
      float t = cellStart + (float(j) + 0.5 + (jitter - 0.5) * 0.5) * fineStep;
      vec3 p = ro + rd * t;
      float hf = vcHeightFrac(p);
      float shapeLod = clamp(log2(max(max(fineStep * 0.5, t * rayCone), 56.25) / 56.25), 0.0, 4.0);
      float d = vcDensityLod(p, hf, false, shapeLod);
      if (d <= 0.002) continue;
      cellHit = true;
      if (firstHit < 0.0) firstHit = t;
      float sigma = 0.045;
      vec3 lit = vec3(0.0);
      if (lightStrength > 0.001) {
        float tau = vcLightOpticalDepth(p, d) * sigma;
        float powder = 1.0 - exp(-d * 60.0);
        float direct = exp(-tau) * mix(1.0, powder, 0.55) * directPhase;
        // A low-frequency, weak fill approximates light scattered within the cloud. It does
        // not inherit the forward-peaked direct phase or the surface powder response.
        float multiple = 0.24 * exp(-tau * 0.18) * softPhase * mix(0.65, 1.0, hf);
        lit = uCloudSunColor * (direct + multiple);
      }
      vec3 amb = mix(uCloudAmbBottom, uCloudAmbTop, hf);
      float Ts = exp(-d * sigma * fineStep);
      float weight = T * (1.0 - Ts);
      col += weight * (lit + amb);
      weightedDistance += weight * t;
      opacityWeight += weight;
      T *= Ts;
    }
    refining = cellHit;
  }
  // Only cloud radiance tends toward horizon haze. Transmittance stays physical
  // so the composite retains correct occlusion of the scene behind it.
  if (firstHit > 0.0) {
    float fade = exp(-max(firstHit - 4000.0, 0.0) / 30000.0);
    vec3 haze = uCloudHazeReady > 0.5 ? vcHazeSky(rd) :
      mix(uCloudAmbBottom, uCloudAmbTop, 0.45) * 0.8;
    col = mix(haze * (1.0 - T), col, fade);
  }
  if (opacityWeight > 0.0001) representativeDistance = weightedDistance / opacityWeight;
  return vec4(col, T);
}
vec4 vcMarch(vec3 rd, float steps, float jitter) {
  float representativeDistance;
  return vcMarch(rd, steps, jitter, 1.0e30, representativeDistance);
}


        float sceneDistance(vec2 uv) {
          float z = texture(uSceneDepth, uv).r;
          if (uReversedDepth > 0.5 ? z <= 0.0 : z >= 1.0) return -1.0;
          float clipZ = uReversedDepth > 0.5 ? z : z * 2.0 - 1.0;
          vec4 viewRay = uInvViewProj * vec4(uv * 2.0 - 1.0, clipZ, 1.0);
          return length(viewRay.xyz / viewRay.w) * 0.001;
        }

        bool foregroundBeforeClouds(float distanceKm, float cameraHeight) {
          // Below the shell, its radial clearance is a lower bound on every cloud ray.
          // Keep an 8 m cushion for half-float clip metadata and the tap acceptance tolerance.
          // Sky (-1), in-cloud cameras and uncertain boundary pixels retain reconstruction.
          return distanceKm > 0.0 && cameraHeight < C_BOTTOM &&
            distanceKm * 1000.0 < C_BOTTOM - cameraHeight - 8.0;
        }

        void main() {
          vec4 scene = texture(uScene, vUv);
          float distanceKm = sceneDistance(vUv);
          if (foregroundBeforeClouds(distanceKm, uCloudOrigin.y)) {
            // Preserve the rendered surface, including its cloud shadows and reflections.
            fragColor = scene;
            return;
          }
          vec2 texel = vUv * uCloudSize - 0.5;
          vec2 base = floor(texel);
          vec2 f = fract(texel);
          vec3 radiance = vec3(0.0);
          float transmittance = 0.0;
          float total = 0.0;
          // A scene-depth gate on each low-resolution tap prevents a cloudy sky pixel from
          // washing across a nearer mast, coast edge, or other foreground silhouette.
          for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
            vec2 pixel = clamp(base + vec2(float(x), float(y)), vec2(0.0), uCloudSize - 1.0);
            vec2 sampleUv = (pixel + 0.5) / uCloudSize;
            vec4 cloud = texture(uCloud, sampleUv);
            vec4 metadata = texture(uCloudDepth, sampleUv);
            float weight = (x == 0 ? 1.0 - f.x : f.x) * (y == 0 ? 1.0 - f.y : f.y);
            if (distanceKm > 0.0) {
              // The representative cloud depth does not bound all its radiance. Use
              // the actual march limit recorded in G, including for clear taps.
              float tolerance = max(0.001, distanceKm * 0.001);
              if (metadata.g < 0.0 || metadata.g > distanceKm + tolerance) weight = 0.0;
              else weight *= exp(-abs(metadata.g - distanceKm) / max(0.005, distanceKm * 0.02));
            } else if (metadata.g >= 0.0) {
              weight = 0.0;
            }
            radiance += cloud.rgb * weight;
            transmittance += cloud.a * weight;
            total += weight;
          }
          if (total > 0.00001) {
            radiance /= total;
            transmittance /= total;
          } else {
            // The low-resolution footprint can straddle a sharp mast or coast edge.
            // March just this pixel against its own scene depth to fill that gap.
            vec4 p = uInvViewProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
            vec3 ray = normalize(p.xyz / p.w);
            float cloudDistance;
            vec4 exactCloud = vcMarch(ray, 24.0, 0.5,
              distanceKm > 0.0 ? distanceKm * 1000.0 : 1.0e30, cloudDistance);
            radiance = exactCloud.rgb;
            transmittance = exactCloud.a;
          }
          scene.rgb = scene.rgb * transmittance + radiance;
          fragColor = scene;
        }