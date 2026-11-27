import { useId } from 'react'

import type { SettingsScope } from '@minmo/api-client'

import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { isLocalOwner, repoLabelOf, useReposStore } from '../../store/repos'
import { useSettingsPageStore } from '../../store/settingsPage'
import { ScopeSettings } from './ScopeSettings'

const scopeKeyOf = (s: SettingsScope) => (s.kind === 'global' ? 'global' : s.kind === 'org' ? `org:${s.owner}` : `project:${s.owner}/${s.repo}`)

export function WorkspaceSection() {
  const uid = useId()
  const target = useSettingsPageStore((s) => s.target)
  const scope = useSettingsPageStore((s) => s.scope)
  const setScope = useSettingsPageStore((s) => s.setScope)
  const context = target?.context ?? null
  const projectLabel = useReposStore((s) => (context?.kind === 'project' ? repoLabelOf(s, context.owner, context.repo) : ''))

  // Why: 후보는 연 때의 범위 문맥(store target)에서만 만든다 — 열린 채 고른 이슈가 바뀌어도 그대로다
  const candidates: { scope: SettingsScope; label: string }[] = [{ scope: { kind: 'global' }, label: '전역' }]
  if (context) {
    const owner = context.owner
    candidates.push({ scope: { kind: 'org', owner }, label: isLocalOwner(owner) ? '로컬 저장소 공통' : `조직: ${owner}` })
    if (context.kind === 'project') candidates.push({ scope: context, label: `프로젝트: ${projectLabel}` })
  }
  const scopeKey = scopeKeyOf(scope)

  return (
    <div className="grid gap-4">
      {candidates.length === 1 ? (
        <p className="text-sm font-medium">범위: 전역</p>
      ) : (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span id={`${uid}-scope`} className="text-sm font-medium">
              범위
            </span>
            <RadioGroup
              aria-labelledby={`${uid}-scope`}
              aria-describedby={`${uid}-scope-hint`}
              value={scopeKey}
              onValueChange={(v) => {
                const next = candidates.find((c) => scopeKeyOf(c.scope) === v)
                if (next) setScope(next.scope)
              }}
              className="flex flex-wrap gap-4"
            >
              {candidates.map((c, i) => (
                <div key={scopeKeyOf(c.scope)} className="flex items-center gap-2">
                  <RadioGroupItem id={`${uid}-scope-${i}`} value={scopeKeyOf(c.scope)} />
                  <Label htmlFor={`${uid}-scope-${i}`}>{c.label}</Label>
                </div>
              ))}
            </RadioGroup>
          </div>
          <p id={`${uid}-scope-hint`} className="text-xs text-muted-foreground">
            범위를 바꾸면 저장하지 않은 입력은 사라집니다
          </p>
        </div>
      )}
      {/* Why: 범위마다 새로 마운트한다 — 저장하지 않은 입력·늦게 끝난 이전 범위의 저장 결과가 새 범위에 남지 않는다 */}
      <ScopeSettings key={scopeKey} scope={scope} previewIssue={target?.preview ?? null} />
    </div>
  )
}
