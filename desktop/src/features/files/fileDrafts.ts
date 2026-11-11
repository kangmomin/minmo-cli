// 파일 탭의 편집 상태(메모리). 탭·이슈를 오가도 저장 안 한 내용과 열어 둔 파일이 유지되게 컴포넌트 밖에 둔다.

/** 연 파일의 편집 상태: saved = 마지막으로 읽거나 저장한 내용, text = 지금 편집 중인 내용 */
export type Draft = { text: string; saved: string; version: string }

const drafts = new Map<string, Draft>()
const openFiles = new Map<string, string>()

const key = (scope: string, rel: string) => `${scope}\n${rel}`

export const fileDrafts = {
  get: (scope: string, rel: string) => drafts.get(key(scope, rel)),
  set: (scope: string, rel: string, d: Draft) => void drafts.set(key(scope, rel), d),
  delete: (scope: string, rel: string) => void drafts.delete(key(scope, rel)),
  /** 이름을 바꾸거나 지운 경로(하위 포함)의 편집 상태를 옮기거나 버린다 */
  move(scope: string, from: string, to: string | null) {
    for (const [k, d] of [...drafts]) {
      const prefix = `${scope}\n`
      if (!k.startsWith(prefix)) continue
      const rel = k.slice(prefix.length)
      if (rel !== from && !rel.startsWith(`${from}/`)) continue
      drafts.delete(k)
      if (to !== null) drafts.set(key(scope, to + rel.slice(from.length)), d)
    }
  },
  /** 이 작업 공간에서 저장 안 한 파일들 */
  dirty: (scope: string) =>
    [...drafts].filter(([k, d]) => k.startsWith(`${scope}\n`) && d.text !== d.saved).map(([k]) => k.slice(scope.length + 1)),
  openFile: (scope: string) => openFiles.get(scope) ?? null,
  setOpenFile(scope: string, rel: string | null) {
    if (rel === null) openFiles.delete(scope)
    else openFiles.set(scope, rel)
  },
  /** 테스트용 */
  clear() {
    drafts.clear()
    openFiles.clear()
  },
}

/** "file_changed: 설명" 형태의 오류에서 코드와 설명을 나눈다 */
export function fileError(e: unknown): { code: string | null; message: string } {
  const text = e instanceof Error ? e.message : String(e)
  const m = /^(file_[a-z_]+): ([\s\S]*)$/.exec(text)
  return m ? { code: m[1], message: m[2] } : { code: null, message: text }
}

export const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
export const nameOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1)
export const joinRel = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`)

/** 새 이름 검사 — 경로 구분자나 상위 폴더 표기는 받지 않는다. 문제가 없으면 null */
export function nameProblem(name: string): string | null {
  const n = name.trim()
  if (n === '') return '이름을 입력하세요'
  if (n === '.' || n === '..' || /[\\/\n]/.test(n)) return '이름에 / \\ 를 쓸 수 없습니다'
  if (n === '.git') return '.git 은 쓸 수 없습니다'
  return null
}
