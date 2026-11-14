-- 새 worktree 에 무시된 파일(.env 등)을 가져올 때 뺄 폴더·파일 이름(줄바꿈 구분). 'off' 면 가져오지 않는다.
-- global 행은 기본 목록(settings.DefaultIgnoredCopyExclude 와 같은 값)으로 채우고, org/project 는 NULL(상속).
ALTER TABLE settings ADD COLUMN ignored_copy_exclude TEXT;
UPDATE settings SET ignored_copy_exclude = 'node_modules' || char(10) || 'target' || char(10) || 'dist' || char(10) || 'build' || char(10) || 'out' || char(10) || '.next' || char(10) || '.nuxt' || char(10) || '.venv' || char(10) || 'venv' || char(10) || '__pycache__' || char(10) || '.gradle' || char(10) || '.turbo' || char(10) || '.cache' || char(10) || 'coverage' WHERE scope = 'global';
