// 내장 서버(사이드카) minmo-server 를 빌드한다. tauri.conf.json 의 bundle.externalBin 이 찾는 이름
// (src-tauri/binaries/minmo-server-<host triple>[.exe])으로 두면 Tauri 가 설치 파일과 target/<profile>/ 에 함께 넣는다.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (\S+)$/m)?.[1]
if (!triple) throw new Error('rustc -vV 에서 host triple 을 찾지 못했습니다')
const out = join(desktop, 'src-tauri', 'binaries', `minmo-server-${triple}${triple.includes('windows') ? '.exe' : ''}`)
mkdirSync(dirname(out), { recursive: true })
execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, './cmd/minmo-server'], {
  cwd: join(desktop, '..', 'server'),
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0' },
})
console.log(`minmo-server → ${out}`)
