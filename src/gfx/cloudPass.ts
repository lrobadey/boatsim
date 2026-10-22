import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { CLOUD_GLSL, type Clouds } from './clouds';

/** Composites the reduced-resolution cloud radiance over the fully rendered HDR scene. */
export class CloudPass extends Pass {
  private readonly material: THREE.ShaderMaterial;
  private readonly invViewProj = new THREE.Matrix4();
  private readonly size = new THREE.Vector2(1, 1);

  constructor(private readonly clouds: Clouds, private readonly viewCamera: THREE.PerspectiveCamera, private readonly reversedDepth: boolean) {
    super('CloudPass');
    this.needsDepthTexture = true;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...clouds.uniforms,
        uScene: { value: null },
        uSceneDepth: { value: null },
        uCloud: { value: null },
        uCloudDepth: { value: null },
        uCloudSize: { value: new THREE.Vector2(1, 1) },
        uFallbackSteps: { value: 56 },
        uInvViewProj: { value: this.invViewProj },
        uReversedDepth: { value: reversedDepth ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        out vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uScene;
        uniform sampler2D uSceneDepth;
        uniform sampler2D uCloud;
        uniform sampler2D uCloudDepth;
        uniform vec2 uCloudSize;
        uniform float uFallbackSteps;
        uniform mat4 uInvViewProj;
        uniform float uReversedDepth;
        in vec2 vUv;
        out vec4 fragColor;
        ${CLOUD_GLSL}

        float sceneDistance(vec2 uv) {
          float z = texture(uSceneDepth, uv).r;
          if (uReversedDepth > 0.5 ? z <= 0.0 : z >= 1.0) return -1.0;
          float clipZ = uReversedDepth > 0.5 ? z : z * 2.0 - 1.0;
          vec4 viewRay = uInvViewProj * vec4(uv * 2.0 - 1.0, clipZ, 1.0);
          return length(viewRay.xyz / viewRay.w) * 0.001;
        }

        void main() {
          vec4 scene = texture(uScene, vUv);
          float distanceKm = sceneDistance(vUv);
          // Ray and cone are taken here, outside any per-pixel branch, so the fallback march
          // below gets defined derivatives. The cone is widened to the reduced-resolution
          // pixel so the fallback filters cloud detail like the neighbouring taps.
          vec4 p = uInvViewProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
          vec3 ray = normalize(p.xyz / p.w);
          float rayCone = max(length(dFdx(ray)), length(dFdy(ray))) *
            float(textureSize(uScene, 0).x) / uCloudSize.x;
          if (distanceKm > 0.0) {
            // A surface nearer than where its view ray enters the cloud layer has no cloud
            // in front of it. This covers the ship, crew and all terrain below cloud base.
            vec2 interval = vcCloudInterval(vec3(0.0, uCloudOrigin.y + C_EARTH, 0.0), ray);
            if (interval.x < 0.0 || distanceKm * 1000.0 <= interval.x) {
              fragColor = scene;
              return;
            }
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
            // Rare: a surface inside the cloud layer next to sky, or the reverse. March
            // just this pixel against its own scene depth to fill that gap.
            float cloudDistance;
            vec4 exactCloud = vcMarchCone(ray, uFallbackSteps, 0.5,
              distanceKm > 0.0 ? distanceKm * 1000.0 : 1.0e30, rayCone, cloudDistance);
            radiance = exactCloud.rgb;
            transmittance = exactCloud.a;
          }
          scene.rgb = scene.rgb * transmittance + radiance;
          fragColor = scene;
        }`,
    });
    this.fullscreenMaterial = this.material;
  }

  override setDepthTexture(texture: THREE.Texture): void {
    this.material.uniforms.uSceneDepth.value = texture;
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget): void {
    this.viewCamera.updateMatrixWorld();
    // Work relative to the camera origin so distant world coordinates do not lose depth
    // precision when the ship travels far from the initial scene origin.
    this.invViewProj.copy(this.viewCamera.matrixWorld).setPosition(0, 0, 0).multiply(this.viewCamera.projectionMatrixInverse);
    const db = renderer.getDrawingBufferSize(this.size);
    this.clouds.setSize(db.x, db.y);
    this.clouds.render(renderer, this.viewCamera, this.material.uniforms.uSceneDepth.value, this.reversedDepth);
    const image = this.clouds.texture.image as { width: number; height: number };
    (this.material.uniforms.uCloudSize.value as THREE.Vector2).set(image.width, image.height);
    this.material.uniforms.uFallbackSteps.value = this.clouds.steps;
    this.material.uniforms.uScene.value = inputBuffer.texture;
    this.material.uniforms.uCloud.value = this.clouds.texture;
    this.material.uniforms.uCloudDepth.value = this.clouds.depthTexture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }
}
