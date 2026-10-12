/** Wind-sea spectrum shared by the Gerstner waves, the FFT detail and the sea state field. */
const G = 9.81;

/** JONSWAP spectral density S(omega) [m^2 s] for wind speed U [m/s] and fetch F [m] */
export function jonswap(omega: number, U: number, F: number) {
  const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);
  const wp = jonswapPeak(U, F);
  const gamma = 3.3;
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  return ((alpha * G * G) / Math.pow(omega, 5)) * Math.exp(-1.25 * Math.pow(wp / omega, 4)) * Math.pow(gamma, r);
}
export function jonswapPeak(U: number, F: number) {
  return 22 * Math.pow((G * G) / (U * F), 1 / 3);
}
