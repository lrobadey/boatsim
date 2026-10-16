/** Fixed binary contract shared by the startup texture baker and browser loader. */
export interface StartupTextures {
  noise: Uint8Array;
  ripple: Uint8Array;
  cloudShape: Uint16Array;
  cloudDetail: Uint16Array;
  cloudWeather: Uint8Array;
}

export const STARTUP_TEXTURE_HEADER_BYTES = 12;
export const STARTUP_TEXTURE_LENGTHS = [256 * 256 * 4, 512 * 512 * 4, 128 ** 3 * 2, 64 ** 3 * 2, 256 * 256 * 4] as const;
export const TEXTURE_BYTE_LENGTH = STARTUP_TEXTURE_HEADER_BYTES + STARTUP_TEXTURE_LENGTHS.reduce((sum, n) => sum + n, 0);

const MAGIC = [0x53, 0x54, 0x58, 0x52]; // "STXR"
const VERSION = 1;

function checksum(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
  return hash;
}

export function encodeStartupTextures(data: StartupTextures): ArrayBuffer {
  const actual = [data.noise.byteLength, data.ripple.byteLength, data.cloudShape.byteLength, data.cloudDetail.byteLength, data.cloudWeather.byteLength];
  for (let i = 0; i < STARTUP_TEXTURE_LENGTHS.length; i++) {
    if (actual[i] !== STARTUP_TEXTURE_LENGTHS[i]) throw new RangeError(`Startup texture ${i} has ${actual[i]} bytes; expected ${STARTUP_TEXTURE_LENGTHS[i]}`);
  }
  const buffer = new ArrayBuffer(TEXTURE_BYTE_LENGTH);
  const view = new DataView(buffer);
  MAGIC.forEach((b, i) => view.setUint8(i, b));
  view.setUint16(4, VERSION, true);
  view.setUint16(6, STARTUP_TEXTURE_HEADER_BYTES, true);
  let offset = STARTUP_TEXTURE_HEADER_BYTES;
  const byteViews = [new Uint8Array(data.noise.buffer, data.noise.byteOffset, data.noise.byteLength), new Uint8Array(data.ripple.buffer, data.ripple.byteOffset, data.ripple.byteLength)];
  for (const bytes of byteViews) { new Uint8Array(buffer, offset, bytes.byteLength).set(bytes); offset += bytes.byteLength; }
  for (const values of [data.cloudShape, data.cloudDetail]) {
    const out = new DataView(buffer, offset, values.byteLength);
    for (let i = 0; i < values.length; i++) out.setUint16(i * 2, values[i], true);
    offset += values.byteLength;
  }
  const weather = new Uint8Array(data.cloudWeather.buffer, data.cloudWeather.byteOffset, data.cloudWeather.byteLength);
  new Uint8Array(buffer, offset, weather.byteLength).set(weather);
  view.setUint32(8, checksum(new Uint8Array(buffer, STARTUP_TEXTURE_HEADER_BYTES)), true);
  return buffer;
}

export function decodeStartupTextures(buffer: ArrayBuffer): StartupTextures {
  if (buffer.byteLength !== TEXTURE_BYTE_LENGTH) throw new RangeError(`Startup texture file has ${buffer.byteLength} bytes; expected ${TEXTURE_BYTE_LENGTH}`);
  const view = new DataView(buffer);
  if (MAGIC.some((b, i) => view.getUint8(i) !== b)) throw new Error('Invalid startup texture magic');
  if (view.getUint16(4, true) !== VERSION) throw new Error('Unsupported startup texture version');
  if (view.getUint16(6, true) !== STARTUP_TEXTURE_HEADER_BYTES) throw new Error('Invalid startup texture header');
  if (view.getUint32(8, true) !== checksum(new Uint8Array(buffer, STARTUP_TEXTURE_HEADER_BYTES))) throw new Error('Startup texture checksum mismatch');
  let offset = STARTUP_TEXTURE_HEADER_BYTES;
  const takeBytes = (length: number) => { const bytes = new Uint8Array(buffer, offset, length); offset += length; return bytes; };
  const noise = takeBytes(STARTUP_TEXTURE_LENGTHS[0]);
  const ripple = takeBytes(STARTUP_TEXTURE_LENGTHS[1]);
  const cloudShape = decodeU16LE(takeBytes(STARTUP_TEXTURE_LENGTHS[2]));
  const cloudDetail = decodeU16LE(takeBytes(STARTUP_TEXTURE_LENGTHS[3]));
  const cloudWeather = takeBytes(STARTUP_TEXTURE_LENGTHS[4]);
  return { noise, ripple, cloudShape, cloudDetail, cloudWeather };
}

function decodeU16LE(bytes: Uint8Array): Uint16Array {
  const result = new Uint16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < result.length; i++) result[i] = view.getUint16(i * 2, true);
  return result;
}

export async function loadStartupTextures(
  url: string,
  fallback: () => Promise<StartupTextures>,
  options: { fetcher?: typeof fetch; onStatus?: (status: 'precomputed' | 'generated') => void } = {},
): Promise<StartupTextures> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loaded: StartupTextures | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Startup texture fetch timed out')); }, 1500); });
    const response = await Promise.race([fetcher(url, { signal: controller.signal }), timeout]);
    if (!response.ok) throw new Error(`Startup texture fetch failed (${response.status})`);
    const buffer = await Promise.race([response.arrayBuffer(), timeout]);
    loaded = decodeStartupTextures(buffer);
  } catch {
    // Fetch, body-read, and decode failures all use the established worker path.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (loaded) {
    options.onStatus?.('precomputed');
    return loaded;
  }
  const generated = await fallback();
  options.onStatus?.('generated');
  return generated;
}
