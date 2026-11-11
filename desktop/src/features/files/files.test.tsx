// 파일 탭 — 트리(펼치기), 열기·편집·저장, 외부 변경 충돌, 새 파일·이름 바꾸기·삭제, 탭을 오가도 유지되는 편집 상태
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirEntry, TauriApi } from '../../lib/tauri'
import { createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { fileDrafts, fileError, nameProblem } from './fileDrafts'
import { FilesTab } from './FilesTab'

// CodeMirror 는 jsdom 에서 레이아웃을 잴 수 없어 textarea 로 대신한다(저장 단축키는 버튼으로 흉내)
const editor = vi.hoisted(() => ({ mounts: 0 }))
vi.mock('./CodeEditor', () => ({
  CodeEditor: ({ initial, label, onChange, onSave }: { initial: string; label: string; onChange(t: string): void; onSave(): void }) => {
    editor.mounts += 1
    return (
      <div>
        <textarea aria-label={label} defaultValue={initial} onChange={(e) => onChange(e.target.value)} />
        <button type="button" onClick={onSave}>
          단축키 저장
        </button>
      </div>
    )
  },
}))

const ROOT = '/ws/o/r/t'
const SCOPE = 'o/r#1'

const TREE: Record<string, DirEntry[]> = {
  '': [
    { name: 'src', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
    { name: 'link', kind: 'link' },
  ],
  src: [{ name: 'index.ts', kind: 'file' }],
}

function setup(overrides: Partial<TauriApi> = {}) {
  const files = new Map([
    ['README.md', '# hi\n'],
    ['src/index.ts', 'export {}\n'],
  ])
  let v = 0
  const { tauri } = createFakeTauri({
    listDir: async (_root, rel) => TREE[rel] ?? [],
    readTextFile: async (_root, rel) => {
      const content = files.get(rel)
      if (content === undefined) throw 'file_too_large: 2MB 보다 큰 파일은 열 수 없습니다'
      return { content, version: `v${v}` }
    },
    writeTextFile: async (_root, rel, content) => {
      files.set(rel, content)
      return `v${++v}`
    },
    ...overrides,
  })
  const r = renderWithDeps(<FilesTab root={ROOT} scope={SCOPE} />, makeDeps({ tauri }))
  return { ...r, tauri, files, user: userEvent.setup() }
}

beforeEach(() => {
  fileDrafts.clear()
  editor.mounts = 0
})

describe('파일 트리', () => {
  it('최상위를 보여 주고, 폴더를 누르면 그 안을 불러온다', async () => {
    const t = setup()
    const tree = await screen.findByRole('tree', { name: '파일' })
    expect(await within(tree).findByRole('treeitem', { name: 'src' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(tree).getByRole('treeitem', { name: 'README.md' })).toBeInTheDocument()
    await t.user.click(within(tree).getByRole('treeitem', { name: 'src' }))
    expect(await within(tree).findByRole('treeitem', { name: 'index.ts' })).toBeInTheDocument()
    expect(t.tauri.listDir).toHaveBeenCalledWith(ROOT, 'src')
    expect(within(tree).getByRole('treeitem', { name: 'src' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('심볼릭 링크는 열지 않는다 · 폴더를 못 읽으면 그 자리에 오류를 보여 준다', async () => {
    const t = setup({ listDir: async (_r, rel) => (rel === '' ? TREE[''] : Promise.reject('Permission denied')) })
    await t.user.click(await screen.findByRole('treeitem', { name: 'link' }))
    expect(t.tauri.readTextFile).not.toHaveBeenCalled()
    await t.user.click(screen.getByRole('treeitem', { name: 'src' }))
    expect(await screen.findByText('Permission denied')).toBeInTheDocument()
  })
})

describe('편집·저장', () => {
  it('파일을 열어 고치면 "저장 안 됨" 이 뜨고, 저장하면 읽을 때의 version 과 함께 쓴다', async () => {
    const t = setup()
    await t.user.click(await screen.findByRole('treeitem', { name: 'README.md' }))
    const box = await screen.findByRole('textbox', { name: 'README.md 편집' })
    expect(box).toHaveValue('# hi\n')
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled()

    await t.user.type(box, 'more')
    expect(screen.getByText('● 저장 안 됨')).toBeInTheDocument()
    await t.user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(t.tauri.writeTextFile).toHaveBeenCalledWith(ROOT, 'README.md', '# hi\nmore', { expected: 'v0' }))
    await waitFor(() => expect(screen.queryByText('● 저장 안 됨')).toBeNull())
    expect(screen.getByText('저장했습니다')).toBeInTheDocument()

    // 다음 저장은 새 version 으로(단축키)
    await t.user.type(box, '!')
    await t.user.click(screen.getByRole('button', { name: '단축키 저장' }))
    await waitFor(() => expect(t.tauri.writeTextFile).toHaveBeenLastCalledWith(ROOT, 'README.md', '# hi\nmore!', { expected: 'v1' }))
  })

  it('그 사이 파일이 바뀌었으면 덮어쓰지 않고 묻는다 → [내 내용으로 덮어쓰기]', async () => {
    const writeTextFile = vi
      .fn<TauriApi['writeTextFile']>()
      .mockRejectedValueOnce('file_changed: 연 뒤에 파일이 바뀌었습니다')
      .mockResolvedValue('v9')
    const t = setup({ writeTextFile })
    await t.user.click(await screen.findByRole('treeitem', { name: 'README.md' }))
    await t.user.type(await screen.findByRole('textbox', { name: 'README.md 편집' }), 'x')
    await t.user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('다른 곳에서 바뀌었습니다')
    expect(screen.getByText('● 저장 안 됨')).toBeInTheDocument()
    await t.user.click(screen.getByRole('button', { name: '내 내용으로 덮어쓰기' }))
    await waitFor(() => expect(writeTextFile).toHaveBeenLastCalledWith(ROOT, 'README.md', '# hi\nx', undefined))
    await waitFor(() => expect(screen.queryByText('● 저장 안 됨')).toBeNull())
  })

  it('열 수 없는 파일(너무 큼·바이너리)은 사유를 보여 준다', async () => {
    const t = setup({ listDir: async () => [{ name: 'big.bin', kind: 'file' }] })
    await t.user.click(await screen.findByRole('treeitem', { name: 'big.bin' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('열 수 없습니다: 2MB 보다 큰 파일은 열 수 없습니다')
  })

  it('탭을 떠났다 돌아와도 저장 안 한 내용과 열어 둔 파일이 그대로다', async () => {
    const t = setup()
    await t.user.click(await screen.findByRole('treeitem', { name: 'README.md' }))
    await t.user.type(await screen.findByRole('textbox', { name: 'README.md 편집' }), 'draft')
    t.unmount()
    expect(fileDrafts.dirty(SCOPE)).toEqual(['README.md'])

    const again = setup()
    expect(await screen.findByRole('textbox', { name: 'README.md 편집' })).toHaveValue('# hi\ndraft')
    expect(screen.getByText('● 저장 안 됨')).toBeInTheDocument()
    // 다시 읽지 않는다(읽으면 편집 내용을 덮는다)
    expect(again.tauri.readTextFile).not.toHaveBeenCalled()
  })

  it('[다시 불러오기] 는 디스크의 내용으로 되돌린다', async () => {
    const t = setup()
    await t.user.click(await screen.findByRole('treeitem', { name: 'README.md' }))
    await t.user.type(await screen.findByRole('textbox', { name: 'README.md 편집' }), 'zzz')
    await t.user.click(screen.getByRole('button', { name: '다시 불러오기' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'README.md 편집' })).toHaveValue('# hi\n'))
    expect(screen.queryByText('● 저장 안 됨')).toBeNull()
  })
})

describe('새 파일·이름 바꾸기·삭제', () => {
  it('고른 폴더 안에 새 파일을 만들고 바로 연다', async () => {
    const t = setup()
    await t.user.click(await screen.findByRole('treeitem', { name: 'src' }))
    await t.user.click(screen.getByRole('button', { name: '새 파일' }))
    const dlg = screen.getByRole('dialog', { name: '새 파일' })
    expect(dlg).toHaveTextContent('위치: src')
    await t.user.type(within(dlg).getByLabelText('이름'), 'a/b.ts')
    await t.user.click(within(dlg).getByRole('button', { name: '확인' }))
    expect(within(dlg).getByRole('alert')).toHaveTextContent('/ \\ 를 쓸 수 없습니다')
    await t.user.clear(within(dlg).getByLabelText('이름'))
    await t.user.type(within(dlg).getByLabelText('이름'), 'new.ts')
    await t.user.click(within(dlg).getByRole('button', { name: '확인' }))
    await waitFor(() => expect(t.tauri.writeTextFile).toHaveBeenCalledWith(ROOT, 'src/new.ts', '', { create: true }))
    expect(await screen.findByRole('textbox', { name: 'src/new.ts 편집' })).toBeInTheDocument()
  })

  it('이름을 바꾸면 열어 둔 파일과 편집 내용이 새 이름으로 옮겨진다', async () => {
    const t = setup()
    await t.user.click(await screen.findByRole('treeitem', { name: 'README.md' }))
    await t.user.type(await screen.findByRole('textbox', { name: 'README.md 편집' }), 'keep')
    await t.user.click(screen.getByRole('button', { name: '이름 바꾸기' }))
    const dlg = screen.getByRole('dialog', { name: '이름 바꾸기' })
    const input = within(dlg).getByLabelText('이름')
    expect(input).toHaveValue('README.md')
    await t.user.clear(input)
    await t.user.type(input, 'DOCS.md')
    await t.user.click(within(dlg).getByRole('button', { name: '확인' }))
    await waitFor(() => expect(t.tauri.renamePath).toHaveBeenCalledWith(ROOT, 'README.md', 'DOCS.md'))
    expect(fileDrafts.get(SCOPE, 'DOCS.md')?.text).toBe('# hi\nkeep')
    expect(fileDrafts.get(SCOPE, 'README.md')).toBeUndefined()
    expect(fileDrafts.openFile(SCOPE)).toBe('DOCS.md')
  })

  it('삭제는 확인을 거치고, 열어 둔 파일이면 편집기를 닫는다', async () => {
    const t = setup()
    await t.user.click(await screen.findByRole('treeitem', { name: 'README.md' }))
    await screen.findByRole('textbox', { name: 'README.md 편집' })
    await t.user.click(screen.getByRole('button', { name: '삭제' }))
    const dlg = screen.getByRole('dialog', { name: '삭제' })
    expect(dlg).toHaveTextContent('README.md')
    expect(t.tauri.removePath).not.toHaveBeenCalled()
    await t.user.click(within(dlg).getByRole('button', { name: '삭제' }))
    await waitFor(() => expect(t.tauri.removePath).toHaveBeenCalledWith(ROOT, 'README.md'))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'README.md 편집' })).toBeNull())
    expect(screen.getByText('README.md 을(를) 삭제했습니다')).toBeInTheDocument()
  })

  it('실패하면 사유를 알린다(같은 이름이 이미 있음)', async () => {
    const t = setup({ createDir: async () => Promise.reject('file_exists: 같은 이름이 이미 있습니다') })
    await screen.findByRole('treeitem', { name: 'src' })
    await t.user.click(screen.getByRole('button', { name: '새 폴더' }))
    await t.user.type(within(screen.getByRole('dialog', { name: '새 폴더' })).getByLabelText('이름'), 'src')
    await act(async () => void (await t.user.click(screen.getByRole('button', { name: '확인' }))))
    expect(await screen.findByRole('alert')).toHaveTextContent('같은 이름이 이미 있습니다')
  })
})

describe('도우미', () => {
  it('오류 코드와 설명을 나눈다', () => {
    expect(fileError('file_changed: 바뀜')).toEqual({ code: 'file_changed', message: '바뀜' })
    expect(fileError(new Error('boom'))).toEqual({ code: null, message: 'boom' })
  })

  it('이름 검사', () => {
    for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', '.git']) expect(nameProblem(bad)).not.toBeNull()
    for (const ok of ['a.ts', '.env', '한글 파일.md']) expect(nameProblem(ok)).toBeNull()
  })
})
