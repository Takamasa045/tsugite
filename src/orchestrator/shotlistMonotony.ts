/**
 * ショットリストの単調さ検出（出口側・証拠提示用）。
 * Gate を自動承認/拒否せず、警告文だけを返す。
 */

import { createTranslator, type TranslateParams } from "../i18n/index.js";

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
  params: TranslateParams;
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

type Translator = (key: string, params?: TranslateParams) => string;

const DEFAULTS = {
  durationRangeRatioMax: 0.12,
  durationCvMax: 0.1,
  cameraRepeatThreshold: 3,
  staticRunThreshold: 3,
  earlyHookSeconds: 2,
  minShotsForDuration: 3
} as const;

const ja = createTranslator("ja");

function formatMonotonySeconds(value: number, tr: Translator): string {
  const rounded = Math.round(value * 10) / 10;
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return tr("review.format.seconds", { value: display });
}

function monotonyFindingMessage(
  code: ShotlistMonotonyFinding["code"],
  params: TranslateParams,
  tr: Translator
): string {
  if (code === "shotlist.duration_low_variance") {
    return tr("review.warn.duration_low_variance", {
      min: formatMonotonySeconds(Number(params.min), tr),
      max: formatMonotonySeconds(Number(params.max), tr),
      cv_note: params.lowCv ? tr("review.warn.duration_cv_note") : ""
    });
  }
  if (code === "shotlist.camera_repeat") {
    return tr("review.warn.camera_repeat", { camera: params.camera, count: params.count });
  }
  if (code === "shotlist.static_run") {
    return tr("review.warn.static_run", { count: params.count });
  }
  return tr("review.warn.missing_early_hook", {
    seconds: formatMonotonySeconds(Number(params.seconds), tr)
  });
}

function finding(
  code: ShotlistMonotonyFinding["code"],
  params: TranslateParams
): ShotlistMonotonyFinding {
  return {
    code,
    severity: "warning",
    params,
    message: monotonyFindingMessage(code, params, ja)
  };
}

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
        findings.push(finding("shotlist.duration_low_variance", {
          min,
          max,
          lowCv: lowCv ? 1 : 0
        }));
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
        findings.push(finding("shotlist.camera_repeat", {
          camera,
          count: cameraRepeatThreshold
        }));
        break;
      }
    }
  }

  if (staticRunThreshold >= 2) {
    let run = 0;
    for (const shot of ordered) {
      // 未指定 (undefined) は「不明」扱い。明示 static/none だけを固定画連続に数える。
      const camera = cameraFamily(shot.camera);
      if (camera === "static") {
        run += 1;
        if (run === staticRunThreshold) {
          findings.push(finding("shotlist.static_run", { count: staticRunThreshold }));
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
      findings.push(finding("shotlist.missing_early_hook", { seconds: earlyHookSeconds }));
    }
  }

  return findings;
}

export function monotonyFindingsToWarningMessages(
  findings: readonly ShotlistMonotonyFinding[],
  tr: Translator = ja
): string[] {
  return findings.map((item) =>
    `${tr("review.warn.monotony_prefix")} ${monotonyFindingMessage(item.code, item.params, tr)}`
  );
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
