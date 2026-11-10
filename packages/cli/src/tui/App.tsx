// 전체 화면 TUI: 왼쪽 트리(보일 저장소 필터) · 오른쪽 상세(worktree·준비 로그·설정) · 아래 키 안내.
// tmux·편집기로 넘어갈 때는 화면을 내리고(onExit) 돌아오면 snapshot 으로 같은 상태를 다시 그린다.
import { Box, Text, useApp, useInput } from 'ink'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError } from '@minmo/api-client'
import { isOwnerAllSelected, toggleOwnerAll, toggleRepo, worktreeId } from '@minmo/core'
import type { GitHubRepo, IssueTarget, RepoSelection, SetupLogEvent } from '@minmo/core'

import { loadSelection } from '../commands/issues'
import { SOURCE_LABEL } from '../backend'
import { serverErrorMessage } from '../context'
import type { Ctx } from '../context'
import { NOTES_SERVER_ONLY } from '../errors'
import { terminalLabel } from '../host/terminal'
import { describeServer } from '../server'
import { reloadState } from '../store'
import { buildRows, expandSelection } from './model'
import type { IssueItem, Row, TreeData } from './model'

export type Snapshot = {
  data: TreeData
  sel: RepoSelection
  expanded: string[]
  cursorId: string | null
  showAll: boolean
  search: string
  message: string
}

export type ExitResult =
  | { kind: 'quit' }
  | { kind: 'attach'; path: string; title: string; snapshot: Snapshot }
  | { kind: 'note'; target: IssueTarget; snapshot: Snapshot }

export interface AppProps {
  ctx: Ctx
  /** 서버 모드의 로그인 이름(로컬 모드는 null) */
  login: string | null
  initial?: Snapshot
  onExit(r: ExitResult): void
  /** 터미널 높이(테스트 주입용) */
  rows?: number
}

type Mode = { kind: 'normal' } | { kind: 'search' } | { kind: 'confirm'; text: string; run(): Promise<void> }

const errText = (e: unknown, ctx: Ctx) => (e instanceof ApiError ? serverErrorMessage(e, ctx.server) : e instanceof Error ? e.message : String(e))

const targetOf = (repo: GitHubRepo, i: IssueItem): IssueTarget => ({ owner: repo.owner, repo: repo.name, key: i.key, number: i.number, title: i.number === null ? '' : i.title })

export function App({ ctx, login, initial, onExit, rows: termRows }: AppProps) {
  const { exit } = useApp()
  const [data, setData] = useState<TreeData>(initial?.data ?? { owners: [], repos: {}, issues: {} })
  const [sel, setSel] = useState<RepoSelection>(initial?.sel ?? null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initial?.expanded ?? []))
  const [cursorId, setCursorId] = useState<string | null>(initial?.cursorId ?? null)
  const [showAll, setShowAll] = useState(initial?.showAll ?? false)
  const [search, setSearch] = useState(initial?.search ?? '')
  const [mode, setMode] = useState<Mode>({ kind: 'normal' })
  const [message, setMessage] = useState(initial?.message ?? '')
  const [logs, setLogs] = useState<string[]>([])
  const [detail, setDetail] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [worktrees, setWorktrees] = useState({ ...ctx.state.worktrees })
  const [loaded, setLoaded] = useState(initial !== undefined)

  const syncWorktrees = () => setWorktrees({ ...ctx.state.worktrees })

  const loadRepos = useCallback(
    async (ownerLogin: string) => {
      const owner = data.owners.find((o) => o.login === ownerLogin)
      if (!owner) return
      setData((d) => ({ ...d, repos: { ...d.repos, [ownerLogin]: 'loading' } }))
      try {
        const repos = await ctx.github.listRepos(owner)
        setData((d) => ({ ...d, repos: { ...d.repos, [ownerLogin]: repos } }))
      } catch (e) {
        setData((d) => ({ ...d, repos: { ...d.repos, [ownerLogin]: { error: errText(e, ctx) } } }))
      }
    },
    [ctx, data.owners],
  )

  const loadIssues = useCallback(
    async (repo: GitHubRepo) => {
      const key = `${repo.owner}/${repo.name}`
      setData((d) => ({ ...d, issues: { ...d.issues, [key]: 'loading' } }))
      try {
        const prefix = worktreeId(repo.owner, repo.name, '')
        const local = Object.keys(ctx.state.worktrees)
          .filter((id) => id.startsWith(prefix))
          .map((id) => Number(id.slice(prefix.length)))
          .filter((n) => Number.isInteger(n) && n > 0)
        const list = await ctx.github.listIssues(repo.owner, repo.name, { ensureNumbers: local })
        const items: IssueItem[] = [
          { key: 'etc', number: null, title: '★기타', state: 'open' },
          ...list.sort((a, b) => b.number - a.number).map((i) => ({ key: String(i.number), number: i.number, title: i.title, state: i.state })),
        ]
        setData((d) => ({ ...d, issues: { ...d.issues, [key]: items } }))
      } catch (e) {
        setData((d) => ({ ...d, issues: { ...d.issues, [key]: { error: errText(e, ctx) } } }))
      }
    },
    [ctx],
  )

  const refresh = useCallback(async () => {
    setMessage('불러오는 중…')
    try {
      const [owners, selection] = await Promise.all([ctx.github.listOwners(), loadSelection(ctx)])
      setData({ owners, repos: {}, issues: {} })
      setSel(selection)
      setMessage('')
    } catch (e) {
      setMessage(errText(e, ctx))
    }
    setLoaded(true)
  }, [ctx])

  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])

  // 펼친 노드의 데이터가 없으면 불러온다(새로고침·검색 후 포함)
  useEffect(() => {
    for (const o of data.owners) if ((expanded.has(`o:${o.login}`) || search !== '') && data.repos[o.login] === undefined) void loadRepos(o.login)
    for (const id of expanded) {
      if (!id.startsWith('r:')) continue
      const [owner, name] = id.slice(2).split('/')
      const repos = data.repos[owner]
      const repo = Array.isArray(repos) ? repos.find((r) => r.name === name) : undefined
      if (repo && data.issues[`${owner}/${name}`] === undefined) void loadIssues(repo)
    }
  }, [data, expanded, search, loadRepos, loadIssues])

  const rows = useMemo(() => buildRows(data, { sel, showAll, expanded, search, worktrees }), [data, sel, showAll, expanded, search, worktrees])
  const cursor = Math.max(0, rows.findIndex((r) => r.id === cursorId))
  const row: Row | undefined = rows[cursor]

  const snapshot = (): Snapshot => ({ data, sel, expanded: [...expanded], cursorId: row?.id ?? null, showAll, search, message: '' })
  const quit = (r: ExitResult) => {
    onExit(r)
    exit()
  }

  const toggleExpand = (id: string, on?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (on ?? !next.has(id)) next.add(id)
      else next.delete(id)
      return next
    })

  async function prepare(t: IssueTarget): Promise<string | null> {
    setBusy(true)
    setLogs([])
    setDetail(null)
    ctx.onLog((e: SetupLogEvent) => setLogs((l) => [...l.slice(-50), `${e.status === 'error' ? '✗' : e.status === 'ok' ? '✓' : '·'} ${e.step}${e.message ? ` ${e.message}` : ''}`]))
    try {
      const res = await ctx.worktree.openIssue(t)
      syncWorktrees()
      setMessage(`${res.created ? '준비됨' : '이미 있음'}: ${res.path}${res.script.status === 'failed' ? ' (생성 후 스크립트 실패)' : ''}`)
      return res.path
    } catch (e) {
      setMessage(errText(e, ctx))
      return null
    } finally {
      ctx.onLog(null)
      setBusy(false)
    }
  }

  async function saveSelection(change: (cur: string[] | null) => string[] | null) {
    try {
      setSel(await ctx.data.updateSelection(change))
      setMessage(ctx.mode === 'local' ? '보일 저장소를 저장했습니다(이 기기 로컬)' : '보일 저장소를 저장했습니다(데스크탑에도 반영)')
    } catch (e) {
      setMessage(errText(e, ctx))
    }
  }

  async function showSettings(repo: GitHubRepo) {
    try {
      const eff = await ctx.data.getEffective(repo.owner, repo.name)
      setDetail([
        `설정 — ${repo.owner}/${repo.name} (값 · 출처)`,
        ...Object.entries(eff.values).map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 60)} · ${SOURCE_LABEL[eff.sources[k as keyof typeof eff.sources]]}`),
        '',
        `바꾸려면: minmo config set <key> <value> --project owner/repo${ctx.mode === 'local' ? ' (로컬 값)' : ''}`,
      ])
    } catch (e) {
      setMessage(errText(e, ctx))
    }
  }

  useInput((input, key) => {
    if (busy) return
    if (mode.kind === 'search') {
      if (key.escape) {
        setSearch('')
        setMode({ kind: 'normal' })
      } else if (key.return) setMode({ kind: 'normal' })
      else if (key.backspace || key.delete) setSearch((s) => s.slice(0, -1))
      else if (input && !key.ctrl) setSearch((s) => s + input)
      return
    }
    if (mode.kind === 'confirm') {
      if (input === 'y') {
        setMode({ kind: 'normal' })
        setBusy(true)
        void mode.run().finally(() => setBusy(false))
      } else if (input === 'n' || key.escape) {
        setMode({ kind: 'normal' })
        setMessage('취소했습니다')
      }
      return
    }

    if (input === 'q') return quit({ kind: 'quit' })
    if (key.upArrow || input === 'k') return setCursorId(rows[Math.max(0, cursor - 1)]?.id ?? null)
    if (key.downArrow || input === 'j') return setCursorId(rows[Math.min(rows.length - 1, cursor + 1)]?.id ?? null)
    if (input === '/') return setMode({ kind: 'search' })
    if (input === 'a') {
      setShowAll((v) => !v)
      return setMessage(showAll ? '보일 저장소만 표시' : '숨긴 저장소도 표시 — f 로 보이기/숨기기')
    }
    if (input === 'r') {
      // 다른 SSH 세션·tmux 패널의 minmo 가 바꾼 worktree·로컬 값도 다시 읽는다
      return void reloadState(ctx.paths, ctx.state, ctx.config)
        .catch(() => undefined)
        .then(() => {
          syncWorktrees()
          return refresh()
        })
    }
    if (!row) return

    if ((key.leftArrow || input === 'h') && row.kind !== 'issue' && row.kind !== 'note' && row.expanded) return toggleExpand(row.id, false)
    if (key.leftArrow || input === 'h') {
      // 부모로 이동
      for (let i = cursor - 1; i >= 0; i--) if (rows[i].depth < row.depth) return setCursorId(rows[i].id)
      return
    }
    if (row.kind === 'owner' || row.kind === 'repo') {
      if (key.rightArrow || key.return || input === 'l') return toggleExpand(row.id, key.rightArrow || input === 'l' ? true : undefined)
      if (input === 'f') {
        const owners = data.owners.map((o) => o.login)
        const reposOf = (owner: string) => {
          const r = data.repos[owner]
          return Array.isArray(r) ? r.map((x) => x.name) : undefined
        }
        if (row.kind === 'owner') {
          const login = row.owner.login
          // 조직 전체가 보이는 중이면 숨기고(다른 조직은 그대로), 아니면 조직 전체를 보이게
          return void saveSelection((s) =>
            isOwnerAllSelected(s, login) ? toggleOwnerAll(expandSelection(s, owners, login, undefined), login, false) : toggleOwnerAll(s ?? [], login, true),
          )
        }
        const { owner, name } = row.repo
        return void saveSelection((s) =>
          row.hidden ? toggleRepo(s ?? [], owner, name, true) : toggleRepo(expandSelection(s, owners, owner, reposOf(owner)), owner, name, false),
        )
      }
      if (input === 's' && row.kind === 'repo') return void showSettings(row.repo)
      return
    }
    if (row.kind !== 'issue') return
    const t = targetOf(row.repo, row.issue)
    if (key.return) return void prepare(t)
    if (input === 's') return void showSettings(row.repo)
    if (input === 't') {
      void (async () => {
        const path = row.worktree?.path ?? (await prepare(t))
        if (path) quit({ kind: 'attach', path, title: `${t.repo}#${t.key}`, snapshot: snapshot() })
      })()
      return
    }
    if (input === 'n') return ctx.mode === 'local' ? setMessage(NOTES_SERVER_ONLY) : quit({ kind: 'note', target: t, snapshot: snapshot() })
    if (input === 'd') {
      if (t.key === 'etc') return setMessage('★기타 worktree 는 삭제하지 않습니다')
      if (!row.worktree) return setMessage('이 기기에 worktree 가 없습니다')
      void (async () => {
        try {
          const c = await ctx.worktree.inspect(t)
          const warn = [c.uncommitted ? `미커밋 ${c.uncommitted}` : '', c.unpushed ? `미push ${c.unpushed}` : '', c.uncommitted === null || c.unpushed === null ? '확인 실패' : '']
            .filter(Boolean)
            .join(', ')
          setMode({
            kind: 'confirm',
            text: `#${t.key} worktree 와 그 안의 터미널·프로세스를 지울까요?${warn ? ` (${warn})` : ''} y/n`,
            run: async () => {
              try {
                await ctx.worktree.deleteWorktree(t, { confirmed: true })
                syncWorktrees()
                setMessage(`삭제했습니다: #${t.key}`)
              } catch (e) {
                setMessage(errText(e, ctx))
              }
            },
          })
        } catch (e) {
          setMessage(errText(e, ctx))
        }
      })()
    }
  })

  // 커서가 보이도록 스크롤
  const height = Math.max(5, (termRows ?? process.stdout.rows ?? 24) - 6)
  const start = Math.min(Math.max(0, cursor - Math.floor(height / 2)), Math.max(0, rows.length - height))
  const visible = rows.slice(start, start + height)

  const label = (r: Row): string => {
    switch (r.kind) {
      case 'owner':
        return `${r.expanded ? '▾' : '▸'} ${r.owner.login}`
      case 'repo':
        return `${r.expanded ? '▾' : '▸'} ${r.repo.name}${r.worktrees > 0 ? ` ●${r.worktrees}` : ''}${r.hidden ? ' (숨김)' : ''}`
      case 'issue':
        return `${r.worktree ? '●' : ' '} ${r.issue.number === null ? r.issue.title : `#${r.issue.number} ${r.issue.title}`}${r.issue.state === 'closed' ? ' [closed]' : ''}`
      case 'note':
        return r.text
    }
  }

  const detailLines: string[] =
    detail ??
    (row?.kind === 'issue'
      ? [
          row.issue.number === null ? `${row.repo.owner}/${row.repo.name} ★기타` : `${row.repo.owner}/${row.repo.name}#${row.issue.number}`,
          row.issue.title,
          '',
          row.worktree ? `브랜치 ${row.worktree.branch}` : 'worktree 없음 — Enter 로 준비',
          row.worktree ? row.worktree.path : '',
          '',
          ...logs.slice(-10),
        ]
      : row?.kind === 'repo'
        ? [`${row.repo.owner}/${row.repo.name}`, `기본 브랜치 ${row.repo.defaultBranch}`, row.hidden ? '보일 저장소에서 빠져 있음(f 로 추가)' : '']
        : [])

  const hints =
    mode.kind === 'search'
      ? `검색: ${search}▏  Enter 적용 · Esc 지우기`
      : mode.kind === 'confirm'
        ? mode.text
        : `↑↓ 이동 · Enter 열기/준비 · t 터미널(${terminalLabel()}) · n 메모 · d 삭제 · f 보이기/숨기기 · a 숨긴 것 보기 · s 설정 · / 검색 · r 새로고침 · q 종료`

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>minmo</Text> <Text dimColor>· {ctx.mode === 'local' ? '로컬 모드(서버 없이)' : `${login ?? ''} · ${ctx.server.kind === 'socket' ? '역터널 소켓' : describeServer(ctx.server)}`}{sel === null ? '' : ' · 보일 저장소 필터'}{showAll ? ' · 숨긴 것 포함' : ''}{search ? ` · 검색 "${search}"` : ''}</Text>
      </Text>
      <Box>
        <Box flexDirection="column" width="50%" borderStyle="round" paddingX={1}>
          {!loaded && <Text dimColor>불러오는 중…</Text>}
          {loaded && rows.length === 0 && <Text dimColor>표시할 저장소가 없습니다 — a 로 숨긴 저장소를 보거나 `minmo repos add`</Text>}
          {visible.map((r) => (
            <Text key={r.id} inverse={r.id === row?.id} wrap="truncate-end">
              {'  '.repeat(r.depth)}
              {label(r)}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" width="50%" borderStyle="round" paddingX={1}>
          {detailLines.map((l, i) => (
            <Text key={i} wrap="truncate-end">
              {l || ' '}
            </Text>
          ))}
        </Box>
      </Box>
      <Text color={mode.kind === 'confirm' ? 'yellow' : undefined} dimColor={mode.kind === 'normal'}>
        {busy ? '작업 중…' : hints}
      </Text>
      {message !== '' && <Text>{message}</Text>}
    </Box>
  )
}
