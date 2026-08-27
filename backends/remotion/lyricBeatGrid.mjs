export const LYRIC_BEATS = Object.freeze([
  0.44, 0.88, 1.3, 1.64, 1.96, 2.22, 2.62, 3.04, 3.38, 3.7, 4.36, 4.78, 5.12, 5.44,
  6.1, 6.96, 7.4, 7.82, 8.26, 8.7, 9.12, 9.56, 10, 10.44, 10.86, 11.3, 11.74, 12.18,
  12.6, 13.04, 13.48, 13.92, 14.34, 14.78, 15.22, 15.64, 16.08, 16.52, 16.96, 17.38,
  17.82, 18.26, 18.7, 19.12, 19.56, 20, 20.44, 20.88, 21.3, 21.74, 22.18, 22.6, 23.04,
  23.48, 23.92, 24.34, 24.78, 25.22, 25.64, 26.1, 26.52, 26.96, 27.4, 28.26, 28.7,
  29.12, 29.46, 29.78, 30.44, 30.86, 31.3, 31.74
]);

export const LYRIC_IMPACTS = Object.freeze([7.2, 11, 14, 18, 22, 25, 27.6]);

export function beatVideoScale(second) {
  return 1 + beatEnergy(second, LYRIC_IMPACTS, 0.16) * 0.09;
}

export function beatEnergy(second, beats, windowSeconds = 0.09) {
  let peak = 0;
  for (const time of beats) {
    const delta = Math.abs(second - time);
    if (delta < windowSeconds) {
      peak = Math.max(peak, 1 - delta / windowSeconds);
    }
  }
  return peak;
}
