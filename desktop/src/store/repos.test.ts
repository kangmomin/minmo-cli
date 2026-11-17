// 저장소 별칭(#73) — 저장 규칙과 화면 이름 우선순위
import { beforeEach, describe, expect, it } from 'vitest'

import { LOCAL_OWNER, NICKNAME_MAX, repoFullNameOf, repoLabelOf, repoNicknameOf, repoShortNameOf, shortNameTaken, useReposStore } from './repos'

beforeEach(() => {
  useReposStore.setState({ added: [], local: {}, lastParent: {}, nicknames: {} })
})

describe('setNickname', () => {
  it('앞뒤 공백을 지우고, owner/repo 의 대소문자를 가리지 않는다', () => {
    useReposStore.getState().setNickname('MyOrg', 'Repo-A', '  my app  ')
    expect(useReposStore.getState().nicknames).toEqual({ 'myorg/repo-a': 'my app' })
    expect(repoNicknameOf(useReposStore.getState(), 'myorg', 'REPO-A')).toBe('my app')
  })

  it('빈 값·공백뿐인 값·null 이면 별칭을 지운다', () => {
    const { setNickname } = useReposStore.getState()
    setNickname('o', 'r', 'x')
    setNickname('o', 'r', '   ')
    expect(useReposStore.getState().nicknames).toEqual({})
    setNickname('o', 'r', 'x')
    setNickname('o', 'r', null)
    expect(useReposStore.getState().nicknames).toEqual({})
  })

  it(`${NICKNAME_MAX}글자(코드 포인트)로 자른다`, () => {
    useReposStore.getState().setNickname('o', 'r', '가'.repeat(NICKNAME_MAX + 10))
    expect(Array.from(useReposStore.getState().nicknames['o/r'])).toHaveLength(NICKNAME_MAX)
  })

  it('정리한 값이 같으면 상태를 바꾸지 않는다(구독자를 깨우지 않게)', () => {
    useReposStore.getState().setNickname('o', 'r', 'x')
    const before = useReposStore.getState()
    useReposStore.getState().setNickname('o', 'r', ' x ')
    expect(useReposStore.getState()).toBe(before)
  })
})

describe('shortNameTaken(별칭 중복 경고)', () => {
  it('다른 저장소의 별칭·로컬 폴더명·직접 추가한 저장소 이름과 비교한다(대소문자·앞뒤 공백 무시, 자기 자신 제외)', () => {
    const id = useReposStore.getState().addLocal({ hostId: 'local', path: '/src/app', displayName: 'app' })
    useReposStore.setState({ added: ['Acme/Gadgets'] })
    useReposStore.getState().setNickname('acme', 'widgets', 'wg')
    const s = () => useReposStore.getState()
    expect(shortNameTaken(s(), 'o', 'r', ' WG ')).toBe(true)
    expect(shortNameTaken(s(), 'o', 'r', 'App')).toBe(true)
    expect(shortNameTaken(s(), 'o', 'r', 'gadgets')).toBe(true)
    expect(shortNameTaken(s(), 'o', 'r', 'other')).toBe(false)
    expect(shortNameTaken(s(), 'o', 'r', '  ')).toBe(false)
    // 자기 자신의 이름·별칭은 겹침이 아니다
    expect(shortNameTaken(s(), 'Acme', 'Widgets', 'wg')).toBe(false)
    expect(shortNameTaken(s(), LOCAL_OWNER, id, 'app')).toBe(false)
  })
})

describe('화면 이름', () => {
  it('GitHub 저장소: 별칭이 없으면 name · owner/name, 있으면 둘 다 별칭. 툴팁은 owner/name', () => {
    const s = () => useReposStore.getState()
    expect(repoShortNameOf(s(), 'MyOrg', 'Repo-A')).toBe('Repo-A')
    expect(repoLabelOf(s(), 'MyOrg', 'Repo-A')).toBe('MyOrg/Repo-A')
    s().setNickname('MyOrg', 'Repo-A', 'ra')
    expect(repoShortNameOf(s(), 'MyOrg', 'Repo-A')).toBe('ra')
    expect(repoLabelOf(s(), 'MyOrg', 'Repo-A')).toBe('ra')
    expect(repoFullNameOf(s(), 'MyOrg', 'Repo-A')).toBe('MyOrg/Repo-A')
  })

  it('로컬 저장소: 별칭이 없으면 폴더명, 있으면 별칭. 툴팁은 폴더 경로', () => {
    const id = useReposStore.getState().addLocal({ hostId: 'local', path: '/src/my-app', displayName: 'my-app' })
    const s = () => useReposStore.getState()
    expect(repoShortNameOf(s(), LOCAL_OWNER, id)).toBe('my-app')
    expect(repoLabelOf(s(), LOCAL_OWNER, id)).toBe('my-app')
    s().setNickname(LOCAL_OWNER, id, '앱')
    expect(repoShortNameOf(s(), LOCAL_OWNER, id)).toBe('앱')
    expect(repoLabelOf(s(), LOCAL_OWNER, id)).toBe('앱')
    expect(repoFullNameOf(s(), LOCAL_OWNER, id)).toBe('/src/my-app')
  })
})
