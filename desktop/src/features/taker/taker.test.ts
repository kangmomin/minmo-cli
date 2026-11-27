// 이슈 테이커 순수 로직 — 지시문 치환, 위험 옵션, 후보 고르기, 단계 검사, 시작 순서, 명령 넣기·단계 끝 판정
import { describe, expect, it } from 'vitest'

import type { RecentIssue } from '@minmo/core'

import { buildCommand, defaultPrompt } from '../agents/launch'
import {
  TAKER_CHECK_MS,
  TAKER_EXIT_QUIET_MS,
  TAKER_MAX_ACTIVE,
  TAKER_START_TIMEOUT_MS,
  canWrite,
  isActive,
  nextToStart,
  pickCandidates,
  renderPrompt,
  riskyFlags,
  stepProgress,
  validateSteps,
} from './taker'
import type { TakerAuthor, TakerRun, TakerStatus, TakerStep } from './takerStore'

const URL42 = 'https://github.com/acme/app/issues/42'

const issue = (n: number, o: Partial<RecentIssue> = {}): RecentIssue => ({
  number: n,
  title: `Issue ${n}`,
  state: 'open',
  htmlUrl: `https://github.com/acme/app/issues/${n}`,
  assignees: [],
  author: 'me',
  authorAssociation: 'OWNER',
  ...o,
})

const run = (id: string, status: TakerStatus, o: Partial<TakerRun> = {}): TakerRun => ({
  id,
  repoKey: 'acme/app',
  owner: 'acme',
  repo: 'app',
  number: 1,
  title: 't',
  url: '',
  issueId: null,
  steps: [],
  step: 0,
  status,
  paneId: null,
  assigned: false,
  note: null,
  error: null,
  foundAt: 0,
  updatedAt: 0,
  ...o,
})

describe('상수', () => {
  it('AC-04 새 이슈는 5분마다 확인한다', () => {
    expect(TAKER_CHECK_MS).toBe(300_000)
  })

  it('AC-09 동시에 도는 실행은 3개까지', () => {
    expect(TAKER_MAX_ACTIVE).toBe(3)
  })

  it('EC-29 셸만 남고 6초(프로세스 확인 2번) 잠잠해야 한다', () => {
    expect(TAKER_EXIT_QUIET_MS).toBe(6000)
  })

  it('EC-05 명령을 넣고 120초 안에 프로그램이 보여야 한다', () => {
    expect(TAKER_START_TIMEOUT_MS).toBe(120_000)
  })
})

describe('renderPrompt — 지시문 자리표시', () => {
  const ISSUE = { number: 42, title: 'Add login', url: URL42 }

  it('AC-15 {issue} 는 [에이전트 실행] 의 기본 지시문과 같은 "#번호 제목 (URL)"', () => {
    expect(renderPrompt('/common:ready-for-impl {issue}', ISSUE)).toBe(
      `/common:ready-for-impl ${defaultPrompt({ owner: 'acme', repo: 'app', key: '42', number: 42, title: 'Add login' })}`,
    )
    expect(renderPrompt('{issue}', ISSUE)).toBe(`#42 Add login (${URL42})`)
  })

  it('AC-15 {number}·{title}·{url} 은 각 값으로, 여러 번 나와도 모두 바뀐다', () => {
    expect(renderPrompt('{number}|{title}|{url}|{number}', ISSUE)).toBe(`42|Add login|${URL42}|42`)
  })

  it('AC-15 한 번에 바꾼다 — 제목 안의 {url}·{number} 글자는 다시 바뀌지 않는다', () => {
    const tricky = { ...ISSUE, title: 'Fix {url} and {number}' }
    expect(renderPrompt('{title} @ {url}', tricky)).toBe(`Fix {url} and {number} @ ${URL42}`)
    expect(renderPrompt('{issue}', tricky)).toBe(`#42 Fix {url} and {number} (${URL42})`)
  })
})

describe('riskyFlags — 권한 확인을 건너뛰는 옵션', () => {
  it.each(['--dangerously-skip-permissions', '--permission-mode bypassPermissions', '--yolo', '-y', '--full-auto', '--dangerously-bypass-approvals-and-sandbox'])(
    'EC-08 명령에 %s 가 있으면 찾는다',
    (flag) => {
      expect(riskyFlags(`claude ${flag} {prompt}`)).toEqual([flag])
    },
  )

  it('EC-08 권한 확인을 건너뛰지 않는 명령은 빈 목록', () => {
    expect(riskyFlags('claude {prompt}')).toEqual([])
    expect(riskyFlags('claude --continue {prompt}')).toEqual([])
    expect(riskyFlags('claude --permission-mode plan {prompt}')).toEqual([])
    expect(riskyFlags('gemini -i {prompt}')).toEqual([])
  })
})

describe('pickCandidates — 새 이슈 중 실행할 것', () => {
  const opts = (o: Partial<{ author: TakerAuthor; baseline: number; taken: number[]; login: string }> = {}) => ({
    author: 'anyone' as TakerAuthor,
    baseline: 10,
    taken: [] as number[],
    login: 'me',
    ...o,
  })
  const picked = (issues: RecentIssue[], o: Parameters<typeof opts>[0] = {}) => pickCandidates(issues, opts(o)).map((i) => i.number)

  it.each<[TakerAuthor, string | null, string | null, boolean]>([
    ['me', 'me', 'OWNER', true],
    ['me', 'other', 'OWNER', false],
    ['writers', 'other', 'OWNER', true],
    ['writers', 'other', 'MEMBER', true],
    ['writers', 'other', 'COLLABORATOR', true],
    ['writers', 'other', 'CONTRIBUTOR', false],
    ['writers', 'other', 'NONE', false],
    ['writers', 'other', null, false],
    ['anyone', 'other', 'NONE', true],
    ['anyone', null, null, true],
  ])('AC-11 작성자 설정 %s · 작성자 %s · association %s → 실행 %s', (author, by, assoc, expected) => {
    expect(picked([issue(11, { author: by, authorAssociation: assoc })], { author })).toEqual(expected ? [11] : [])
  })

  it('AC-11 로그인·작성자·담당자는 대소문자를 가리지 않는다', () => {
    expect(picked([issue(11, { author: 'ME', assignees: ['mE'] })], { author: 'me', login: 'Me' })).toEqual([11])
  })

  it('AC-04 열린 이슈만 고른다', () => {
    expect(picked([issue(11, { state: 'closed' }), issue(12)])).toEqual([12])
  })

  it('EC-01 다른 사람에게만 assign 된 이슈는 건너뛰고, 담당자가 없거나 나를 포함하면 고른다', () => {
    expect(picked([issue(11, { assignees: ['other'] }), issue(12, { assignees: ['other', 'me'] }), issue(13)])).toEqual([12, 13])
  })

  it('EC-02 작성자 조건에 맞지 않는 이슈는 건너뛴다', () => {
    expect(picked([issue(11, { author: 'other', authorAssociation: 'NONE' }), issue(12)], { author: 'me' })).toEqual([12])
  })

  it('EC-03 이미 자동 실행한 번호는 다시 고르지 않는다', () => {
    expect(picked([issue(11), issue(12)], { taken: [11] })).toEqual([12])
  })

  it('EC-22 다시 열린 옛 이슈는 번호가 기준 번호 이하라 고르지 않는다', () => {
    expect(picked([issue(5), issue(10), issue(11)], { baseline: 10 })).toEqual([11])
  })

  it('EC-23 작성자 설정을 넓혀도 기준 번호 이하의 남의 이슈는 고르지 않는다', () => {
    const other = { author: 'other', authorAssociation: 'NONE' }
    expect(picked([issue(8, other), issue(11, other)], { author: 'anyone', baseline: 10 })).toEqual([11])
  })
})

describe('validateSteps — 대화상자의 단계 검사', () => {
  const step = (command: string, prompt: string): TakerStep => ({ kind: 'custom', command, prompt })

  it('EC-10 단계가 없으면 "단계를 하나 이상 두세요"', () => {
    expect(validateSteps([])).toEqual({ error: '단계를 하나 이상 두세요', steps: [] })
  })

  it.each([
    ['빈 명령', '', '/x {issue}'],
    ['{prompt} 없이 지시문', 'claude', '/x {issue}'],
    ['{prompt} 를 따옴표로 감쌈', "claude '{prompt}'", '/x {issue}'],
  ])('EC-09 %s → 그 단계에 buildCommand 의 오류 문구', (_label, command, prompt) => {
    const expected = buildCommand(command, prompt, 'posix')
    expect(expected.ok).toBe(false)
    const r = validateSteps([step('claude {prompt}', '/a {issue}'), step(command, prompt)])
    expect(r.steps[0]).toBeNull()
    expect(r.steps[1]).toBe(expected.ok ? null : expected.error)
  })

  it('EC-09 맞는 단계들은 오류가 없다', () => {
    expect(validateSteps([step('claude {prompt}', '/common:ready-for-impl {issue}'), step('claude --continue {prompt}', '{number} 이어서')])).toEqual({
      error: null,
      steps: [null, null],
    })
  })

  it.each(['{title} 고쳐', '-p 고쳐', '--x {issue}'])('EC-27 지시문 틀이 {title} 이나 - 로 시작하면(%s) 그 단계에 오류', (prompt) => {
    expect(validateSteps([step('claude {prompt}', prompt)]).steps[0]).toEqual(expect.any(String))
  })
})

describe('isActive · nextToStart — 동시 실행 3개', () => {
  it.each<[TakerStatus, boolean]>([
    ['preparing', true],
    ['running', true],
    ['manualNext', true],
    ['queued', false],
    ['done', false],
    ['stopped', false],
    ['failed', false],
    ['interrupted', false],
  ])('AC-09 %s 는 동시 실행에 센다: %s', (status, expected) => {
    expect(isActive({ status })).toBe(expected)
  })

  const all = () => true

  it('AC-09 활성 2개면 대기 중 먼저 찾은 1개만 시작한다', () => {
    const runs = [run('a', 'running'), run('b', 'preparing'), run('c', 'queued', { foundAt: 1 }), run('d', 'queued', { foundAt: 2 })]
    expect(nextToStart(runs, all).map((r) => r.id)).toEqual(['c'])
  })

  it('AC-09 다음 단계 대기도 세므로 활성 3개면 시작하지 않는다', () => {
    expect(nextToStart([run('a', 'running'), run('b', 'preparing'), run('c', 'manualNext'), run('d', 'queued')], all)).toEqual([])
  })

  it('AC-09 끝난·멈춘·실패·중단된 실행은 세지 않고, 대기는 찾은 순서로 3개까지', () => {
    const runs = [
      run('a', 'done'),
      run('b', 'stopped'),
      run('c', 'failed'),
      run('d', 'interrupted'),
      run('e', 'queued', { foundAt: 1 }),
      run('f', 'queued', { foundAt: 2 }),
      run('g', 'queued', { foundAt: 3 }),
      run('h', 'queued', { foundAt: 4 }),
    ]
    expect(nextToStart(runs, all).map((r) => r.id)).toEqual(['e', 'f', 'g'])
  })

  it('EC-13 호스트가 연결되지 않은 실행은 건너뛰고 다음 대기를 시작한다', () => {
    const runs = [run('a', 'queued', { foundAt: 1 }), run('b', 'queued', { foundAt: 2 })]
    expect(nextToStart(runs, (r) => r.id !== 'a').map((r) => r.id)).toEqual(['b'])
  })
})

describe('canWrite — 다음 명령을 넣어도 되는가', () => {
  const NOW = 100_000

  it.each<[string, number | undefined, number | null | undefined, boolean]>([
    ['셸만 있다는 신호가 없으면 false', undefined, null, false],
    ['셸만 있은 지 5999ms 면 false', NOW - 5999, null, false],
    ['셸만 있은 지 6000ms 면 true', NOW - 6000, null, true],
    ['연결이 바뀐 지 5999ms 면 false', NOW - 10_000, NOW - 5999, false],
    ['연결이 바뀐 지 6000ms 면 true', NOW - 10_000, NOW - 6000, true],
  ])('EC-29 %s', (_label, shellSince, linkChangedAt, expected) => {
    expect(canWrite({ shellSince, linkChangedAt, now: NOW })).toBe(expected)
  })
})

describe('stepProgress — 단계가 끝났는가', () => {
  const NOW = 200_000
  const base = { seen: true, lastSeenAt: NOW - 10_000, shellSince: NOW - 6000, agentPresent: false, wroteAt: NOW - 20_000, now: NOW }

  it('AC-07 프로그램을 본 뒤 셸만 남고 6초 지나면 ended — 셸 시각이 마지막으로 본 시각과 같아도', () => {
    expect(stepProgress(base)).toBe('ended')
    expect(stepProgress({ ...base, lastSeenAt: NOW - 6000 })).toBe('ended')
  })

  it.each<[string, Partial<typeof base> & { shellSince?: number | undefined }]>([
    ['셸만 있은 지 5999ms', { shellSince: NOW - 5999 }],
    ['셸 시각이 마지막으로 본 시각보다 앞', { lastSeenAt: NOW - 5000, shellSince: NOW - 7000 }],
    ['프로그램이 아직 보임', { agentPresent: true }],
    ['셸만 있다는 신호가 없음', { shellSince: undefined }],
  ])('AC-07 %s → wait', (_label, o) => {
    expect(stepProgress({ ...base, ...o })).toBe('wait')
  })

  it('EC-05 명령을 넣고 120초 동안 프로그램이 보이지 않으면 startTimeout', () => {
    const unseen = { ...base, seen: false, lastSeenAt: 0 }
    expect(stepProgress({ ...unseen, wroteAt: NOW - 120_000 })).toBe('startTimeout')
    expect(stepProgress({ ...unseen, wroteAt: NOW - 119_999 })).toBe('wait')
  })

  it('EC-05 명령을 넣은 시각이 없으면 시작 확인을 하지 않는다', () => {
    expect(stepProgress({ ...base, seen: false, lastSeenAt: 0, wroteAt: null, now: NOW + 1_000_000 })).toBe('wait')
  })
})
