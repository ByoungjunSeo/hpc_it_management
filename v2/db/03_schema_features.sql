-- ============================================================
-- IT 자산관리 시스템 v2 — 기능 테이블 (Level 3)
-- ============================================================
-- 대상: lending_items, vendor_intake_requests, power_nodes,
--       network_connections, photos
-- 선행: 01_schema_base.sql, 02_schema_assets.sql
-- 변환 기준: MIGRATION_PLAN.md §2~§4
-- ============================================================

-- 1. lending_items (→ lendings, → assets[BL-13])
CREATE TABLE lending_items (
    id SERIAL PRIMARY KEY,
    lending_id INTEGER NOT NULL
        REFERENCES lendings(id) ON DELETE CASCADE ON UPDATE CASCADE,
    item_type TEXT NOT NULL,
    item_code TEXT,
    quantity INTEGER DEFAULT 1,
    description TEXT,
    asset_id INTEGER                              -- BL-13: 장비 품목의 자산 개체 연결
        REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    returned_quantity INTEGER NOT NULL DEFAULT 0, -- BL-13: 부분 반납 누적(<= quantity)
    last_returned_at TIMESTAMPTZ,                 -- BL-13: 최종 반납 시각
    inventory_linked BOOLEAN NOT NULL DEFAULT FALSE -- BL-13: 등록 시 재고 차감 여부(복귀 판단 근거)
);

CREATE INDEX idx_lending_items_lending ON lending_items(lending_id);
CREATE INDEX idx_lending_items_asset ON lending_items(asset_id);

-- 2. vendor_intake_requests (→ assets)
-- 기능 토글: FEATURE_VENDOR_INTAKE (기본 true)
-- 테이블은 항상 존재, 메뉴와 라우트만 토글로 ON/OFF
CREATE TABLE vendor_intake_requests (
    id SERIAL PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('draft', 'pending', 'approved', 'rejected')),
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    contact_phone TEXT,
    contact_email TEXT,
    equipment_type TEXT NOT NULL DEFAULT 'server',
    model_name TEXT,
    manufacturer TEXT,
    serial_number TEXT,
    rack_unit_size INTEGER DEFAULT 1,
    quantity INTEGER DEFAULT 1,
    purpose TEXT,
    expected_start DATE,
    expected_end DATE,
    power_requirement TEXT,
    network_requirement TEXT,
    notes TEXT,
    admin_notes TEXT,
    asset_id INTEGER
        REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);

CREATE INDEX idx_vendor_intake_status ON vendor_intake_requests(status);
CREATE INDEX idx_vendor_intake_token ON vendor_intake_requests(token);

-- 3. power_nodes (→ server_rooms, 자기참조 parent_id, → assets)
-- 기능 토글: FEATURE_POWER_NODES (기본 true)
-- 테이블은 항상 존재, 메뉴와 라우트만 토글로 ON/OFF
CREATE TABLE power_nodes (
    id SERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL
        REFERENCES server_rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
    parent_id INTEGER
        REFERENCES power_nodes(id) ON DELETE CASCADE ON UPDATE CASCADE,
    node_type TEXT NOT NULL
        CHECK(node_type IN ('main_panel', 'sub_panel', 'hvac', 'pdu', 'ups')),
    name TEXT NOT NULL,
    capacity_kw REAL,
    rating TEXT,
    voltage TEXT,
    phase TEXT,
    circuit_number TEXT,
    asset_id INTEGER
        REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_power_nodes_room ON power_nodes(room_id);
CREATE INDEX idx_power_nodes_parent ON power_nodes(parent_id);

-- 4. network_connections (→ server_rooms, → assets ×2, → vendor_info)
CREATE TABLE network_connections (
    id SERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL
        REFERENCES server_rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
    from_asset_id INTEGER NOT NULL
        REFERENCES assets(id) ON DELETE CASCADE ON UPDATE CASCADE,
    from_port TEXT NOT NULL,
    to_asset_id INTEGER NOT NULL
        REFERENCES assets(id) ON DELETE CASCADE ON UPDATE CASCADE,
    to_port TEXT NOT NULL,
    cable_type TEXT,
    cable_label TEXT,
    cable_color TEXT,
    cable_length TEXT,
    ownership TEXT DEFAULT 'company'
        CHECK(ownership IN ('company', 'vendor')),
    vendor_id INTEGER
        REFERENCES vendor_info(id) ON DELETE SET NULL ON UPDATE CASCADE,
    speed TEXT,
    status TEXT DEFAULT 'active'
        CHECK(status IN ('active', 'inactive', 'planned')),
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_network_connections_room ON network_connections(room_id);
CREATE INDEX idx_network_connections_from ON network_connections(from_asset_id);
CREATE INDEX idx_network_connections_to ON network_connections(to_asset_id);

-- 5. photos (다형성 — FK 없음)
-- entity_type + entity_id로 대상 엔티티를 식별
-- (예: entity_type='asset', entity_id=42 → assets.id=42)
-- PostgreSQL에서도 다형성 FK는 직접 설정 불가, 앱 레벨에서 무결성 보장
CREATE TABLE photos (
    id SERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    original_name TEXT,
    description TEXT,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    uploaded_by TEXT
);

CREATE INDEX idx_photos_entity ON photos(entity_type, entity_id);
