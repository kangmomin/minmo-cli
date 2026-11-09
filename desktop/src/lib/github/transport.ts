/** gh·REST 공통 전송 계층. path 는 선두 '/' 없는 API 경로(쿼리 포함) */
export type TransportResponse = {
  data: unknown
  /**
   * 다음 페이지 존재 여부. REST 는 Link rel="next" 로 판단, gh 는 헤더를 받지 않으므로 undefined
   * (호출자가 항목 수 < per_page 로 판단).
   */
  hasNext?: boolean
}

export interface GitHubTransport {
  kind: 'gh' | 'rest'
  get(path: string): Promise<TransportResponse>
  post(path: string, body: unknown): Promise<TransportResponse>
}
