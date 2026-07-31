/**
 * Retry 完了時の focus handoff は、ユーザーがまだ retry 操作を「所有」しているときだけ行う。
 * - 同じ retry button 上
 * - disabled / unmount などで body（または html）へ落ちた場合
 * 別の button / input / link などへ移っていれば絶対に動かさない。
 * retrySurfaceActive だけでは所有権と見なさない（呼び出し側で retry 開始 ref と組み合わせる）。
 */
export function ownsRetryFocusHandoff(retryButton: Element | null): boolean {
  const active = document.activeElement
  if (active == null || active === document.body || active === document.documentElement) {
    return true
  }
  return retryButton != null && active === retryButton
}
