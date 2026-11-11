// 사용자에게 보여 줄 오류와 서버 오류 안내 — context·backend 가 함께 쓴다(순환 import 를 피하려고 따로 둔다)
import { ApiError } from '@minmo/api-client'
import { isOfflineError, isUnauthorized } from '@minmo/core'

import { WINDOWS_SERVER_HINT, describeServer } from './server'
import type { ServerTarget } from './server'

/** 스택 없이 메시지만 출력하고 종료 코드를 정한다 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

/** 서버 오류 → 사용자 안내 */
export function serverErrorMessage(e: unknown, server: ServerTarget): string {
  if (isUnauthorized(e)) return '세션이 만료되었거나 끊겼습니다 — 데스크탑의 "원격 CLI 접속"에서 새 코드를 발급해 `minmo login <코드>` 하세요'
  if (isOfflineError(e) && server.kind === 'unset') return `${WINDOWS_SERVER_HINT}. 서버 없이 쓰려면 \`minmo mode local\``
  if (isOfflineError(e))
    return `minmo 서버에 연결할 수 없습니다(${describeServer(server)}) — SSH 역터널(RemoteForward)로 접속했는지, PC 의 minmo 서버가 켜져 있는지 확인하세요(\`minmo doctor\`). 터널 없이 쓰려면 \`minmo mode local\``
  if (e instanceof ApiError) return `서버 오류(${e.code})`
  return e instanceof Error ? e.message : String(e)
}

/** 명령에서 난 오류를 CliError 로 — 서버 오류는 안내 문구로, 그 밖은 메시지만 */
export function toCliError(e: unknown, server: ServerTarget): CliError {
  if (e instanceof CliError) return e
  return new CliError(e instanceof ApiError || isOfflineError(e) ? serverErrorMessage(e, server) : e instanceof Error ? e.message : String(e))
}

export const NOTES_SERVER_ONLY = '메모는 서버 모드에서만 쓸 수 있습니다 — 역터널로 접속한 뒤 `minmo mode server`'
