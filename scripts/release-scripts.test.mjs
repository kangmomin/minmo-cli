// node --test scripts/ — 릴리즈 스크립트(버전 확인·latest.json)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkVersions, collectVersions } from './check-versions.mjs'
import { buildManifest, findSigned } from './updater-manifest.mjs'

test('저장소의 버전은 모두 같다', () => {
  assert.match(checkVersions(collectVersions()), /^\d+\.\d+\.\d+$/)
})

test('버전이 다르거나 태그가 다르면 실패', () => {
  assert.throws(() => checkVersions({ a: '0.4.0', b: '0.3.0' }), /버전이 서로 다릅니다/)
  assert.throws(() => checkVersions({ a: '0.4.0' }, 'v0.4.1'), /태그 v0\.4\.1/)
  assert.equal(checkVersions({ a: '0.4.0', b: '0.4.0' }, 'v0.4.0'), '0.4.0')
})

test('latest.json — 설치 종류별 키, 다운로드 URL, 서명', () => {
  const m = buildManifest({
    version: '0.4.0',
    tag: 'v0.4.0',
    repo: 'kangmomin/minmo-cli',
    notes: '노트',
    pubDate: '2026-11-11T00:00:00.000Z',
    nsis: { name: 'minmo_0.4.0_x64-setup.exe', signature: 'SIG-NSIS\n' },
    msi: { name: 'minmo_0.4.0_x64_en-US.msi', signature: 'SIG-MSI' },
  })
  assert.equal(m.version, '0.4.0')
  assert.deepEqual(Object.keys(m.platforms), ['windows-x86_64', 'windows-x86_64-nsis', 'windows-x86_64-msi'])
  assert.deepEqual(m.platforms['windows-x86_64'], {
    signature: 'SIG-NSIS',
    url: 'https://github.com/kangmomin/minmo-cli/releases/download/v0.4.0/minmo_0.4.0_x64-setup.exe',
  })
  assert.equal(m.platforms['windows-x86_64-msi'].url, 'https://github.com/kangmomin/minmo-cli/releases/download/v0.4.0/minmo_0.4.0_x64_en-US.msi')
})

test('findSigned — 해당 버전 설치 파일과 .sig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-'))
  try {
    const nsis = join(dir, 'nsis')
    mkdirSync(nsis)
    writeFileSync(join(nsis, 'minmo_0.3.0_x64-setup.exe'), '')
    writeFileSync(join(nsis, 'minmo_0.4.0_x64-setup.exe'), '')
    assert.throws(() => findSigned(nsis, '-setup.exe', '0.4.0'), /서명 파일이 없습니다/)
    writeFileSync(join(nsis, 'minmo_0.4.0_x64-setup.exe.sig'), 'SIG')
    assert.deepEqual(findSigned(nsis, '-setup.exe', '0.4.0'), { name: 'minmo_0.4.0_x64-setup.exe', signature: 'SIG' })
    assert.throws(() => findSigned(join(dir, 'msi'), '.msi', '0.4.0'), /찾지 못했습니다/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
