-- ============================================================
-- BL-12 마이그레이션: 장비실 재고 점검 3테이블 (MIGRATION_PLAN §4-4)
-- 대상: 2.0.2 이하로 설치된 기존 DB (신규 설치는 01_schema_base.sql에 포함)
-- 실행: docker exec -i <db컨테이너> psql -U <유저> -d <DB> < 이 파일
-- 멱등: IF NOT EXISTS. 재실행 무해.
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory_audits (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    auditor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK(status IN ('in_progress','completed','cancelled')),
    scope_owner TEXT,
    scope_module_type TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_audit_items (
    id SERIAL PRIMARY KEY,
    audit_id INTEGER NOT NULL REFERENCES inventory_audits(id) ON DELETE CASCADE,
    item_code TEXT NOT NULL,
    module_type TEXT NOT NULL,
    system_storage_qty INTEGER NOT NULL,
    system_in_use_qty INTEGER NOT NULL,
    actual_storage_qty INTEGER,
    diff INTEGER,
    reason TEXT,
    checked_at TIMESTAMPTZ,
    ok_flag BOOLEAN DEFAULT FALSE,
    UNIQUE(audit_id, item_code)
);
CREATE INDEX IF NOT EXISTS idx_audit_items_audit ON inventory_audit_items(audit_id);

CREATE TABLE IF NOT EXISTS inventory_corrections (
    id SERIAL PRIMARY KEY,
    audit_id INTEGER REFERENCES inventory_audits(id) ON DELETE SET NULL,
    item_code TEXT NOT NULL,
    before_qty INTEGER NOT NULL,
    after_qty INTEGER NOT NULL,
    reason TEXT NOT NULL,
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_corrections_item ON inventory_corrections(item_code);

-- [사후 확인] \dt inventory_audits inventory_audit_items inventory_corrections
