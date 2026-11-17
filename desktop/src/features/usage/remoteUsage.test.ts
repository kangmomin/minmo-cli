// @vitest-environment node
// 원격 호스트의 사용량 스크립트(python3) — 이 PC 의 Rust 구현과 같은 fixture·같은 기대값으로 맞춘다
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EMPTY_USAGE, REMOTE_USAGE_SCRIPT, parseRemoteUsage } from './remoteUsage'

const FIXTURES = join(__dirname, '..', '..', '..', 'src-tauri', 'tests', 'fixtures', 'usage')
const HOME = join(FIXTURES, 'home')
// fixture 의 "오늘" 자정(UTC)과 지금 — src-tauri/src/commands/usage.rs 의 테스트와 같은 값
const SINCE = Date.parse('2026-11-17T00:00:00Z')
const NOW = Date.parse('2026-11-17T12:00:00Z')

/** heredoc 안의 python 본문 — sh 없이(Windows 에서도) 바로 python3 에 넘긴다 */
const PYTHON = REMOTE_USAGE_SCRIPT.slice(REMOTE_USAGE_SCRIPT.indexOf("<<'MINMO_USAGE_PY'\n") + "<<'MINMO_USAGE_PY'\n".length, REMOTE_USAGE_SCRIPT.lastIndexOf('\nMINMO_USAGE_PY'))

function runPython(home: string, since = SINCE) {
  // 홈은 OS 마다 다른 변수로 정한다. 도구별 설정 폴더 변수는 이 PC 의 값이 섞이지 않게 뺀다
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', PYTHONIOENCODING: 'utf-8' }
  return spawnSync('python3', ['-', String(since), String(NOW)], { input: PYTHON, env, encoding: 'utf8' })
}

const python = runPython(HOME)
const hasPython = python.error === undefined && python.status === 0
// python3 이 없는 개발 PC 에서는 건너뛰지만, CI 에서는 두 구현이 같은지 꼭 확인한다(조용히 건너뛰지 않는다)
const mustRun = hasPython || Boolean(process.env.CI)

describe('REMOTE_USAGE_SCRIPT', () => {
  it('본문에 역슬래시·템플릿 치환이 없다(템플릿 문자열과 heredoc 을 그대로 지나간다)', () => {
    expect(PYTHON).not.toContain('\\')
    expect(PYTHON.length).toBeGreaterThan(1000)
    // python3 이 없으면 계산하지 않고 알린다
    expect(REMOTE_USAGE_SCRIPT.split('\n')[0]).toContain('{"unavailable":"python3"}')
  })

  it.skipIf(!mustRun)('fixture 의 결과가 Rust 구현과 같은 기대값이다', () => {
    expect(python.error, 'python3 을 실행할 수 없다').toBeUndefined()
    expect(python.status, python.stderr).toBe(0)
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8'))
    expect(JSON.parse(python.stdout)).toEqual(expected)
    // 화면이 읽는 모양으로도 같다
    expect(parseRemoteUsage(python.stdout)).toEqual(expected)
  })

  it.skipIf(!mustRun)('기록 폴더가 없는 도구는 null · 내일 자정부터는 0', () => {
    expect(JSON.parse(runPython(join(FIXTURES, 'no-such-home')).stdout)).toEqual({ claude: null, codex: null, gemini: null })
    const tomorrow = JSON.parse(runPython(HOME, SINCE + 24 * 60 * 60 * 1000).stdout)
    expect(tomorrow.claude).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
    expect(tomorrow.gemini).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
  })
})

describe('parseRemoteUsage', () => {
  it('로그인 셸의 인사말이 섞여도 JSON 인 마지막 줄을 읽는다', () => {
    const out = 'Welcome to dev\n{not json}\n{"claude":{"input":1,"output":2,"cacheWrite":3,"cacheRead":4},"codex":null,"gemini":null}\n'
    expect(parseRemoteUsage(out)).toEqual({ claude: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 }, codex: null, gemini: null })
  })

  it('모양이 맞지 않는 값은 없음·0 으로 본다(원격의 출력은 믿을 수 없는 입력이다)', () => {
    expect(parseRemoteUsage('')).toEqual(EMPTY_USAGE)
    expect(parseRemoteUsage('[1,2]')).toEqual(EMPTY_USAGE)
    expect(parseRemoteUsage('{"claude":"lots","codex":{"tokens":null},"gemini":{"input":-5,"output":"7","cacheRead":1e999}}')).toEqual({
      claude: null,
      codex: null,
      gemini: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    })
    const codex = '{"codex":{"tokens":{"input":1},"limits":[{"usedPercent":"high"},{"usedPercent":12.5,"windowMinutes":300},7],"limitsAtMs":5}}'
    expect(parseRemoteUsage(codex).codex).toEqual({ tokens: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0 }, limits: [{ usedPercent: 12.5, windowMinutes: 300, resetsAtMs: 0 }], limitsAtMs: 5 })
  })

  it('python3 이 없는 호스트는 unavailable 로 알린다', () => {
    expect(parseRemoteUsage('{"unavailable":"python3"}')).toEqual({ ...EMPTY_USAGE, unavailable: 'python3' })
  })
})
