// 새로고침 단축키 차단(#99) — WebView 가 Ctrl+R·F5 로 앱 전체를 새로고침해 작업 화면이 날아간다

type ReloadKeyEvent = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'key' | 'code'>

/** 새로고침 키(Ctrl+R·Ctrl+Shift+R·F5·Ctrl+F5·Shift+F5·키보드의 새로고침 키)인가. Alt·Meta 조합은 보지 않는다(Ctrl+Alt 는 AltGr 글자 입력일 수 있다) */
export function isReloadKey(e: ReloadKeyEvent): boolean {
  if (e.altKey || e.metaKey) return false
  if (e.key === 'F5' || e.key === 'BrowserRefresh') return true
  if (!e.ctrlKey) return false
  // 입력된 글자를 우선한다(Dvorak 등). 한글 IME 처럼 라틴 문자가 아닐 때만 물리 키로 본다 — terminal/keys.ts 의 isKey 와 같은 규칙
  const k = e.key.length === 1 ? e.key.toLowerCase() : ''
  return /^[a-z]$/.test(k) ? k === 'r' : e.code === 'KeyR'
}

/**
 * 앱 전체에서 새로고침 키의 기본 동작을 막는다. 해제 함수를 돌려준다.
 * capture 단계에서 건다 — 하위 요소가 stopPropagation 해도 빠지지 않게. preventDefault 만 하고 전파는 막지 않는다:
 * xterm 은 키 입력에서 defaultPrevented 를 보지 않으므로 터미널의 Ctrl+R(^R, 셸 역방향 검색)은 그대로 셸로 간다.
 */
export function blockReloadKeys(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isReloadKey(e)) e.preventDefault()
  }
  target.addEventListener('keydown', onKey, { capture: true })
  return () => target.removeEventListener('keydown', onKey, { capture: true })
}
