-- Linux/macOS(sh) 생성 후 스크립트. 기존 post_create_script 는 Windows(PowerShell) 용으로 남긴다.
ALTER TABLE settings ADD COLUMN post_create_script_posix TEXT;
UPDATE settings SET post_create_script_posix = '' WHERE scope = 'global';
