-- ============================================================
-- BL-12 후속 마이그레이션: inventory_corrections 원복(undo) 표기 컬럼
-- 대상: BL-12 재고 점검이 이미 적용된 DB (신규 설치는 01_schema_base.sql에 포함)
-- 실행: docker exec -i <db컨테이너> psql -U <유저> -d <DB> < 이 파일
-- 멱등: IF NOT EXISTS. 재실행 무해.
-- ============================================================

ALTER TABLE inventory_corrections ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;
ALTER TABLE inventory_corrections ADD COLUMN IF NOT EXISTS reverted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- [사후 확인] \d inventory_corrections  (reverted_at, reverted_by 존재)
