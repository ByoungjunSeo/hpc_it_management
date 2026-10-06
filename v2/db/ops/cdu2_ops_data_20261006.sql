-- CDU-2 운영 데이터 조치 (마이그레이션과 분리 — ★ 운영 승인 후에만 실행)
-- 배경: 랙 내장 CDU TPC-CDU-02(id 1205)는 데이터상 칠러와 연결고리가 없다(실 배관은
--   칠러 TPC-CHI-01(id 1177) → Y밸브 → 독립형 CDU(1176) + 랙 내장 CDU(1205) 병렬 공급).
--   마이그레이션은 "탱크를 보던 CDU"만 자동 귀속하므로 1205는 수동으로 칠러에 귀속한다.
-- 전제: 2026-10-06_1_cdu2_cooling_source.sql 적용 완료(cooling_source_asset_id 존재).

BEGIN;

-- 적용 전 확인
\echo '--- 조치 전 ---'
SELECT id, management_number, rack_id, cooling_source_asset_id FROM assets WHERE id IN (1176, 1205);
SELECT id, management_number, status FROM assets WHERE id = 1177;  -- 대상 칠러 active 확인

-- 랙 내장 TPC-CDU-02 → 칠러 TPC-CHI-01
UPDATE assets SET cooling_source_asset_id = 1177, updated_at = NOW()
WHERE id = 1205
  AND asset_type = 'cdu'
  AND EXISTS (SELECT 1 FROM assets c WHERE c.id = 1177 AND c.asset_type = 'chiller');

-- 적용 후 확인 (1176·1205 모두 cooling_source=1177, 칠러 1177 parent NULL이어야 함)
\echo '--- 조치 후 ---'
SELECT id, management_number, cooling_source_asset_id FROM assets WHERE id IN (1176, 1205);

-- 영향 행수 확인 후 COMMIT, 아니면 ROLLBACK
COMMIT;
