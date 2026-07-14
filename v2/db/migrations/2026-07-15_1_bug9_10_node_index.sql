-- ============================================================
-- BUG-9/10 마이그레이션: node_index 신설 + blade_slot 노드슬롯 용법 제거
-- 대상: 2.1 이하로 설치된 기존 DB (신규 설치는 02_schema_assets.sql에 포함)
-- 실행: psql (docker exec <db컨테이너> psql -U itadmin -d it_assets -f <파일>) 로 적용
-- 게이트: 운영 적용은 사용자 승인 후. 데이터 보정(/tmp/bug9_10_data_fix.sql)은 본 마이그레이션 이후 실행.
-- ============================================================

-- 1) node_index 컬럼 추가 (블레이드 노드 번호 — 부모 내 유일, 자산 식별용)
ALTER TABLE assets ADD COLUMN IF NOT EXISTS node_index INTEGER;

-- 2) 구 부분 유니크 인덱스 제거 (blade_slot을 숫자 노드슬롯으로 오용하던 BL-2 잔재)
--    blade_slot 컬럼 자체는 유지(랙 렌더용 left/right/SW 의미로 원복 — 데이터 건드리지 않음).
DROP INDEX IF EXISTS idx_assets_parent_slot_unique;

-- 3) 신 부분 유니크 인덱스 (부모, node_index)
--    [사전 점검] 같은 부모 아래 node_index 중복이 있으면 생성 실패 — 아래가 0행인지 먼저 확인.
--      SELECT parent_asset_id, node_index, count(*)
--        FROM assets WHERE parent_asset_id IS NOT NULL AND node_index IS NOT NULL
--        GROUP BY parent_asset_id, node_index HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_parent_node_unique
    ON assets (parent_asset_id, node_index)
    WHERE parent_asset_id IS NOT NULL AND node_index IS NOT NULL;

-- [사후 확인]
--   \d assets            -- node_index 컬럼 존재
--   \di idx_assets_parent_node_unique
--   SELECT 1 FROM pg_indexes WHERE indexname='idx_assets_parent_slot_unique';  -- 0행이어야 함
