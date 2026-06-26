# B-2 데이터 이전 — 재개 가이드

> 마지막 작업일: 2026-06-09
> 작성 목적: 서버 재시작 후 Claude Code로 작업 재개 시 참조

## 1. 클로드 실행 방법

```bash
cd /mlcommons_cm/hpc_it_management
claude
```

프로젝트 루트에서 실행해야 `.git`, `app/`, `v2/` 모두 접근 가능합니다.

## 2. 현재 진행 상태

### 완료된 단계

| 단계 | 내용 | 커밋 |
|------|------|------|
| B-1 | PostgreSQL 21 테이블 + 트리거 + 배포 정책 | 4a96a24 |
| B-1.5 | docker-compose ports 127.0.0.1:5433 추가 | 5fa09f0 |
| B-2.1 | v2/scripts/ 환경 (package.json, test-connection.js, migrate-data.js 골격) | 미커밋 → 이 가이드와 함께 커밋 예정 |
| B-2.2 | 단순 테이블 5개 이전 완료 (server_rooms, vendor_info, users, racks, module_inventory) | 미커밋 → 이 가이드와 함께 커밋 예정 |

### v2 PostgreSQL 현재 데이터 상태

| 테이블 | 행 수 | 비고 |
|--------|------:|------|
| server_rooms | 9 | ✅ 이전 완료 |
| vendor_info | 15 | ✅ 이전 완료 |
| users | 13 | ✅ 이전 완료 (password_hash 포함) |
| racks | 27 | ✅ 이전 완료 (linked_asset_id=NULL 보류 1건) |
| module_inventory | 202 | ✅ 이전 완료 |
| 나머지 15개 테이블 | 0 | 미이전 |

### 보류 항목

- `racks #212` ("AquaRack 21U (탱크)"): `linked_asset_id` v1=1175 → v2=NULL
  - assets 이전 후 `UPDATE racks SET linked_asset_id=1175 WHERE id=212;` 실행 필요

## 3. 다음 작업 (B-2.3~)

나머지 15개 테이블 이전 (의존성 순서):

```
B-2.3: assets (172행) — server_rooms, racks, vendor_info FK
        → 이후 racks.linked_asset_id 복원
B-2.4: ip_addresses (2,304행) — FK 없음
B-2.5: asset_ips (216행) — assets FK
       asset_credentials (211행) — assets FK
       photos (48행) — entity_type/id (논리적 참조)
B-2.6: computing_modules (570행) — assets, vendor_info FK
       power_nodes (0행)
       network_connections (0행)
B-2.7: vendor_intake_requests (1행) — assets FK
       lendings (1행) + lending_items (1행)
B-2.8: audit_logs (1,348행) — users FK
       module_inventory_logs (375행)
       module_transfer_logs (378행)
       equipment_usage_logs (779행) — 59→21컬럼 변환 + JSONB 3개
B-2.9: 시퀀스 리셋 (모든 테이블 id 시퀀스를 MAX(id)+1로)
       racks.linked_asset_id 복원
       최종 검증
```

**inventory_logs (0행)**: v2에 없음, 이전 불필요.

## 4. 서버 재시작 후 확인 사항

```bash
# 1. Docker 컨테이너 확인 (restart: unless-stopped이므로 자동 시작됨)
docker ps --filter name=it-assets-db

# 2. 안 올라왔으면 수동 시작
cd /mlcommons_cm/hpc_it_management/v2
docker compose up -d

# 3. healthy 대기 후 포트 확인
docker compose ps
ss -tnl | grep 5433
# 기대: 127.0.0.1:5433 LISTEN

# 4. v1 운영 서비스 확인
systemctl status it-assets
# PID 바뀌지만 서비스 정상 가동 확인

# 5. v2 데이터 보존 확인 (pgdata 볼륨이 유지되므로)
docker exec it-assets-db psql -U itadmin -d it_assets -c \
  "SELECT tablename, n_live_tup FROM pg_stat_user_tables WHERE n_live_tup > 0 ORDER BY tablename;"
# 기대: server_rooms(9), vendor_info(15), users(13), racks(27), module_inventory(202)

# 6. 연결 테스트
cd /mlcommons_cm/hpc_it_management/v2/scripts
node test-connection.js
```

## 5. 주요 파일 위치

| 용도 | 경로 |
|------|------|
| v1 운영 앱 | `app/` (수정 금지) |
| v1 SQLite DB | `app/data/it_assets.db` (readonly만) |
| v2 PostgreSQL 스키마 | `v2/db/01~06_*.sql` |
| v2 Docker | `v2/docker-compose.yml` |
| v2 환경변수 | `v2/.env` (git 제외, 비밀번호 포함) |
| v2 PostgreSQL 데이터 | `v2/pgdata/` (git 제외, Docker 볼륨) |
| 마이그레이션 스크립트 | `v2/scripts/migrate-data.js` |
| 연결 테스트 | `v2/scripts/test-connection.js` |
| 마이그레이션 계획서 | `MIGRATION_PLAN.md` |

## 6. 작업 원칙 (재개 시 Claude에게 전달)

- v1 `app/` 폴더, `app/package.json` 수정 금지
- v1 SQLite는 readonly 접속만
- v1 운영 서비스(systemd it-assets) 중단 금지
- v2 PostgreSQL 접속: 127.0.0.1:5433
- 각 단계별 검증 후 다음 단계 진행
