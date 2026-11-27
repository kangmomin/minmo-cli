// 설정 화면(#115) 분류 목록·검색 — 근거: AC-02(보임 조건·표 순서), AC-04(검색), EC-03(원격 브라우저)
import { describe, expect, it } from 'vitest'

import type { RuntimeKind } from '../../lib/tauri'
import { filterSections, visibleSections } from './sections'
import type { SectionId } from './sections'

const ALL: [SectionId, string][] = [
  ['appearance', '모양'],
  ['notify', '알림·표시'],
  ['agents', '에이전트'],
  ['workspace', '작업 공간'],
  ['sync', '동기화'],
  ['hosts', '원격 호스트'],
  ['remote', '원격 접속'],
  ['cli', '원격 CLI'],
  ['server', '서버·앱'],
]
const pairs = (runtime: RuntimeKind) => visibleSections(runtime).map((s) => [s.id, s.title])

describe('visibleSections', () => {
  it.each<[RuntimeKind, [SectionId, string][]]>([
    ['native', ALL],
    ['mock', ALL.filter(([id]) => id !== 'sync')],
  ])('AC-02 runtime %s → 보임 조건을 만족하는 분류만 표 순서로', (runtime, expected) => {
    expect(pairs(runtime)).toEqual(expected)
  })

  it('EC-03 원격 브라우저(remote)에는 원격 접속·원격 CLI·서버·앱·동기화가 없다', () => {
    expect(pairs('remote')).toEqual(ALL.filter(([id]) => ['appearance', 'notify', 'agents', 'workspace', 'hosts'].includes(id)))
  })
})

describe('filterSections', () => {
  const ids = (query: string) => filterSections(visibleSections('native'), query).map((s) => s.id)

  it.each<[string, SectionId[]]>([
    ['포트', ['hosts', 'remote', 'server']],
    ['테마', ['appearance']],
    ['ssh', ['hosts', 'cli']],
  ])('AC-04 검색어 %s → 제목·키워드에 검색어가 들어간 분류만 표 순서로 남는다', (query, expected) => {
    expect(ids(query)).toEqual(expected)
  })

  it('AC-04 대소문자·앞뒤 공백·NFC 차이를 무시한다', () => {
    expect(ids('SSH')).toEqual(['hosts', 'cli'])
    expect(ids('  ssh  ')).toEqual(['hosts', 'cli'])
    expect(ids('포트'.normalize('NFD'))).toEqual(['hosts', 'remote', 'server'])
  })

  it('AC-04 부분 일치 — 제목의 일부·키워드의 일부로도 찾는다', () => {
    // 제목 "알림·표시" 의 일부
    expect(ids('표시')).toEqual(['notify'])
    // 키워드 "Ghostty" 의 일부
    expect(ids('ghost')).toEqual(['appearance'])
  })

  it('AC-04 검색어가 비었거나 공백뿐이면 모든 분류를 그대로 둔다', () => {
    const all = ALL.map(([id]) => id)
    expect(ids('')).toEqual(all)
    expect(ids('   ')).toEqual(all)
  })
})
