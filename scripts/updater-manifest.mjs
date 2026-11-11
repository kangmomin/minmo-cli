// Tauri 자동 업데이트용 latest.json 을 만든다 — 앱은 릴리즈의 latest/download/latest.json 을 읽어 새 버전과
// 설치 파일 URL·서명(.sig)을 얻는다. Windows 는 설치 종류(nsis·msi)별 키와, 종류를 모를 때 쓰는 기본 키(nsis)를 둔다.
// 사용: node scripts/updater-manifest.mjs --bundle-dir <target/release/bundle> --tag v0.4.0 --repo owner/name [--notes-file f] --out latest.json
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function buildManifest({ version, tag, repo, notes, pubDate, nsis, msi }) {
  const url = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`
  const entry = (f) => ({ signature: f.signature.trim(), url: url(f.name) })
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': entry(nsis),
      'windows-x86_64-nsis': entry(nsis),
      'windows-x86_64-msi': entry(msi),
    },
  }
}

/** dir 에서 끝이 suffix 인 설치 파일 하나와 그 .sig 를 찾는다 */
export function findSigned(dir, suffix, version) {
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(suffix) && n.includes(`_${version}_`)) : []
  if (names.length !== 1) throw new Error(`${dir} 에서 ${version} 의 *${suffix} 를 하나 찾지 못했습니다: ${names.join(', ') || '(없음)'}`)
  const sig = join(dir, `${names[0]}.sig`)
  if (!existsSync(sig)) throw new Error(`서명 파일이 없습니다: ${sig} (createUpdaterArtifacts·TAURI_SIGNING_PRIVATE_KEY 확인)`)
  return { name: names[0], signature: readFileSync(sig, 'utf8') }
}

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = args(process.argv.slice(2))
  for (const k of ['bundle-dir', 'tag', 'repo', 'out']) if (!a[k]) throw new Error(`--${k} 가 필요합니다`)
  const version = a.tag.replace(/^v/, '')
  const notes = a['notes-file'] && existsSync(a['notes-file']) ? readFileSync(a['notes-file'], 'utf8').trim() : `minmo ${a.tag}`
  const manifest = buildManifest({
    version,
    tag: a.tag,
    repo: a.repo,
    notes,
    pubDate: new Date().toISOString(),
    nsis: findSigned(join(a['bundle-dir'], 'nsis'), '-setup.exe', version),
    msi: findSigned(join(a['bundle-dir'], 'msi'), '.msi', version),
  })
  writeFileSync(a.out, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`${a.out}: ${version} (${Object.keys(manifest.platforms).join(', ')})`)
}
