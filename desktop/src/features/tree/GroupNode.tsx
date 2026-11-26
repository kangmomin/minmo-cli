import { ChevronDownIcon, ChevronRightIcon, LayersIcon, PencilIcon } from 'lucide-react'
import { useId, useState } from 'react'

import type { SettingsScope } from '@minmo/api-client'

import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import { useHost } from '../../app/host'
import { isLocalOwner, splitFullName, useReposStore } from '../../store/repos'
import { useUiStore } from '../../store/ui'
import type { PreviewIssue } from '../settings/ScopeSettings'
import { GroupDialog } from './GroupDialog'
import { useOpenWindow } from './openWindow'
import { OpenWindowButton } from './OpenWindowButton'
import { RepoNode } from './RepoNode'

export interface GroupNodeProps {
  id: string
  onOpenSettings(scope: SettingsScope, preview: PreviewIssue | null): void
}

/** 사용자 정의 그룹 노드(#105) — 묶은 저장소를 조직과 관계없이 보인다. "보이는 저장소" 필터는 적용하지 않는다(직접 고른 것) */
export function GroupNode({ id, onOpenSettings }: GroupNodeProps) {
  const group = useReposStore((s) => s.groups[id])
  const local = useReposStore((s) => s.local)
  // 로컬 저장소는 폴더가 있는 호스트를 볼 때만 보인다(트리의 "로컬 저장소" 노드와 같게)
  const hostId = useHost().id
  const nodeId = `group:${id}`
  const expanded = useUiStore((s) => !!s.expanded[nodeId])
  const setExpanded = useUiStore((s) => s.setExpanded)
  const [editing, setEditing] = useState(false)
  const open = useOpenWindow()
  const childrenId = useId()
  if (!group) return null
  const label = group.name
  const openInWindow = open && (() => open({ kind: 'group', id }, label))
  const edit = () => setEditing(true)

  return (
    <div>
      <div className="group flex items-center">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              data-testid={`group-node-${id}`}
              aria-expanded={expanded}
              aria-controls={childrenId}
              onClick={() => setExpanded(nodeId, !expanded)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left text-sm font-medium hover:bg-accent"
            >
              {expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
              <LayersIcon className="size-3.5" />
              <span className="truncate" title={label}>
                {label}
              </span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {openInWindow && <ContextMenuItem onSelect={openInWindow}>새 창으로 열기</ContextMenuItem>}
            <ContextMenuItem onSelect={edit}>그룹 편집…</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {openInWindow && <OpenWindowButton label={label} onClick={openInWindow} />}
        {/* 우클릭 메뉴와 같은 동작의 버튼(AX-01), 이름에 대상을 넣는다(AX-21) */}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`${label} 그룹 편집`}
          title={`${label} 그룹 편집`}
          onClick={edit}
          className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <PencilIcon className="size-3.5" />
        </Button>
      </div>
      <div id={childrenId} hidden={!expanded}>
        {expanded && (
          <div className="ml-3">
            {group.repos.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">저장소 없음 — 그룹 편집에서 고르세요</div>}
            {group.repos.map((full) => {
              const [owner, name] = splitFullName(full)
              if (isLocalOwner(owner) && local[name]?.hostId !== hostId) return null
              return <RepoNode key={full} repo={{ owner, name, defaultBranch: '' }} onOpenSettings={onOpenSettings} />
            })}
          </div>
        )}
      </div>
      <GroupDialog id={id} open={editing} onOpenChange={setEditing} />
    </div>
  )
}
