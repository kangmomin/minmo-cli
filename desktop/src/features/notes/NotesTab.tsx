import { useId } from 'react'

import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Textarea } from '../../components/ui/textarea'
import { useSessionStore } from '../../store/session'
import { useNotes } from './useNotes'

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

function failureText(code: string): string {
  if (code === 'body_too_large') return '저장 실패 — 메모가 1 MiB 를 넘습니다'
  if (code === 'conflict') return '저장 보류 — 충돌 해결 필요'
  return `저장 실패(${code})`
}

/** 메모 탭 (F-06) — 마크다운 텍스트 편집, 1초 디바운스 자동 저장 */
export function NotesTab({ owner, repo, issueKey }: NotesTabProps) {
  const n = useNotes(owner, repo, issueKey)
  const id = useId()
  const offline = useSessionStore((s) => s.status === 'offline')
  const save = n.saveState

  return (
    // textarea 가 없거나(불러오는 중) disabled(서버 연결 필요)면 포커스 가능한 내용이 없으므로 이 영역이 Tab 정지점이 된다.
    // 편집 가능해지면 -1 로 두어 이미 이 영역에 있던 포커스가 사라지지 않게 한다(CR-20)
    <div
      tabIndex={n.disabled ? 0 : -1}
      className="flex h-full flex-col gap-2 p-3 outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-medium">
          메모
        </label>
        {/* live region 은 role 을 바꾸지 않는다: status 컨테이너는 항상 두고(고정 문구 "저장됨"만), 실패는 새 alert 노드를 삽입해 즉시 알린다.
            "저장 중…" 은 낭독하지 않고(타이핑마다 반복되므로), 저장 시각은 live 밖의 보이는 텍스트로 둔다(AX-20, AX-27) */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {save.kind === 'saving' && <span aria-hidden="true">저장 중…</span>}
          <span data-testid="notes-status" data-state={save.kind} role="status">
            {save.kind === 'saved' ? '저장됨' : ''}
          </span>
          {save.kind === 'saved' && save.updatedAt && <span>{formatTime(save.updatedAt)}</span>}
          {save.kind === 'failed' && (
            <span role="alert" className="text-destructive">
              {failureText(save.code)}
            </span>
          )}
        </div>
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
