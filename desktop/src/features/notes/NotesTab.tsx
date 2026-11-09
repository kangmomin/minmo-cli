import { useId } from 'react'

import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Textarea } from '../../components/ui/textarea'
import { useSessionStore } from '../../store/session'
import { useNotes } from './useNotes'
import type { NotesSaveState } from './useNotes'

export interface NotesTabProps {
  owner: string
  repo: string
  /** 이슈 번호 문자열 또는 'etc' */
  issueKey: string
}

const formatTime = (ts: string | null) => {
  if (!ts) return ''
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString()
}

function statusText(s: NotesSaveState): string {
  switch (s.kind) {
    case 'idle':
      return ''
    case 'saving':
      return '저장 중…'
    case 'saved':
      return s.updatedAt ? `저장됨 ${formatTime(s.updatedAt)}` : '저장됨'
    case 'failed':
      if (s.code === 'body_too_large') return '저장 실패 — 메모가 1 MiB 를 넘습니다'
      if (s.code === 'conflict') return '저장 보류 — 충돌 해결 필요'
      return `저장 실패(${s.code})`
  }
}

/** 메모 탭 (F-06) — 마크다운 텍스트 편집, 1초 디바운스 자동 저장 */
export function NotesTab({ owner, repo, issueKey }: NotesTabProps) {
  const n = useNotes(owner, repo, issueKey)
  const id = useId()
  const offline = useSessionStore((s) => s.status === 'offline')

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-medium">
          메모
        </label>
        <span
          data-testid="notes-status"
          data-state={n.saveState.kind}
          // 저장 진행·완료는 polite, 실패는 즉시 알린다(AX)
          role={n.saveState.kind === 'failed' ? 'alert' : 'status'}
          className={n.saveState.kind === 'failed' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
        >
          {statusText(n.saveState)}
        </span>
      </div>
      {n.isLoading ? (
        <p className="text-sm text-muted-foreground">{offline ? '서버 연결 필요 — 연결되면 메모를 불러옵니다' : '불러오는 중…'}</p>
      ) : (
        <NotesEditor id={id} {...n} />
      )}

      <Dialog open={n.conflict !== null}>
        <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>다른 기기에서 수정됨</DialogTitle>
            <DialogDescription>이 메모가 다른 곳에서 먼저 저장되었습니다. 어느 내용을 남길지 선택하세요.</DialogDescription>
          </DialogHeader>
          {n.conflict && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{n.conflict.body || '(빈 메모)'}</pre>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={n.loadServer}>
              서버 내용 불러오기
            </Button>
            <Button onClick={n.overwrite}>내 내용으로 덮어쓰기</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NotesEditor({ id, body, setBody, disabled }: { id: string } & ReturnType<typeof useNotes>) {
  return (
    <Textarea
      id={id}
      value={body}
      disabled={disabled}
      onChange={(e) => setBody(e.target.value)}
      placeholder={disabled ? '' : '마크다운으로 메모를 작성하세요'}
      className="min-h-0 flex-1 resize-none font-mono"
      spellCheck={false}
    />
  )
}
