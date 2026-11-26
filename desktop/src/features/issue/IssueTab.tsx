// Why: 이슈 탭(#116)은 GitHub 이슈 본문을 마크다운으로 렌더해 읽기 전용으로만 보인다
import { useQuery } from '@tanstack/react-query'
import { memo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

import type { IssueTarget } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { queryKeys } from '../../lib/queryKeys'
import { isLocalOwner } from '../../store/repos'
import { githubErrorMessage } from '../tree/useTree'

// Why: 링은 box-shadow 라 스크롤하면 자식의 배경(코드·표 머리)에 가려진다 — 내용 위에 그려지는 outline 으로 보인다
const FOCUS_OUTLINE = 'outline-hidden focus-visible:outline-solid focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring'

export function IssueTab({ target }: { target: IssueTarget }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} tabIndex={0} role="region" aria-label="이슈 본문" className={`h-full overflow-auto p-4 ${FOCUS_OUTLINE}`}>
      {target.number === null ? (
        <p className="text-sm text-muted-foreground">★기타에는 이슈 본문이 없습니다.</p>
      ) : isLocalOwner(target.owner) ? (
        <p className="text-sm text-muted-foreground">로컬 저장소의 작업에는 본문이 없습니다.</p>
      ) : (
        <GitHubIssueBody owner={target.owner} repo={target.repo} number={target.number} focusContent={() => ref.current?.focus()} />
      )}
    </div>
  )
}

function GitHubIssueBody({ owner, repo, number, focusContent }: { owner: string; repo: string; number: number; focusContent(): void }) {
  const { github } = useDeps()
  // Why: GitHub 조회는 자동으로 다시 하지 않는다 — [다시 시도]·트리 [새로고침]으로만 다시 받는다
  const issue = useQuery({
    queryKey: queryKeys.githubIssueBody(owner, repo, number),
    queryFn: () => github.getIssue(owner, repo, number),
    staleTime: Infinity,
    retry: false,
    retryOnMount: false,
  })
  const loading = issue.data === undefined && (!issue.isError || issue.isFetching)
  return (
    <>
      {/* Why: live region 은 미리 있어야 바뀐 글자를 읽는다 — 영역은 항상 두고 글자만 바꾼다([다시 시도] 중에도 알린다) */}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {loading ? '불러오는 중…' : ''}
      </p>
      {issue.data === undefined ? (
        issue.isError && (
          <div className="grid justify-items-start gap-3">
            <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
              {githubErrorMessage(issue.error)}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={issue.isFetching}
              onClick={() => {
                // Why: 조회가 끝나면 버튼이 사라지므로 포커스를 먼저 내용 영역으로 옮겨 잃지 않게 한다
                focusContent()
                void issue.refetch()
              }}
            >
              다시 시도
            </Button>
          </div>
        )
      ) : isBlank(issue.data.body) ? (
        <p className="text-sm text-muted-foreground">본문이 없습니다.</p>
      ) : (
        <MarkdownBody body={issue.data.body} />
      )}
    </>
  )
}

// Why: 다시 조회하는 동안(isFetching) 본문이 같으면 마크다운을 다시 파싱하지 않는다
const MarkdownBody = memo(function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} skipHtml>
        {body}
      </Markdown>
    </div>
  )
})

// Why: 이슈 템플릿의 HTML 주석은 skipHtml 로 숨으므로, 주석만 남은 본문도 빈 본문으로 본다
const isBlank = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '').trim() === ''

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { tauri } = useDeps()
  const [failed, setFailed] = useState(false)
  // Why: 앱 창 안에서 이동하지 않게 http/https 만 외부 브라우저로 열고, 나머지는 글자로 둔다
  if (href === undefined || !/^https?:/i.test(href)) return <span>{children}</span>
  return (
    <>
      <a
        href={href}
        title="외부 브라우저에서 엽니다"
        onClick={(e) => {
          e.preventDefault()
          setFailed(false)
          void tauri.openUrl(href).catch(() => setFailed(true))
        }}
      >
        {children}
      </a>
      {failed && (
        <span role="alert" className="ml-1 text-destructive">
          (브라우저를 열지 못했습니다)
        </span>
      )}
    </>
  )
}

// Why: CSP 를 넓히지 않으려고 이미지를 띄우지 않고, 배지 링크 안에서 <a> 가 겹치지 않게 글자로만 둔다
function MarkdownImage({ alt }: { alt?: string }) {
  return <span>이미지{alt ? `: ${alt}` : ''}</span>
}

// Why: GFM 체크리스트의 체크박스에는 이름이 없다 — 항목 글자와 label 로 묶어 이름을 준다
function MarkdownListItem({ className, children }: { className?: string; children?: ReactNode }) {
  if (!className?.split(' ').includes('task-list-item')) return <li className={className}>{children}</li>
  return (
    <li className={className}>
      <label>{children}</label>
    </li>
  )
}

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[] }
const textOf = (n: HastNode): string => (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join(''))
const findTag = (n: HastNode, tag: string): HastNode | undefined =>
  n.tagName === tag ? n : (n.children ?? []).reduce<HastNode | undefined>((found, c) => found ?? findTag(c, tag), undefined)

function MarkdownTable({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const row = node && findTag(node, 'tr')
  const headers = (row?.children ?? []).filter((c) => c.tagName === 'th').map((c) => textOf(c).trim()).filter(Boolean)
  return (
    // Why: 넓은 표를 키보드로 가로 스크롤하게 포커스를 받는다. 표가 여럿이어도 구분되게 머리 칸 글자를 이름에 넣고, 랜드마크가 늘지 않게 region 대신 group
    <div tabIndex={0} role="group" aria-label={headers.length > 0 ? `표: ${headers.join(', ')}` : '표'} className={`overflow-x-auto ${FOCUS_OUTLINE}`}>
      <table>{children}</table>
    </div>
  )
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks]
const COMPONENTS: Components = { a: MarkdownLink, img: MarkdownImage, li: MarkdownListItem, table: MarkdownTable }
