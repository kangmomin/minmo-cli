-- 사용자별 "보일 저장소" 선택. repos 는 JSON 배열(소문자 "owner/repo" 또는 "owner/*"), NULL = 전체 표시.
CREATE TABLE repo_filters (
    user_id    TEXT    PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    repos      TEXT,
    updated_at INTEGER NOT NULL
);
