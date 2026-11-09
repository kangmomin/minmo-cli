-- minmo Phase 1 초기 스키마. 모든 *_at 은 INTEGER epoch ms(UTC) — API 경계에서만 timefmt 로 변환한다.

CREATE TABLE users (
    id               TEXT    PRIMARY KEY,               -- usr_<uuid v4>
    github_id        INTEGER NOT NULL UNIQUE,
    login            TEXT    NOT NULL,
    avatar_url       TEXT,
    access_token_enc BLOB    NOT NULL,                  -- AES-256-GCM(nonce || ciphertext)
    created_at       INTEGER NOT NULL
);

CREATE TABLE sessions (
    id         TEXT    PRIMARY KEY,
    user_id    TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL UNIQUE,                 -- SHA-256 hex, 원문 토큰은 저장하지 않음
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE settings (
    user_id            TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope              TEXT    NOT NULL CHECK (scope IN ('global', 'org', 'project')),
    owner              TEXT    NOT NULL DEFAULT '',     -- 소문자 정규화
    repo               TEXT    NOT NULL DEFAULT '',     -- 소문자 정규화
    branch_template    TEXT,
    etc_branch_name    TEXT,
    worktree_path      TEXT,
    main_clone_path    TEXT,
    post_create_script TEXT,
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (user_id, scope, owner, repo),
    CHECK (scope <> 'global' OR (owner = '' AND repo = ''
        AND branch_template IS NOT NULL AND etc_branch_name IS NOT NULL AND worktree_path IS NOT NULL
        AND main_clone_path IS NOT NULL AND post_create_script IS NOT NULL)),
    CHECK (scope <> 'org' OR (owner <> '' AND repo = '')),
    CHECK (scope <> 'project' OR (owner <> '' AND repo <> ''))
);

CREATE TABLE issue_notes (
    user_id    TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    owner      TEXT    NOT NULL,                        -- 소문자 정규화
    repo       TEXT    NOT NULL,                        -- 소문자 정규화
    issue_key  TEXT    NOT NULL,                        -- 이슈 번호 또는 'etc'
    body       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, owner, repo, issue_key)
);
