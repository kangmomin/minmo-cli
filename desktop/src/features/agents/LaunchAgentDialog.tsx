// [에이전트 실행] — 에이전트와 지시문을 정하면 이슈의 새 터미널 패널에서 그 명령을 실행한다.
// 실행한 뒤의 진행은 에이전트 현황(상태·하위 에이전트·알림)으로 본다.
import { useId, useState } from 'react'
import type { FormEvent } from 'react'

import type { IssueTarget } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { useHost } from '../../app/host'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { Textarea } from '../../components/ui/textarea'
import { useUiStore } from '../../store/ui'
import { DEFAULT_AGENT_COMMANDS, LAUNCH_KINDS, LAUNCH_LABEL, PROMPT_SLOT, buildCommand, defaultPrompt } from './launch'
import type { LaunchKind, ShellKind } from './launch'
import { queueLaunch } from './launchQueue'

export interface LaunchAgentDialogProps {
  issueId: string
  target: IssueTarget
  open: boolean
  onOpenChange(open: boolean): void
}

export function LaunchAgentDialog({ issueId, target, open, onOpenChange }: LaunchAgentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>에이전트 실행</DialogTitle>
          <DialogDescription>이 이슈의 작업 폴더에서 새 터미널 패널을 열어 에이전트를 실행합니다. 진행 상황은 에이전트 현황과 알림으로 볼 수 있습니다.</DialogDescription>
        </DialogHeader>
        {open && <LaunchBody issueId={issueId} target={target} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function LaunchBody({ issueId, target, onDone }: { issueId: string; target: IssueTarget; onDone(): void }) {
  const uid = useId()
  const host = useHost()
  const { platform } = useDeps()
  // 이 PC(Windows)의 터미널은 PowerShell, 원격 호스트와 macOS·Linux 는 POSIX 셸이다
  const shell: ShellKind = host.alias === null && platform === 'win32' ? 'powershell' : 'posix'
  const commands = useUiStore((s) => s.agentCommands)
  const [kind, setKind] = useState<LaunchKind>(() => useUiStore.getState().lastLaunchKind)
  const [template, setTemplate] = useState(() => commands[kind])
  const [prompt, setPrompt] = useState(() => defaultPrompt(target))

  const built = buildCommand(template, prompt, shell)

  function pick(next: LaunchKind) {
    setKind(next)
    setTemplate(useUiStore.getState().agentCommands[next])
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!built.ok) return
    const ui = useUiStore.getState()
    // 고친 명령 틀과 고른 에이전트는 다음에도 쓰게 저장한다
    ui.setAgentCommand(kind, template.trim())
    ui.setLastLaunchKind(kind)
    // 원격 호스트의 첫 패널은 남아 있던 tmux 세션에 다시 붙는다 → 항상 새 패널에서 실행한다
    const paneId = ui.launchPane(issueId, host.alias !== null)
    queueLaunch(paneId, built.command)
    ui.setTab('terminal')
    onDone()
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <RadioGroup aria-label="에이전트" value={kind} onValueChange={(v) => pick(v as LaunchKind)} className="flex flex-wrap gap-4">
        {LAUNCH_KINDS.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <RadioGroupItem id={`${uid}-${k}`} value={k} />
            <Label htmlFor={`${uid}-${k}`}>{LAUNCH_LABEL[k]}</Label>
          </div>
        ))}
      </RadioGroup>
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-prompt`}>지시문</Label>
        <Textarea id={`${uid}-prompt`} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="에이전트에게 맡길 일(비워 두면 에이전트만 띄웁니다)" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-cmd`}>명령</Label>
        <div className="flex gap-2">
          <Input id={`${uid}-cmd`} value={template} onChange={(e) => setTemplate(e.target.value)} spellCheck={false} className="font-mono" placeholder={`my-agent ${PROMPT_SLOT}`} />
          {kind !== 'custom' && template.trim() !== DEFAULT_AGENT_COMMANDS[kind] && (
            <Button type="button" variant="outline" onClick={() => setTemplate(DEFAULT_AGENT_COMMANDS[kind])}>
              기본값
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          <code>{PROMPT_SLOT}</code> 자리에 지시문이 들어갑니다. 고친 명령은 저장되어 다음에도 쓰입니다.
        </p>
      </div>
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">터미널에서 실행할 명령</span>
        {built.ok ? (
          <code className="max-h-24 overflow-y-auto break-all rounded bg-muted px-2 py-1 font-mono text-xs" data-testid="launch-preview">
            {built.command}
          </code>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {built.error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={!built.ok}>
          실행
        </Button>
      </DialogFooter>
    </form>
  )
}
