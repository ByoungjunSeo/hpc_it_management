-- ============================================================
-- IT 자산관리 시스템 v2 — 자산 핵심 테이블 (Level 2)
-- ============================================================
-- 대상: assets, computing_modules, asset_ips,
--       asset_credentials, ip_addresses
-- 추가: racks.linked_asset_id FK, module_inventory.owner_vendor_id FK
-- 선행: 01_schema_base.sql (server_rooms, vendor_info, racks 등)
-- 변환 기준: MIGRATION_PLAN.md §2~§4
-- ============================================================

-- =========================
-- Level 2: 자산 마스터
-- =========================

-- 1. assets
--    FK: rack_id → racks, vendor_id → vendor_info,
--        room_id → server_rooms, parent_asset_id → assets (자기참조)
--    참고: ip_address, ssh_port, ssh_user, ssh_password 컬럼은
--          v1 레거시 잔재 (asset_ips + asset_credentials로 이중 저장)
--          데이터 이전(B-2) 후 코드 리팩토링(B-3)에서 제거 예정
--          현재는 v1 호환을 위해 유지
CREATE TABLE assets (
    id SERIAL PRIMARY KEY,
    asset_number TEXT,
    management_number TEXT,
    asset_type TEXT NOT NULL
        CHECK(asset_type IN ('server', 'switch', 'kvm', 'pdu', 'ups',
              'storage', 'immersion_tank', 'cdu', 'chiller', 'other')),
    ownership TEXT NOT NULL DEFAULT 'company'
        CHECK(ownership IN ('company', 'vendor')),
    vendor_id INTEGER
        REFERENCES vendor_info(id) ON DELETE SET NULL ON UPDATE CASCADE,
    model_name TEXT,
    manufacturer TEXT,
    serial_number TEXT,
    rack_id INTEGER
        REFERENCES racks(id) ON DELETE SET NULL ON UPDATE CASCADE,
    rack_unit_start INTEGER,
    rack_unit_size INTEGER DEFAULT 1,
    ip_address TEXT,           -- 레거시: asset_ips로 이관 예정
    ssh_port INTEGER DEFAULT 22,       -- 레거시: asset_credentials로 이관 예정
    ssh_user TEXT DEFAULT 'root',      -- 레거시: asset_credentials로 이관 예정
    ssh_password TEXT,                 -- 레거시: asset_credentials로 이관 예정
    assigned_user TEXT,
    purpose TEXT,
    status TEXT DEFAULT 'active'
        CHECK(status IN ('active', 'inactive', 'returned',
              'maintenance', 'decommissioned')),
    purchase_date DATE,
    warranty_end DATE,
    notes TEXT,
    blade_slot TEXT,
    room_id INTEGER
        REFERENCES server_rooms(id) ON DELETE SET NULL ON UPDATE CASCADE,
    parent_asset_id INTEGER
        REFERENCES assets(id) ON DELETE CASCADE ON UPDATE CASCADE,
    shelf_size INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_assets_rack ON assets(rack_id);
CREATE INDEX idx_assets_type ON assets(asset_type);
CREATE INDEX idx_assets_ownership ON assets(ownership);
CREATE INDEX idx_assets_parent ON assets(parent_asset_id);

-- =========================
-- Level 3: assets 참조 테이블
-- =========================

-- 2. computing_modules (→ assets, → vendor_info)
CREATE TABLE computing_modules (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL
        REFERENCES assets(id) ON DELETE CASCADE ON UPDATE CASCADE,
    module_type TEXT NOT NULL
        CHECK(module_type IN ('cpu', 'memory', 'disk', 'network',
              'raid', 'gpu', 'npu', 'psu')),
    model TEXT,
    manufacturer TEXT,
    capacity TEXT,
    count INTEGER DEFAULT 1,
    specification TEXT,
    slot_info TEXT,
    notes TEXT,
    owner TEXT DEFAULT 'company',
    owner_vendor_id INTEGER
        REFERENCES vendor_info(id) ON DELETE SET NULL ON UPDATE CASCADE,
    is_onboard INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_computing_modules_asset ON computing_modules(asset_id);
CREATE INDEX idx_computing_modules_type ON computing_modules(module_type);

-- 3. asset_ips (→ assets)
CREATE TABLE asset_ips (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL
        REFERENCES assets(id) ON DELETE CASCADE ON UPDATE CASCADE,
    ip_address TEXT NOT NULL,
    ip_type TEXT NOT NULL DEFAULT 'management'
        CHECK(ip_type IN ('management', 'bmc', 'ib', 'data', 'os', 'other')),
    description TEXT,
    interface_type TEXT,
    speed TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_asset_ips_asset ON asset_ips(asset_id);

-- 4. asset_credentials (→ assets)
CREATE TABLE asset_credentials (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL
        REFERENCES assets(id) ON DELETE CASCADE ON UPDATE CASCADE,
    username TEXT NOT NULL,
    password TEXT,
    credential_type TEXT NOT NULL DEFAULT 'root'
        CHECK(credential_type IN ('root', 'user', 'bmc', 'os', 'etc')),
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_asset_credentials_asset ON asset_credentials(asset_id);

-- 5. ip_addresses (→ assets)
CREATE TABLE ip_addresses (
    id SERIAL PRIMARY KEY,
    ip_address TEXT NOT NULL UNIQUE,
    subnet TEXT NOT NULL,
    network_zone TEXT NOT NULL
        CHECK(network_zone IN ('office', 'hpc', 'aidc')),
    allocation_type TEXT NOT NULL DEFAULT 'available'
        CHECK(allocation_type IN ('available', 'assigned', 'reserved')),
    asset_id INTEGER
        REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    assigned_to TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ip_addresses_subnet ON ip_addresses(subnet);
CREATE INDEX idx_ip_addresses_zone ON ip_addresses(network_zone);
CREATE INDEX idx_ip_addresses_allocation ON ip_addresses(allocation_type);

-- =========================
-- ALTER TABLE: 미뤄둔 FK 추가
-- =========================

-- racks.linked_asset_id → assets (01_schema_base.sql에서 미뤘음: assets 미존재)
ALTER TABLE racks
    ADD CONSTRAINT fk_racks_linked_asset
    FOREIGN KEY (linked_asset_id) REFERENCES assets(id)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- module_inventory.owner_vendor_id → vendor_info
-- 01_schema_base.sql에서 컬럼은 정의했으나 FK를 안 건 이유:
-- vendor_info가 같은 파일에 있어서 걸 수 있었지만, module_inventory가
-- vendor_info보다 뒤에 정의되므로 인라인 FK로도 가능했음.
-- 명시적 ALTER로 추가하여 일관성 유지.
ALTER TABLE module_inventory
    ADD CONSTRAINT fk_module_inventory_owner_vendor
    FOREIGN KEY (owner_vendor_id) REFERENCES vendor_info(id)
    ON DELETE SET NULL ON UPDATE CASCADE;
