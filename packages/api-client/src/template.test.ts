// CT-34: template.ts 가 golden fixture(contracts/fixtures/template-vectors.json) 4묶음 전부 통과
// + 계약 §템플릿 치환의 etc 충돌·경로 비교(EC-23) 규칙
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  TemplateError,
  branchDir,
  isSameOrInside,
  isValidRef,
  renderBranch,
  renderPath,
  slug,
  titleToken,
} from './index'
import type { PathContext } from './index'

type Vectors = {
  refCases: { ref: string; valid: boolean }[]
  branchCases: { template: string; issue: { number: number; title: string }; etcBranchName?: string; expected: string }[]
  pathCases: { template: string; ctx: PathContext; expected: string }[]
  slugCases: { title: string; slug: string; titleToken: string }[]
}

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../contracts/fixtures/template-vectors.json'), 'utf8'),
) as Vectors

describe('CT-34 refCases → isValidRef', () => {
  it.each(vectors.refCases.map((c) => [JSON.stringify(c.ref), c.ref, c.valid] as const))('%s → %s', (_l, ref, valid) => {
    expect(isValidRef(ref)).toBe(valid)
  })
})

describe('CT-34 branchCases → renderBranch', () => {
  it.each(vectors.branchCases.map((c) => [`${c.template} #${c.issue.number}`, c] as const))('%s', (_l, c) => {
    const got = renderBranch(c.template, c.issue, c.etcBranchName !== undefined ? { etcBranchName: c.etcBranchName } : undefined)
    expect(got).toBe(c.expected)
    // 계약: branchCases[].expected 는 "유효 ref" (Go validate_test 와 동일 단언)
    expect(isValidRef(got)).toBe(true)
  })
})

describe('CT-34 pathCases → renderPath', () => {
  it.each(vectors.pathCases.map((c) => [`${c.ctx.platform} ${c.template}`, c] as const))('%s', (_l, c) => {
    expect(renderPath(c.template, c.ctx)).toBe(c.expected)
  })
})

describe('CT-34 slugCases → slug / titleToken', () => {
  it.each(vectors.slugCases.map((c) => [JSON.stringify(c.title), c] as const))('%s', (_l, c) => {
    expect(slug(c.title)).toBe(c.slug)
    expect(titleToken(c.title)).toBe(c.titleToken)
  })

  it('slug 는 최대 40자, title 토큰은 최대 60자 (절단 후 양끝 - 재제거)', () => {
    const long = 'word '.repeat(30)
    expect(slug(long).length).toBeLessThanOrEqual(40)
    expect(slug(long)).not.toMatch(/^-|-$/)
    expect(titleToken(long).length).toBeLessThanOrEqual(60)
    expect(titleToken(long)).not.toMatch(/^[-.]|[-.]$/)
  })
})

describe('renderBranch — etc 브랜치 충돌 (계약 §템플릿 치환 "ref 최종 정제")', () => {
  it('렌더 결과가 etcBranchName 과 같으면 TemplateError(branch_conflicts_etc)', () => {
    let err: unknown
    try {
      renderBranch('feat/{number}', { number: 42, title: 'x' }, { etcBranchName: 'feat/42' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TemplateError)
    expect((err as TemplateError).code).toBe('branch_conflicts_etc')
  })

  it('다르면 그대로 반환', () => {
    expect(renderBranch('feat/{number}', { number: 42, title: 'x' }, { etcBranchName: 'etc' })).toBe('feat/42')
  })
})

describe('branchDir — {branch} 경로 삽입 시 "/" → "--" (A-06)', () => {
  it.each([
    ['issue/42-add-login', 'issue--42-add-login'],
    ['etc', 'etc'],
    ['a/b/c', 'a--b--c'],
  ])('%s → %s', (b, d) => {
    expect(branchDir(b)).toBe(d)
  })
})

describe('isSameOrInside — EC-23 겹침 판정 (구분자 통일 + .. 정규화 + Windows 대소문자 무시)', () => {
  it.each([
    ['같은 경로', '/h/ws/o/r/_main', '/h/ws/o/r/_main', 'linux', true],
    ['하위 경로', '/h/ws/o/r/_main/42', '/h/ws/o/r/_main', 'linux', true],
    ['접두사만 같은 형제', '/h/ws/o/r/_main2/42', '/h/ws/o/r/_main', 'linux', false],
    ['.. 정규화', '/h/ws/o/r/x/../_main/42', '/h/ws/o/r/_main', 'linux', true],
    ['linux 는 대소문자 구분', '/h/ws/O/r/_main/42', '/h/ws/o/r/_main', 'linux', false],
    ['win32 대소문자만 다른 겹침', 'C:\\Users\\X\\WS\\o\\r\\_MAIN\\42', 'C:\\Users\\X\\ws\\o\\r\\_main', 'win32', true],
    ['win32 구분자 혼용', 'C:/Users/X/ws/o/r/_main', 'C:\\Users\\X\\ws\\o\\r\\_main', 'win32', true],
    ['상위 경로는 하위가 아님', '/h/ws/o/r', '/h/ws/o/r/_main', 'linux', false],
  ] as const)('%s', (_l, child, parent, platform, expected) => {
    expect(isSameOrInside(child, parent, platform)).toBe(expected)
  })
})
