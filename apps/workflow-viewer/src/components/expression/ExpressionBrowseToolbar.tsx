import { Search } from 'lucide-react'

import { expressionRoleLabel, type ExpressionFilters } from './expressionLibraryModel'

export type ExpressionBrowseMode = 'all' | 'executable' | 'reference'

const ROLE_FILTER_OPTIONS: Array<{ value: ExpressionFilters['role']; label: string }> = [
  { value: 'all', label: 'すべての役割' },
  { value: 'full-composition', label: expressionRoleLabel('full-composition') },
  { value: 'auxiliary', label: expressionRoleLabel('auxiliary') },
  { value: 'transition', label: expressionRoleLabel('transition') },
  { value: 'text-overlay', label: expressionRoleLabel('text-overlay') },
  { value: 'data-viz', label: expressionRoleLabel('data-viz') },
  { value: 'code-dev', label: expressionRoleLabel('code-dev') },
  { value: '3d-shader', label: expressionRoleLabel('3d-shader') },
  { value: 'social', label: expressionRoleLabel('social') },
  { value: 'other', label: expressionRoleLabel('other') },
]

export interface ExpressionBrowseToolbarProps {
  searchId: string
  roleFilterId: string
  query: string
  role: ExpressionFilters['role']
  browseMode: ExpressionBrowseMode
  onQueryChange: (value: string) => void
  onRoleChange: (value: ExpressionFilters['role']) => void
  onBrowseModeChange: (mode: ExpressionBrowseMode) => void
}

export function ExpressionBrowseToolbar({
  searchId,
  roleFilterId,
  query,
  role,
  browseMode,
  onQueryChange,
  onRoleChange,
  onBrowseModeChange,
}: ExpressionBrowseToolbarProps) {
  return (
    <div className="launcher-expression-toolbar">
      <label className="launcher-expression-search" htmlFor={searchId}>
        <span>検索</span>
        <span className="launcher-expression-search-field">
          <Search aria-hidden="true" size={14} />
          <input
            id={searchId}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="名前・説明・タグ"
            type="search"
            value={query}
          />
        </span>
      </label>
      <label className="launcher-expression-role-filter" htmlFor={roleFilterId}>
        <span>役割</span>
        <select
          id={roleFilterId}
          onChange={(event) => onRoleChange(event.target.value as ExpressionFilters['role'])}
          value={role}
        >
          {ROLE_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <div aria-label="表示グループ" className="launcher-expression-group-toggle" role="group">
        {(
          [
            ['all', 'すべて'],
            ['executable', 'この環境の仕上げ候補'],
            ['reference', 'アイデアとして参照する表現'],
          ] as const
        ).map(([id, label]) => (
          <button
            aria-pressed={browseMode === id}
            key={id}
            onClick={() => onBrowseModeChange(id)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
