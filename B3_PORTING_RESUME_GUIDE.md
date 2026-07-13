# B-3 이후 애플리케이션 이식 — 재개 가이드

> 작성일: 2026-06-26 / 최종 현행화: 2026-07-12
> 작성 목적: 서버 종료 전 맥락 보존. 재개 시 이 문서 + git log부터 확인.

> ★ **릴리스 현황(2026-07-13)**: **v2.1.0이 타 팀 배포 첫 정식본**(dist·공지 v2/backups·
> v2/RELEASE_NOTICE_2.1.0.md, git tag v2.1.0). 2.0.1·2.0.2는 **사내 검증본으로 미발송**
> (공지 상단에 "미발송" 헤더). v2.1.0 = 2.0.2 + BL-11(자격증명 암호화·[보기]/[복사]) +
> BL-12(재고 점검 MVP+원복). 마이그레이션 4파일(BL-3/11/12/12-revert) 동봉.

> ★ **새 세션은 여기부터**: 최신 상태는 아래 3개 섹션 —
> "★ 2.0.1 배포 준비 종결(3관문+D)" / "★ v2.1 우선순위 확정 + 2.0.2 후보 묶음 완료" /
> "★ 대기/예약 항목(2026-07-12 기준)". 그 위·아래의 B-3~B-7 기록은 완결 이력이다.
> 운영 구도(v2 단일 운영본 :3001 systemd it-assets-v2, v1 READ_ONLY :3000)는
> "★ B-7 전체 완결" 섹션의 현 상태 선언이 여전히 유효.

## 1. 지금까지 완료 (커밋 기준)

| 단계 | 내용 | 커밋 |
|------|------|------|
| B-1 | PostgreSQL 21테이블 + 트리거 + 배포 정책 | c2a10f4 |
| B-1.5 | docker-compose ports 127.0.0.1:5433 추가 | 6838306 |
| B-2.1/2.2 | 마이그레이션 스크립트 + 단순 테이블 5개 이전 | d4573f0 |
| B-2.3~2.8a | 나머지 15개 테이블 이전 (migrate-data.js 확장) | 302020e |
| B-2.8b | equipment_usage_logs 780→1036행 (id 1~1036), migrate-eul.js | 302020e |
| B-2.9 | 전체 21테이블 검증 + 시퀀스 일괄 리셋 | 302020e |
| chore | scripts/node_modules .gitignore 추가 | ba0588a |
| chore | dryrun 산출물 git 제외 (내부 IP 포함, 재생성 가능) | c65543a |
| B-3 | init-admin.js — admin upsert, PBKDF2 SHA-512 v1 호환, 검증 통과 | 90d7dd9 |

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

> **[종결] B-7 컷오버 2026-07-11 완료 — "★ B-7 전체 완결" 섹션 참조.**
> 아래 메모 중 데이터 이관 관련(델타 재이전·audit 충돌)은 빅뱅 재이관으로 해소됨.
> 미처리 항목(admin 비번, vendor_intake id=1 삭제, returned 표식 notes 방침, blade_slot 표기,
> TPC-SV-1U-06, BUG-3 모달)은 v2.1/운영 후속 과제로 잔존.

- admin 비번 qwe123 → 강한 비번 (`ADMIN_PASSWORD=... node init-admin.js --reset`)
- 로그인 로직 timingSafeEqual 적용
- audit_logs 등 로그 테이블 cutover 시 델타 재이전 + reset-sequences 재실행
- vendor_intake_requests id=1 테스트데이터 삭제
- blade_slot 표기 일관성 (글루시스-007 좌측/우측 vs 008 left/right)
- TPC-SV-1U-06 모듈 등록 누락
- 마이그레이션 표식 notes 정리: equipment_usage_logs returned 행의
  "[returned event migrated from return_date]" 문구가 상세 타임라인에 노출(6d 발견).
  B-2.8b가 심은 데이터 — 일괄 제거 or 유지 방침 결정.
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

### B-4b 검증 경계 (커밋 2a9e278)

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
3-1. **개선 트랙 후보 (B-4d-8/9 등록, 미착수)**:
   - mi_log의 before/after_total이 recalc 전 산술값으로 기록되는 v1 quirk(충실이식 상태) —
     post-recalc 값 기록으로 개선 여지.
   - apply-asset·fault류(fault-repair/module-action/fault-return)의 비트랜잭션 순차 실행
     (v2 모델 pool 개별 연결) — 원자성 강화(클라이언트 전달 리팩토링) 여지.
3. **타임스탬프 KST 표시 (v1 UTC quirk 미계승, 6d 확정)**:
   - v1은 SQLite CURRENT_TIMESTAMP(UTC)를 그대로 표시 — 신규 기록 시각이 벽시계보다 9시간 이전으로 보임.
   - v2는 utils/dateFix.js formatTimestamp(서버 로컬)로 통일: 마이그레이션 이전분은 v1 화면과
     문자열 일치, 신규분은 실제 KST 벽시계. v1↔v2 신규기록 시각 차이는 의도된 개선(같은 순간의 표기 차).

### B-4c 남은 라우트 (순서)

- ~~vendorIntake(완료)~~ → ipManagement(서브넷 벌크) → photos(파일+DB)
- lendings: 의존 모델(Lending/ModuleTransferLog/ModuleInventoryLog 신규 + stub 확장 다수) 갖춰진 뒤.
  fault-return 핸들러(6모델 대형 트랜잭션)는 B-4d 후보로 분리.
- 제외(메뉴정리 가): requests, powerPanel, networkLayout.


### B-4c 완료 + B-4d 진행

**B-4c 완료** (5개 쓰기 라우트 이식·검증):
- serverRooms(b56c3b2) · vendorIntake(42d1e38) · ipManagement(dfb8755) · photos(a1d6d19) · lendings(efbe706)
- 제외 3개(requests/powerPanel/networkLayout) + 미사용 5개(publicIntake/backup/excelUpload/gpuMonitoring/chat) 주석 유지.
- lendings: 8EP 이식, fault-return 2개(6모델 대형 트랜잭션)는 B-4d로 스텁 분리.

**B-4d 진행:**
- B-4d-1: asset 모델 확장 14메서드 + 날짜밀림 스윕(공용 utils/dateFix.js, DATE/TIMESTAMP 분기, 4모델)(979d1f0)
- B-4d-2.5: EUL append-only 트리거 제거 (방향1, 89af313) — v1 동등 mutable EUL 복원, 자산삭제 회귀 해소.
  이력불변은 마이그레이션 후 신기능 트랙으로 분리.
- B-4d-2: assets 12EP 이식 (73fcc83) — fault-repair/module-action 503 스텁,
  EUL동기화·prefill·auto-sync는 B-4d-6 유보.
- BUG-4 종결 (v2 스키마 구조적 소멸 — 아래 BUG_TRACKING 참조).
- B-4d-3: racks 10EP 이식(3b23c72) + power-control 스텁화(B-4d-3b, BUG-2 트랙, 9c09210).
  BUG-5 재현결과: 조건부 잠복·원인규명완료·미룸.
- B-4d-4: 모듈 4모델 확장(26메서드, 트랜잭션 3종). getUsageByCode 유보(EUL, B-4d-5/6).
- B-4d-5: moduleInventory 16EP 이식(f3a1a0c, §5 EUL동기화 제거·syncModulesToUsageLog 스텁) + BUG-1 수정(44581ef).
- B-4d-6 (inventory + EUL 이벤트소싱, 완료):
  - 설계 확정(fd1ec69, B4D6_EUL_DESIGN.md): status↔event_type 매핑 + JSONB 3종 + 쓰기 하이브리드
    (create=INSERT / 반납=append INSERT / update=UPDATE / delete=DELETE).
  - 6a: EUL 모델 확장 — 읽기7+쓰기4, flatten(JSONB→v1 가상컬럼), STATUS_TO_EVENT (d009a9f).
  - 6b: 라우트 헬퍼 — mapHardware/Ips/CredsToCols, generateVendorManagementNumber async (ee25332).
  - **6c: inventory 라우트 18EP 이식 완료 = 구현 17EP + 스텁확정 1EP(#18 migrate-psu, 일회성이라 v2 불필요)**:
    - 6c-A(624766d): 라우트 생성 + 무접촉 7EP(#2,4,5,6,7,8,17) + incoming-form 뷰 복사 + mount.
    - 6c-B(9a5a43b): 읽기 5EP(#1,9,11,12,16) + 뷰 3개 복사(index/form/equipment-detail).
    - 6c-C1(4ff143b): 반납#14·삭제#15. / 6c-C2(8886846): 입고#3(재입고 reactivate, 다중노드, 모듈재고).
    - 6c-C3(b0c510f): 사용등록#10(자동반납 + 자산동기화 200줄). / 6c-C4(b1b4fbd): 수정#13.
  - 실증 완료: flatten 뱃지(읽기 목록/상세 status·개별컬럼 렌더) / append(수동반납#14·자동반납#10,
    이전 in_use 보존 + returned 신규행) / incoming 매핑(#3, status='입고'→event_type) / UPDATE(#13,
    행수 불변 내용정정) / DELETE(#15) / mapXxx→buildSnapshots JSONB 체인(#10 create·#13 update 양경로).
  - 검증은 전부 __TEST_xxx__ 마커 격리 후 정리 — 운영 행수(assets 172/eul 1036 등) 사전=사후 확인됨.
  - 6d(946bfea): 화면 필드 대조 완료 — detail 타임라인(날짜/사용자/용도/위치 v1 문자열 일치.
    v1 1행→v2 2행 이벤트 분리 표시는 설계 의도), edit prefill(JSONB→flatten→폼 정상), index 표본
    (v1 상위행 7월 데이터는 운영 델타, B-7 재이전 대상). returned 행은 "반납:"만 표시
    (6a 보정 — 사용일은 인접 in_use 행에 있어 정보손실 없음 확인).
    **타임스탬프 KST 수정**: toISOString UTC 표시로 이전 데이터가 v1 화면 대비 -9h 밀림 →
    formatTimestamp(서버 로컬) 공용화로 수정 (dateFix.js + auditLog/moduleInventoryLog/photo 3모델).
    사용자 브라우저 확인 완료(입출고/자산/랙/모듈). returned 행 "반납:"만 표시 방식 실사용 승인
    → in_use↔returned 짝매칭 작업 불필요 확정.
  - **→ B-4d-6 전체 완료** (설계→6a→6b→6c 18EP→6d 화면검증).
- **B-4d-7 (discovery 14EP + §5 + BUG-6) — 완결** (2026-07-08, 코드 커밋 대기):
  - 정찰(2026-07-07): SSH=ssh2 라이브러리(자격증명 asset_credentials, fallback env),
    스캔결과는 클라이언트 보관→apply body 재전송(서버 무상태), §5 이중기록=apply-asset
    EUL 2건(vendor 분기)만, BUG-6 잔존결함(phantom PSU diff 비대칭) 발견.
  - 7a: services 3종 이식(sshDiscovery/hardwareParser/specLookup) + SSH_DEFAULT_PASSWORD/OLLAMA env화.
  - 7b: 읽기 6EP + 뷰/클라이언트JS. getUsageByCode는 EUL 보강 포함 전체 이식(in_use 치환).
    v1↔v2 필드 대조 통과(차이는 운영 델타뿐). #11 평문 password 반환은 기술부채 등록.
  - 7c: apply-asset(§5 EUL 제거 + BUG-6 A′/B) + register/link. 합성 페이로드 S1~S4 검증
    (무변동 0건·notes 합성·vendor 자동입고 EUL 0건), 운영 mi 202행 diff 0 원복.
  - 7d: 능동 5EP(scan-asset/ai-spec-lookup/scan/scan-range/apply). SSH 무접촉 실패경로 검증
    (connect 이전 return 코드 증명 + ss -tn 0건), 선택로직 v1=v2 대조, #14 쓰기 템플릿 통과.
    #12/#13에 입력검증 400 가드 추가(v1 미검증 크래시 방지, 계획된 이탈).
  - **7e 실스캔 실증(입회)**: 대상 id=1096 TPC-SV-2U-23 — 스캔 성공(6모듈, 파싱실패 0),
    **드리프트 0** → apply = S1 무변동 실데이터 재현: **mi_logs/transfer 신규 0건(BUG-6 A),
    phantom PSU 0건(A′), EUL 1036 불변(§5) 실환경 확증**. 원복 완전(cm 7행 원본 id 포함 복원,
    mi 202행 스냅샷 diff 0). audit 잔존 관례 1건(1517, 정리 후 총 1464 — B-7 정리 대상).
  - 14EP 전체 이식 완료, 501 스텁 0. 검증 방법론: 능동 EP는 코드증명+실패경로, 실스캔은 입회 1회.
- B-4d-8 (fault류 스텁 해제, 완료 — 커밋 대기):
  - 8b: assets fault-repair/module-action 2EP — storage/transfer/vendor_send·vendor_return 분기,
    __TEST_FR__ 검증(재고 복귀·이동쌍 로그·outgoing은 storage 미증가), EUL 불변.
  - 8a: lendings fault-return 2EP + Lending.markFaultReturned(비고 병합 보존).
    착수 전 검산: keep+자사의 total/spare 수동 증분은 recalculateInUse가 즉시 재유도
    (total=storage+in_use, spare=storage)하는 dead write — 이중 집계 아님 확인 후 충실이식.
    S1 수치 실증(total 5→5 불변), keep업체 tmp 코드 upsert 2회째 증가 분기 실증, EUL 불변.
- B-4d-9 (기술부채 일괄, 완료 — 커밋 대기):
  - assets.js §5 주석 스텁 → 영구 제거 종결(원칙 주석 1줄). /computing-modules 리다이렉트 복원.
  - 날짜 래퍼 공용화 완료(4f160bc 부채 해소 — moduleInventoryLog도 fixRowDates 위임) +
    Date 직렬화 스윕: 미적용 7모델(user/serverRoom/rack/ipAddress/computingModule/assetIp/
    assetCredential) 일괄 적용, v1↔v2 날짜 문자열 재대조 일치·UTC ISO 잔존 0.
  - BUG-3 수정(모달 CSS 탭 분기 밖 이동 — BUG_TRACKING [완료] 참조). BUG-5는 결정 자료
    정리 후 미룸 유지 권고(BUG_TRACKING 참조, 사용자 결정 대기).
- B-4d-10 (§5 화면 전환 잔여, 완료 — 커밋 대기):
  - 대시보드: EUL 호환층 3종 제거(getRecent/countByStatus/getMonthlyTrend가 event_type/
    event_date 원형 반환, 한글 라벨은 dashboard.ejs 책임으로 이동). EVENT_TYPE_LABEL 상수는
    flatten(inventory 충실이식 층) 전용으로 유지.
  - 검증: v2 대시보드 수치가 마이그레이션 스냅샷과 수식 단위 일치 —
    in_use 549 = 사용중@mig 293 + 반납@mig 256 / returned 256 = 반납@mig / 총 1036 = 780+256.
    v1과의 차이는 전부 운영 델타(신규 12행 id 1201~1212 특정 + 반납 전이 6건, B-7 재이전 대상).
    [동치 기대] 위젯(자산/랙/IP 통계) 전 항목 일치(총자산/서버 +2는 자산 델타 1192/1193).
  - prefill: assets(+asset_ips) 1순위, 미등록/삭제 mgmt는 EUL 최신 이벤트 fallback
    (flatten 가상컬럼으로 v1 계약 유지). 표본 2종(실존 자산=전 필드 v1 일치 / EUL-only=fallback 동작) 통과.
  - **→ §5 화면 전환 4개 전부 소진: 입출고(B-4d-6) · 자산 prefill(B-4d-10) ·
    디스커버리(B-4d-7c) · 대시보드(B-4d-10). 잔여 0.**

## B-5b 클린 배포 패키지 (2026-07-10, 커밋 대기)

- 목표: 타 팀 배포 가능한 자립형 Docker 패키지(데이터 0 → compose up 한 번).
- 산출물: `Dockerfile`(멀티스테이지 node:18-bookworm-slim + ipmitool, 비루트, HEALTHCHECK node) +
  `docker-entrypoint.sh`(bootstrap-admin→server) + `app/bootstrap-admin.js`(멱등 admin 시드) +
  `docker-compose.prod.yml`(DB+app, named volume, healthcheck depends_on) + `.dockerignore` +
  `scripts/backup.sh`/`restore.sh` + `DEPLOY.md`(리눅스/윈도우/스캔요건/백업/업데이트/문제해결).
- 배포 결함 수정: ① init-admin/bootstrap 키를 INITIAL_ADMIN_PASSWORD로 통일 + qwe123 fallback 제거
  (미설정 시 명확한 에러로 중단) ② subnets 하드코딩 → SUBNETS_JSON env(미설정 시 시드 skip) ③
  lendingDirections/ssh.defaultUser env화(기본값 유지로 운영 무영향) ④ config/database.js PGHOST env화.
  **운영 인스턴스 무영향 확증**: .env에 현 TTA 대역/라벨 반영 → config 로드 시 기존 9대역·'TTA' 동일.
- 스모크(격리 스택 it-assets-dist, 5434/3002, down -v 정리): 스키마 21테이블 자동생성 + admin 자동시드
  + SUBNETS_JSON 미설정 시 ip_addresses 0 + 신규설치(로그인→서버실→랙→자산+IP+자격→사진업로드) +
  스캔 실패경로(404/400) + 재기동 영속성 + admin 미설정 기동중단(exit 1) + 백업→변형→복원 원복.
  운영 스택(5433/:3000) 무영향 확인.
- ★ **빌드 환경 제약**: 이 개발 서버는 deb.debian.org(apt) egress 차단(npm registry만 허용) →
  ipmitool apt 설치 단계가 이 서버에서 빌드 불가. 정품 이미지는 인터넷/사내미러 있는 환경에서
  빌드해 tar 전달(원래 배포 전제와 부합). 스모크는 ipmitool 라인 뺀 임시 이미지로 앱 레벨 검증(정리 완료).
- 선택 등급 잔여(백로그): 뷰 placeholder '10.100.x' 일반화, discovery IP 우선순위 '10.' 하드코딩,
  ip-management 서브넷 추가 UI 부재(현재 SUBNETS_JSON로만 주입), READ_ONLY 미들웨어(B-6용).
- **다음: B-6** — 배포 검증(윈도우 실검증 포함) + 3단계 전환(READ_ONLY 미들웨어 작성).

## B-6 배포 검증 (진행 중, 커밋 대기)

- 6a: 맥북(Apple Silicon)에서 `buildx --platform linux/amd64` 크로스 빌드 → 정품 이미지
  `it-assets:2.0.0`(ipmitool 포함) tar 생성. 5b 스모크는 ipmitool 뺀 임시 이미지였음.
- 6b: 정품 tar 실 x86 서버 검증(격리 스택 it-assets-dist, down -v 정리, 운영 무접촉):
  - 정품 확인: amd64, User=node(비루트, uid 1000), HEALTHCHECK node 기반, **ipmitool 1.8.19 포함**,
    253MB/11레이어, HEALTHCHECK healthy.
  - DEPLOY.md 리허설(문자 그대로) → [문서 결함] 2건 발견·수정:
    ① compose.prod의 `image: it-assets-app:2.0` + `build: .` — 정품 태그(it-assets:2.0.0)와 불일치 +
       배포지엔 Dockerfile 없어 빌드 실패 → build 제거 + 태그 it-assets:2.0.0 통일.
    ② DEPLOY.md가 로드 태그·APP_IMAGE 안내 없음 → load 출력 태그 명시 + APP_IMAGE/프로젝트명 분리 안내
       + 문제해결 표에 태그 불일치 항목 추가.
  - 클린 설치 재현: 21테이블 자동생성 + admin 자동시드 + SUBNETS_JSON 미설정 0행 + 신규설치
    (서버실→랙→자산+IP+자격) + 스캔 실패경로(404) + 사진업로드 + 재기동 영속성 + backup→복원 원복.
  - 정품 추가분: **TUI 테마 렌더**(tui-theme.css 링크 + 대시보드 tui-rack), **죽은 메뉴 6개 부재**
    (requests/power-panel/network-layout/backup/gpu-monitoring/chat), backup.sh 격리 컨테이너명 동작(env 오버라이드).
  - 배포 전달물 스펙: tar `it-assets-2.0.0.tar.gz`(약 83MB gzip) / 이미지 `it-assets:2.0.0`(253MB, amd64,
    11레이어, node 비루트, ipmitool 1.8.19 포함).
- 6c: 윈도우 사무 PC Docker Desktop 클린 설치 실검증(서병준) → 문서결함 5건 + UI/기능 발견물 11건.
  후속 처리(커밋: docs 1 + fix 3 + docs 1):
  - 문서결함 5건(DEPLOY.md): [DOC-1]윈도우 UTF-8 편집 안내 [DOC-2]로드 명령 파일명 통일
    [DOC-3]postgres:16-alpine 오프라인 전달 누락(→ 앱만 뜨고 db 없어 종료의 원인)
    [DOC-4]db healthy 대기 인과·진단 안내 [DOC-5]http:// 스킴 명시 + SSL 오류 항목.
  - FIX-A(BUG-7): 랙 미리보기 hover 잔상 — JS 인라인 → CSS :hover(inv-rack-empty).
  - FIX-B: 이력관리 대상유형 한글화 — appConfig.auditTargetTypeLabels 14종(DB 불변, 표시계층).
  - FIX-C: 입출고 버튼 텍스트 기호(▼입고/▷사용/↺반납/✎수정/✕삭제, 이모지 변형 없는 문자).
  - INV-1(IP 미반영)/INV-2(입고 섀시 보관뷰 미표시): 조사 결과 **v1 동일·회귀 아님**
    (BUG_TRACKING 판정 기록). 각각 v2/V2.1_BACKLOG.md BL-5(→B-6e 승격)/BL-3로 이관.
  - 나머지 발견물 + 개편 요구: v2/V2.1_BACKLOG.md 신설(BL-1~5).
- **다음: B-6d(2.0.1 재빌드 — FIX 반영 이미지) / B-6e(IP 서브넷 관리 CRUD, INV-1 해소)
  / 3단계 전환 READ_ONLY 미들웨어.** 윈도우 실검증은 2.0.1로 재수행.

## B-6e IP 서브넷 관리 (2026-07-10, 커밋 완료)

INV-1(클린 설치 시 IP 미반영) 해소 — 서브넷을 화면에서 CRUD하고 풀을 자동 생성.
- Part 0 설계(a~e 승인): subnets 테이블 신설 / 마이그레이션+소급 / 삭제정책(assigned 차단,
  reserved 고지) / SUBNETS_JSON 레거시 유지 / CIDR 형식.
- Part 1 스키마(ebcad87): db/02_schema_assets.sql에 subnets + scripts/migrate-add-subnets.js.
  운영 v2 소급 9행, ip_addresses 2,304 무손상. 실행 전 pg_dump 백업(backups/, .gitignore).
- Part 2 백엔드(c3b3428): Subnet 모델 + IpAddress 확장(createPool/deletePool/countByAllocation/
  findMissingFromPool, syncAssetIps 무수정) + 서브넷 CRUD 라우트(중복/겹침 검증, 삭제정책, audit
  target_type='subnet') + 사용등록 풀밖 IP 경고 + FIX-B 라벨 '서브넷'.
- Part 3 프론트(c3b3428): 하드코딩 Office/HPC/AIDC 제거 → 서브넷 보유 zone만 동적 렌더(빈 zone
  미렌더) + 서브넷 관리 UI + 삭제 고지(reserved) + 빈 상태 안내 + 통계 카드 유지.
- Part 3-fix(424b311): POST /subnets 크래시 근본 수정 — server.js unhandledRejection/
  uncaughtException 안전망(node18은 미처리 rejection 시 프로세스 종료) + 미들웨어 try/catch.
  CIDR /24 → **/16~/30 확장**(네트워크 주소 정렬검사, multi-row 배치 INSERT: /16 65,536행 2.6s,
  CIDR 범위 겹침 검사, 상세 /24 블록 페이지네이션). 실환경 브라우저 검증 통과, 운영 원복.
- 백로그: BL-5 완료 처리, BL-7(대량 블록 네비 개선)·BL-6(zone 사용자 정의화) 추가.
- Part 4(사용등록 폼 가용 IP 조회): subnets 테이블 기반 동적 서브넷 목록 + available LIMIT 512 +
  직접입력 병행(하이브리드). BUG-7 동종 재발 5곳 전수 전환 + 렌더 JS 문법 검증 규약(2bbdaa6).

## B-6d 2.0.1 재빌드·패키징 (2026-07-11, 커밋 완료)

FIX 3건 + B-6e 반영 이미지 재빌드 및 배포 패키지 확정.
- 버전 표기(dc080ac): package.json/lock 2.0.1 + DEPLOY.md·compose 태그/tar명 정합.
- 빌드 환경 전환: 사무 PC(윈도우 x86 네이티브)에서 빌드 — 사무망이 deb.debian.org 도메인
  차단이라 Dockerfile에 **ARG APT_MIRROR** 추가(미지정=원본 소스 회귀0, 지정 시 미러 교체+
  security 스킵). kakao 미러 경유 빌드. 서버도 deb.debian.org egress 차단이라 기본 경로
  실빌드는 불가 — 미러 ARG 경로로만 재현 확인(DEPLOY.md 빌드섹션에 기록).
- 정품 검증(격리 스택 it-assets-dist, down -v): amd64/비루트/ipmitool 1.8.19/version 2.0.1/
  HEALTHCHECK healthy/254MB, **initdb 22테이블(subnets 포함)** = 신규 설치 SQL에 B-6e 반영.
- 클린 스모크: admin 시드=INITIAL_ADMIN_PASSWORD(하드코딩 fallback 없음, 미설정 시 기동 중단
  재확정) + B-6e 신기능(빈상태→서브넷등록→풀256→가용IP모달→assigned전환→풀밖경고→삭제차단)
  + FIX 렌더(이력 한글/버튼 기호) + 렌더 JS 문법 파싱 통과 + 영속성 2방식(stop→start, down→up).
- 최종 패키징: /tmp/it-assets-dist-2.0.1.tar.gz (193MB) — 이미지 tar 2종(무압축 .tar) +
  DEPLOY.md + docker-compose.prod.yml + .env.example + db/ + scripts/(backup·restore).
  DEPLOY.md tar명 실물(.tar) 정합 + docker load -i는 tar/tar.gz 겸용 안내.
- **다음: B-6c 윈도우 실검증을 2.0.1 배포물로 재수행 → 3단계 전환(READ_ONLY 미들웨어) → B-7 cutover.**

## ★ B-6 배포 검증 전체 완료 (2026-07-11)

배포 패키지 확정 + 윈도우 클린 설치 실검증까지 완결. v1 무중단 운영·무접촉 유지.

**단계별 완료 (커밋 해시):**

| 하위 | 내용 | 커밋 |
|------|------|------|
| 6a | Apple Silicon → `buildx --platform linux/amd64` 크로스 빌드, 정품 이미지 tar | (5b 연장) |
| 6b | 정품 tar x86 서버 검증 + DEPLOY.md 문서결함 2건 수정 | 8d4d606 |
| 6c | 윈도우 클린 설치 실검증 → 문서결함 5건(DOC-1~5) + FIX 3건 + 백로그 | 8d4d606, 0823b8d, 2f65f92, a31bab1, 3e90846 |
| 6e | 서브넷 CRUD + 풀 자동생성(INV-1 해소) + CIDR /16~/30 | ebcad87, c3b3428, 424b311, cc1b645, 2bbdaa6 |
| 6d | 2.0.1 버전표기 + ARG APT_MIRROR + 재빌드·패키징 | dc080ac, 35b40e3, 6ec2121 |
| BUG-8 | 랙 미리보기 선택 백화 — 클래스+CSS 전환 + tui-theme 다크 오버라이드 | f12ebf3 |

**윈도우 최종 스모크 (2.0.1 배포물, 서병준):**
- 전 항목 통과. 소요 ~5분(Docker Desktop·git 설치 전제).
- BUG-8 반영 확인: 재빌드 이미지 컨테이너 내 `tui-theme.css`에 `inv-rack-empty` 다크
  오버라이드 존재(grep 3), 빈 칸 초기 렌더 다크·선택색(장비 파랑/선반 노랑) 정상.
- 격리 스모크(기동→로그인 302→사용등록 폼 200→렌더 JS 파싱 3블록)까지 통과.

**전달물 최종 스펙:**

| 항목 | 값 |
|------|-----|
| 배포 묶음 | `it-assets-dist-2.0.1.tar.gz` (193MB) |
| 앱 이미지 | `it-assets:2.0.1` — 83MB(무압축 tar) / 254MB(로드 후), **amd64**, node 비루트(uid 1000), ipmitool 1.8.19 포함, HEALTHCHECK healthy |
| DB 이미지 | `postgres:16-alpine` (오프라인 전달분 포함) |
| 구성 | 14파일 — 이미지 tar 2 + DEPLOY.md + docker-compose.prod.yml + .env.example + db/(6 SQL) + scripts/(backup.sh·restore.sh) |
| initdb | **22테이블**(subnets 포함) = 신규 설치 SQL에 B-6e 반영 |
| 설치 전제 | Docker Desktop + git, `.env`에 INITIAL_ADMIN_PASSWORD 필수(미설정 시 기동 중단, 하드코딩 fallback 없음) |

**다음 단계 (순서):**
1. ~~READ_ONLY 미들웨어~~ → **B-7b로 완료** (fda8230)
2. ~~B-7 cutover~~ → **2026-07-11 완료** ("★ B-7 전체 완결" 섹션)
3. **8월 타 팀 배포** — 클린 설치 패키지 배부.
4. **v2.1** — BL-1~8 우선순위 정렬부터(현 유력 최상위: BL-1 선반 1/3U, 정확성 이슈).

## ★ B-7 전체 완결 — v1→v2 컷오버 (2026-07-11)

**v2(3001)가 단일 운영본이 됐다. v1(3000)은 READ_ONLY 조회 전용 존치.**

**하위 단계:**

| 하위 | 내용 | 커밋/산출물 |
|------|------|------|
| B-7a | 델타 규모 조사 + v1 보존 스냅샷 | 3afcccf |
| B-7b | v1 READ_ONLY 미들웨어(환경변수 없으면 no-op, /login만 쓰기 허용) | fda8230 |
| B-7c' | 스크래치 DB(5434) 전량 재이관 드라이런 — 드리프트 0, 54/54 PASS | ab73578 (b7-remigrate/ 4종) |
| B-7f | 운영 컷오버 본실행(게이트 방식 10단계) — 검증 54/54 PASS | v2/backups/b7f_* |
| 마무리 | v2 상시 구동 systemd 정식화(it-assets-v2.service) | v2/deploy/ 사본 |

**빅뱅 재이관 채택 근거(B-7a):** 델타 세밀 재이전은 audit_logs id 충돌 48건 + 자식테이블
타임스탬프 부재로 식별 불가 → 운영 v2 데이터 폐기 후 v1 전량 재이관으로 확정.

**핵심 수치:**
- 최종 동결 스냅샷: audit_logs **1429**(+1은 READ_ONLY 배너 확인 로그인 — 허용 예외, 승인 확정),
  assets 174, racks 23(v1 실삭제 4건 반영), ip_addresses 2304, asset_credentials 223.
- EUL: v1 792행 → **1055 이벤트**(incoming 233 / in_use 559 / returned 263, asset_id NULL 218).
- 검증 54/54 PASS(행수 20·EUL 3·FK 7·시퀀스 21·racks·표본 diff 2) — verify.js가 스냅샷에서
  기대치 재산출(하드코딩 아님).
- 실측 소요: DB 이관 자체 ~3초. v1 쓰기 동결(21:56) → v2 전환 검증 완료(22:14) **총 18분**.

**산출물 (v2/backups/, gitignore 대상 — 파일 실물 보존):**
b7f_v2_full_20260711_2151.sql(구 v2 전체 덤프 = 롤백 수단, 구 audit 1526 포함) /
v1_snapshot_b7f.sqlite(동결 스냅샷 = 이관 소스) / b7f_cutover_migrate.log /
b7f_subnets_backup.sql / B7F_CUTOVER_REPORT.md

**현 상태 선언:**
- v2: 3001, **systemd `it-assets-v2`**(enabled, Restart=on-failure, dotenv가 v2/.env 로드),
  DB=it-assets-db 컨테이너(5433).
- v1: 3000, systemd `it-assets` + READ_ONLY=1 override 존치(조회·로그인만) — **해제 금지**.
  v1 audit_logs는 로그인 기록으로만 +1씩 증가 가능(무해, 이관 기준은 동결 스냅샷).
- 알려진 관찰(BL-8 등록): 이관 audit_logs(id≤1476) 표시 시각이 v1의 UTC 저장 특성 그대로
  (신규 v2 기록은 KST 정상) — v1 대비 회귀 아님.

**다음 단계:** 8월 타 팀 배포 → v2.1 백로그(BL-1~8) 우선순위 정렬.
(→ 두 갈래 모두 진행됨: 아래 "★ 2.0.1 배포 준비 종결" · "★ v2.1 우선순위 확정" 섹션)

## ★ 2.0.1 배포 준비 종결 — 3관문 + D 문서 마무리 (2026-07-11 밤 ~ 07-12)

**패키지 확정: `v2/backups/it-assets-dist-2.0.1.tar.gz`**
(sha256 `f06bf0e5…3383c70` — 동봉 `.sha256` 파일 존재, 기준 커밋 f12ebf3, **git tag `v2.0.1`**)

**3관문 전부 통과 → "2.0.1 그대로 배포" 확정:**

| 관문 | 내용 | 판정 |
|------|------|------|
| A-1 | 패키지 stale 여부 — 기준 커밋 이후 변경 전수 분류(P1~P4) | ① 그대로 배포 가능(코드/배포구성 변경 0) |
| C-6 | 이미지 레이어 전개 잔존 데이터 스캔(C1~C7: 자격증명/내부IP/시크릿/데이터/테스트/운영물/SSH·BMC) | 전 항목 PASS. 관찰 2: SESSION_SECRET fallback(→BL-9로 해소됨), APT_MIRROR 공개 미러 흔적(무해) |
| B-4 | 리눅스 격리 클린 설치(-p b4test, 문서만 보고 walkthrough) | ① 문서만으로 설치 가능. 신규 결함 DOC-7(compose 주석)·DOC-8(cron 경로) 경미 — 공지문 정오표로 보완 |

**D 문서 마무리 (커밋 95304cf / 8798a01 / 9eec9ec):**
- `v2/RELEASE_NOTICE_2.0.1.md` 신설 — 공지문(sha256·보안 필수 조치·정오표·업그레이드 예고).
  ※ §8 문의 채널은 **아직 플레이스홀더** — 배부 전 확정 필요(대기 항목).
- DEPLOY.md: DOC-7/8 수정 + §6 업그레이드 절차 보강(sha256 대조·백업 선행·APP_IMAGE·마이그레이션 동봉 원칙).
  §1 SESSION_SECRET은 "보안 필수(기동 미차단)"로 분리 정정했다가 → **BL-9 구현 후 "필수 키(기동 차단)"로 복귀**(0891c9c).
- CHANGE_ME 5종 판별: 기동 필수 2(POSTGRES_PASSWORD·INITIAL_ADMIN_PASSWORD) /
  보안 필수 1(SESSION_SECRET — BL-9 이후 기동 필수화) / 기능·표기 2(SSH_DEFAULT_PASSWORD·LENDING_ORG_LABEL, 후자 미설정 시 기본 'TTA' 표기).
- OPS-1(docker libnetwork)은 TTA 서버 고유 문제로 판정 — 공지문 미기재(패키지 compose는 전용 네트워크 생성이라 노출면 다름).

**조사 리포트 소재**: `/tmp/A1·C6·B4·D_report_202607*.md` + BL 시리즈 8건(`/tmp/BL*_2026071*.md`) —
**전부 /tmp에만 존재(재부팅 시 소실)**, v2/backups 미이동 상태. 보존 필요 시 이동은 대기 항목.

## ★ v2.1 우선순위 확정 + 2.0.2 후보 묶음 완료 (2026-07-12)

**우선순위**: V2.1_BACKLOG.md 상단 "우선순위 (2026-07-12 확정)" 표가 기준.
1~4(BL-9/1/8/3) = **2.0.2 릴리스 후보 묶음 — 전부 완료**. BL-11(자격증명 암호화, 원격 스위트에서 분리)·BL-12(재고 점검) 신설(4bf0853).

**완료·운영 반영 5건:**

| 항목 | 내용 | 커밋 |
|------|------|------|
| BL-10 | 통합검색 관리번호(management_number) 매칭 + subtitle 표기 + placeholder | 49f2608 |
| BL-9 | SESSION_SECRET 4조건 기동 검사(미설정/CHANGE_ME/구 fallback/32자 미만) + fallback 리터럴 제거 + compose `:?` | 702ef5d, 0891c9c |
| BL-1 | 선반 1/3U 입력 — 영향 조사 판정 A(저장/검증/렌더/파서 홀 단위 기지원) → 폼 2곳 U+홀 병행 + `normalizeUnitSize`(`\|\| 3` 함정 제거). **스키마 무변경** | 71ff446, f392404 |
| BL-8 | audit_logs 이관분(id≤1476) **1429행 +9h 보정**(2중 백업, 앵커 id 1476=21:57 KST, 경계 단조성 회복). 코드 무수정 — 데이터만 | 8211013(docs) |
| BL-3 | 실 이름 정규화(trim+lower) 중복 방지 — 4경로 앱 검사 + 함수 유니크 인덱스. **v2/db/migrations/ 관례 신설**(첫 파일), 운영 DB 인덱스 적용 완료. 재설계(마스터 선택·유형 분리·INV-2)는 잔여 존치 | a590085, dc49744 |

**BL-9 운영 반영 사건 (교훈 — 재발 방지):**
- 반영 중 운영 v2/.env의 SESSION_SECRET이 **6자**임이 발견돼 회전(현재 64자, 검사 통과 확인).
- 반영 과정 사고: 대화형 bash에서 확인 원라이너의 **큰따옴표 안 `!`가 히스토리 확장으로 실패**
  → 값 미확인 상태로 재시작 → 기동 실패 루프 → sed로 .env 교체 후 복구.
  **교훈: 대화형 bash에서 큰따옴표 내 `!` 금지, .env 조작은 sed/awk로.** (세션 전체 무효화 = 시크릿 회전의 정상 부수효과)

**이번에 확립된 패턴 (다음 세션도 준용):**
- **Phase 1 조사 → ★게이트(사용자 승인) → Phase 2 실행** 2단계 구성(BL-8·BL-3에서 확립) — 운영 데이터 보정/DDL은 반드시 게이트.
- **일회용 격리 검증 스택**: `blNtest-db`(postgres:16-alpine, :15433, --rm·볼륨 미지정) + 임시 앱(:13001, `timeout` 한정, APP_PORT/PGPORT env 주입) + **전용 docker 네트워크(OPS-1 기본 bridge 손상 우회)**. 종료 시 잔재 0 확인.
- 운영 반영(재시작·DDL 적용 포함)은 **항상 사용자 수동** — 에이전트는 수정·격리 검증·완성형 명령 제시까지.

## ★ 대기/예약 항목 (2026-07-12 기준)

| 항목 | 내용 | 시점/조건 |
|------|------|-----------|
| OPS-1 점검 창 | docker 데몬 재시작으로 libnetwork 스토어 정리 — BL-1 격리 검증 중 재현 재확인됨. v2 정지 공지 창 필요 | 이번 주 목표 |
| 독립개발실3 이중 등재 | office(id 61)·server_room(id 67) 양존 — 같은 물리 공간인지 실물 확인. 병합 시 랙 4·자산 20건 재배정 | 사용자 확인 |
| audit_logs_bl8_backup | BL-8 보정 원본 백업 테이블(1429행) DROP 결정 (+ pg_dump 사본은 v2/backups/에 보존) | 7/19 이후 |
| 선반 18건 실사 보정 | BL-1 반영 후 기존 shelf_size=3 자산 18건을 실사에 맞춰 화면 개별 수정 | 실사 시 |
| 2.0.2 패키징 | ㉯ 1주 숙성 후 방침. **migrations/ dist 포함 첫 사례** — 릴리스 노트에 적용 순서 명기, 이후 A-1/C-6/B-4 축약 재검증 | ~7/19 이후 |
| 공지문 문의 채널 | RELEASE_NOTICE_2.0.1.md §8 플레이스홀더 확정 | 8월 배부 전 |
| /tmp 리포트 12건 | 조사/구현 리포트가 /tmp에만 존재 — 보존 원하면 v2/backups/ 이동 | 재부팅 전 |
| inventory_count_*.js | repo 루트 scripts/ 미추적 2건 — 커밋/폐기는 BL-12(재고 점검) 설계 시 통합 판단 | BL-12 착수 시 |

## B-4d 단계 전체 완결 (2026-07-09)

| 조각 | 내용 | 커밋 |
|------|------|------|
| B-4d-1 | asset 모델 14메서드 + 날짜밀림 스윕(dateFix.js) | 979d1f0 |
| B-4d-2 / 2.5 | assets 12EP / EUL append-only 트리거 제거 | 73fcc83 / 89af313 |
| B-4d-3 / 3b | racks 10EP / power-control 스텁화(BUG-2 트랙) | 3b23c72 / 9c09210 |
| B-4d-4 | 모듈 4모델 26메서드 | (가이드 기재) |
| B-4d-5 | moduleInventory 16EP + BUG-1 수정 | f3a1a0c / 44581ef |
| B-4d-6 | inventory 18EP + EUL 이벤트소싱(설계~6d 화면검증) | fd1ec69~946bfea |
| B-4d-7 | discovery 14EP + §5 + BUG-6 + 입회 실스캔 | a3de1bc |
| B-4d-8 | fault류 4EP(assets 2 + lendings 2) | 2167ac5 |
| B-4d-9 | 기술부채 일괄(§5 주석 종결·날짜 스윕·BUG-3) | 2167ac5 |
| B-4d-10 | 대시보드 §5 + prefill 전환 — §5 잔여 0 | 2167ac5 |
| (docs) | B-4d-7~10 완결 기록 + BUG 클로징 | cdfa308 |

- 남은 스텁: racks power-control(BUG-2 신기능 트랙 확정) · inventory #18 migrate-psu(설계 확정)뿐.
- **다음 단계: B-5 이후** — MIGRATION_PLAN 로드맵 확인 후 별도 세션에서 설계
  (B-7 cutover 준비물: 로그 델타 재이전 §7 표 + EUL 델타(신규 12행+전이 6건) 방침 포함).

**B-4d 하위단계 분해 (확정 순서):**
- B-4d-1(완료) → B-4d-2/3(assets/racks, 완료) → B-4d-4(모듈모델, 완료) →
  B-4d-5/6(moduleInventory/inventory+EUL+화면검증, 완료) →
  **다음: B-4d-7(discovery + §5 + BUG-6, 최고위험)** →
  B-4d-8(fault-return 스텁 해제) → B-4d-9(기술부채 정리)

**B-4d 후반 블로커/확인지점:**
- ~~EUL 이벤트소싱 매핑 (B-4d-5/6 선행 필수)~~ → **해소**: B-4d-6 설계·구현·실증 완료
  (B4D6_EUL_DESIGN.md + 위 6a~6c 기록 참조).
- audit 스키마 v1(before/after 2컬럼) ≠ v2(details 단일 JSONB) — 개수검증만 함, 내용 동등성 미검증.
- ~~삭제 후 이력조회~~ → **해소**(6d 검증): getHistory가 management_number 텍스트 기반이라
  asset_id=NULL 무관 — assets에 없는 '매니-001' 이력이 v1과 동일 조회됨(입고 2건).
- BUG-5: assets 저장(blade_slot 클리어) ↔ racks 렌더(shelfU) 불일치 → B-4d-3(racks) 이식 후 합동수정.

**포팅 방법론 (B-4d 관통 원칙):**
- 포팅 결함(v1엔 없던 v2 회귀, 예: 날짜밀림·삭제회귀) = 즉시 수정, 충실이식에 포함.
- 기존 버그(BUG-1~6) = (a)충실이식→v1==v2 동등성 확인→커밋, (b)버그수정→별도 커밋.
  단 BUG-6은 §5와 한 몸이라 B-4d-7 통합.

### 날짜 헬퍼 중복 (B-4d-9 정리)
- moduleInventoryLog.js가 자체 fixTimestamps 함수 정의 — 공용 utils/dateFix.js의 fixRowDates와 중복.
  B-4d-9에서 fixRowDates(row, [], ['created_at'])로 공용화. 기능은 정상, 코드 정리만.
  (6d에서 formatTimestamp 공용화로 일부 해소 — 잔여 래퍼만 정리 대상)

### Date 무처리 직렬화 잔여분 (발견 시 fixRowDates 일괄 적용)
- moduleInventory.findByCode의 updated_at UTC ISO 노출을 7b 대조에서 발견 → 7c에서 적용.
- 다른 모델의 JSON 반환 경로에도 동일 잔여분 있을 수 있음 — v1↔v2 대조에서 발견되는 대로
  fixRowDates(공용 dateFix.js) 일괄 적용. 스윕은 B-4d-9 후보.

### legacy /apply 기본비번 assets 저장 (v1 충실이식)
- discovery legacy POST /apply는 신규 자산 생성 시 ssh_password에 기본비번 저장(v1 L1029).
- v2는 값 출처만 env(SSH_DEFAULT_PASSWORD) 경유로 변경, 저장 동작 자체는 v1 충실이식.
  평문 저장 개선은 보안 트랙(아래 #11 평문 반환 건과 동일 계열).

## 고도화 백로그 (마이그레이션 후 신기능 트랙)

- 부품 모델명 정규화/별칭 매칭: 스캔 출력 원문↔item_code 매핑 저장, 관리자 선택 결과 학습.
  7e 실증: spec 없는 PSU가 퍼지매칭으로 PSU-2550W-A에 오링크(임의 PSU 재고 링크) —
  별칭 매칭 도입 시 우선 해소 대상.
- 시리얼 기반 유닛 추적: 디스크/GPU 우선, 소유 혼재 해소, 재고 모델 개편 수반.
- 부품 대여/차용 원장(part_loans): 소유×위치 이중 축 최소 구현.
- module_inventory 소유 축 추가: 부품코드×소유자 단위.
  실증 사례(8a): fault-return keep업체가 tmp 코드를 owner=company로 upsert —
  업체품 자사 혼입 경로, 마이너스 재고 발생 경로 후보.
- 마이너스 재고 실사: net-100-A(-2)/net-200-A(-1) — 실물 확인 후 원장 소급 기록.
  실행 도구 초안 존재(scripts/inventory_count_*.js, 2026-05-22 세션 산출물, 미커밋·미실행 확인,
  실사 계획 확정 시 v2 pg 버전 개작 후 커밋이 정석 경로).
- (v2.1) AI채팅 복원: v1 정찰 필요 — Ollama 모델/데이터 접근 범위 확인 후 이식 판단. 헤더 메뉴는 주석 보존(B-T2).
- (v2.1) 백업 UI 복원: v1 방식 이식이 아닌 scripts/backup.sh 호출형으로 재설계. 헤더 메뉴는 주석 보존(B-T2).

## 부품코드 발급 원칙

1. 코드는 스펙 요약이 아닌 식별자 — 스펙은 속성 열에, 코드에 스펙 추가 금지.
2. 신규 알파벳 발급 기준은 교환 가능성 — 파트넘버가 다르면 기본 분리, 교환 가능 확인 시에만 병합(괄호 리비전).
3. 애매하면 분리(분리→병합은 쉽고 병합→분리는 이력이 섞임).
4. 스펙 불명확 부품도 미상 상태로 코드 발급, 단 스캔 출력 원문 문자열을 속성에 보관.

## 8. 작업 원칙 (유지)

- 한 단계씩 잘게, 사용자 직접 검증 후 다음
- v1 app/ 절대 미수정, v1 SQLite readonly만, v1 운영 무중단
- 의문 생기면 직접 스키마/데이터 확인 후 진행
- 비즈니스 결정은 사용자, 안전절차/접근방식은 권고 수용
- ★ **뷰(.ejs) 내 인라인 `<script>` 수정 시 렌더 JS 문법 검증 필수** (B-6e Part4 교훈):
  `curl 200`은 서버측 렌더만 확인하고 **클라이언트 JS 문법 오류는 못 잡는다**
  (따옴표 짝 깨짐 → 브라우저 Uncaught SyntaxError → 전 함수 미정의로 폼 전면 사망).
  표준 절차: 렌더된 페이지에서 `<script>`(src 없는 인라인) 블록 추출 → 각 블록을
  `new Function(body)`(또는 node --check)로 파싱해 문법 통과 확인. perl/sed로 EJS 내
  JS 문자열 치환 시 백슬래시 이스케이프(`\'`) 소실에 특히 주의.

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
