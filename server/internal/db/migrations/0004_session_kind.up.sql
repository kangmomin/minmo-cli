-- 세션 종류·이름·마지막 사용 시각. 원격 CLI 세션(kind='cli')을 데스크탑에서 확인하고 폐기할 수 있게 한다.
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'desktop' CHECK (kind IN ('desktop', 'cli'));
ALTER TABLE sessions ADD COLUMN label TEXT;
ALTER TABLE sessions ADD COLUMN last_used_at INTEGER;
