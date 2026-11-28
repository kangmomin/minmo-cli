// Why: 설정 화면(#115)의 분류 목록과 검색 — 순수 함수만 둔다
import type { RuntimeKind } from '../../lib/tauri'

export type SectionId = 'appearance' | 'notify' | 'agents' | 'workspace' | 'sync' | 'hosts' | 'remote' | 'cli' | 'server'

export interface Section {
  id: SectionId
  title: string
  keywords: string[]
  visible(runtime: RuntimeKind): boolean
}

const always = () => true
// Why: 원격 브라우저는 이 PC 의 서버·원격 접속을 다룰 수 없다(app/Workspace.tsx 의 기존 조건)
const notRemote = (runtime: RuntimeKind) => runtime !== 'remote'

export const SECTIONS: Section[] = [
  { id: 'appearance', title: '모양', keywords: ['테마', 'Ghostty', '블랙', '라이트', '다크', '글자 크기', '폰트', 'font'], visible: always },
  { id: 'notify', title: '알림·표시', keywords: ['알림', '에이전트 알림', 'AI 사용량', '사용량', '하단 바'], visible: always },
  { id: 'agents', title: '에이전트', keywords: ['에이전트', '실행 명령', '명령', 'Claude', 'Codex', 'Gemini', 'prompt'], visible: always },
  {
    id: 'workspace',
    title: '작업 공간',
    keywords: ['브랜치', '템플릿', 'worktree', '경로', 'clone', '스크립트', '체크아웃', '무시된 파일', '.env', '별칭', '연결 호스트', '원본 위치', '조직', '프로젝트', '전역', '공유', '다른 PC'],
    visible: always,
  },
  // Why: 페어링 동기화는 이 PC 의 앱 창에서만 동작한다(pairSync/PairSyncSection.tsx 와 같은 조건)
  { id: 'sync', title: '동기화', keywords: ['동기화', '페어링', '다른 PC'], visible: (runtime) => runtime === 'native' },
  { id: 'hosts', title: '원격 호스트', keywords: ['원격 호스트', 'SSH', '호스트', 'tmux', '포트'], visible: always },
  { id: 'remote', title: '원격 접속', keywords: ['원격 접속', '휴대폰', '기기 등록', '등록 코드', 'QR', 'Tailscale', 'LAN', '포트', '다른 PC'], visible: notRemote },
  { id: 'cli', title: '원격 CLI', keywords: ['원격 CLI', 'CLI', '로그인 코드', 'SSH', 'RemoteForward', '세션'], visible: notRemote },
  { id: 'server', title: '서버·앱', keywords: ['서버', '포트', '다시 시작', '로그', '업데이트', '버전', '창 닫기', '트레이', '세션 요약', '답변 모드', 'Jev'], visible: notRemote },
]

export function visibleSections(runtime: RuntimeKind): Section[] {
  return SECTIONS.filter((s) => s.visible(runtime))
}

// Why: 한글은 입력기·붙여넣기에 따라 NFD 로 올 수 있어 NFC 로 맞춰 비교한다
const normalize = (text: string) => text.normalize('NFC').toLowerCase().trim()

export function filterSections(list: Section[], query: string): Section[] {
  const q = normalize(query)
  if (q === '') return list
  return list.filter((s) => [s.title, ...s.keywords].some((word) => normalize(word).includes(q)))
}
