import { describe, expect, it } from 'vitest'

import { isOwnerAllSelected, isOwnerVisible, isRepoVisible, toggleOwnerAll, toggleRepo } from './visibleRepos'

describe('보일 저장소 판정', () => {
  it('null = 전체 표시, 대소문자 무시, owner/* 는 조직 전체', () => {
    expect(isRepoVisible(null, 'Acme', 'Widgets')).toBe(true)
    expect(isRepoVisible(['acme/widgets'], 'Acme', 'Widgets')).toBe(true)
    expect(isRepoVisible(['acme/widgets'], 'acme', 'other')).toBe(false)
    expect(isRepoVisible(['acme/*'], 'ACME', 'anything')).toBe(true)
    expect(isRepoVisible([], 'acme', 'widgets')).toBe(false)
  })

  it('소유자 노드는 그 소유자의 항목이 하나라도 있으면 보인다', () => {
    expect(isOwnerVisible(null, 'x')).toBe(true)
    expect(isOwnerVisible(['acme/widgets'], 'Acme')).toBe(true)
    expect(isOwnerVisible(['acme/widgets'], 'acmex')).toBe(false)
    expect(isOwnerAllSelected(['acme/*'], 'Acme')).toBe(true)
    expect(isOwnerAllSelected(['acme/widgets'], 'acme')).toBe(false)
  })

  it('toggle: 정렬·중복 제거, 조직 전체를 켜면 개별 항목은 지운다', () => {
    let sel = toggleRepo([], 'Acme', 'Widgets', true)
    sel = toggleRepo(sel, 'acme', 'widgets', true)
    sel = toggleRepo(sel, 'zed', 'a', true)
    expect(sel).toEqual(['acme/widgets', 'zed/a'])
    expect(toggleRepo(sel, 'acme', 'widgets', false)).toEqual(['zed/a'])
    expect(toggleOwnerAll(sel, 'Acme', true)).toEqual(['acme/*', 'zed/a'])
    expect(toggleOwnerAll(['acme/*', 'zed/a'], 'acme', false)).toEqual(['zed/a'])
  })
})
