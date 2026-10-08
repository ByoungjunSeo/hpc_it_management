-- v2.4.1 자격증명 평문 마이그레이션 확인 (읽기 전용). 변경 없음.

\echo '--- [후] EUL credentials_snapshot에 password/value 키 잔존 (0이어야 함) ---'
SELECT COUNT(*) AS eul_rows_with_plaintext
FROM equipment_usage_logs e
WHERE e.credentials_snapshot IS NOT NULL
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.credentials_snapshot) y WHERE (y ? 'password') OR (y ? 'value'));

\echo '--- [후] 샘플: snapshot이 type/username/has_password만 갖는지 ---'
SELECT id, credentials_snapshot
FROM equipment_usage_logs
WHERE credentials_snapshot IS NOT NULL AND credentials_snapshot::text <> '[]'
ORDER BY id LIMIT 5;

\echo '--- 참조 무결성: asset_credentials password_enc 평문 혼입 여부(password 컬럼 비어야 정상) ---'
SELECT COUNT(*) AS legacy_plaintext_password_rows
FROM asset_credentials WHERE password IS NOT NULL AND password <> '';

\echo '--- audit_logs 비밀번호 키에 평문값 잔존(0이어야 함; *** 마스킹값은 제외, 배열 cred_passwords[] 포함) ---'
SELECT COUNT(*) AS audit_plaintext
FROM audit_logs
WHERE details::text ~ '"(ssh_password|password|bmc_password|cred_passwords(\[\])?)"\s*:\s*(\[\s*)?"(?!\*\*\*")[^"]+';
