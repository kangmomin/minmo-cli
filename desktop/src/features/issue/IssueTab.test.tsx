// 이슈 탭 — GitHub 이슈 본문 마크다운 미리보기(#116)
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { GitHubError } from '@minmo/core'
import type { GitHubClient, GitHubIssueDetail, IssueTarget } from '@minmo/core'

import { queryKeys } from '../../lib/queryKeys'
import { LOCAL_OWNER } from '../../store/repos'
import { createFakeGitHub, createFakeTauri, flush } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { IssueTab } from './IssueTab'

const GH: IssueTarget = { owner: 'my-org', repo: 'widgets', key: '42', number: 42, title: 'Add login' }

const detail = (body: string): GitHubIssueDetail => ({
  number: 42,
  title: 'Add login',
  state: 'open',
  htmlUrl: 'https://github.com/my-org/widgets/issues/42',
  assignees: [],
  body,
})

function renderTab(getIssue: GitHubClient['getIssue'], target: IssueTarget = GH) {
  const github = createFakeGitHub({ getIssue })
  const { tauri } = createFakeTauri()
  const deps = makeDeps({ github, tauri })
  return { github, tauri, deps, ...renderWithDeps(<IssueTab target={target} />, deps) }
}

const renderBody = (body: string) => renderTab(async () => detail(body))

describe('IssueTab 정상 흐름', () => {
  it('AC-01 getIssue 로 받은 본문의 제목·목록·굵게·기울임·코드·코드 블록·인용·구분선을 렌더한다', async () => {
    const { github, container } = renderBody(
      ['# 제목', '', '- 항목 하나', '- 항목 둘', '', '**굵게** *기울임* `코드`', '', '```', 'const x = 1', '```', '', '> 인용', '', '---'].join('\n'),
    )
    expect(await screen.findByRole('heading', { level: 1, name: '제목' })).toBeInTheDocument()
    expect(github.getIssue).toHaveBeenCalledWith('my-org', 'widgets', 42)
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['항목 하나', '항목 둘'])
    expect(screen.getByText('굵게').tagName).toBe('STRONG')
    expect(screen.getByText('기울임').tagName).toBe('EM')
    expect(screen.getByText('코드').tagName).toBe('CODE')
    expect(container.querySelector('pre')).toHaveTextContent('const x = 1')
    expect(container.querySelector('blockquote')).toHaveTextContent('인용')
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('AC-01 문단 안의 줄바꿈 한 번은 <br> 로 보인다', async () => {
    const { container } = renderBody('첫 줄\n둘째 줄')
    await waitFor(() => expect(container.querySelector('.markdown br')).not.toBeNull())
  })

  it('AC-02 GFM 표·체크리스트(읽기 전용)·취소선·맨 URL 자동 링크를 렌더한다', async () => {
    renderBody(['| 이름 | 값 |', '| --- | --- |', '| a | 1 |', '', '- [ ] 할 일', '- [x] 한 일', '', '~~취소~~', '', 'https://example.com/auto'].join('\n'))
    const table = await screen.findByRole('table')
    expect(table).toHaveTextContent('이름')
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    for (const b of boxes) expect(b).toBeDisabled()
    expect(boxes[0]).not.toBeChecked()
    expect(boxes[1]).toBeChecked()
    expect(screen.getByText('취소').tagName).toBe('DEL')
    expect(screen.getByRole('link', { name: 'https://example.com/auto' })).toHaveAttribute('href', 'https://example.com/auto')
  })

  it('AC-03 http/https 링크(대소문자 무관)를 누르면 화면은 이동하지 않고 openUrl 로 연다', async () => {
    const { tauri } = renderBody('[소문자](https://example.com/a) [대문자](HTTPS://EXAMPLE.COM/B)')
    const lower = await screen.findByRole('link', { name: '소문자' })
    expect(fireEvent.click(lower)).toBe(false)
    expect(tauri.openUrl).toHaveBeenLastCalledWith('https://example.com/a')
    expect(fireEvent.click(screen.getByRole('link', { name: '대문자' }))).toBe(false)
    expect(tauri.openUrl).toHaveBeenLastCalledWith('HTTPS://EXAMPLE.COM/B')
    expect(tauri.openUrl).toHaveBeenCalledTimes(2)
  })

  it('AC-05 GitHub 캐시를 무효화하면(트리 [새로고침]) 본문을 다시 받아 새 본문을 보인다', async () => {
    let calls = 0
    const { github, queryClient } = renderTab(async () => detail(++calls === 1 ? '처음 본문' : '새로 받은 본문'))
    expect(await screen.findByText('처음 본문')).toBeInTheDocument()
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.githubAll }))
    expect(await screen.findByText('새로 받은 본문')).toBeInTheDocument()
    expect(screen.queryByText('처음 본문')).toBeNull()
    expect(github.getIssue).toHaveBeenCalledTimes(2)
  })
})

describe('IssueTab 엣지 케이스', () => {
  it.each([
    ['빈 본문', ''],
    ['공백뿐', '   \n\t \n'],
    ['HTML 주석뿐', '<!-- 템플릿 안내 -->'],
    ['공백과 HTML 주석 여러 개', '\n  <!-- a -->\n\n<!-- b -->  \n'],
  ])('EC-01 본문이 비었거나 공백·HTML 주석뿐이면 "본문이 없습니다." (%s)', async (_label, body) => {
    renderBody(body)
    expect(await screen.findByText('본문이 없습니다.')).toBeInTheDocument()
  })

  it('EC-02 조회 중에는 "불러오는 중…"', async () => {
    renderTab(() => new Promise<GitHubIssueDetail>(() => {}))
    expect(await screen.findByText('불러오는 중…')).toBeInTheDocument()
  })

  it('EC-03 조회 실패 → role=alert 오류 문구 + [다시 시도], 누르면 포커스가 내용 영역으로 가고 다시 조회한다', async () => {
    const user = userEvent.setup()
    let calls = 0
    const { github, container } = renderTab(async () => {
      if (++calls === 1) throw new GitHubError('network', { message: 'offline' })
      return detail('다시 받은 본문')
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub 에 연결할 수 없습니다')
    await user.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(container.firstElementChild).toHaveFocus()
    expect(await screen.findByText('다시 받은 본문')).toBeInTheDocument()
    expect(github.getIssue).toHaveBeenCalledTimes(2)
  })

  it('EC-04 ★기타(number null)는 "★기타에는 이슈 본문이 없습니다." 이고 조회하지 않는다', async () => {
    const { github } = renderTab(async () => detail('x'), { owner: 'my-org', repo: 'widgets', key: 'etc', number: null, title: '' })
    expect(await screen.findByText('★기타에는 이슈 본문이 없습니다.')).toBeInTheDocument()
    await flush()
    expect(github.getIssue).not.toHaveBeenCalled()
  })

  it('EC-05 로컬 저장소 작업은 "로컬 저장소의 작업에는 본문이 없습니다." 이고 조회하지 않는다', async () => {
    const { github } = renderTab(async () => detail('x'), { owner: LOCAL_OWNER, repo: 'app-1a2b', key: '1', number: 1, title: '첫 작업' })
    expect(await screen.findByText('로컬 저장소의 작업에는 본문이 없습니다.')).toBeInTheDocument()
    await flush()
    expect(github.getIssue).not.toHaveBeenCalled()
  })

  it('EC-06 raw HTML 은 요소·글자 모두 보이지 않고, 빈 줄로 나눈 안쪽 마크다운 글자는 보인다', async () => {
    const { container } = renderBody(
      ['<script>alert(1)</script>', '', '<img src=x onerror="alert(2)">', '', '<!-- 안내 -->', '', '<details>', '', '**안쪽 글자**', '', '</details>'].join('\n'),
    )
    expect(await screen.findByText('안쪽 글자')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container).not.toHaveTextContent('alert')
    expect(container).not.toHaveTextContent('안내')
    expect(container).not.toHaveTextContent('<details>')
  })

  it.each([
    ['javascript:', '[스크립트](javascript:alert(1))', '스크립트'],
    ['상대 경로', '[상대](docs/a.md)', '상대'],
    ['#anchor', '[앵커](#section)', '앵커'],
  ])('EC-07 http/https 가 아닌 링크(%s)는 글자로 보이고 openUrl 을 부르지 않는다', async (_label, body, text) => {
    const { tauri } = renderBody(body)
    const el = await screen.findByText(text)
    expect(el.closest('a')).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    fireEvent.click(el)
    expect(tauri.openUrl).not.toHaveBeenCalled()
  })

  it('EC-08 이미지는 <img> 없이 "이미지: alt" 글자, 배지는 링크 하나(중첩 없음)이고 누르면 링크 href 로 openUrl 1번', async () => {
    const { tauri, container } = renderBody('![스크린샷](https://example.com/s.png)\n\n[![CI](https://example.com/b.svg)](https://github.com/o/r/actions)')
    expect(await screen.findByText('이미지: 스크린샷')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAccessibleName('이미지: CI')
    expect(container.querySelector('a a')).toBeNull()
    fireEvent.click(links[0])
    expect(tauri.openUrl).toHaveBeenCalledTimes(1)
    expect(tauri.openUrl).toHaveBeenCalledWith('https://github.com/o/r/actions')
  })

  it('EC-13 본문을 받은 뒤 다시 조회가 실패해도 받은 본문을 계속 보인다', async () => {
    let calls = 0
    const { github, queryClient } = renderTab(async () => {
      if (++calls === 1) return detail('받은 본문')
      throw new GitHubError('network', { message: 'offline' })
    })
    expect(await screen.findByText('받은 본문')).toBeInTheDocument()
    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.githubAll }))
    expect(github.getIssue).toHaveBeenCalledTimes(2)
    expect(screen.getByText('받은 본문')).toBeInTheDocument()
  })

  it('EC-15 링크를 외부 브라우저로 열지 못하면 링크 옆에 알린다', async () => {
    const { tauri } = renderBody('[문서](https://example.com/doc)')
    tauri.openUrl.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(await screen.findByRole('link', { name: '문서' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('브라우저를 열지 못했습니다')
  })

  it('EC-16 체크리스트의 체크박스는 항목 글자를 이름으로 가진다', async () => {
    renderBody('- [ ] 할 일\n- [x] 한 일')
    expect(await screen.findByRole('checkbox', { name: '할 일' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '한 일' })).toBeChecked()
  })

  it('EC-17 불러오는 중 안내는 항상 있는 status 영역에서 바뀐다 — [다시 시도] 중에도 알린다', async () => {
    const user = userEvent.setup()
    let calls = 0
    renderTab(() => (++calls === 1 ? Promise.reject(new GitHubError('network', { message: 'offline' })) : new Promise<GitHubIssueDetail>(() => {})))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('')
    await user.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(status).toHaveTextContent('불러오는 중…')
  })

  it('EC-11 본문 영역은 "이슈 본문" 영역이고, 표 영역 이름은 머리 칸 글자를 담는다(없으면 "표")', async () => {
    renderBody(['| 이름 | 값 |', '| --- | --- |', '| a | 1 |', '', '|  |  |', '| --- | --- |', '| b | 2 |'].join('\n'))
    expect(await screen.findByRole('group', { name: '표: 이름, 값' })).toHaveAttribute('tabindex', '0')
    const region = screen.getByRole('region', { name: '이슈 본문' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region.className).toContain('focus-visible:outline-ring')
    expect(screen.getByRole('group', { name: '표' })).toHaveAttribute('tabindex', '0')
  })

  it('AC-03 링크는 외부 브라우저에서 열린다는 설명을 가진다', async () => {
    renderBody('[문서](https://example.com/doc)')
    expect(await screen.findByRole('link', { name: '문서' })).toHaveAccessibleDescription('외부 브라우저에서 엽니다')
  })

  it('EC-14 조회가 실패한 뒤 다시 마운트해도(다른 탭에 갔다 돌아옴) 자동으로 다시 조회하지 않는다', async () => {
    const { github, deps, queryClient, unmount } = renderTab(async () => {
      throw new GitHubError('network', { message: 'offline' })
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub 에 연결할 수 없습니다')
    expect(github.getIssue).toHaveBeenCalledTimes(1)
    unmount()
    renderWithDeps(<IssueTab target={GH} />, deps, queryClient)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('GitHub 에 연결할 수 없습니다')
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument()
    expect(github.getIssue).toHaveBeenCalledTimes(1)
  })
})
