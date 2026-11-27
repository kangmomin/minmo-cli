// 이슈 테이커가 실행할 호스트 — 저장소의 연결 호스트(없으면 작업 호스트), 원격 tmux 사용 여부
import { describe, expect, it } from 'vitest'

import type { SshProbe } from '../lib/tauri'
import { usesTmux, workHostAliasOf } from './hosts'

const probe = (tmux: boolean): SshProbe => ({ platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux })

describe('workHostAliasOf — 실행할 호스트', () => {
  it('EC-13 저장소가 이 PC 에 묶여 있으면 작업 호스트가 원격이어도 이 PC(null)', () => {
    expect(workHostAliasOf({ repoHosts: { 'acme/app': 'local' }, selected: 'my-server' }, 'acme', 'app')).toBeNull()
  })

  it('EC-13 저장소가 원격 호스트에 묶여 있으면 그 별칭 — 이 PC 에서 대신 열지 않는다', () => {
    expect(workHostAliasOf({ repoHosts: { 'acme/app': 'ssh:my-server' }, selected: null }, 'Acme', 'App')).toBe('my-server')
  })

  it('EC-13 묶이지 않은 저장소는 사이드바의 작업 호스트를 따른다', () => {
    expect(workHostAliasOf({ repoHosts: {}, selected: 'other' }, 'acme', 'app')).toBe('other')
    expect(workHostAliasOf({ repoHosts: {}, selected: null }, 'acme', 'app')).toBeNull()
  })
})

describe('usesTmux — 원격 tmux 를 쓰는가', () => {
  it.each<[string, string | null, boolean, Record<string, SshProbe>, boolean]>([
    ['이 PC → false', null, true, {}, false],
    ['tmux 사용 꺼짐 → false', 'my-server', false, { 'my-server': probe(true) }, false],
    ['원격에 tmux 없음 → false', 'my-server', true, { 'my-server': probe(false) }, false],
    ['아직 연결을 확인하지 않음 → false', 'my-server', true, {}, false],
    ['tmux 사용 켜짐 · 원격에 tmux 있음 → true', 'my-server', true, { 'my-server': probe(true) }, true],
  ])('EC-07 %s', (_label, alias, useTmux, probes, expected) => {
    expect(usesTmux({ useTmux, probes }, alias)).toBe(expected)
  })
})
