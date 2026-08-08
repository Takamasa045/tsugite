import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { PersonConsistencyPanel } from './PersonConsistencyPanel'
import type { WorkflowPersonConsistencyEvidence } from '../../types/workflow'

afterEach(cleanup)

const baseProps: WorkflowPersonConsistencyEvidence = {
  stage: 'gate_2',
  status: 'review',
  status_label: '要レビュー（人が判断）',
  basis_summary: 'reference',
  subjects: [
    {
      subject_id: 'hero',
      basis: 'reference',
      evaluable_coverage: 0.75,
      traits: [
        { trait: 'identity', status: 'possible-drift', level: 'required' },
      ],
      ambiguity_codes: ['track_crossing'],
      observation_count: 4,
      face_evaluable_count: 3,
    },
  ],
  ambiguities: ['subject:hero:track_crossing'],
  contact_sheet_href: 'qa/person-consistency/gate2/contact-sheet.webp',
  contact_sheet_alt:
    '人物一貫性コンタクトシート: 対象 hero、stage gate_2、状態 要レビュー（人が判断）',
  report_href: 'qa/person-consistency/gate2/report.json',
  evidence_integrity: 'valid',
  evidence_integrity_label: '証跡ハッシュ検証: 有効',
  analyzer: {
    status: 'ok',
    label: '解析器: 実行済み',
    needs_human_review: false,
  },
  human_decision: {
    decision: 'revise',
    reason: '服装の揺れを再生成で確認したい',
  },
  frame_details: [
    {
      timestamp_ms: 0,
      shot_id: 'shot_1',
      visibility: 'visible',
      face_evaluable: true,
      reason: 'face clear',
    },
  ],
  a11y: {
    status_text: '要レビュー（人が判断）',
    summary_text: '要レビュー。対象 hero。',
  },
}

describe('PersonConsistencyPanel', () => {
  it('renders subject summary, contact sheet alt, analyzer, human decision with keyboard targets', async () => {
    const user = userEvent.setup()
    render(<PersonConsistencyPanel {...baseProps} />)

    expect(
      screen.getByRole('heading', { name: '人物一貫性 QA 証跡' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/判定: 要レビュー/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Subject hero/)).toBeInTheDocument()
    expect(screen.getByText(/解析器: 実行済み/)).toBeInTheDocument()
    expect(screen.getByText(/revise/)).toBeInTheDocument()
    expect(
      screen.getByText(/服装の揺れを再生成で確認したい/),
    ).toBeInTheDocument()

    const img = screen.getByRole('img', {
      name: /人物一貫性コンタクトシート/,
    })
    expect(img).toHaveAttribute('alt', expect.stringContaining('hero'))
    expect(img).toHaveAttribute('loading', 'lazy')

    const sheetLink = screen.getByRole('link', {
      name: /人物一貫性コンタクトシート/,
    })
    sheetLink.focus()
    expect(sheetLink).toHaveFocus()
    await user.tab()
    expect(document.activeElement).not.toBe(null)
  })

  it('shows explicit tampered/invalid evidence and never shows media', () => {
    render(
      <PersonConsistencyPanel
        {...baseProps}
        evidence_integrity="tampered"
        evidence_integrity_label="証跡ハッシュ検証: 改ざん検出（自動合格にしない）"
        human_decision={undefined}
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/改ざん|無効/)
    expect(alert).toHaveTextContent(/自動合格にしない|Gate 通過根拠として扱いません/)
    expect(screen.getByText(/未記録（Gate 通過不可）/)).toBeInTheDocument()
    expect(
      screen.getAllByText(/証跡ハッシュ検証: 改ざん検出/).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /人物一貫性コンタクトシート/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'コンタクトシート' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'フレーム詳細' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/表示しません/)
  })

  it('hides contact sheet and frame media when evidence_integrity is not valid', () => {
    for (const integrity of ['invalid', 'not-verified'] as const) {
      cleanup()
      render(
        <PersonConsistencyPanel
          {...baseProps}
          evidence_integrity={integrity}
          evidence_integrity_label={
            integrity === 'invalid'
              ? '証跡ハッシュ検証: 無効（自動合格にしない）'
              : '証跡ハッシュ検証: 未検証'
          }
        />,
      )
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('link', { name: /人物一貫性コンタクトシート/ }),
      ).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'フレーム詳細' })).not.toBeInTheDocument()
      expect(screen.getByRole('status')).toBeInTheDocument()
      // Status labels still shown
      expect(screen.getByText(/判定: 要レビュー/)).toBeInTheDocument()
    }
  })

  it('shows lazy contact sheet img/link only when evidence_integrity is valid', () => {
    render(<PersonConsistencyPanel {...baseProps} evidence_integrity="valid" />)
    const img = screen.getByRole('img', { name: /人物一貫性コンタクトシート/ })
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(screen.getByRole('heading', { name: 'コンタクトシート' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'フレーム詳細' })).toBeInTheDocument()
  })

  it('exposes landmark headings and non-hover status for a11y', () => {
    render(<PersonConsistencyPanel {...baseProps} />)
    expect(screen.getByRole('heading', { name: '対象人物サマリー' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'コンタクトシート' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'フレーム詳細' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '人の判断' })).toBeInTheDocument()
    expect(screen.getByText(/自動scoreは参考/)).toBeInTheDocument()
  })
})
