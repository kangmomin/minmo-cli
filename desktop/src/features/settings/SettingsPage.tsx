import { XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'

import { useBaseDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { useSettingsPageStore } from '../../store/settingsPage'
import { CliAccessSettings } from '../cli/CliAccessSettings'
import { HostsSettings } from '../hosts/HostsSettings'
import { PairSyncSection } from '../pairSync/PairSyncSection'
import { RemoteAccessSettings } from '../remote/RemoteAccessSettings'
import { ServerSettingsForm } from '../server/ServerSettingsDialog'
import { useNarrow, useTouch } from '../terminal/TerminalKeyBar'
import { AgentCommandsSection, AppearanceSection, NotifySection } from './PreferenceSections'
import { filterSections, visibleSections } from './sections'
import type { SectionId } from './sections'
import { WorkspaceSection } from './WorkspaceSection'

// Why: 공용 Dialog·Tabs 의 기본 모양(가운데 작은 창·가로 알약 탭)을 이 화면에서만 덮어쓴다 — components/ui 는 그대로 둔다
const CONTENT_CLASS = 'left-0 top-0 translate-x-0 translate-y-0 h-dvh max-h-none w-full max-w-none sm:max-w-none rounded-none border-0 p-0 gap-0 overflow-hidden flex flex-col'
const TABS_CLASS = 'min-h-0 flex-1 flex-row gap-0 max-md:flex-col'
const SIDE_CLASS = 'flex flex-col gap-2 border-b p-3 md:min-h-0 md:w-60 md:border-r md:border-b-0 max-md:shrink-0'
const LIST_CLASS = 'justify-start p-1 md:h-auto md:w-full md:min-h-0 md:flex-1 md:flex-col md:items-stretch md:overflow-y-auto max-md:w-full max-md:max-w-full max-md:overflow-x-auto'
// Why: 기본 h-full 은 세로 목록에서 탭마다 목록 전체 높이가 된다
const TRIGGER_CLASS = 'md:h-auto md:flex-none md:justify-start md:rounded-l-none md:border-l-2 md:data-[state=active]:border-l-primary data-[state=active]:font-semibold'
const PANEL_CLASS = 'min-h-0 overflow-y-auto p-4 md:p-6'

function ServerSection() {
  // Why: 서버는 이 PC 에서 돈다 — 원격 호스트 영역 안에서도 이 PC 의 tauri 로 읽고 저장한다
  const { tauri } = useBaseDeps()
  return <ServerSettingsForm tauri={tauri} />
}

const SECTION_BODY: Record<SectionId, ComponentType> = {
  appearance: AppearanceSection,
  notify: NotifySection,
  agents: AgentCommandsSection,
  workspace: WorkspaceSection,
  sync: PairSyncSection,
  hosts: HostsSettings,
  remote: RemoteAccessSettings,
  cli: CliAccessSettings,
  server: ServerSection,
}

export function SettingsPage() {
  const open = useSettingsPageStore((s) => s.open)
  const close = useSettingsPageStore((s) => s.close)
  const touch = useTouch()
  // Why: 열린 채 Workspace 가 내려가면(세션 만료·재연결) 닫는다 — 다시 그려져도 저절로 열리지 않게
  useEffect(() => () => close(), [close])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        showCloseButton={false}
        className={CONTENT_CLASS}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const toTab = useSettingsPageStore.getState().focusSection || touch
          // Why: 터치 기기에서 검색창에 포커스하면 화면 키보드가 내용을 가린다
          const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(toTab ? '[role="tab"][aria-selected="true"]' : 'input[type="search"]')
          el?.focus()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const { opener } = useSettingsPageStore.getState()
          // Why: DialogTrigger 로 열지 않아 Radix 가 되돌릴 곳을 모른다 — 연 요소가 사라졌으면 상단 ⚙ 로
          const el = opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-settings-trigger]')
          el?.focus()
        }}
        onEscapeKeyDown={(e) => {
          // Why: 한글 조합 중 Esc 는 조합만 끝낸다 — 설정까지 닫으면 쓰던 검색어가 사라진다
          if (e.isComposing || e.keyCode === 229) e.preventDefault()
        }}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
          <DialogTitle asChild>
            <h1>설정</h1>
          </DialogTitle>
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="닫기">
              <XIcon />
            </Button>
          </DialogClose>
        </div>
        <DialogDescription className="sr-only">분류를 고르거나 검색해 설정을 바꿉니다. Esc 로 닫습니다.</DialogDescription>
        <SettingsBody />
      </DialogContent>
    </Dialog>
  )
}

function SettingsBody() {
  const runtime = useBaseDeps().tauri.runtime
  const section = useSettingsPageStore((s) => s.section)
  const setSection = useSettingsPageStore((s) => s.setSection)
  const narrow = useNarrow()
  const [query, setQuery] = useState('')
  // Why: 목록에 쓴 검색어 — 조합 중 글자(ㅍ)만으로 결과가 0 이 되면 바꾸지 않아 직전 목록을 둔다
  const [held, setHeld] = useState('')
  const [composing, setComposing] = useState(false)

  const all = visibleSections(runtime)
  const list = filterSections(all, held)
  const switchTo = list.length > 0 && !list.some((s) => s.id === section) ? list[0].id : null
  // Why: 조합 중에 보이는 분류를 바꾸면 글자마다 내용이 바뀐다 — 조합이 끝난 뒤 첫 결과로 옮긴다
  useEffect(() => {
    if (!composing && switchTo) setSection(switchTo)
  }, [composing, switchTo, setSection])

  const change = (value: string, isComposing: boolean) => {
    setQuery(value)
    if (!isComposing || filterSections(all, value).length > 0) setHeld(value)
  }

  return (
    <Tabs
      value={section}
      onValueChange={(v) => setSection(v as SectionId)}
      orientation={narrow ? 'horizontal' : 'vertical'}
      activationMode="manual"
      className={TABS_CLASS}
    >
      <div className={SIDE_CLASS}>
        <Input
          type="search"
          aria-label="설정 검색"
          placeholder="검색…"
          value={query}
          onChange={(e) => change(e.target.value, composing)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => {
            setComposing(false)
            change(e.currentTarget.value, false)
          }}
        />
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {list.length > 0 ? `분류 ${list.length}개` : '일치하는 설정이 없습니다'}
        </p>
        {list.length > 0 && (
          <TabsList aria-label="설정 분류" className={LIST_CLASS}>
            {list.map((s) => (
              <TabsTrigger key={s.id} value={s.id} className={TRIGGER_CLASS}>
                {s.title}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      </div>
      {/* Why: 검색과 무관한 목록으로 그려 키가 그대로다 — 목록이 걸러져도 보이는 내용이 다시 마운트되지 않는다 */}
      {list.length > 0 &&
        all.map((s) => {
          const Body = SECTION_BODY[s.id]
          return (
            <TabsContent key={s.id} value={s.id} tabIndex={-1} className={PANEL_CLASS}>
              <div className="grid max-w-3xl gap-4">
                <h2 className="text-lg font-semibold">{s.title}</h2>
                <Body />
              </div>
            </TabsContent>
          )
        })}
    </Tabs>
  )
}
