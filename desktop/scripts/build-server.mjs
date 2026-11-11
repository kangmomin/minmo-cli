// 내장 서버(사이드카) minmo-server 를 빌드한다. tauri.conf.json 의 bundle.externalBin 이 찾는 이름
// (src-tauri/binaries/minmo-server-<target triple>[.exe])으로 두면 Tauri 가 설치 파일과 target/<profile>/ 에 함께 넣는다.
// 대상은 Tauri 가 넘기는 TAURI_ENV_TARGET_TRIPLE(`tauri build --target`), 없으면 rustc 의 host triple.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GOARCH = { x86_64: 'amd64', aarch64: 'arm64', i686: '386' }
const GOOS = [
  ['windows', 'windows'],
  ['apple-darwin', 'darwin'],
  ['linux', 'linux'],
]

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (\S+)$/m)?.[1]
if (!triple) throw new Error('target triple 을 알 수 없습니다(TAURI_ENV_TARGET_TRIPLE 또는 rustc -vV)')
const goarch = GOARCH[triple.split('-')[0]]
const goos = GOOS.find(([key]) => triple.includes(key))?.[1]
if (!goarch || !goos) throw new Error(`지원하지 않는 대상입니다: ${triple} (universal macOS 는 대상별로 빌드한 뒤 lipo 로 합치세요)`)

const out = join(desktop, 'src-tauri', 'binaries', `minmo-server-${triple}${goos === 'windows' ? '.exe' : ''}`)
mkdirSync(dirname(out), { recursive: true })
execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, './cmd/minmo-server'], {
  cwd: join(desktop, '..', 'server'),
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
})
console.log(`minmo-server(${goos}/${goarch}) → ${out}`)
