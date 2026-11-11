// CodeMirror 6 래퍼 — 내용은 마운트할 때 한 번 넣고(uncontrolled) 바뀔 때마다 알려 준다. 다른 내용을 넣으려면 key 로 다시 마운트한다.
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { yaml } from '@codemirror/lang-yaml'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { tags as t } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

import { GHOSTTY, GHOSTTY_COLORS as C, GHOSTTY_UI } from '../../lib/ghostty'
import type { Theme } from '../../store/ui'

export interface CodeEditorProps {
  /** 처음 넣을 내용 */
  initial: string
  /** 문법 강조를 고르는 데 쓰는 파일 이름 */
  fileName: string
  theme: Theme
  label: string
  onChange(text: string): void
  /** Ctrl+S / Cmd+S */
  onSave(): void
}

/** 파일 이름(확장자)에 맞는 문법 강조. 모르는 형식은 강조 없이 연다 */
export function languageFor(fileName: string): Extension[] {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return [javascript({ typescript: true })]
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })]
    case 'js':
    case 'mjs':
    case 'cjs':
      return [javascript()]
    case 'jsx':
      return [javascript({ jsx: true })]
    case 'json':
      return [json()]
    case 'md':
    case 'markdown':
      return [markdown()]
    case 'go':
      return [go()]
    case 'rs':
      return [rust()]
    case 'py':
      return [python()]
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return [html()]
    case 'css':
    case 'scss':
      return [css()]
    case 'yml':
    case 'yaml':
      return [yaml()]
    default:
      return []
  }
}

/** Ghostty 테마의 편집기 — 배경·글자는 Ghostty 기본, 문법 강조는 그 16색 팔레트로 */
const ghosttyEditor: Extension[] = [
  EditorView.theme(
    {
      '&': { color: GHOSTTY.foreground, backgroundColor: GHOSTTY.background },
      '.cm-content': { caretColor: GHOSTTY.foreground },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: GHOSTTY.foreground },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#4a5263' },
      '.cm-gutters': { backgroundColor: GHOSTTY.background, color: GHOSTTY_UI.comment, border: 'none' },
      '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 5%)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgb(255 255 255 / 5%)', color: GHOSTTY_UI.mutedForeground },
      '.cm-selectionMatch': { backgroundColor: 'rgb(129 162 190 / 30%)' },
      '&.cm-focused .cm-matchingBracket': { backgroundColor: 'rgb(129 162 190 / 35%)', outline: 'none' },
      '.cm-panels, .cm-tooltip': { backgroundColor: GHOSTTY_UI.surface, color: GHOSTTY.foreground, border: '1px solid rgb(255 255 255 / 14%)' },
      '.cm-foldPlaceholder': { backgroundColor: GHOSTTY_UI.raised, border: 'none', color: GHOSTTY_UI.mutedForeground },
    },
    { dark: true },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: C.brightMagenta },
      { tag: [t.string, t.special(t.string), t.regexp, t.inserted], color: C.green },
      { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name)], color: C.yellow },
      { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: C.brightBlue },
      { tag: [t.typeName, t.className, t.namespace, t.tagName], color: C.cyan },
      { tag: [t.propertyName, t.attributeName], color: C.blue },
      { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: C.white },
      { tag: [t.comment, t.meta], color: GHOSTTY_UI.comment, fontStyle: 'italic' },
      { tag: [t.heading], color: C.brightBlue, fontWeight: 'bold' },
      { tag: [t.link, t.url], color: C.cyan, textDecoration: 'underline' },
      { tag: t.strong, fontWeight: 'bold' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: [t.deleted, t.invalid], color: C.red },
    ]),
  ),
]

/** 테마별 편집기 색: Ghostty 는 전용, 블랙은 oneDark, 라이트는 CodeMirror 기본 */
export function editorTheme(theme: Theme): Extension[] {
  return theme === 'ghostty' ? ghosttyEditor : theme === 'black' ? [oneDark] : []
}

export function CodeEditor({ initial, fileName, theme, label, onChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  // 뷰는 마운트 때 한 번 만든다 — 최신 콜백은 ref 로 읽는다
  const handlers = useRef({ onChange, onSave })
  useEffect(() => {
    handlers.current = { onChange, onSave }
  }, [onChange, onSave])

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      doc: initial,
      parent: host.current,
      extensions: [
        basicSetup,
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              handlers.current.onSave()
              return true
            },
          },
          indentWithTab,
        ]),
        ...languageFor(fileName),
        ...editorTheme(theme),
        EditorView.theme({ '&': { height: '100%', fontSize: '13px' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } }),
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange(u.state.doc.toString())
        }),
      ],
    })
    return () => view.destroy()
    // initial 은 처음 값만 쓴다(다른 내용은 key 로 다시 마운트)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName, theme, label])

  return <div ref={host} className="size-full overflow-hidden" data-testid="code-editor" />
}
