// E2E 큐 역할 — 모델 인자 넣기(A-4)·명령 만들기·모델 입력 검사·저장 값 정리
import { describe, expect, it } from 'vitest'

import { DEFAULT_ROLES, MODEL_RE, buildRoleCommand, fillPrompt, sanitizeRoles, withModel } from './roles'
import type { RoleConfig } from './roles'

describe('fillPrompt', () => {
  // AC-04 — 지시문 자리표시 치환
  it('AC-04 {issue}·{out}·{prev} 자리에 값을 넣는다(여러 번 나와도 모두)', () => {
    expect(
      fillPrompt('이슈 {issue} 결과는 {out} 에 · 앞 단계 {prev} · 다시 {out}', {
        issue: '#12 로그인',
        out: '.minmo/e2e/j1/2-edge-cases.md',
        prev: '.minmo/e2e/j1/1-run.md',
      }),
    ).toBe('이슈 #12 로그인 결과는 .minmo/e2e/j1/2-edge-cases.md 에 · 앞 단계 .minmo/e2e/j1/1-run.md · 다시 .minmo/e2e/j1/2-edge-cases.md')
  })
})

describe('withModel (A-4)', () => {
  // AC-04 — ① {model} 자리
  it('AC-04 ① 틀에 {model} 자리가 있으면 그 자리에 감싼 모델을 넣고, 모델이 비면 자리와 바로 앞 옵션을 뺀다', () => {
    expect(withModel('claude --model {model} {prompt}', 'claude', 'opus', 'posix')).toBe("claude --model 'opus' {prompt}")
    expect(withModel('claude --model {model} {prompt}', 'claude', '', 'posix')).toBe('claude {prompt}')
    expect(withModel('codex -m {model} {prompt}', 'codex', '', 'powershell')).toBe('codex {prompt}')
  })

  // AC-04 — ② 이미 모델 옵션이 있음
  it('AC-04 ② 틀에 이미 --model / -m 토큰이 있으면 넣지 않는다', () => {
    expect(withModel('claude --model sonnet {prompt}', 'claude', 'opus', 'posix')).toBe('claude --model sonnet {prompt}')
    expect(withModel('codex -m gpt-5 {prompt}', 'codex', 'o3', 'posix')).toBe('codex -m gpt-5 {prompt}')
  })

  // AC-04 — ③ CLI 이름 토큰 바로 뒤(따옴표·경로·.cmd/.exe 무시)
  it('AC-04 ③ CLI 이름과 일치하는 첫 토큰 바로 뒤에 넣는다 — claude 는 --model, codex·gemini 는 -m', () => {
    expect(withModel('claude {prompt}', 'claude', 'opus', 'posix')).toBe("claude --model 'opus' {prompt}")
    expect(withModel('codex --full-auto {prompt}', 'codex', 'gpt-5', 'posix')).toBe("codex -m 'gpt-5' --full-auto {prompt}")
    expect(withModel('gemini -i {prompt}', 'gemini', 'gemini-2.5-pro', 'posix')).toBe("gemini -m 'gemini-2.5-pro' -i {prompt}")
    expect(withModel('npx claude {prompt}', 'claude', 'opus', 'posix')).toBe("npx claude --model 'opus' {prompt}")
    expect(withModel('/usr/local/bin/codex {prompt}', 'codex', 'gpt-5', 'posix')).toBe("/usr/local/bin/codex -m 'gpt-5' {prompt}")
    expect(withModel('codex.exe {prompt}', 'codex', 'gpt-5', 'powershell')).toBe("codex.exe -m 'gpt-5' {prompt}")
  })

  // AC-04 — ③ PowerShell 의 `& '...claude.cmd'` 형태
  it("AC-04 ③ PowerShell 의 & '…\\claude.cmd' 처럼 따옴표·경로·.cmd 가 붙은 토큰도 CLI 이름으로 본다", () => {
    expect(withModel("& 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd' {prompt}", 'claude', 'opus', 'powershell')).toBe(
      "& 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd' --model 'opus' {prompt}",
    )
  })

  // AC-04 — ④ {prompt} 앞(바로 앞 한 글자 옵션 포함)
  it('AC-04 ④ CLI 이름 토큰도 없으면 {prompt} 앞에 넣는다 — 바로 앞의 한 글자 옵션은 {prompt} 와 붙여 둔다', () => {
    expect(withModel('my-agent {prompt}', 'claude', 'opus', 'posix')).toBe("my-agent --model 'opus' {prompt}")
    expect(withModel('my-agent -p {prompt}', 'gemini', 'flash', 'posix')).toBe("my-agent -m 'flash' -p {prompt}")
  })

  // AC-04 — 빈 모델 = CLI 기본값
  it('AC-04 모델이 비면(CLI 기본값) 틀을 바꾸지 않는다', () => {
    for (const tpl of ['claude {prompt}', 'gemini -i {prompt}', 'my-agent -p {prompt}'])
      expect(withModel(tpl, 'claude', '', 'posix')).toBe(tpl)
  })
})

describe('buildRoleCommand', () => {
  const cfg: RoleConfig = { kind: 'claude', model: 'opus', prompt: "이슈 {issue}\n결과는 {out} 에 써라. it's" }
  const ctx = { issue: '#12 로그인', out: '.minmo/e2e/j1/1-run.md', prev: '' }

  // AC-04 — 틀 + 모델 + 지시문(치환·한 줄·셸별 따옴표)
  it('AC-04 명령 틀 + 모델 인자 + 지시문(자리표시 치환, 한 줄, 셸에 맞는 따옴표)', () => {
    expect(buildRoleCommand(cfg, 'claude {prompt}', ctx, 'posix')).toEqual({
      ok: true,
      command: `claude --model 'opus' '이슈 #12 로그인 결과는 .minmo/e2e/j1/1-run.md 에 써라. it'\\''s'`,
    })
    expect(buildRoleCommand(cfg, 'claude {prompt}', ctx, 'powershell')).toEqual({
      ok: true,
      command: "claude --model 'opus' '이슈 #12 로그인 결과는 .minmo/e2e/j1/1-run.md 에 써라. it''s'",
    })
  })

  // EC-07
  it('EC-07 명령 틀이 비었거나 {prompt} 가 따옴표 안이면 오류(작업 실패 사유로 쓴다)', () => {
    expect(buildRoleCommand(cfg, '  ', ctx, 'posix')).toMatchObject({ ok: false, error: expect.any(String) })
    expect(buildRoleCommand(cfg, 'claude "{prompt}"', ctx, 'posix')).toMatchObject({ ok: false, error: expect.stringContaining('따옴표') })
  })
})

describe('MODEL_RE', () => {
  // EC-05
  it('EC-05 모델 이름 글자만 받고 공백·따옴표·; ·$()·- 시작(옵션 주입)·빈 값은 거부한다', () => {
    const accepted = ['opus', 'claude-opus-4-5', 'gpt-5.1-codex', 'claude-sonnet-4-5[1m]', 'models/gemini-2.5-pro', 'ns:model_v2']
    const rejected = ['-rf', '--dangerously-skip-permissions', 'opus sonnet', "op'us", 'op"us', 'opus;calc', '$(id)', '']
    expect(accepted.filter((m) => !MODEL_RE.test(m))).toEqual([])
    expect(rejected.filter((m) => MODEL_RE.test(m))).toEqual([])
  })
})

describe('sanitizeRoles', () => {
  // EC-11
  it('EC-11 모양이 맞지 않으면 기본값, 역할별로 알려진 유효 값만 받는다(모델 패턴 검사 포함)', () => {
    expect(sanitizeRoles(null)).toEqual(DEFAULT_ROLES)
    expect(sanitizeRoles('x')).toEqual(DEFAULT_ROLES)
    expect(sanitizeRoles([])).toEqual(DEFAULT_ROLES)
    const got = sanitizeRoles({
      run: { kind: 'codex', model: 'gpt-5', prompt: '실행 {out}' },
      edge: { kind: 'gemini', model: '--yolo', prompt: 42 },
      verify: { kind: 'custom', model: 3, prompt: null },
      bogus: { kind: 'claude', model: 'opus', prompt: 'x' },
    })
    expect(got).toEqual({
      run: { kind: 'codex', model: 'gpt-5', prompt: '실행 {out}' },
      edge: { kind: 'gemini', model: DEFAULT_ROLES.edge.model, prompt: DEFAULT_ROLES.edge.prompt },
      verify: DEFAULT_ROLES.verify,
    })
    // 빈 모델(CLI 기본값)은 유효하다
    expect(sanitizeRoles({ run: { kind: 'claude', model: '', prompt: 'p' } }).run).toEqual({ kind: 'claude', model: '', prompt: 'p' })
  })
})
