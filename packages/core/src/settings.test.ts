// 서버 settings/validate_test.go 의 규칙표를 그대로 옮겨, CLI 로컬 모드가 서버와 같은 값만 받는지 확인한다
import { describe, expect, it } from 'vitest'

import type { SettingsField } from '@minmo/api-client'

import { DEFAULT_SETTINGS, mergeSettings, validateSettingValue } from './settings'

type Case = [name: string, value: string, ok: boolean]

function table(field: SettingsField, code: string, cases: Case[]) {
  it.each(cases)(`${field}: %s`, (_name, value, ok) => {
    expect(validateSettingValue(field, value)).toBe(ok ? null : code)
  })
}

describe('validateSettingValue (서버 규칙과 동일)', () => {
  table('branchTemplate', 'invalid_template', [
    ['default', 'issue/{number}-{slug}', true],
    ['number only', '{number}', true],
    ['title token', '{number}-{title}', true],
    ['100 runes', '{number}' + 'a'.repeat(92), true],
    ['no number', 'feat/x', false],
    ['empty', '', false],
    ['unknown token', '{number}-{foo}', false],
    ['branch token not allowed', '{branch}/{number}', false],
    ['unclosed brace', 'feat/{number', false],
    ['space', 'feat {number}', false],
    ['double dot', 'feat..{number}', false],
    ['leading slash', '/{number}', false],
    ['trailing .lock', '{number}.lock', false],
    ['101 runes', '{number}' + 'a'.repeat(93), false],
    // Go IsSpace·IsControl 과 같은 범위: C1 제어문자는 거부, U+FEFF 는 허용
    ['C1 control', 'issue/{number}\u0085', false],
    ['BOM', 'issue/{number}\u{feff}x', true],
  ])

  table('etcBranchName', 'invalid_template', [
    ['etc', 'etc', true],
    ['nested', 'misc/scratch', true],
    ['100 runes', 'a'.repeat(100), true],
    ['space', 'a b', false],
    ['empty', '', false],
    ['token', '{number}', false],
    ['brace', 'etc}', false],
    ['ref double dot', 'a..b', false],
    ['101 runes', 'a'.repeat(101), false],
  ])

  const long = '~/' + 'a'.repeat(510 - '{key}'.length) + '{key}'
  table('worktreePath', 'invalid_path_template', [
    ['branch', '~/minmo-workspaces/{owner}/{repo}/{branch}', true],
    ['key', '~/work/{owner}/{repo}/{key}', true],
    ['all tokens', '~/w/{owner}/{repo}/{number}-{slug}/{key}', true],
    ['windows absolute', 'D:\\w\\{key}', true],
    ['512 runes', long, true],
    ['no branch/key', '~/w/{owner}/{repo}', false],
    ['empty', '', false],
    ['title not allowed', '~/w/{title}/{key}', false],
    ['unknown token', '~/w/{key}/{oops}', false],
    ['513 runes', long + 'a', false],
  ])

  table('mainClonePath', 'invalid_path_template', [
    ['default', '~/minmo-workspaces/{owner}/{repo}/_main', true],
    ['windows', 'C:\\m\\{owner}\\{repo}', true],
    ['branch', '~/m/{owner}/{repo}/{branch}', false],
    ['key', '~/m/{owner}/{repo}/{key}', false],
    ['number', '~/m/{number}', false],
    ['empty', '', false],
    ['513 runes', '~/' + 'a'.repeat(511), false],
  ])

  table('postCreateScript', 'script_too_large', [
    ['empty', '', true],
    ['65536 bytes', 'x'.repeat(65536), true],
    ['65537 bytes', 'x'.repeat(65537), false],
    ['multibyte over limit(바이트 기준)', '가'.repeat(21846), false],
  ])
  table('postCreateScriptPosix', 'script_too_large', [
    ['ok', 'npm ci', true],
    ['too large', 'x'.repeat(65537), false],
  ])

  table('sparsePaths', 'invalid_sparse_paths', [
    ['empty = 전체', '', true],
    ['dirs', 'desktop\npackages/api-client/\n\n  server  ', true],
    ['crlf', 'desktop\r\nserver', true],
    ['absolute', '/etc', false],
    ['drive', 'C:/x', false],
    ['backslash', 'desktop\\src', false],
    ['parent', 'a/../b', false],
    ['dot', './a', false],
    ['glob', 'src/*', false],
    ['negation', '!docs', false],
    ['option-like', '--no-cone', false],
    ['double slash', 'a//b', false],
    ['101 lines', 'a\n'.repeat(100) + 'a', false],
    ['4097 bytes', 'a'.repeat(4097), false],
    ['control char', 'a\u0085b', false],
    // Go TrimSpace 와 같은 공백 범위: U+0085 는 지우고 U+FEFF 는 남긴다
    ['NEL 은 앞뒤 공백', '\u0085a', true],
    ['BOM 은 공백 아님(안의 탭은 제어문자)', '\u{feff}\t\u{feff}', false],
  ])

  it('기본값은 모두 통과한다', () => {
    for (const [f, v] of Object.entries(DEFAULT_SETTINGS)) expect(validateSettingValue(f as SettingsField, v)).toBeNull()
  })
})

describe('ignoredCopyExclude — 이름만 받는다', () => {
  it('이름 목록·빈 값·"off" 는 통과, 경로·..·제어문자·크기 초과는 거절', () => {
    for (const ok of ['node_modules\n\n  .venv  \ntarget', '', 'off', DEFAULT_SETTINGS.ignoredCopyExclude]) {
      expect(validateSettingValue('ignoredCopyExclude', ok)).toBeNull()
    }
    for (const bad of ['a/b', 'a\\b', '..', '.', 'a\tb', 'x'.repeat(4097), 'a\n'.repeat(100)]) {
      expect(validateSettingValue('ignoredCopyExclude', bad)).toBe('invalid_ignored_copy_exclude')
    }
  })
})

describe('mergeSettings', () => {
  it('null·undefined 는 아래 값을 두고, "" 는 값으로 덮는다 — 출처는 마지막으로 덮은 층', () => {
    const m = mergeSettings(DEFAULT_SETTINGS, 'default', [
      { source: 'copy', values: { sparsePaths: 'desktop', branchTemplate: null } },
      { source: 'local', values: { sparsePaths: '', worktreePath: '~/w/{key}' } },
      { source: 'none', values: null },
    ])
    expect(m.values).toMatchObject({ sparsePaths: '', worktreePath: '~/w/{key}', branchTemplate: DEFAULT_SETTINGS.branchTemplate })
    expect(m.sources).toMatchObject({ sparsePaths: 'local', worktreePath: 'local', branchTemplate: 'default', etcBranchName: 'default' })
  })
})
