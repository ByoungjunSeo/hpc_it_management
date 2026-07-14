-- ============================================================
-- BL-2 마이그레이션: 블레이드 노드 (parent_asset_id, blade_slot) 부분 유니크 인덱스
-- 대상: 2.1 이하로 설치된 기존 DB (신규 설치는 02_schema_assets.sql에 포함)
-- 실행: psql(또는 docker exec <db컨테이너> psql -U <유저> -d <DB>) 로 본 파일 적용
-- 게이트: 운영 적용은 사용자 승인 후. 앱 계층(라우트) 검증이 1차 방어, 본 인덱스는 DB 계층 보완.
-- ============================================================

-- [사전 점검] 같은 부모 아래 blade_slot 중복이 이미 있으면 인덱스 생성이 실패한다.
-- 아래 조회가 0행인지 먼저 확인하고, 행이 나오면 해당 노드들을 개명/삭제 후 재시도.
--   SELECT parent_asset_id, blade_slot, count(*), array_agg(id), array_agg(management_number)
--     FROM assets
--    WHERE parent_asset_id IS NOT NULL AND blade_slot IS NOT NULL
--    GROUP BY parent_asset_id, blade_slot HAVING count(*) > 1;

-- 부모가 있고 슬롯이 지정된 노드에 한해 (부모, 슬롯) 유일성 보장.
-- parent_asset_id/blade_slot 미지정(단독 자산·비블레이드)은 인덱스 대상에서 제외(부분 인덱스).
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_parent_slot_unique
    ON assets (parent_asset_id, blade_slot)
    WHERE parent_asset_id IS NOT NULL AND blade_slot IS NOT NULL;

-- [사후 확인]
--   \di idx_assets_parent_slot_unique
