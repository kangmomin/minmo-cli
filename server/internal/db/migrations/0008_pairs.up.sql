-- 설정 페어링 동기화(pairsync) — 사용자 계정과 무관하게 페어 토큰으로만 접근한다. 토큰·코드는 SHA-256 해시만 둔다.
CREATE TABLE pairs (
    id              TEXT    PRIMARY KEY,
    code_hash       TEXT,                          -- 1회용 페어링 코드. 쓰거나 다시 발급하면 바뀐다
    code_expires_at INTEGER NOT NULL DEFAULT 0,
    rev             INTEGER NOT NULL DEFAULT 0,
    payload         TEXT    NOT NULL DEFAULT '{}', -- 서버가 해석하지 않는 JSON
    updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX pairs_code ON pairs (code_hash) WHERE code_hash IS NOT NULL;

CREATE TABLE pair_devices (
    token_hash TEXT    PRIMARY KEY,
    pair_id    TEXT    NOT NULL REFERENCES pairs (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
);
