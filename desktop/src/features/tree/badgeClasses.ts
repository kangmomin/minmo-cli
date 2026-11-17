// Badge 기본 shrink-0 이면 좁은 폭에서 배지가 줄지 않아 이름이 0px 로 사라진다 — 이름과 함께 줄고 … 를 보인다 (#70).
// 저장소·연결 대기·이슈 행이 같은 규칙을 쓴다. 컴포넌트 파일이 아닌 모듈에 두어 react-refresh 경계를 지킨다
export const shrinkBadge = 'block min-w-0 shrink truncate'
