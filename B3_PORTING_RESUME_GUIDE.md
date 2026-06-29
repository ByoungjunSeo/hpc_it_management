# B-3 이후 애플리케이션 이식 — 재개 가이드

> 작성일: 2026-06-26
> 작성 목적: 서버 종료 전 맥락 보존. 재개 시 이 문서 + git log부터 확인.

## 1. 지금까지 완료 (커밋 기준)

| 단계 | 내용 | 커밋 |
|------|------|------|
| B-1 | PostgreSQL 21테이블 + 트리거 + 배포 정책 | 4a96a24 |
| B-1.5 | docker-compose ports 127.0.0.1:5433 추가 | 5fa09f0 |
| B-2.1/2.2 | 마이그레이션 스크립트 + 단순 테이블 5개 이전 | 569a270 |
| B-2.3~2.8a | 나머지 15개 테이블 이전 (migrate-data.js 확장) | b55985a |
| B-2.8b | equipment_usage_logs 780→1036행 (id 1~1036), migrate-eul.js | b55985a |
| B-2.9 | 전체 21테이블 검증 + 시퀀스 일괄 리셋 | b55985a |
| chore | scripts/node_modules .gitignore 추가 | 8e3e966 |
| chore | dryrun 산출물 git 제외 (내부 IP 포함, 재생성 가능) | 99f6c74 |
| B-3 | init-admin.js — admin upsert, PBKDF2 SHA-512 v1 호환, 검증 통과 | d33fd0a |

**상태: 데이터 이전 + 인증 기반 완료.**

검증 결과:
- 행수 대조 20/20 일치 (eul +256 의도, audit -1 운영 추가)
- FK 무결성 15/15 고아 행 0
- 시퀀스 20/20 정렬 (last_value = max(id))

## 2. v2 현재 상태

### 있음
- PostgreSQL 스키마 (v2/db/01~06_*.sql)
- Docker Compose (v2/docker-compose.yml)
- 환경변수 (.env, .env.example)
- 마이그레이션 스크립트 5개 (v2/scripts/)
  - migrate-data.js: 단순/복합 테이블 15개 이전 함수
  - migrate-eul.js: equipment_usage_logs 59→21컬럼 변환 + JSONB
  - dryrun-eul.js: EUL 드라이런 검증
  - test-connection.js: v1 SQLite + v2 PostgreSQL 연결 테스트
  - init-admin.js: admin 계정 생성/재설정 (v1 해시 호환)

### 없음 (이식 대상)
- server.js (앱 엔트리포인트)
- 라우트 23개
- 모델 20개
- 미들웨어 3개 (auth, errorHandler, upload)
- 서비스 4개 (gpuMonitor, hardwareParser, specLookup, sshDiscovery)
- EJS 템플릿 44개
- config/ (app.js, database.js)
- public/ (프론트엔드 JS 5개 + CSS + 이미지)

### 세션
- v1: 메모리 저장 (express-session 기본)
- v2: connect-pg-simple로 전환 예정 (06_sessions.sql 준비됨, session 테이블 존재)

### DB 데이터
- 20개 테이블 모두 적재 완료. 시퀀스 정렬됨. 다음 INSERT 충돌 없음.
- equipment_usage_logs: append-only 트리거 활성 (UPDATE/DELETE 차단)

## 3. 이식 대상 인벤토리 (실측)

### 라우트 (23개 파일, 7,509줄, 157 엔드포인트)

| 파일 | 줄수 | EP수 | 주요 경로 |
|------|-----:|-----:|-----------|
| inventory.js | 1,406 | 18 | /incoming, /equipment/:mgmt, /api/* |
| discovery.js | 1,059 | 14 | /scan, /scan-asset, /scan-range |
| assets.js | 1,051 | 14 | /assets, /new, /:id, /api/assets |
| moduleInventory.js | 899 | 16 | /modules, /api/inventory/* |
| racks.js | 444 | 10 | /:roomId, /:id/slots |
| lendings.js | 395 | 10 | /, /:id, /create-link |
| excelUpload.js | 318 | 3 | /excel, /parse-text |
| chat.js | 276 | 4 | /query, /stream |
| requests.js | 242 | 4 | /setup, /apply |
| serverRooms.js | 237 | 8 | /, /:id, /:id/edit |
| networkLayout.js | 217 | 7 | /connections/* |
| gpuMonitoring.js | 156 | 2 | / |
| powerPanel.js | 125 | 5 | /nodes/* |
| publicIntake.js | 121 | 4 | /:token, /intake |
| backup.js | 102 | 4 | /download, /delete |
| auth.js | 99 | 7 | /login, /logout, /admin/users |
| ipManagement.js | 84 | 3 | /subnet/:subnet, /ip/:ip |
| vendorIntake.js | 76 | 6 | /, /:id/approve, /:id/reject |
| photos.js | 57 | 3 | /upload, /:entityType/:entityId |
| index.js | 46 | 1 | / (dashboard) |
| storage.js | 43 | 1 | / (장비실) |
| auditLog.js | 30 | 1 | / |
| offices.js | 26 | 1 | / (사무실) |

### 모델 (20개 파일, 2,664줄, SQLite .prepare() 총 266회)

| 모델 | 줄수 | .prepare() | 이식 난이도 |
|------|-----:|----------:|------------|
| asset.js | 320 | 29 | 높음 |
| equipmentUsageLog.js | 313 | 20 | 높음 (v2 구조 변경) |
| moduleInventory.js | 291 | 16 | 중간 |
| ipAddress.js | 197 | 17 | 중간 |
| rack.js | 178 | 14 | 중간 |
| networkConnection.js | 172 | 13 | 중간 |
| lending.js | 131 | 13 | 낮음 |
| computingModule.js | 117 | 8 | 낮음 |
| vendorIntake.js | 106 | 11 | 낮음 |
| moduleTransferLog.js | 111 | 4 | 낮음 |
| moduleInventoryLog.js | 105 | 6 | 낮음 |
| inventoryLog.js | 107 | 7 | 낮음 |
| photo.js | 105 | 7 | 낮음 |
| powerNode.js | 99 | 6 | 낮음 |
| auditLog.js | 78 | 5 | 낮음 |
| user.js | 78 | 9 | 낮음 |
| serverRoom.js | 53 | 8 | 낮음 |
| vendor.js | 43 | 5 | 낮음 |
| assetCredential.js | 30 | 3 | 낮음 |
| assetIp.js | 30 | 3 | 낮음 |

### 라우트 내 직접 DB 호출 (모델 우회)

| 라우트 | .prepare() |
|--------|----------:|
| chat.js | 16 |
| inventory.js | 15 |
| discovery.js | 13 |
| moduleInventory.js | 12 |
| racks.js | 9 |
| assets.js | 7 |
| lendings.js | 6 |

### EJS 템플릿 (44개)

- 핵심 뷰: dashboard, inventory/(4), assets/(4), racks/(5), module-inventory/(2)
- 시설: ip-management/(2), power-panel/(2), network-layout/(2)
- 관리: auth/(2), audit-log/(1), backup/(1)
- 기능: vendor-intake/(3), requests/(3), lendings/(2), discovery/(1), chat/(1)
- 기타: offices/(1), storage/(1), gpu-monitoring/(1), excel/(1), error
- 공통: partials/(3) — header, footer, photo-section

### v1 server.js 부트스트랩 구조

```
express → getDb() → 디렉토리 생성(backups, photos)
→ EJS 뷰엔진 설정
→ morgan, json, urlencoded, cookieParser, session(메모리), flash
→ static(public/)
→ flash·currentUser 미들웨어 (res.locals)
→ auth 라우트 (로그인 불필요)
→ publicIntake (외부 벤더용, 로그인 불필요)
→ requireLogin 이후 나머지 23개 라우트 마운트
```

## 4. §5 화면 전환 대상 (데이터 소스 변경 동반)

| 화면 | 라우트 | 모델 | 변경 내용 |
|------|--------|------|-----------|
| 입출고 관리 | inventory.js | equipmentUsageLog.js | eul만 읽기 → assets+computing_modules JOIN |
| 자산 상세/등록 | assets.js | asset.js | eul prefill → assets prefill |
| 디스커버리 | discovery.js | asset.js + sshDiscovery.js | eul 이중기록 → computing_modules에만 + 이력 스냅샷 INSERT |
| 대시보드 | index.js | (인라인 쿼리) | eul 통계 → assets 통계 |

(상세는 MIGRATION_PLAN.md §5 표 참조)

## 5. 이식 시 핵심 변환 원칙 (B-3 이후 SQL 전환)

### 동기→비동기 전환
- `db.prepare(sql).get(params)` → `await pool.query(sql, params)` (.rows[0])
- `db.prepare(sql).all(params)` → `await pool.query(sql, params)` (.rows)
- `db.prepare(sql).run(params)` → `await pool.query(sql, params)` (.rowCount)

### 트랜잭션
- `db.transaction(() => {...})()` → `await query('BEGIN'); try { ... COMMIT } catch { ROLLBACK }`

### §5 동기화 코드 제거 대상
- assets↔eul 양방향 동기화 전부 삭제
- computing_modules→eul 동기화 삭제
- usageLog→assets 동기화 삭제
- eul은 이제 append-only 이벤트 이력 전용
- 현재상태는 assets/asset_ips/asset_credentials/computing_modules가 유일 소스 (single source of truth)

### 자동복원 로직 제거
- assets.js의 hardware_json→모듈 복원 로직 삭제

### DB 연결
- 127.0.0.1:5433, Pool, dotenv (migrate-data.js 패턴)
- 세션: connect-pg-simple (06_sessions.sql의 session 테이블 사용)

### 비밀번호 (변경 금지)
- PBKDF2 / SHA-512 / 100,000회 / 16B salt / 64B key
- 저장 형식: "salt_hex:hash_hex" (161자)
- 로그인 검증은 timingSafeEqual로 개선하되 해시 파라미터는 불변

## 6. 다음 단계 진입점 (재개 시 여기부터)

이식 로드맵을 아직 확정 안 함. 재개 시 첫 작업:

1. **이식 순서/묶음 설계** (의존성·위험도 기준)
2. 제안된 시작 순서:
   - (1) server.js + 미들웨어 + 세션(connect-pg-simple)
   - (2) auth 라우트 (이미 init-admin으로 해시 검증됨)
   - (3) 읽기전용 라우트로 pg 비동기 패턴 검증 (대시보드/조회)
   - (4) 쓰기·동기화제거 라우트 (위험 높음, 신중히)
3. B-2처럼 "한 묶음 이식 → 동작 검증 → 다음" 점진 진행
4. v1은 무중단 운영 유지. 이식은 v2에서만. 최종 cutover는 B-7.

## 7. 운영 전환 시 정리 메모 (B-7)

- admin 비번 qwe123 → 강한 비번 (`ADMIN_PASSWORD=... node init-admin.js --reset`)
- 로그인 로직 timingSafeEqual 적용
- audit_logs 등 로그 테이블 cutover 시 델타 재이전 + reset-sequences 재실행
- vendor_intake_requests id=1 테스트데이터 삭제
- blade_slot 표기 일관성 (글루시스-007 좌측/우측 vs 008 left/right)
- TPC-SV-1U-06 모듈 등록 누락

## 이식 기술부채 (B-4d에서 정리)

### B-4b에서 발생한 호환층 부채 (B-4d §5 전환 시 제거 대상)

- **equipmentUsageLog.js**: v2 깨끗한 스키마(event_type 영문, event_date)를
  v1 대시보드 뷰에 맞추려 호환층 3종 적용 중:
  1. event_type → 한글 status 역매핑 (incoming→입고 등). `EVENT_TYPE_LABEL` 상수.
  2. SELECT에서 `event_date AS usage_date` 별칭 (뷰가 옛 컬럼명 기대).
  3. 세 메서드(getRecent/countByStatus/getMonthlyTrend) 모두 fallback `|| event_type`.
  → B-4d에서 §5대로 대시보드를 assets 기반 통계로 재작성하고,
    위 호환층 제거 + 뷰를 event_type/event_date 직접 사용으로 전환.
- **transferred event_type**: v1엔 없던 신규 개념(v1은 모듈 이동만 module_transfer_logs로 관리).
  현재 DB 0건. 한글 라벨 미정 → fallback으로 'transferred' 원문 노출(안 깨짐).
  자산 이관 기능을 실제 설계할 때(B-4d 또는 이후) 한글 라벨 확정.

### B-4b 완료 상태

- requireLogin + 읽기 라우트: auditLog, offices, storage, serverRooms(rooms),
  index(대시보드), /api/search — 전부 pg async 전환, 로그인 보호 하에 200 동작.
- 검증: 대시보드 자산통계 정확(172/87/22/7), audit login 기록(id 1422~), 세션 user 저장.
- 알려진 호환층 부채는 위에 기록(기능 정상, B-4d에서 정리).

## 8. 작업 원칙 (유지)

- 한 단계씩 잘게, 사용자 직접 검증 후 다음
- v1 app/ 절대 미수정, v1 SQLite readonly만, v1 운영 무중단
- 의문 생기면 직접 스키마/데이터 확인 후 진행
- 비즈니스 결정은 사용자, 안전절차/접근방식은 권고 수용

## 9. 주요 파일 위치

| 용도 | 경로 |
|------|------|
| v1 운영 앱 | `app/` (수정 금지) |
| v1 SQLite DB | `app/data/it_assets.db` (readonly만) |
| v2 PostgreSQL 스키마 | `v2/db/01~06_*.sql` |
| v2 Docker | `v2/docker-compose.yml` |
| v2 환경변수 | `v2/.env` (git 제외) |
| v2 PostgreSQL 데이터 | `v2/pgdata/` (git 제외, Docker 볼륨) |
| 마이그레이션 스크립트 | `v2/scripts/migrate-data.js`, `migrate-eul.js` |
| admin 초기화 | `v2/scripts/init-admin.js` |
| 마이그레이션 계획서 | `MIGRATION_PLAN.md` |
| B-2 재개 가이드 | `B2_RESUME_GUIDE.md` |
| 이 문서 | `B3_PORTING_RESUME_GUIDE.md` |

## 10. 서버 재시작 후 확인 사항

```bash
# 1. Docker 컨테이너 확인 (restart: unless-stopped이므로 자동 시작됨)
docker ps --filter name=it-assets-db

# 2. 안 올라왔으면 수동 시작
cd /mlcommons_cm/hpc_it_management/v2
docker compose up -d

# 3. healthy 대기 후 포트 확인
docker compose ps
ss -tnl | grep 5433

# 4. v1 운영 서비스 확인
systemctl status it-assets

# 5. v2 데이터 보존 확인
docker exec it-assets-db psql -U itadmin -d it_assets -c \
  "SELECT tablename, n_live_tup FROM pg_stat_user_tables WHERE n_live_tup > 0 ORDER BY tablename;"

# 6. 연결 테스트
cd /mlcommons_cm/hpc_it_management/v2/scripts
node test-connection.js
```
