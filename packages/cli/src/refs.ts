// 이슈 지정: "owner/repo#42" · "owner/repo#etc"(★기타), 저장소 지정: "owner/repo"
import { CliError } from './errors'

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
