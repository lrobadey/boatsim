/** Shared analytic cloud motion for density lookup and temporal reprojection. */
export const CLOUD_FLOW_GLSL = /* glsl */ `
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
`;
