<!-- .claude/be-harness/README.md -->
# be-harness project overrides

이 디렉토리는 프로젝트별 be-harness 스킬/에이전트 오버라이드를 담는다.
상세 규약은 플러그인 루트 `OVERRIDES.md` 참조.

- `common.md` — 모든 스킬/에이전트에 공통 적용
- `skills/{skill-name}.md` — 특정 스킬 전용
- `agents/{agent-name}.md` — 특정 에이전트 전용

파일은 전부 선택. start-workflow Phase 12 의 보완점이 자동으로 이곳에 append 된다.
