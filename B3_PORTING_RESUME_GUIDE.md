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

## ★ 세션 시작 시 v1 운영 확인 (최우선)

재개할 때 가장 먼저:
```bash
systemctl status it-assets --no-pager | head -5
ss -ltnp | grep 3000
```
- inactive/dead면 즉시: `sudo systemctl start it-assets`
- v1(3000, systemd)과 v2 개발(3001, 수동 node)은 같은 서버 공존.
- v2 작업 중 절대 it-assets stop 금지, 3000 포트 건드리지 말 것.
- v2 검증 서버는 timeout으로만 띄우고 자동 종료시킬 것 (nohup 금지).
- (2026-06-29 14:20 v1이 status=0 정상종료로 꺼져있던 적 있음 — 원인 추적 중)

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
- [UI일괄점검] BUG-3: /module-inventory 이동 모달이 인라인으로 풀림. transferModal 구조는 정상
  (modal-overlay + openModal, index.ejs L902/938). 추정: .modal-overlay 기본 display:none 누락
  또는 openModal .active 토글 불일치(L342-350). 공통 문제면 모달 4개 전부 → CSS 1곳 수정으로 일괄해결.
  화면 확인 필요, UI 세션에서 수정.
- [UI일괄점검] 대여관리(/lendings) 상단 메뉴 링크 없음 — v1도 동일(header에 없고 footer 배열은
  메뉴 아닌 목록판별용). 포팅 결함 아님. 메뉴 추가는 UI 개선 선택사항(필수 아님).

### 로그 테이블 cutover 델타 (B-7) — 실측 스냅샷 (2026-07-03)
| 테이블 | v1 현재 | v2 이전시점 | 처리 |
|--------|--------:|-----------:|------|
| module_transfer_logs | 428 | 380 (id≤392 완전일치) | v1 id>392 델타 +48 추가 |
| module_inventory_logs | 427 | 379 | 델타 +48 추가 |
| audit_logs | 1399 | 1417 | ★ v2가 많음(검증 audit 누적). cutover 시 v2 테스트 audit 처리 방침 필요 — v1 운영분과 id 충돌 주의 |
| equipment_usage_logs | 787 | 1036 | 이벤트소싱 이전(별개). v1 787→v2 1036은 정상(반납 이벤트 분리) |
- transfer/inventory: id 기준 델타 재이전(단순 증가분).
- audit_logs: v2 검증 중 누적된 테스트 audit(1435~) 존재. cutover 시 정리 or v1 재이전 방침 B-7에서 결정.

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

### B-4b 검증 경계 (커밋 ba9401e)

검증 완료 (실데이터 확인):
- requireLogin 보호 + 읽기 라우트: auditLog, 대시보드, offices, storage,
  rooms(목록/상세/자산/모듈), /api/search — 전부 pg async, 200 동작.
- rooms 상세 검증: room_id=64 → 자산 55개 화면 렌더 = DB 55 일치.
- 주의: server_rooms id는 60~71 대역(원본 id 보존). assets id도 1041~.
  검증 시 id=1 가정 금지, 항상 실제 분포부터 확인할 것.

선반입됐으나 독립 검증 안 됨 (파일 존재 ≠ 전환 완료):
- 모델 asset.js는 rooms 경유 '읽기'만 검증됨. 자산 CRUD(생성/수정/삭제) 미검증.
- ipAddress.js, moduleInventory.js, assetCredential.js, assetIp.js:
  자체 라우트(/assets, /modules, IP관리) 아직 mount 안 됨 → B-4c/d에서 정식 이식·검증.
- rack.js, computingModule.js: rooms 읽기 경유로만 동작 확인. 자체 기능 미검증.
→ B-4c/d 진입 시 "파일 있음"을 완료로 간주하지 말고, 해당 라우트에서 독립 검증할 것.

### §5 호환층 부채 (B-4d 정리) — 재확인

- equipmentUsageLog.js: event_type→한글 역매핑 + event_date AS usage_date 별칭.
  세 메서드 fallback `|| event_type` 적용(transferred 등 안 깨짐).
- transferred: v1 무, v2 신규. 라벨 미정. 자산 이관 기능 설계 시 확정.

### 이식 버그 트래킹 (BUG_TRACKING.md 연결)

v1에 원래 있던 버그 목록. 방침: (나) 이식하며 수정. 문서: `./BUG_TRACKING.md`
- 각 라우트/모델 이식 전 BUG_TRACKING.md 확인 필수.
- 등록 버그는 v2에서 의도적으로 v1과 다르게(고쳐서) 동작.
  → 검증 시 v1↔v2 차이가 나면 BUG_TRACKING 먼저 확인: 등록 버그 수정이면 정상.
- 현재 버그:
  - BUG-1 (B-4d): 부품수정 시 사용자 비고 손실 → 비고 보존
  - BUG-2 (보류/신기능): 전원 끄기 미동작(no_cred) → 자격증명 규명 후 신기능 트랙. (나) 예외
  - BUG-3 (B-4d): 부품 이동 팝업 UI 깨짐
  - BUG-4 (B-4d): audit before/after [object Object]. v1 기존 결함(pg 아님), 신규기록부터 수정
- 수정 완료 시 BUG_TRACKING.md에 [완료]+커밋해시 기록.

### 메뉴 정리 결정 (가) — 이식 제외 + 숨김

- 신청서(requests.js), 전력분전반(powerPanel.js), 네트워크(networkLayout.js):
  데이터 0행 또는 테스트뿐 → v2 이식 제외 + 메뉴 숨김. 완전삭제 아님(v1 코드 보존).
- B-4c 로드맵에서 위 3개 제외하고 재구성.

### B-4c 진행 — 쓰기 라우트 검증

B-4c-1 serverRooms 쓰기 검증 완료 (코드 변경 없음 — B-4b에서 이미 async 전환됨):
- CRUD 한 사이클 검증: CREATE(id=72)→UPDATE→DELETE 전부 302, DB 반영 확인.
- 시퀀스 정합 실전 검증: 새 id=72 (B-2.9에서 server_rooms 시퀀스 71로 맞춘 것 확인).
- audit_logs 연쇄 기록 정상(1435~1437). 원본 9행 보존, 테스트 데이터 정리 완료.

### 쓰기 검증 템플릿 (이후 쓰기 라우트 공통)

1. before 기준 행수
2. CREATE → DB 확인 + 새 id가 시퀀스 이상인지(정합)
3. UPDATE → 값 변경 확인
4. DELETE → 정리 겸 삭제 검증
5. after → 원본 보존 + 테스트 0
6. audit_logs 연쇄 기록 확인
- 테스트 데이터는 `__TEST_xxx__` 명명으로 격리, DELETE로 반드시 정리. 운영 데이터 불가침.

### B-4c-2 vendorIntake 완료

- 이식+쓰기검증 통과: create-link(id=2)→approve(상태전이)→delete, 시퀀스 정합, id=1 보존.
- audit 연쇄 기록(1441~1442). publicIntake 제외(v1도 미사용), requests 제외(가).

### ★ B-4c 공통 원칙 (이후 모든 쓰기 라우트 적용)

1. **pg 날짜 후처리 패턴**:
   - pg는 날짜/타임스탬프 컬럼을 Date 객체로 반환 → 뷰가 문자열 기대 시 깨짐.
   - 날짜 컬럼 있는 모델은 fixDates류 후처리(Date→ISO 문자열) 적용.
   - 적용 이력: auditLog, equipmentUsageLog, vendorIntake. 이후 ipManagement/photos 등도 점검.
2. **audit 일관 적용**:
   - 쓰기 라우트의 생성/수정/삭제/상태변경에는 AuditLog.log 기록을 남긴다.
   - v1에 audit가 없던 동작도 v2에서 보강(의도된 개선 — v1과 다른 것은 정상).
   - 단 BUG_TRACKING이 아니라 "공통 개선 원칙"으로 분류. 검증 시 audit 차이는 의도된 것.
   - 확인: serverRooms·vendorIntake 모두 audit 있음(일관성 OK).

### B-4c 남은 라우트 (순서)

- ~~vendorIntake(완료)~~ → ipManagement(서브넷 벌크) → photos(파일+DB)
- lendings: 의존 모델(Lending/ModuleTransferLog/ModuleInventoryLog 신규 + stub 확장 다수) 갖춰진 뒤.
  fault-return 핸들러(6모델 대형 트랜잭션)는 B-4d 후보로 분리.
- 제외(메뉴정리 가): requests, powerPanel, networkLayout.


### B-4c 완료 + B-4d 진행

**B-4c 완료** (5개 쓰기 라우트 이식·검증):
- serverRooms(c592b0d) · vendorIntake(f7823f4) · ipManagement(d23cd90) · photos(9cdd202) · lendings(5fb9446)
- 제외 3개(requests/powerPanel/networkLayout) + 미사용 5개(publicIntake/backup/excelUpload/gpuMonitoring/chat) 주석 유지.
- lendings: 8EP 이식, fault-return 2개(6모델 대형 트랜잭션)는 B-4d로 스텁 분리.

**B-4d 진행:**
- B-4d-1: asset 모델 확장 14메서드 + 날짜밀림 스윕(공용 utils/dateFix.js, DATE/TIMESTAMP 분기, 4모델)(0218d2b)
- B-4d-2.5: EUL append-only 트리거 제거 (방향1, b88e7de) — v1 동등 mutable EUL 복원, 자산삭제 회귀 해소.
  이력불변은 마이그레이션 후 신기능 트랙으로 분리.
- B-4d-2: assets 12EP 이식 (ad36abc) — fault-repair/module-action 503 스텁,
  EUL동기화·prefill·auto-sync는 B-4d-6 유보.
- BUG-4 종결 (v2 스키마 구조적 소멸 — 아래 BUG_TRACKING 참조).
- B-4d-3: racks 10EP 이식(0777fe0) + power-control 스텁화(B-4d-3b, BUG-2 트랙, bde0854).
  BUG-5 재현결과: 조건부 잠복·원인규명완료·미룸.
- B-4d-4: 모듈 4모델 확장(26메서드, 트랜잭션 3종). getUsageByCode 유보(EUL, B-4d-5/6).

**B-4d 하위단계 분해 (확정 순서):**
- B-4d-1(완료) → B-4d-2/3(assets/racks, 병렬가능) → B-4d-4(모듈모델) →
  B-4d-5/6(moduleInventory/inventory, 병렬가능) → B-4d-7(discovery+§5, 최고위험) →
  B-4d-8(fault-return 스텁 해제) → B-4d-9(기술부채 정리)

**B-4d 후반 블로커/확인지점:**
- EUL 이벤트소싱 매핑 (B-4d-5/6 선행 필수): v2 EUL 컬럼구조 상이
  (event_type/JSONB, status·return_date·하드웨어컬럼 없음) + management_number당 다중행(최대18).
  v1 상태전이 로직(markReturned/returnActiveByManagement/updateHardwareColumns) 매핑 설계 필요.
- audit 스키마 v1(before/after 2컬럼) ≠ v2(details 단일 JSONB) — 개수검증만 함, 내용 동등성 미검증.
- 삭제 후 이력조회: v2 asset_id=NULL vs v1 management_number 텍스트 연결 → B-4d-6 확인.
- BUG-5: assets 저장(blade_slot 클리어) ↔ racks 렌더(shelfU) 불일치 → B-4d-3(racks) 이식 후 합동수정.

**포팅 방법론 (B-4d 관통 원칙):**
- 포팅 결함(v1엔 없던 v2 회귀, 예: 날짜밀림·삭제회귀) = 즉시 수정, 충실이식에 포함.
- 기존 버그(BUG-1~6) = (a)충실이식→v1==v2 동등성 확인→커밋, (b)버그수정→별도 커밋.
  단 BUG-6은 §5와 한 몸이라 B-4d-7 통합.

### 날짜 헬퍼 중복 (B-4d-9 정리)
- moduleInventoryLog.js가 자체 fixTimestamps 함수 정의 — 공용 utils/dateFix.js의 fixRowDates와 중복.
  B-4d-9에서 fixRowDates(row, [], ['created_at'])로 공용화. 기능은 정상, 코드 정리만.

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
