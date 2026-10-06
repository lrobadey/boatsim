/// <reference lib="webworker" />
import { cloudNoiseData, cloudWeatherData, noiseData, rippleData } from './texdata';

self.onmessage = () => {
  const noise = noiseData(256, 3);
  const ripple = rippleData(512, 9);
  const clouds = cloudNoiseData(5);
  const cloudWeather = cloudWeatherData(256, 23);
  (self as unknown as Worker).postMessage(
    { noise, ripple, cloudShape: clouds.shape, cloudDetail: clouds.detail, cloudWeather },
    [noise.buffer, ripple.buffer, clouds.shape.buffer, clouds.detail.buffer, cloudWeather.buffer],
  );
};
