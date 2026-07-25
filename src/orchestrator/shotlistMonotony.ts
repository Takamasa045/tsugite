/**
 * ショットリストの単調さ検出（出口側・証拠提示用）。
 * Gate を自動承認/拒否せず、警告文だけを返す。
 */

export type ShotlistMonotonyShot = {
  id?: string;
  start: number;
  end?: number;
  duration: number;
  /** カメラ/モーションの主ベクトル。同じ値が連続すると単調とみなす。 */
  camera?: string;
  /** hook / intro など役割。冒頭フック判定に使う。 */
  role?: string;
  title?: string;
  kicker?: string;
  badges?: string[];
};

export type ShotlistMonotonyFinding = {
  code:
    | "shotlist.duration_low_variance"
    | "shotlist.camera_repeat"
    | "shotlist.static_run"
    | "shotlist.missing_early_hook";
  message: string;
  severity: "warning";
};

export type LintShotlistMonotonyOptions = {
  /** 尺の相対レンジ (max-min)/mean がこれ未満なら均等割り疑い。既定 0.12 */
  durationRangeRatioMax?: number;
  /** 変動係数 (std/mean) がこれ未満なら均等割り疑い。既定 0.1 */
  durationCvMax?: number;
  /** 同カメラ連続の閾値。既定 3 */
  cameraRepeatThreshold?: number;
  /** 無カメラ/static 連続の閾値。既定 3 */
  staticRunThreshold?: number;
  /** フックを期待する冒頭秒。既定 2 */
  earlyHookSeconds?: number;
  /** 均等判定に必要な最小ショット数。既定 3 */
  minShotsForDuration?: number;
};

const DEFAULTS = {
  durationRangeRatioMax: 0.12,
  durationCvMax: 0.1,
  cameraRepeatThreshold: 3,
  staticRunThreshold: 3,
  earlyHookSeconds: 2,
  minShotsForDuration: 3
} as const;

export function lintShotlistMonotony(
  shots: readonly ShotlistMonotonyShot[],
  options: LintShotlistMonotonyOptions = {}
): ShotlistMonotonyFinding[] {
  if (shots.length === 0) return [];

  const durationRangeRatioMax = options.durationRangeRatioMax ?? DEFAULTS.durationRangeRatioMax;
  const durationCvMax = options.durationCvMax ?? DEFAULTS.durationCvMax;
  const cameraRepeatThreshold = options.cameraRepeatThreshold ?? DEFAULTS.cameraRepeatThreshold;
  const staticRunThreshold = options.staticRunThreshold ?? DEFAULTS.staticRunThreshold;
  const earlyHookSeconds = options.earlyHookSeconds ?? DEFAULTS.earlyHookSeconds;
  const minShotsForDuration = options.minShotsForDuration ?? DEFAULTS.minShotsForDuration;

  const findings: ShotlistMonotonyFinding[] = [];
  const ordered = [...shots].sort((left, right) => left.start - right.start || left.duration - right.duration);

  if (ordered.length >= minShotsForDuration) {
    const durations = ordered.map((shot) => shot.duration).filter((value) => Number.isFinite(value) && value > 0);
    if (durations.length >= minShotsForDuration) {
      const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
      const max = Math.max(...durations);
      const min = Math.min(...durations);
      const variance =
        durations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / durations.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
      const lowRange = mean > 0 && (max - min) / mean < durationRangeRatioMax;
      const lowCv = mean > 0 && cv < durationCvMax;
      if (lowRange || lowCv) {
        findings.push({
          code: "shotlist.duration_low_variance",
          severity: "warning",
          message:
            `ショット尺がほぼ均等です（最短 ${formatSeconds(min)} / 最長 ${formatSeconds(max)}`
            + `${lowCv ? `、ばらつき小` : ""}）。`
            + "見せ場前に短カットを密集させ、均等割りを避けてください。"
        });
      }
    }
  }

  if (cameraRepeatThreshold >= 2) {
    let run = 0;
    let previous: string | undefined;
    for (const shot of ordered) {
      const camera = cameraFamily(shot.camera);
      if (!camera || camera === "static") {
        run = 0;
        previous = undefined;
        continue;
      }
      if (camera === previous) {
        run += 1;
      } else {
        previous = camera;
        run = 1;
      }
      if (run === cameraRepeatThreshold) {
        findings.push({
          code: "shotlist.camera_repeat",
          severity: "warning",
          message:
            `同じカメラ系統「${camera}」が${cameraRepeatThreshold}連続しています。`
            + "1ショット1ベクトルを保ちつつ、隣接ショットで画角や動きを変えてください。"
        });
        break;
      }
    }
  }

  if (staticRunThreshold >= 2) {
    let run = 0;
    for (const shot of ordered) {
      const camera = cameraFamily(shot.camera);
      if (!camera || camera === "static") {
        run += 1;
        if (run === staticRunThreshold) {
          findings.push({
            code: "shotlist.static_run",
            severity: "warning",
            message:
              `カメラ動きのない（または static の）ショットが${staticRunThreshold}連続しています。`
              + "寄り/引きや1ベクトルの動きを挟み、単調な固定画を避けてください。"
          });
          break;
        }
      } else {
        run = 0;
      }
    }
  }

  const timelineEnd = Math.max(
    ...ordered.map((shot) => (Number.isFinite(shot.end) ? shot.end! : shot.start + shot.duration)),
    0
  );
  if (timelineEnd > earlyHookSeconds + 1e-9) {
    const hasEarlyHook = ordered.some((shot) => {
      const end = Number.isFinite(shot.end) ? shot.end! : shot.start + shot.duration;
      const overlapsEarly = shot.start < earlyHookSeconds - 1e-9 && end > 1e-9;
      if (!overlapsEarly) return false;
      if (looksLikeHook(shot)) return true;
      // 冒頭枠内に短いショット境界がある（尺を割っている）
      return shot.duration <= earlyHookSeconds + 1e-9 || end <= earlyHookSeconds + 1e-9;
    });
    if (!hasEarlyHook) {
      findings.push({
        code: "shotlist.missing_early_hook",
        severity: "warning",
        message:
          `冒頭${formatSeconds(earlyHookSeconds)}以内にフックとなる短いカットや役割が見つかりません。`
          + "導入を短くし、価値・問い・見どころを先に出してください。"
      });
    }
  }

  return findings;
}

export function monotonyFindingsToWarningMessages(
  findings: readonly ShotlistMonotonyFinding[]
): string[] {
  return findings.map((finding) => `[単調さ] ${finding.message}`);
}

/** カメラ表記を系統に正規化（zoom/push など近縁を同一視）。 */
export function cameraFamily(value: string | undefined): string | undefined {
  const normalized = normalizeCamera(value);
  if (!normalized) return undefined;
  if (/^(none|static|fixed|hold|still)$/.test(normalized)) return "static";
  if (/^(zoom|push|dolly|truck-in|truck_in)/.test(normalized)) return "push-zoom";
  if (/^(pan|slide|track|orbit|swish)/.test(normalized)) return "pan-track";
  if (/^(tilt|crane|boom|pedestal)/.test(normalized)) return "tilt-crane";
  if (/^(rise|parallax|pulse|wipe|fade)/.test(normalized)) return normalized.split("-")[0] ?? normalized;
  return normalized;
}

function normalizeCamera(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  return normalized.length > 0 ? normalized : undefined;
}

function looksLikeHook(shot: ShotlistMonotonyShot): boolean {
  const haystack = [
    shot.role,
    shot.kicker,
    shot.title,
    ...(shot.badges ?? [])
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /(hook|フック|掴み|問い|衝撃|冒頭|見どころ)/i.test(haystack);
}

function formatSeconds(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}秒` : `${rounded.toFixed(1)}秒`;
}
