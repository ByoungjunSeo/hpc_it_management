-- ============================================================
-- v2.9 단계 1 마이그레이션: 규격 카탈로그 도입(새 테이블 4개, 기존 테이블 무수정)
--   module_specs          규격 코드(스펙을 읽을 수 있는 형식) + 유형별 속성
--   module_part_aliases   정규화한 품번 → 규격(별칭)
--   module_scan_raw       스캔 원문·출처 보존(이번엔 테이블만, 기록은 단계 3)
--   module_spec_mapping   옛 module_inventory.item_code → 제안 규격(대응표 검토용)
-- 대상: v2.8.x 이하로 설치된 기존 DB. 되돌리기: 2026-10-24_1_v29_1_catalog.down.sql
-- 실행: docker exec -i <db컨테이너> psql -U <유저> -d <DB> -v ON_ERROR_STOP=1 < 이 파일
-- 멱등: IF NOT EXISTS + 제약은 존재 확인 후 추가. 재실행 무해.
-- module_type 허용값: computing_modules CHECK 집합(cpu·memory·disk·network·raid·gpu·npu·psu)
--   + 'cable'(module_inventory에 케이블 품목이 있고 설계 4장에 CBL- 코드가 있으므로 추가).
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS module_specs (
    id SERIAL PRIMARY KEY,
    spec_code TEXT NOT NULL,
    module_type TEXT NOT NULL,
    attrs JSONB NOT NULL DEFAULT '{}'::jsonb,          -- 유형별 필수 속성(예: 메모리 gen·type·gb·mts)
    manufacturer TEXT,                                  -- 대표 제조사(같은 규격의 다른 제조사 품번은 별칭으로)
    display_name TEXT,
    serialized BOOLEAN NOT NULL DEFAULT FALSE,          -- 시리얼 개체 관리 대상(GPU·NPU·NIC≥100G·NVMe≥3.84TB)
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT module_specs_spec_code_key UNIQUE (spec_code),
    CONSTRAINT module_specs_type_check CHECK (module_type IN ('cpu','memory','disk','network','raid','gpu','npu','psu','cable')),
    CONSTRAINT module_specs_status_check CHECK (status IN ('active','retired')),
    CONSTRAINT module_specs_attrs_object CHECK (jsonb_typeof(attrs) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_module_specs_type ON module_specs(module_type);

CREATE TABLE IF NOT EXISTS module_part_aliases (
    id SERIAL PRIMARY KEY,
    part_number_norm TEXT NOT NULL,                     -- 대문자·공백 제거·리비전 접미 정규화 결과
    part_number_raw_samples JSONB NOT NULL DEFAULT '[]'::jsonb,
    module_type TEXT NOT NULL,
    spec_id INTEGER NOT NULL REFERENCES module_specs(id) ON DELETE CASCADE ON UPDATE CASCADE,
    source TEXT NOT NULL DEFAULT 'rule',
    confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT module_part_aliases_type_norm_key UNIQUE (module_type, part_number_norm),
    CONSTRAINT module_part_aliases_type_check CHECK (module_type IN ('cpu','memory','disk','network','raid','gpu','npu','psu','cable')),
    CONSTRAINT module_part_aliases_source_check CHECK (source IN ('rule','manual','import')),
    CONSTRAINT module_part_aliases_samples_array CHECK (jsonb_typeof(part_number_raw_samples) = 'array')
);
CREATE INDEX IF NOT EXISTS idx_module_part_aliases_spec ON module_part_aliases(spec_id);

CREATE TABLE IF NOT EXISTS module_scan_raw (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL,
    tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    missing_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw TEXT,                                           -- 원문(크기 상한 512KB)
    parsed JSONB,
    fingerprint TEXT,
    CONSTRAINT module_scan_raw_source_check CHECK (source IN ('ssh','redfish')),
    CONSTRAINT module_scan_raw_raw_size CHECK (raw IS NULL OR octet_length(raw) <= 524288),
    CONSTRAINT module_scan_raw_tools_array CHECK (jsonb_typeof(tools) = 'array' AND jsonb_typeof(missing_tools) = 'array')
);
CREATE INDEX IF NOT EXISTS idx_module_scan_raw_asset ON module_scan_raw(asset_id, scanned_at DESC);

CREATE TABLE IF NOT EXISTS module_spec_mapping (
    id SERIAL PRIMARY KEY,
    legacy_item_code TEXT NOT NULL,                     -- 현 module_inventory.item_code(FK 없음 — 옛 코드가 바뀌어도 기록 보존)
    module_inventory_id INTEGER REFERENCES module_inventory(id) ON DELETE SET NULL ON UPDATE CASCADE,
    owner TEXT,
    owner_vendor_id INTEGER REFERENCES vendor_info(id) ON DELETE SET NULL ON UPDATE CASCADE,
    proposed_spec_code TEXT,
    spec_id INTEGER REFERENCES module_specs(id) ON DELETE SET NULL ON UPDATE CASCADE,
    method TEXT NOT NULL,
    confidence TEXT NOT NULL,
    reason TEXT,
    reviewed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT module_spec_mapping_legacy_key UNIQUE (legacy_item_code),
    CONSTRAINT module_spec_mapping_method_check CHECK (method IN ('rule','manual','unresolved')),
    CONSTRAINT module_spec_mapping_confidence_check CHECK (confidence IN ('high','medium','low'))
);
CREATE INDEX IF NOT EXISTS idx_module_spec_mapping_spec ON module_spec_mapping(spec_id);
CREATE INDEX IF NOT EXISTS idx_module_spec_mapping_proposed ON module_spec_mapping(proposed_spec_code);

COMMIT;
