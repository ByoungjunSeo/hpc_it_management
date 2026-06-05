-- ============================================================
-- IT 자산관리 시스템 v2 — 로그/이력 테이블 (Level 4)
-- ============================================================
-- 대상: module_inventory_logs, module_transfer_logs,
--       equipment_usage_logs (새 append-only 스키마)
-- 선행: 01_schema_base.sql, 02_schema_assets.sql, 03_schema_features.sql
-- 변환 기준: MIGRATION_PLAN.md §2~§5
-- ============================================================

-- 1. module_inventory_logs
--    v1 구조 유지 + asset_id FK 신규 추가 (MIGRATION_PLAN.md §4)
--    이력 테이블이므로 ON DELETE SET NULL (자산 삭제 시 이력 보존)
CREATE TABLE module_inventory_logs (
    id SERIAL PRIMARY KEY,
    item_code TEXT NOT NULL,
    event_type TEXT NOT NULL,
    quantity_change INTEGER DEFAULT 0,
    before_total INTEGER,
    after_total INTEGER,
    before_spare INTEGER,
    after_spare INTEGER,
    asset_id INTEGER
        REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    asset_label TEXT,
    from_asset_id INTEGER,
    from_asset_label TEXT,
    to_asset_id INTEGER,
    to_asset_label TEXT,
    asset_number TEXT,
    user_id INTEGER,
    username TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mil_item_code ON module_inventory_logs(item_code);
CREATE INDEX idx_mil_created_at ON module_inventory_logs(created_at);

-- 2. module_transfer_logs
--    v1 구조 유지 + from_asset_id, to_asset_id FK 신규 추가 (MIGRATION_PLAN.md §4)
--    이력 테이블이므로 ON DELETE SET NULL (자산 삭제 시 이력 보존)
CREATE TABLE module_transfer_logs (
    id SERIAL PRIMARY KEY,
    transfer_date DATE DEFAULT CURRENT_DATE,
    module_type TEXT NOT NULL,
    model TEXT,
    capacity TEXT,
    count INTEGER DEFAULT 1,
    owner TEXT DEFAULT 'company',
    owner_vendor_id INTEGER,
    from_asset_id INTEGER
        REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    from_asset_label TEXT,
    to_asset_id INTEGER
        REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    to_asset_label TEXT,
    reason TEXT,
    user_id INTEGER,
    username TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mtl_from_asset ON module_transfer_logs(from_asset_id);
CREATE INDEX idx_mtl_to_asset ON module_transfer_logs(to_asset_id);
CREATE INDEX idx_mtl_date ON module_transfer_logs(transfer_date);

-- ============================================================
-- 3. equipment_usage_logs — 새 Append-Only 스키마
-- ============================================================
-- ⚠️ Append-Only 이력 테이블 (MIGRATION_PLAN.md §5)
-- - INSERT만 허용, UPDATE/DELETE 금지
-- - updated_at 컬럼 의도적 제거
-- - v1의 50+ 하드웨어 개별 컬럼 → hardware_snapshot JSONB로 통합
-- - v1의 ip1~4, bmc, ib1~2 → network_snapshot JSONB로 통합
-- - v1의 credential 컬럼 → credentials_snapshot JSONB로 통합
--   (비밀번호 제외, username/type만 저장)
-- - return_date 컬럼 없음: 반납 시 event_type='returned' 새 행 INSERT
--
-- JSONB 예시:
--   hardware_snapshot:
--     [{"module_type":"cpu","model":"Xeon Gold 6430","count":2},
--      {"module_type":"memory","model":"DDR5 64GB","count":16}]
--   network_snapshot:
--     [{"ip":"10.1.1.100","type":"management"},
--      {"ip":"10.1.1.101","type":"bmc"}]
--   credentials_snapshot:
--     [{"username":"root","type":"root"},
--      {"username":"admin","type":"bmc"}]
-- ============================================================
CREATE TABLE equipment_usage_logs (
    id SERIAL PRIMARY KEY,

    -- 이벤트 정보
    event_type TEXT NOT NULL
        CHECK(event_type IN ('incoming', 'in_use', 'returned', 'transferred')),
    event_date DATE NOT NULL DEFAULT CURRENT_DATE,

    -- 자산 참조 (정규 테이블 FK)
    asset_id INTEGER
        REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    management_number TEXT,     -- 이력 시점 스냅샷 (검색 편의용 비정규화)
    asset_number TEXT,          -- 이력 시점 스냅샷
    model_name TEXT,            -- 이력 시점 스냅샷

    -- 사용 정보
    user_name TEXT,
    test_name TEXT,
    test_detail TEXT,

    -- 위치 스냅샷 (이벤트 시점의 위치)
    room TEXT,
    rack TEXT,
    unit TEXT,

    -- 하드웨어 스냅샷 (이벤트 시점 구성, computing_modules 전체)
    hardware_snapshot JSONB,

    -- 네트워크 스냅샷 (이벤트 시점, asset_ips 전체)
    network_snapshot JSONB,

    -- 계정 스냅샷 (비밀번호 제외, username/type만)
    credentials_snapshot JSONB,

    -- 메타
    ownership TEXT DEFAULT 'company',
    os TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
    -- updated_at 의도적 제거: append-only 테이블은 수정하지 않음
);

CREATE INDEX idx_eul_asset ON equipment_usage_logs(asset_id);
CREATE INDEX idx_eul_event_type ON equipment_usage_logs(event_type);
CREATE INDEX idx_eul_event_date ON equipment_usage_logs(event_date);
CREATE INDEX idx_eul_mgmt_number ON equipment_usage_logs(management_number);
