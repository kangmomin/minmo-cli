-- 프로젝트별 sparse-checkout 디렉터리 목록(줄바꿈 구분). 기존 global CHECK 는 SQLite 에서 바꿀 수 없어
-- nullable 로 추가하고 global 행만 '' 로 채운다. 읽을 때 NULL 은 ''(전체 체크아웃)로 취급한다.
ALTER TABLE settings ADD COLUMN sparse_paths TEXT;
UPDATE settings SET sparse_paths = '' WHERE scope = 'global';
