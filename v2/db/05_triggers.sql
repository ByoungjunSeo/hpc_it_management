-- ============================================================
-- IT 자산관리 시스템 v2 — Append-only 보호 트리거
-- ============================================================
-- 적용 대상:
--   - equipment_usage_logs (자산 사용 이력)
--
-- 동작:
--   - INSERT는 정상 허용
--   - UPDATE, DELETE 시도 시 에러 발생
--
-- 일시 비활성화 (B-2 데이터 이전 시 등):
--   ALTER TABLE equipment_usage_logs
--     DISABLE TRIGGER no_update_delete_equipment_usage_logs;
--
-- 재활성화:
--   ALTER TABLE equipment_usage_logs
--     ENABLE TRIGGER no_update_delete_equipment_usage_logs;
-- ============================================================

-- 범용 append-only 보호 함수
-- 다른 테이블에도 재사용 가능 (TG_TABLE_NAME으로 동적 식별)
CREATE OR REPLACE FUNCTION prevent_update_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only. UPDATE/DELETE not allowed.', TG_TABLE_NAME;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- equipment_usage_logs에 트리거 부착
CREATE TRIGGER no_update_delete_equipment_usage_logs
    BEFORE UPDATE OR DELETE ON equipment_usage_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_update_delete();
