/// <reference lib="webworker" />
import { noiseData, rippleData } from './texdata';

self.onmessage = () => {
  const noise = noiseData(256, 3);
  const ripple = rippleData(512, 9);
  (self as unknown as Worker).postMessage({ noise, ripple }, [noise.buffer, ripple.buffer]);
};
