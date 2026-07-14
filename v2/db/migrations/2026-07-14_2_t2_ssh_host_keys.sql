-- ============================================================
-- T2(웹 SSH 터미널) 마이그레이션: TOFU 호스트키 저장소
-- 대상: v2.1.0 이하로 설치된 기존 DB (신규 설치는 01_schema_base.sql에 포함)
-- 실행: docker exec -i <db컨테이너> psql -U <유저> -d <DB> < 이 파일
-- 멱등: IF NOT EXISTS. 재실행 무해.
-- ============================================================

CREATE TABLE IF NOT EXISTS ssh_host_keys (
    id SERIAL PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    key_type TEXT NOT NULL,          -- 예: ssh-ed25519, ssh-rsa
    fingerprint TEXT NOT NULL,       -- base64 sha256 (호스트키 해시)
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (host, port)
);

-- [사후 확인] \d ssh_host_keys
