-- ============================================================
-- BL-3 마이그레이션: server_rooms 이름 정규화 유니크 인덱스
-- 대상: 2.0.1 이하로 설치된 기존 DB (신규 설치는 01_schema_base.sql에 포함)
-- 실행: psql(또는 docker exec <db컨테이너> psql -U <유저> -d <DB>) 로 본 파일 적용
-- ============================================================

-- [사전 점검] 정규화 기준 중복이 이미 있으면 인덱스 생성이 실패한다.
-- 아래 조회가 0행인지 먼저 확인하고, 행이 나오면 해당 실들을 병합/개명 후 재시도.
--   SELECT lower(trim(name)) AS norm, location_type, count(*), array_agg(id), array_agg(name)
--     FROM server_rooms GROUP BY 1, 2 HAVING count(*) > 1;
-- (TTA 운영 DB는 2026-07-12 조사 기준 0건 확인됨)

-- 공백/대소문자 변형 중복까지 DB 계층에서 차단.
-- 기존 UNIQUE(name, location_type) 제약은 유지(바이트 동일 방어) — 본 인덱스가 보완.
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_rooms_name_norm
    ON server_rooms (lower(trim(name)), location_type);

-- [사후 확인]
--   \di idx_server_rooms_name_norm
