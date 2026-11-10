import type { ApiErrorCode, Notes } from './types'

export type ApiErrorInit = {
  status: number
  code: ApiErrorCode
  field?: string
  current?: Notes
  message?: string
}

// 데이터 클래스(필드 보관만). 응답 → ApiError 변환 규칙은 client.ts 책임.
export class ApiError extends Error {
  status: number
  code: ApiErrorCode
  field?: string
  current?: Notes

  constructor(init: ApiErrorInit) {
    super(init.message ?? init.code)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    if (init.field !== undefined) this.field = init.field
    if (init.current !== undefined) this.current = init.current
  }
}
