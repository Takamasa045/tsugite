import { Sparkles } from 'lucide-react'

import type { RecommendationIntent } from './expressionRecommendation'

export interface ExpressionIntentPanelProps {
  freeTextId: string
  aspectId: string
  purposeId: string
  readinessId: string
  freeText: string
  aspect: RecommendationIntent['aspect']
  purpose: string
  readiness: RecommendationIntent['readiness']
  preferCalmMotion: boolean
  hasLoadedCatalog: boolean
  /** Disable recommend while finish candidates are still loading. */
  recommendDisabled: boolean
  recommendDisabledReason?: string | null
  onFreeTextChange: (value: string) => void
  onAspectChange: (value: RecommendationIntent['aspect']) => void
  onPurposeChange: (value: string) => void
  onReadinessChange: (value: RecommendationIntent['readiness']) => void
  onPreferCalmMotionChange: (value: boolean) => void
  onRecommend: () => void
}

export function ExpressionIntentPanel({
  freeTextId,
  aspectId,
  purposeId,
  readinessId,
  freeText,
  aspect,
  purpose,
  readiness,
  preferCalmMotion,
  hasLoadedCatalog,
  recommendDisabled,
  recommendDisabledReason = null,
  onFreeTextChange,
  onAspectChange,
  onPurposeChange,
  onReadinessChange,
  onPreferCalmMotionChange,
  onRecommend,
}: ExpressionIntentPanelProps) {
  return (
    <section aria-label="どんな動画を作りたいか" className="launcher-expression-intent" role="region">
      <label className="launcher-expression-intent-free" htmlFor={freeTextId}>
        <span>どんな動画を作りたいですか</span>
        <textarea
          id={freeTextId}
          onChange={(event) => onFreeTextChange(event.target.value)}
          placeholder="例: 記事を会話でわかりやすく解説する横型60秒"
          rows={2}
          value={freeText}
        />
      </label>
      <div className="launcher-expression-intent-grid">
        <label htmlFor={aspectId}>
          <span>比率</span>
          <select
            id={aspectId}
            onChange={(event) => onAspectChange(event.target.value as RecommendationIntent['aspect'])}
            value={aspect ?? 'any'}
          >
            <option value="any">指定なし</option>
            <option value="16:9">16:9 横型</option>
            <option value="9:16">9:16 縦型</option>
          </select>
        </label>
        <label htmlFor={purposeId}>
          <span>目的</span>
          <select
            id={purposeId}
            onChange={(event) => onPurposeChange(event.target.value)}
            value={purpose}
          >
            <option value="">指定なし</option>
            <option value="explainer">解説</option>
            <option value="dialogue">会話</option>
            <option value="promo">告知・募集</option>
            <option value="showreel">ダイジェスト</option>
            <option value="data">データ</option>
            <option value="dev">開発・コード</option>
            <option value="social">SNS・配信</option>
          </select>
        </label>
        <label htmlFor={readinessId}>
          <span>探す範囲</span>
          <select
            id={readinessId}
            onChange={(event) => onReadinessChange(event.target.value as RecommendationIntent['readiness'])}
            value={readiness ?? 'explore'}
          >
            <option value="explore">アイデアも含めて探す</option>
            <option value="ready">制作依頼に指定できる候補から探す</option>
          </select>
        </label>
        <label className="launcher-expression-check">
          <input
            checked={preferCalmMotion}
            onChange={(event) => onPreferCalmMotionChange(event.target.checked)}
            type="checkbox"
          />
          <span>落ち着いた候補を優先（候補の絞り込み用）</span>
        </label>
      </div>
      <button
        aria-disabled={recommendDisabled || undefined}
        className="launcher-primary"
        disabled={recommendDisabled}
        onClick={onRecommend}
        type="button"
      >
        <Sparkles aria-hidden="true" size={16} />
        入力内容から候補を絞り込む
      </button>
      {recommendDisabled && recommendDisabledReason && (
        <p className="launcher-expression-intent-note" role="status">
          {recommendDisabledReason}
        </p>
      )}
      <p className="launcher-expression-intent-note">
        入力した内容・比率・目的を、この端末内の一覧と照合して1〜3件を提案します。
        候補は自動選択されず、制作依頼へ追加したものだけが文章に入ります。
        生成・書き出し・外部サービス実行・課金は行いません。
        {(readiness ?? 'explore') === 'explore' && !hasLoadedCatalog && (
          <>
            {' '}
            いま参考一覧は未読込です。「アイデアも含めて探す」では、読込前は制作依頼に指定できる仕上げだけが検索対象です。
          </>
        )}
      </p>
    </section>
  )
}
