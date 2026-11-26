// Why: 이슈 탭(#116)은 GitHub 이슈 본문을 마크다운으로 렌더해 읽기 전용으로만 보인다
import { useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
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

export function IssueTab({ target }: { target: IssueTarget }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} tabIndex={0} className="h-full overflow-auto p-4 outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring">
      {target.number === null ? (
        <p className="text-sm text-muted-foreground">★기타에는 이슈 본문이 없습니다.</p>
      ) : isLocalOwner(target.owner) ? (
        <p className="text-sm text-muted-foreground">로컬 저장소의 작업에는 본문이 없습니다.</p>
      ) : (
        <GitHubIssueBody owner={target.owner} repo={target.repo} number={target.number} onRetry={() => ref.current?.focus()} />
      )}
    </div>
  )
}

function GitHubIssueBody({ owner, repo, number, onRetry }: { owner: string; repo: string; number: number; onRetry(): void }) {
  const { github } = useDeps()
  // Why: GitHub 조회는 자동으로 다시 하지 않는다 — [다시 시도]·트리 [새로고침]으로만 다시 받는다
  const issue = useQuery({
    queryKey: queryKeys.githubIssueBody(owner, repo, number),
    queryFn: () => github.getIssue(owner, repo, number),
    staleTime: Infinity,
    retry: false,
    retryOnMount: false,
  })
  if (issue.data === undefined) {
    if (!issue.isError) return <p className="text-sm text-muted-foreground">불러오는 중…</p>
    return (
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
            onRetry()
            void issue.refetch()
          }}
        >
          다시 시도
        </Button>
      </div>
    )
  }
  if (isBlank(issue.data.body)) return <p className="text-sm text-muted-foreground">본문이 없습니다.</p>
  return (
    <div className="markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} skipHtml>
        {issue.data.body}
      </Markdown>
    </div>
  )
}

// Why: 이슈 템플릿의 HTML 주석은 skipHtml 로 숨으므로, 주석만 남은 본문도 빈 본문으로 본다
const isBlank = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '').trim() === ''

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { tauri } = useDeps()
  // Why: 앱 창 안에서 이동하지 않게 http/https 만 외부 브라우저로 열고, 나머지는 글자로 둔다
  if (href === undefined || !/^https?:/i.test(href)) return <span>{children}</span>
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        void tauri.openUrl(href).catch(() => undefined)
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

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    // Why: 넓은 표를 키보드로 가로 스크롤하게 포커스를 받는다. 랜드마크 이름이 겹치지 않게 region 대신 group
    <div tabIndex={0} role="group" aria-label="표" className="overflow-x-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring">
      <table>{children}</table>
    </div>
  )
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks]
const COMPONENTS: Components = { a: MarkdownLink, img: MarkdownImage, table: MarkdownTable }
