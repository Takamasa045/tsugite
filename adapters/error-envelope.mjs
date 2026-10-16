// Shared allowlist. Neither child stderr nor provider messages are display text.
const entries = {
  credential_missing: ["authentication", "not_submitted", "connect", "音声生成サービスへの接続が設定されていません。音声はまだ送信していません。"],
  oauth_credential_unavailable: ["authentication", "not_submitted", "connect", "接続を読み込めませんでした。生成は開始していません。"],
  oauth_refresh_failed: ["authentication", "not_submitted", "connect", "接続を更新できませんでした。生成は開始していません。"],
  mcp_discovery_failed: ["discovery", "not_submitted", "check_connection", "接続または選択したモデルの提供契約を確認できませんでした。"],
  mcp_model_not_supported: ["discovery", "not_submitted", "review_model", "選んだモデルをこの接続で確認できませんでした。モデルを確認して再レビューしてください。"],
  mcp_v4_speech_tool_unavailable: ["discovery", "not_submitted", "review_model", "選んだモデルをこの接続で確認できませんでした。モデルを確認して再レビューしてください。"],
  submission_not_durable: ["persistence", "not_submitted", "check_storage", "送信記録を安全に保存できませんでした。生成は開始していません。保存先を確認してください。"],
  submission_durability_unsupported: ["persistence", "not_submitted", "check_storage", "このOSでは送信記録の永続化を保証できないため、生成を開始していません。"],
  submission_already_exists_or_unwritable: ["submission", "unknown", "inspect_record", "既存の送信記録があります。料金が発生している可能性があるため再送を止めています。"],
  mcp_outcome_unknown: ["submission", "unknown", "inspect_record", "送信結果を確認できません。料金が発生している可能性があるため再送を止めています。"],
  mcp_generation_pending: ["poll", "accepted", "poll_same_job", "生成は受け付けられています。同じ処理の完了を確認してください。"],
  mcp_status_failed: ["poll", "accepted", "poll_same_job", "受理済み処理の状態を確認できませんでした。同じ処理の記録を確認してください。"],
  mcp_audio_download_failed: ["download", "accepted", "download_same_job", "生成後のファイル取得で止まりました。同じ生成結果を取得してください。"],
  mcp_generation_failed: ["poll", "failed", "inspect_record", "生成処理の失敗を確認しました。記録を確認し、新しい承認を準備してください。"],
  output_write_failed: ["persistence", "accepted", "inspect_record", "生成後の音声を保存できませんでした。既存の処理記録を確認してください。"],
  output_already_exists: ["persistence", "unknown", "inspect_record", "既存の音声があります。上書きや再送をせず処理記録を確認してください。"],
  adapter_failed: ["unknown", "unknown", "inspect_record", "処理結果を安全に確認できませんでした。記録を確認してください。自動再送はしません。"]
};
for (const code of ["oauth_login_required", "oauth_keychain_unavailable", "oauth_keychain_failed", "oauth_keychain_record_invalid", "oauth_resource_metadata_changed", "oauth_authorization_metadata_changed", "oauth_token_endpoint_rejected", "oauth_token_response_rejected"]) {
  entries[code] = ["authentication", "not_submitted", "connect", "接続を安全に確認できませんでした。生成は開始していません。接続手順を確認してください。"];
}
for (const code of ["invalid_request_id", "invalid_run_directory", "invalid_text_length", "unsupported_operation_or_model", "unsupported_output_kind", "unsupported_audio_role", "unsupported_input_field", "voice_id_required_or_unsupported_params", "unsafe_output_directory", "input_too_large"]) {
  entries[code] = ["validation", "not_submitted", "review_request", "音声の制作条件または保存先を確認してください。生成は開始していません。"];
}
for (const code of ["mcp_audio_invalid", "mcp_audio_missing", "mcp_audio_too_large", "mcp_audio_url_invalid", "mcp_audio_url_untrusted", "mcp_generation_identity_invalid", "mcp_generation_request_mismatch", "mcp_generation_result_invalid", "output_inspection_failed"]) {
  entries[code] = ["inspection", "accepted", "inspect_record", "生成結果を安全に採用できませんでした。再送せず検証記録を確認してください。"];
}
const keys = ["schema_version", "kind", "code", "phase", "submission_state", "recovery_action", "request_id"];
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export function adapterErrorEnvelope(code, requestId) {
  if (!Object.hasOwn(entries, code)) code = "adapter_failed";
  const [phase, submission_state, recovery_action] = entries[code];
  return { schema_version: 1, kind: "tsugite.adapter-error", code, phase, submission_state, recovery_action,
    ...(safeId(requestId) ? { request_id: requestId } : {}) };
}
export function parseAdapterErrorEnvelope(text, requestId) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 4096) return undefined;
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some((key) => !keys.includes(key))
      || !Object.hasOwn(entries, value.code) || (value.request_id !== undefined && (!safeId(value.request_id) || value.request_id !== requestId))) return undefined;
    const expected = adapterErrorEnvelope(value.code, value.request_id);
    if (Object.keys(value).length !== Object.keys(expected).length || Object.entries(expected).some(([key, item]) => value[key] !== item)) return undefined;
    return expected;
  } catch { return undefined; }
}
export function describeAdapterError(code) { return entries[code]?.[3] ?? entries.adapter_failed[3]; }
