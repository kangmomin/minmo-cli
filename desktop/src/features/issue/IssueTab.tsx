// Why: 이슈 탭(#116)은 GitHub 이슈 본문을 마크다운으로 렌더해 읽기 전용으로만 보인다
import { useQuery } from '@tanstack/react-query'
import { Children, createContext, isValidElement, memo, useContext, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components, ExtraProps } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

import type { IssueTarget } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { queryKeys } from '../../lib/queryKeys'
import { isLocalOwner } from '../../store/repos'
import { githubErrorMessage } from '../tree/useTree'

// Why: 링은 box-shadow 라 스크롤하면 자식의 배경(코드·표 머리)에 가려진다 — 내용 위에 그려지는 outline 으로 보인다.
// 포커스 때만 실선 outline 을 둔다(고대비 모드에서도 outline 은 시스템 색으로 남고, 포커스가 없을 때 테두리가 생기지 않는다)
const FOCUS_OUTLINE = 'outline-none focus-visible:outline-solid focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring'

/** 링크를 열지 못한 주소를 본문 위에 알린다 — 알림이 표 머리·체크리스트 label 안에 섞이지 않게 한 곳에 둔다 */
const OpenFailureContext = createContext<(href: string | null) => void>(() => undefined)

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
  const [openFailed, setOpenFailed] = useState<string | null>(null)
  const loading = issue.data === undefined && (!issue.isError || issue.isFetching)
  return (
    <>
      {/* Why: live region 은 미리 접근성 트리에 있어야 바뀐 글자를 읽는다 — 영역은 항상 두고(숨기지 않음, 비면 높이 0) 글자만 바꾼다 */}
      <p role="status" className="text-sm text-muted-foreground">
        {loading ? '불러오는 중…' : ''}
      </p>
      {/* Why: 아래로 스크롤한 채 링크를 눌러도 보이게 스크롤 영역 위에 붙인다(배경은 그대로 background — 대비 유지) */}
      {openFailed !== null && (
        <p role="alert" className="sticky top-0 z-10 mb-3 break-all bg-background py-1 text-sm text-destructive">
          브라우저를 열지 못했습니다 — {openFailed}
        </p>
      )}
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
        <OpenFailureContext.Provider value={setOpenFailed}>
          <MarkdownBody body={issue.data.body} />
        </OpenFailureContext.Provider>
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
  const reportOpenFailure = useContext(OpenFailureContext)
  // Why: 앱 창 안에서 이동하지 않게 http/https 만 외부 브라우저로 열고, 나머지는 글자로 둔다
  if (href === undefined || !/^https?:/i.test(href)) return <span>{children}</span>
  return (
    <a
      href={href}
      title="외부 브라우저에서 엽니다"
      onClick={(e) => {
        e.preventDefault()
        reportOpenFailure(null)
        void tauri.openUrl(href).catch(() => reportOpenFailure(href))
      }}
    >
      {children}
    </a>
  )
}

// Why: CSP 를 넓히지 않으려고 이미지를 띄우지 않고, 배지 링크 안에서 <a> 가 겹치지 않게 글자로만 둔다
function MarkdownImage({ alt }: { alt?: string }) {
  return <span>이미지{alt ? `: ${alt}` : ''}</span>
}

// Why: GFM 체크리스트의 체크박스에는 이름이 없다 — 항목 글자와 label 로 묶어 이름을 준다.
// 하위 목록은 label 밖에 둔다(label 안에 label 이 생기거나 바깥 체크박스 이름에 하위 항목이 붙지 않게)
function MarkdownListItem({ node: _node, className, children, ...rest }: ComponentProps<'li'> & ExtraProps) {
  if (!className?.split(' ').includes('task-list-item')) return <li className={className} {...rest}>{children}</li>
  const items = Children.toArray(children)
  const nestedAt = items.findIndex((c) => isValidElement(c) && (c.type === 'ul' || c.type === 'ol'))
  return (
    <li className={className} {...rest}>
      <label>{nestedAt === -1 ? items : items.slice(0, nestedAt)}</label>
      {nestedAt === -1 ? null : items.slice(nestedAt)}
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
