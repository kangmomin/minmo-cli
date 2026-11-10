// 이슈 지정: "owner/repo#42" · "owner/repo#etc"(★기타). owner/repo 는 GitHub 표기(대소문자)로 맞춘다.
import { GitHubError } from '@minmo/core'
import type { GitHubClient, IssueTarget } from '@minmo/core'

import { CliError } from './context'

export type Ref = { owner: string; repo: string; key: string }

const NAME = /^[A-Za-z0-9_.-]{1,100}$/

export function parseRef(input: string): Ref {
  const m = /^([^/#\s]+)\/([^/#\s]+)#(etc|[1-9][0-9]{0,9})$/i.exec(input.trim())
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2])) {
    throw new CliError(`이슈를 "owner/repo#번호" 또는 "owner/repo#etc" 로 지정하세요: ${input}`, 2)
  }
  return { owner: m[1], repo: m[2], key: m[3].toLowerCase() }
}

export function parseRepo(input: string): { owner: string; repo: string } {
  const m = /^([^/#\s]+)\/([^/#\s]+)$/.exec(input.trim())
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2])) throw new CliError(`저장소를 "owner/repo" 로 지정하세요: ${input}`, 2)
  return { owner: m[1], repo: m[2] }
}

/** GitHub 에서 저장소·이슈를 확인해 worktree 서비스용 대상을 만든다 */
export async function resolveTarget(github: GitHubClient, ref: Ref): Promise<IssueTarget> {
  try {
    const repo = await github.getRepo(ref.owner, ref.repo)
    if (ref.key === 'etc') return { owner: repo.owner, repo: repo.name, key: 'etc', number: null, title: '' }
    const issue = await github.getIssue(repo.owner, repo.name, Number(ref.key))
    return { owner: repo.owner, repo: repo.name, key: ref.key, number: issue.number, title: issue.title }
  } catch (e) {
    if (e instanceof GitHubError && e.code === 'not_found') throw new CliError(`찾을 수 없습니다: ${ref.owner}/${ref.repo}#${ref.key}`)
    throw e
  }
}
