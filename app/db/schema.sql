-- Server Rooms
CREATE TABLE IF NOT EXISTS server_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    location TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Racks
CREATE TABLE IF NOT EXISTS racks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    total_units INTEGER DEFAULT 42,
    row_position INTEGER DEFAULT 1,
    col_position INTEGER DEFAULT 1,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES server_rooms(id) ON DELETE CASCADE
);

-- Vendor Info
CREATE TABLE IF NOT EXISTS vendor_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_name TEXT NOT NULL,
    contact_person TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    contract_number TEXT,
    contract_start DATE,
    contract_end DATE,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Assets
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_number TEXT UNIQUE,
    management_number TEXT,
    asset_type TEXT NOT NULL CHECK(asset_type IN ('server', 'switch', 'pdu', 'ups', 'storage', 'other')),
    ownership TEXT NOT NULL DEFAULT 'company' CHECK(ownership IN ('company', 'vendor')),
    vendor_id INTEGER,
    model_name TEXT,
    manufacturer TEXT,
    serial_number TEXT,
    rack_id INTEGER,
    rack_unit_start INTEGER,
    rack_unit_size INTEGER DEFAULT 3,
    blade_slot TEXT CHECK(blade_slot IN ('left','right')),
    ip_address TEXT,
    ssh_port INTEGER DEFAULT 22,
    ssh_user TEXT DEFAULT 'root',
    ssh_password TEXT,
    assigned_user TEXT,
    purpose TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'maintenance', 'decommissioned')),
    purchase_date DATE,
    warranty_end DATE,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (rack_id) REFERENCES racks(id) ON DELETE SET NULL,
    FOREIGN KEY (vendor_id) REFERENCES vendor_info(id) ON DELETE SET NULL
);

-- Computing Modules
CREATE TABLE IF NOT EXISTS computing_modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    module_type TEXT NOT NULL CHECK(module_type IN ('cpu', 'memory', 'disk', 'network', 'raid', 'gpu')),
    model TEXT,
    manufacturer TEXT,
    capacity TEXT,
    count INTEGER DEFAULT 1,
    specification TEXT,
    slot_info TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- IP Addresses
CREATE TABLE IF NOT EXISTS ip_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT NOT NULL UNIQUE,
    subnet TEXT NOT NULL,
    network_zone TEXT NOT NULL CHECK(network_zone IN ('office', 'hpc', 'aidc')),
    allocation_type TEXT NOT NULL DEFAULT 'available' CHECK(allocation_type IN ('available', 'assigned', 'reserved')),
    asset_id INTEGER,
    assigned_to TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

-- Inventory Logs
CREATE TABLE IF NOT EXISTS inventory_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_type TEXT NOT NULL CHECK(log_type IN ('inbound', 'outbound')),
    item_name TEXT NOT NULL,
    item_type TEXT,
    quantity INTEGER DEFAULT 1,
    serial_number TEXT,
    vendor_name TEXT,
    handler TEXT,
    register_as_asset INTEGER DEFAULT 0,
    asset_id INTEGER,
    purpose TEXT,
    notes TEXT,
    log_date DATE DEFAULT (date('now')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

-- Asset IPs (multiple IPs per asset)
CREATE TABLE IF NOT EXISTS asset_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    ip_address TEXT NOT NULL,
    ip_type TEXT NOT NULL DEFAULT 'management'
      CHECK(ip_type IN ('management','bmc','ib','data')),
    description TEXT,
    interface_type TEXT DEFAULT NULL,
    speed TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- Asset Credentials (multiple credentials per asset)
CREATE TABLE IF NOT EXISTS asset_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    password TEXT,
    credential_type TEXT NOT NULL DEFAULT 'root'
      CHECK(credential_type IN ('root','user','bmc')),
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- Lendings (대여 관리)
CREATE TABLE IF NOT EXISTS lendings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL CHECK(direction IN ('outbound','inbound')),
    counterparty TEXT NOT NULL,
    loan_date DATE,
    return_date DATE,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','returned')),
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lending_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lending_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_code TEXT,
    quantity INTEGER DEFAULT 1,
    description TEXT,
    FOREIGN KEY (lending_id) REFERENCES lendings(id) ON DELETE CASCADE
);

-- Module Inventory (부품 재고 현황)
CREATE TABLE IF NOT EXISTS module_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 업체 서버 입고 신청
CREATE TABLE IF NOT EXISTS vendor_intake_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft','pending','approved','rejected')),
    -- 업체 정보
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    contact_phone TEXT,
    contact_email TEXT,
    -- 장비 정보
    equipment_type TEXT NOT NULL DEFAULT 'server',
    model_name TEXT,
    manufacturer TEXT,
    serial_number TEXT,
    rack_unit_size INTEGER DEFAULT 1,
    quantity INTEGER DEFAULT 1,
    -- 요구사항
    purpose TEXT,
    expected_start DATE,
    expected_end DATE,
    power_requirement TEXT,
    network_requirement TEXT,
    notes TEXT,
    -- 관리
    admin_notes TEXT,
    asset_id INTEGER,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_vendor_intake_status ON vendor_intake_requests(status);
CREATE INDEX IF NOT EXISTS idx_vendor_intake_token ON vendor_intake_requests(token);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_assets_rack ON assets(rack_id);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_ownership ON assets(ownership);
CREATE INDEX IF NOT EXISTS idx_computing_modules_asset ON computing_modules(asset_id);
CREATE INDEX IF NOT EXISTS idx_computing_modules_type ON computing_modules(module_type);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_subnet ON ip_addresses(subnet);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_zone ON ip_addresses(network_zone);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_allocation ON ip_addresses(allocation_type);
CREATE INDEX IF NOT EXISTS idx_inventory_logs_type ON inventory_logs(log_type);
CREATE INDEX IF NOT EXISTS idx_inventory_logs_date ON inventory_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_asset_ips_asset ON asset_ips(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_credentials_asset ON asset_credentials(asset_id);
CREATE INDEX IF NOT EXISTS idx_lendings_status ON lendings(status);
CREATE INDEX IF NOT EXISTS idx_lending_items_lending ON lending_items(lending_id);
CREATE INDEX IF NOT EXISTS idx_module_inventory_type ON module_inventory(module_type);

-- Power Nodes (전력 분배 계통)
CREATE TABLE IF NOT EXISTS power_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    parent_id INTEGER,
    node_type TEXT NOT NULL CHECK(node_type IN ('main_panel','sub_panel','hvac','pdu','ups')),
    name TEXT NOT NULL,
    capacity_kw REAL,
    rating TEXT,
    voltage TEXT,
    phase TEXT,
    circuit_number TEXT,
    asset_id INTEGER,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES server_rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES power_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_power_nodes_room ON power_nodes(room_id);
CREATE INDEX IF NOT EXISTS idx_power_nodes_parent ON power_nodes(parent_id);

-- Network Connections (네트워크 포트 연결)
CREATE TABLE IF NOT EXISTS network_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    from_asset_id INTEGER NOT NULL,
    from_port TEXT NOT NULL,
    to_asset_id INTEGER NOT NULL,
    to_port TEXT NOT NULL,
    cable_type TEXT,
    cable_label TEXT,
    cable_color TEXT,
    cable_length TEXT,
    ownership TEXT DEFAULT 'company' CHECK(ownership IN ('company','vendor')),
    vendor_id INTEGER,
    speed TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','planned')),
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES server_rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (from_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY (to_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY (vendor_id) REFERENCES vendor_info(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_network_connections_room ON network_connections(room_id);
CREATE INDEX IF NOT EXISTS idx_network_connections_from ON network_connections(from_asset_id);
CREATE INDEX IF NOT EXISTS idx_network_connections_to ON network_connections(to_asset_id);

-- Users (인증/권한)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','maintenance','viewer')),
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Audit Logs (감사 이력)
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    target_label TEXT,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_date ON audit_logs(created_at);

-- Equipment Usage Logs (입출고관리 - 장비 사용 이력)
CREATE TABLE IF NOT EXISTS equipment_usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usage_date DATE,
    return_date DATE,
    asset_number TEXT,
    management_number TEXT,
    model_name TEXT,
    user_name TEXT,
    test_name TEXT,
    test_detail TEXT,
    credential_root TEXT,
    credential_etc1 TEXT,
    credential_etc2 TEXT,
    ip1 TEXT, ip2 TEXT, ip3 TEXT, ip4 TEXT,
    bmc TEXT, ib1 TEXT, ib2 TEXT,
    room TEXT, rack TEXT, unit TEXT,
    cpu_type TEXT, cpu_num INTEGER,
    mem1_type TEXT, mem1_num INTEGER,
    mem2_type TEXT, mem2_num INTEGER,
    disk1_part TEXT, disk1_num INTEGER,
    disk2_part TEXT, disk2_num INTEGER,
    disk3_part TEXT, disk3_num INTEGER,
    disk4_part TEXT, disk4_num INTEGER,
    nic1_type TEXT, nic1_num INTEGER,
    nic2_type TEXT, nic2_num INTEGER,
    nic3_type TEXT, nic3_num INTEGER,
    nic4_type TEXT, nic4_num INTEGER,
    raid_type TEXT, raid_num INTEGER,
    gpu1_type TEXT, gpu1_num INTEGER,
    gpu2_type TEXT, gpu2_num INTEGER,
    os TEXT,
    notes TEXT,
    status TEXT DEFAULT '입고' CHECK(status IN ('입고','사용중','반납완료')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_equip_usage_mgmt ON equipment_usage_logs(management_number);
CREATE INDEX IF NOT EXISTS idx_equip_usage_status ON equipment_usage_logs(status);
CREATE INDEX IF NOT EXISTS idx_equip_usage_date ON equipment_usage_logs(usage_date);
