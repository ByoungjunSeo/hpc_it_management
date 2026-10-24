-- v2.9 단계 1 확인(읽기 전용): 새 테이블·제약·인덱스 존재와 기존 테이블 무수정 여부
SELECT 'table' AS kind, table_name AS name FROM information_schema.tables
 WHERE table_schema='public' AND table_name IN ('module_specs','module_part_aliases','module_scan_raw','module_spec_mapping')
UNION ALL
SELECT 'constraint', conrelid::regclass || '.' || conname FROM pg_constraint
 WHERE conrelid::regclass::text IN ('module_specs','module_part_aliases','module_scan_raw','module_spec_mapping')
UNION ALL
SELECT 'index', indexname FROM pg_indexes
 WHERE tablename IN ('module_specs','module_part_aliases','module_scan_raw','module_spec_mapping')
ORDER BY 1, 2;
-- 행 수(단계 1 적용 직후는 모두 0 — 대응표 반영은 승인 후 별도)
SELECT (SELECT count(*) FROM module_specs) AS specs, (SELECT count(*) FROM module_part_aliases) AS aliases,
       (SELECT count(*) FROM module_scan_raw) AS scan_raw, (SELECT count(*) FROM module_spec_mapping) AS mapping;
