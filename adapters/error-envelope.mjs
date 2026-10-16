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
for (const code of ["billing_quote_required", "billing_quote_invalid", "billing_quote_mismatch", "billing_quote_expired", "billing_limit_exceeded", "billing_connection_unverified", "billing_connection_changed", "billing_gate_required", "billing_transfer_approval_required", "billing_quote_unsupported", "billing_quote_failed", "billing_amount_invalid", "billing_currency_unknown", "billing_storage_invalid"]) {
  entries[code] = ["billing", "not_submitted", "quote_and_review", "料金・接続・承認条件を確認できませんでした。生成は開始していません。見積を確認して再レビューしてください。"];
}
for (const code of ["billing_context_required", "billing_context_invalid"]) entries[code] = ["billing", "not_submitted", "quote_and_review", "見積の対象projectを確認できません。新規生成は開始していません。見積とレビューを確認してください。"];
for (const code of ["receipt_unknown", "receipt_legacy_unknown", "receipt_invalid", "receipt_request_mismatch", "receipt_approval_mismatch", "receipt_billing_mismatch", "project_submission_unresolved", "project_authorization_used", "project_index_invalid"]) {
  entries[code] = ["recovery", "unknown", "inspect_record", "既存の送信記録を安全に照合できないか、未解決の処理があります。料金が発生している可能性があるため再送せず、元の記録を確認してください。"];
}
for (const code of ["receipt_poll_budget_exhausted", "receipt_refresh_budget_exhausted", "receipt_download_budget_exhausted"]) entries[code] = ["recovery", "accepted", "inspect_record", "同じ処理の照会・取得予算の上限に達しました。再起動しても予算は戻りません。生成を再送せずproviderの記録を確認してください。"];
for (const code of ["receipt_asset_missing", "receipt_asset_invalid", "receipt_asset_mismatch"]) entries[code] = ["inspection", "accepted", "inspect_record", "保存音声が永続記録と一致しません。上書きや再生成をせず検証記録を確認してください。"];
entries.submission_busy = ["recovery", "unknown", "inspect_record", "この音声で別の処理が実行中です。実行中の処理を確認してください。"];
entries.resume_no_submission = ["recovery", "not_submitted", "review_request", "再開できる送信記録がありません。新規生成は開始していません。"];
entries.mcp_status_tool_unavailable = ["poll", "accepted", "inspect_record", "受理済み処理の照会schemaを確認できません。別モデルへ替えず、接続契約を確認してください。"];
for (const code of ["oauth_arguments_invalid", "oauth_execution_approval_required", "oauth_client_metadata_url_required", "oauth_client_metadata_mismatch", "oauth_discovery_failed", "oauth_login_failed", "oauth_operation_failed", "oauth_callback_rejected", "oauth_token_endpoint_rejected", "oauth_profile_invalid", "oauth_callback_listener_failed", "oauth_browser_failed"]) entries[code] = ["authentication", "not_submitted", "connect", "接続条件・明示承認・専用のclient metadataを確認してください。生成は開始していません。"];
entries.oauth_refresh_uncertain = ["authentication", "not_submitted", "inspect_record", "前回の接続更新が確定していません。古いrefresh tokenを再送せず停止しました。接続記録を確認し、必要なら明示的に再接続してください。"];
entries.oauth_profile_busy = ["authentication", "not_submitted", "check_connection", "別の接続操作が実行中です。完了してから再試行してください。"];
entries.oauth_callback_port_in_use = ["authentication", "not_submitted", "check_connection", "接続用の待受portが使用中です。別の接続操作を完了してから再試行してください。無関係な処理は終了しません。"];
entries.oauth_callback_timeout = ["authentication", "not_submitted", "connect", "接続の待機時間が終了しました。生成は開始していません。必要なら接続操作をやり直してください。"];
entries.oauth_authorization_denied = ["authentication", "not_submitted", "connect", "接続がキャンセルされました。生成は開始していません。"];
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
