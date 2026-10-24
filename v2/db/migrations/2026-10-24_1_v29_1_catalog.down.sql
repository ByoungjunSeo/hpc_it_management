-- ============================================================
-- v2.9 단계 1 되돌리기: 2026-10-24_1_v29_1_catalog.sql이 만든 새 테이블 4개만 삭제(기존 테이블 무관)
-- ⚠ 카탈로그·대응표 데이터가 함께 지워짐 — 운영에서는 백업 후 실행.
-- 실행: docker exec -i <db컨테이너> psql -U <유저> -d <DB> -v ON_ERROR_STOP=1 < 이 파일
-- 멱등: IF EXISTS. 의존 순서(별칭·대응표 → 규격)대로 삭제.
-- ============================================================
BEGIN;
DROP TABLE IF EXISTS module_spec_mapping;
DROP TABLE IF EXISTS module_part_aliases;
DROP TABLE IF EXISTS module_scan_raw;
DROP TABLE IF EXISTS module_specs;
COMMIT;
