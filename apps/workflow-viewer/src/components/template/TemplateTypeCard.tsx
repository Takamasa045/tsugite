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
  onSelectDetail: (templateId: string) => void
  onQuickStart: (templateId: string) => void
}

export function TemplateTypeCard({
  template,
  selected,
  onSelectDetail,
  onQuickStart,
}: TemplateTypeCardProps) {
  const preview = template.valid ? templatePreview(template) : null
  const inputTypes = template.valid
    ? Array.from(new Set(template.requiredInputDetails.map((input) => input.type)))
    : []
  const previewIsReady = template.valid && hasUsableTemplatePreview(template.preview)
  const a11yDescriptionId = `launcher-template-card-a11y-${template.id}`
  const cardLabel = template.valid
    ? template.name
    : `${template.name}（選択不可）`
  const detailActionLabel = `${cardLabel}を詳しく選ぶ`
  const quickStartActionLabel = `${cardLabel}のおすすめ設定でプロンプトを作る`

  return (
    <article
      aria-labelledby={`launcher-template-card-name-${template.id}`}
      aria-describedby={template.valid ? a11yDescriptionId : undefined}
      className="launcher-template-card"
      data-category={template.valid ? template.category : '要確認'}
      data-invalid={!template.valid}
      data-selected={selected || undefined}
      data-status={template.status}
      data-tone={template.valid ? templateTone(template.category) : undefined}
    >
      <div className="launcher-template-card-body">
        <span className="launcher-template-card-topline">
          <span>{template.valid ? TEMPLATE_STATUS_LABELS[template.status] : '設定を確認'}</span>
          <small>{template.valid ? `${template.duration} · ${template.aspectRatio}` : template.id}</small>
        </span>
        <h3
          className="launcher-template-card-name"
          id={`launcher-template-card-name-${template.id}`}
        >
          {template.name}
        </h3>
        <p className="launcher-template-card-summary">
          {template.valid ? template.summary : template.issue?.message ?? 'メタデータを読み込めませんでした。'}
        </p>
        {template.valid && preview && (
          <div className="launcher-template-storyboard">
            <div className="launcher-template-storyboard-heading">
              <b>構成イメージ</b>
              {!previewIsReady && <small>プレビュー準備中</small>}
            </div>
            <div className="launcher-template-frames">
              {preview.frames.slice(0, 3).map((frame, index) => (
                <div
                  aria-label={`${index + 1}コマ目: ${frame.label}`}
                  className="launcher-template-frame"
                  data-kind={frame.kind}
                  key={`${frame.kind}-${frame.label}`}
                  role="img"
                >
                  <span aria-hidden="true" className="launcher-template-frame-visual" />
                  <small aria-hidden="true">{frame.label}</small>
                </div>
              ))}
            </div>
            <p className="launcher-template-flow">
              {preview.flow.join(' → ')}
            </p>
          </div>
        )}
        {template.valid && (
          <>
            <span className="sr-only" id={a11yDescriptionId}>
              {template.duration}、{template.aspectRatio}。構成: {preview?.flow.join('、')}。必要素材: {inputTypes.length > 0
                ? inputTypes.map((type) => TEMPLATE_INPUT_TYPE_LABELS[type]).join('、')
                : '指定なし'}。
            </span>
            <div className="launcher-template-card-footer">
              <div className="launcher-template-card-tags">
                <b>{template.category}</b>
                {template.tags.slice(0, 1).map((tag) => <i key={tag}>{tag}</i>)}
              </div>
              <div aria-label="必要素材タイプ" className="launcher-template-input-types">
                {inputTypes.map((type) => <i key={type}>{TEMPLATE_INPUT_TYPE_LABELS[type]}</i>)}
              </div>
            </div>
          </>
        )}
      </div>

      <div
        aria-label={`${cardLabel}の操作`}
        className="launcher-template-card-actions"
      >
        <button
          aria-label={detailActionLabel}
          className="launcher-secondary"
          disabled={!template.valid}
          onClick={() => {
            if (!template.valid) return
            onSelectDetail(template.id)
          }}
          type="button"
        >
          詳しく選ぶ
        </button>
        <button
          aria-label={quickStartActionLabel}
          className="launcher-primary"
          disabled={!template.valid}
          onClick={() => {
            if (!template.valid) return
            onQuickStart(template.id)
          }}
          type="button"
        >
          おすすめ設定でプロンプトを作る
        </button>
      </div>
    </article>
  )
}
