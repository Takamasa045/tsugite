// Kept inside the standalone v2 package; root Doctor/bootstrap use this same policy.
export const NODE_RUNTIME_RANGE = '>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1 <27';
export const DEFAULT_NODE_VERSION = '22.23.4';

export function isSupportedNodeVersion(version) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  const floor = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
  return Boolean(floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1])));
}
