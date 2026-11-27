import { useCallback, useEffect, useRef, useState } from 'react'

export function useAnnouncer(): [string, (text: string) => void] {
  const [text, setText] = useState('')
  const frame = useRef({ id: 0 })
  const say = useCallback((next: string) => {
    cancelAnimationFrame(frame.current.id)
    // Why: 비운 뒤 다음 frame 에 넣어야 화면 읽기 프로그램이 같은 글도 다시 읽는다.
    setText('')
    if (next !== '') frame.current.id = requestAnimationFrame(() => setText(next))
  }, [])
  useEffect(() => {
    const f = frame.current
    return () => cancelAnimationFrame(f.id)
  }, [])
  return [text, say]
}
