-- ============================================================
-- IT 자산관리 시스템 v2 — 기초 테이블 (Level 0~1)
-- ============================================================
-- 대상: server_rooms, vendor_info, users, lendings,
--       module_inventory, racks, audit_logs
-- 의존성 순서: Level 0 (부모 없음) → Level 1 (Level 0 참조)
-- 변환 기준: MIGRATION_PLAN.md §2~§4
-- ============================================================

-- =========================
-- Level 0: 부모 없음
-- =========================

-- 1. server_rooms
CREATE TABLE server_rooms (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT,
    description TEXT,
    location_type TEXT DEFAULT 'server_room',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, location_type)
);

-- BL-3: 이름 정규화(공백/대소문자 변형) 중복까지 DB 계층에서 차단.
-- 기존 UNIQUE(name, location_type)는 바이트 동일만 방어 — 이 인덱스가 보완.
-- (기존 설치 DB 적용분은 db/migrations/2026-07-12_bl3_room_name_norm_unique.sql)
CREATE UNIQUE INDEX idx_server_rooms_name_norm
    ON server_rooms (lower(trim(name)), location_type);

-- 2. vendor_info
CREATE TABLE vendor_info (
    id SERIAL PRIMARY KEY,
    vendor_name TEXT NOT NULL,
    contact_person TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    contract_number TEXT,
    contract_start DATE,
    contract_end DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. users
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer'
        CHECK(role IN ('admin', 'maintenance', 'viewer')),
    display_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. lendings
CREATE TABLE lendings (
    id SERIAL PRIMARY KEY,
    direction TEXT NOT NULL
        CHECK(direction IN ('outbound', 'inbound')),
    counterparty TEXT NOT NULL,
    loan_date DATE,
    return_date DATE,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'returned')),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_lendings_status ON lendings(status);

-- 5. module_inventory
CREATE TABLE module_inventory (
    id SERIAL PRIMARY KEY,
    module_type TEXT NOT NULL,
    item_code TEXT UNIQUE,
    label TEXT,
    manufacturer TEXT,
    model TEXT,
    capacity TEXT,
    specification TEXT,
    total_quantity INTEGER DEFAULT 0,
    in_use_quantity INTEGER DEFAULT 0,
    spare_quantity INTEGER DEFAULT 0,
    storage_quantity INTEGER DEFAULT 0,
    asset_number TEXT,
    owner TEXT DEFAULT 'company',
    owner_vendor_id INTEGER,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_module_inventory_type ON module_inventory(module_type);

-- =========================
-- Level 1: Level 0 참조
-- =========================

-- 6. racks (→ server_rooms, → assets는 B-1.3-b에서 정의)
--    linked_asset_id FK는 assets 테이블 생성 후 ALTER TABLE로 추가 (B-1.3-b)
CREATE TABLE racks (
    id SERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL
        REFERENCES server_rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
    name TEXT NOT NULL,
    total_units INTEGER DEFAULT 42,
    row_position INTEGER DEFAULT 1,
    col_position INTEGER DEFAULT 1,
    description TEXT,
    rack_type TEXT DEFAULT 'standard',
    linked_asset_id INTEGER,  -- FK는 assets 생성 후 추가
    switch_slots INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_racks_linked_asset ON racks(linked_asset_id);

-- 7. audit_logs (→ users)
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER
        REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    username TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    target_label TEXT,
    details TEXT,
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_type);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_date ON audit_logs(created_at);
