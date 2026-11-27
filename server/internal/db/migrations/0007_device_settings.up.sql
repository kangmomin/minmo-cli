-- PC 별 설정 — 작업 폴더 경로·생성 후 스크립트처럼 그 PC 에만 맞는 값. 요청에 X-Minmo-Pc 가 있으면 settings 의 같은 열 대신 쓴다.
-- 행이 없으면 settings 의 값을 그대로 쓴다. 열의 NULL 은 settings 와 같이 "상속"이다(global 은 검증을 거친 값만 들어온다).
CREATE TABLE device_settings (
    user_id                  TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id                TEXT    NOT NULL,                -- 데스크탑이 만든 UUID(소문자)
    scope                    TEXT    NOT NULL CHECK (scope IN ('global', 'org', 'project')),
    owner                    TEXT    NOT NULL DEFAULT '',     -- 소문자 정규화
    repo                     TEXT    NOT NULL DEFAULT '',     -- 소문자 정규화
    worktree_path            TEXT,
    main_clone_path          TEXT,
    post_create_script       TEXT,
    post_create_script_posix TEXT,
    ignored_copy_exclude     TEXT,
    updated_at               INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, scope, owner, repo),
    CHECK (scope <> 'global' OR (owner = '' AND repo = '')),
    CHECK (scope <> 'org' OR (owner <> '' AND repo = '')),
    CHECK (scope <> 'project' OR (owner <> '' AND repo <> ''))
);
