// E2E 큐의 역할(① E2E 실행 ② 엣지케이스 찾기 ③ 엣지케이스 기반 테스트) 설정과 명령 만들기 — 순수 함수
// TODO(Phase 5.2): 구현. 지금은 테스트가 import 할 수 있게 시그니처만 둔 스텁이다
import type { BuiltCommand, LaunchKind, ShellKind } from '../agents/launch'

export const E2E_ROLES = ['run', 'edge', 'verify'] as const
export type E2eRole = (typeof E2E_ROLES)[number]

export type RoleKind = Exclude<LaunchKind, 'custom'>
/** model 이 빈 값이면 CLI 기본값(모델 인자 없음) */
export type RoleConfig = { kind: RoleKind; model: string; prompt: string }
export type E2eRoles = Record<E2eRole, RoleConfig>

export const ROLE_LABEL: Record<E2eRole, string> = { run: '① E2E 실행', edge: '② 엣지케이스 찾기', verify: '③ 엣지케이스 기반 테스트' }

export const DEFAULT_ROLES: E2eRoles = {
  run: { kind: 'claude', model: '', prompt: '' },
  edge: { kind: 'claude', model: '', prompt: '' },
  verify: { kind: 'claude', model: '', prompt: '' },
}

/** 지시문 자리표시: {issue} · {out}(이 단계 결과 파일) · {prev}(앞 단계 결과 파일들) */
export type PromptContext = { issue: string; out: string; prev: string }

/** 모델 입력 패턴(A-6) — `-` 로 시작하지 않는다 */
export const MODEL_RE: RegExp = /(?!)/

export function resultFile(_jobId: string, _role: E2eRole): string {
  throw new Error('not implemented')
}

export function fillPrompt(_template: string, _ctx: PromptContext): string {
  throw new Error('not implemented')
}

/** 명령 틀에 모델 인자를 넣는다(A-4) */
export function withModel(_template: string, _kind: RoleKind, _model: string, _shell: ShellKind): string {
  throw new Error('not implemented')
}

export function buildRoleCommand(_cfg: RoleConfig, _template: string, _ctx: PromptContext, _shell: ShellKind): BuiltCommand {
  throw new Error('not implemented')
}

/** 공유 동기화·저장 값에서 받은 역할 설정 — 알려진 유효 값만 받고 나머지는 기본값(EC-11) */
export function sanitizeRoles(_value: unknown): E2eRoles {
  throw new Error('not implemented')
}
