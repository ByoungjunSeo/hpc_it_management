-- ============================================================
-- BL-11 마이그레이션 (1/2): asset_credentials 암호화 컬럼 추가
-- 대상: 2.0.2 이하로 설치된 기존 DB (신규 설치는 02_schema_assets.sql에 포함)
-- ============================================================
-- ★ 적용 순서 (릴리스 노트 준수):
--   1) 이 SQL (컬럼 추가 — DDL)
--   2) .env에 CREDENTIAL_ENCRYPTION_KEY 설정 (openssl rand -hex 32) + 서버 외부 백업
--   3) 앱 스크립트: node scripts/encrypt-credentials.js (평문 → 암호문, 검증 후 평문 비움)
--   ※ 2·3 없이 이 SQL만 적용하면 기존 자격증명은 평문 password 컬럼에 그대로 남아 동작(무해).
-- ============================================================

-- 암호문 컬럼(AES-256-GCM, v1:iv:tag:ct). 평문 password 컬럼은 스크립트가 비운 뒤에도
-- 차기 릴리스까지 유예 존치(롤백·미암호화 잔존 탐지용).
ALTER TABLE asset_credentials ADD COLUMN IF NOT EXISTS password_enc TEXT;

-- [사후 확인] 미암호화 잔존 탐지: 아래가 0행이면 전 자격증명 암호화 완료(스크립트 실행 후).
--   SELECT count(*) FROM asset_credentials WHERE password IS NOT NULL AND password <> '';
--   SELECT count(*) FROM assets WHERE ssh_password IS NOT NULL AND ssh_password <> '';
