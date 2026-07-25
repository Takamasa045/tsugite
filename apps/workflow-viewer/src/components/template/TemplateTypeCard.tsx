import {
  hasUsableTemplatePreview,
  TEMPLATE_INPUT_TYPE_LABELS,
  TEMPLATE_STATUS_LABELS,
  templatePreview,
  templateTone,
  type LauncherTemplate,
} from './templateShelfModel'

interface TemplateTypeCardProps {
  template: LauncherTemplate
  selected: boolean
  onSelect: (templateId: string) => void
}

export function TemplateTypeCard({ template, selected, onSelect }: TemplateTypeCardProps) {
  const preview = template.valid ? templatePreview(template) : null
  const inputTypes = template.valid
    ? Array.from(new Set(template.requiredInputDetails.map((input) => input.type)))
    : []
  const previewIsReady = template.valid && hasUsableTemplatePreview(template.preview)
  const a11yDescriptionId = `launcher-template-card-a11y-${template.id}`

  return (
    <button
      aria-describedby={template.valid ? a11yDescriptionId : undefined}
      aria-disabled={!template.valid || undefined}
      aria-label={`${template.name}を選ぶ`}
      aria-pressed={selected}
      className="launcher-template-card"
      data-category={template.valid ? template.category : '要確認'}
      data-invalid={!template.valid}
      data-status={template.status}
      data-tone={template.valid ? templateTone(template.category) : undefined}
      disabled={!template.valid}
      onClick={() => {
        if (!template.valid) return
        onSelect(template.id)
      }}
      type="button"
    >
      <span className="launcher-template-card-topline">
        <span>{template.valid ? TEMPLATE_STATUS_LABELS[template.status] : '設定を確認'}</span>
        <small>{template.valid ? `${template.duration} · ${template.aspectRatio}` : template.id}</small>
      </span>
      <span className="launcher-template-card-name" role="heading" aria-level={3}>{template.name}</span>
      <span className="launcher-template-card-summary">
        {template.valid ? template.summary : template.issue?.message ?? 'メタデータを読み込めませんでした。'}
      </span>
      {template.valid && preview && (
        <span className="launcher-template-storyboard">
          <span className="launcher-template-storyboard-heading">
            <b>構成イメージ</b>
            {!previewIsReady && <small>プレビュー準備中</small>}
          </span>
          <span className="launcher-template-frames">
            {preview.frames.slice(0, 3).map((frame, index) => (
              <span
                aria-label={`${index + 1}コマ目: ${frame.label}`}
                className="launcher-template-frame"
                data-kind={frame.kind}
                key={`${frame.kind}-${frame.label}`}
                role="img"
              >
                <span aria-hidden="true" className="launcher-template-frame-visual" />
                <small aria-hidden="true">{frame.label}</small>
              </span>
            ))}
          </span>
          <span className="launcher-template-flow">
            {preview.flow.join(' → ')}
          </span>
        </span>
      )}
      {template.valid && (
        <>
          <span className="sr-only" id={a11yDescriptionId}>
            {template.duration}、{template.aspectRatio}。構成: {preview?.flow.join('、')}。必要素材: {inputTypes.length > 0
              ? inputTypes.map((type) => TEMPLATE_INPUT_TYPE_LABELS[type]).join('、')
              : '指定なし'}。
          </span>
          <span className="launcher-template-card-footer">
            <span className="launcher-template-card-tags">
              <b>{template.category}</b>
              {template.tags.slice(0, 1).map((tag) => <i key={tag}>{tag}</i>)}
            </span>
            <span aria-label="必要素材タイプ" className="launcher-template-input-types">
              {inputTypes.map((type) => <i key={type}>{TEMPLATE_INPUT_TYPE_LABELS[type]}</i>)}
            </span>
          </span>
        </>
      )}
    </button>
  )
}
