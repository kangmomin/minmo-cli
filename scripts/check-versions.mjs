// 릴리즈 전 버전 일치 확인 — 루트·desktop·CLI package.json, tauri.conf.json, Cargo.toml 이 같은 버전이어야 하고,
// 태그(GITHUB_REF_TYPE=tag)로 실행되면 태그도 v<버전> 이어야 한다. 결과는 GITHUB_OUTPUT(version·tag)에 쓴다.
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(root + p, 'utf8')

export function collectVersions(readFile = read) {
  const j = (p) => JSON.parse(readFile(p)).version
  return {
    'package.json': j('package.json'),
    'desktop/package.json': j('desktop/package.json'),
    'packages/cli/package.json': j('packages/cli/package.json'),
    'desktop/src-tauri/tauri.conf.json': j('desktop/src-tauri/tauri.conf.json'),
    'desktop/src-tauri/Cargo.toml': /^version\s*=\s*"([^"]+)"/m.exec(readFile('desktop/src-tauri/Cargo.toml'))?.[1],
  }
}

/** 모두 같으면 그 버전, 다르면 오류 문구를 던진다 */
export function checkVersions(versions, tag) {
  const values = [...new Set(Object.values(versions))]
  if (values.length !== 1 || !values[0]) {
    throw new Error(`버전이 서로 다릅니다:\n${Object.entries(versions).map(([f, v]) => `  ${f}: ${v}`).join('\n')}`)
  }
  const version = values[0]
  if (tag && tag !== `v${version}`) throw new Error(`태그 ${tag} 가 버전 v${version} 과 다릅니다`)
  return version
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined
  try {
    const version = checkVersions(collectVersions(), tag)
    console.log(`version ${version}${tag ? ` (tag ${tag})` : ''}`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
