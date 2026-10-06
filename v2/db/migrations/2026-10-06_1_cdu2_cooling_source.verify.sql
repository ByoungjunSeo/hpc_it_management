-- CDU-2 마이그레이션 적용 전/후 확인용 (읽기 전용 SELECT). 실행해도 데이터 변경 없음.

\echo '--- [사전] 칠러→탱크 현황 (적용 후 parent_asset_id는 전부 NULL이어야 함) ---'
SELECT id, management_number, status, parent_asset_id
FROM assets WHERE asset_type = 'chiller' ORDER BY id;

\echo '--- [사전] 탱크당 칠러 수 (2 이상이면 마이그레이션이 중단됨) ---'
SELECT parent_asset_id AS tank_id, COUNT(*) AS chillers
FROM assets WHERE asset_type = 'chiller' AND parent_asset_id IS NOT NULL
GROUP BY parent_asset_id ORDER BY chillers DESC;

\echo '--- [후] CDU별 공급 칠러 (parent=탱크였던 CDU에 cooling_source가 채워져야 함) ---'
SELECT cdu.id, cdu.management_number AS cdu, cdu.parent_asset_id AS tank,
       cdu.rack_id, cdu.cooling_source_asset_id AS cooling_src,
       chi.management_number AS chiller
FROM assets cdu
LEFT JOIN assets chi ON cdu.cooling_source_asset_id = chi.id
WHERE cdu.asset_type = 'cdu' ORDER BY cdu.id;

\echo '--- [후] 참조 무결성: cooling_source가 실제 칠러를 가리키는지 (위반 0건이어야 함) ---'
SELECT a.id, a.management_number, a.cooling_source_asset_id,
       s.asset_type AS source_type, s.status AS source_status
FROM assets a
LEFT JOIN assets s ON a.cooling_source_asset_id = s.id
WHERE a.cooling_source_asset_id IS NOT NULL
  AND (s.id IS NULL OR s.asset_type <> 'chiller');
