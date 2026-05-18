단계 1: 현재 시스템 파악
여기서 ARCHITECTURE.md를 만듭니다. 한 번에 다 묻지 말고 나눠서 물어보세요.
1-1. 전체 구조 파악
이 프로젝트의 전체 구조를 분석해줘. 
- package.json에서 사용 중인 주요 라이브러리
- 디렉토리 구조와 각 폴더의 역할
- 진입점(entry point)과 서버 실행 방식
- 사용 중인 포트
이걸 정리해서 보여줘.
1-2. DB 현황 파악 (가장 중요)
프로젝트 전체에서 SQLite와 관련된 모든 것을 찾아줘.
1) sqlite3, better-sqlite3 등 DB 라이브러리를 import/require하는 모든 파일
2) DB 파일을 여는 코드와 그 경로 (상대경로/절대경로 구분해서)
3) 실제 디스크에 존재하는 .db, .sqlite 파일들의 위치와 크기, 최근 수정 시각
4) 각 DB 파일의 테이블 스키마 (CREATE TABLE 문)
표 형태로 정리해줘.
이 결과를 보면 "아 DB가 여기저기 흩어져 있었구나"가 명확히 보일 거예요. 여기서 한번 멈추고 결과를 확인하세요. 예상과 다르면 다음 단계로 못 갑니다.
1-3. API와 DB 매핑
모든 API 라우트(엔드포인트)를 나열하고, 각 라우트가 어떤 DB의 
어떤 테이블에 대해 어떤 작업(SELECT/INSERT/UPDATE/DELETE)을 하는지 
표로 정리해줘.
1-4. 문서화
지금까지 파악한 내용을 프로젝트 루트의 ARCHITECTURE.md 파일로 정리해줘.
디렉토리 구조, DB 스키마, API-DB 매핑표, 발견된 문제점(DB 분산 등)을 포함해서.
단계 2: 마이그레이션 계획 수립
바로 코드 바꾸지 마시고, 계획부터 받으세요.
ARCHITECTURE.md를 바탕으로 SQLite를 PostgreSQL로 마이그레이션하는 
계획을 세워줘. 코드는 아직 바꾸지 말고 계획만 마크다운으로 작성해줘.
포함할 내용:
1) SQLite와 PostgreSQL 간 스키마 차이점 (데이터 타입, 자동증가 등)
2) 어떤 라이브러리를 쓸지 (pg, prisma, knex 중 추천과 이유)
3) 마이그레이션 단계별 작업 순서
4) 기존 SQLite 시스템은 그대로 두고 신규 환경을 구축하는 방법
5) 데이터 이전 스크립트 설계
6) 롤백 계획 (문제 생기면 되돌리는 방법)
이걸 MIGRATION_PLAN.md로 저장해줘.
이 계획서를 받아서 본인이 한번 읽어보세요. 이상한 부분이 있으면 질문하고 수정 요청하세요. 여기서 시간을 쓰는 게 나중에 헛수고를 줄입니다.
단계 3: 신규 환경 구축 (기존 건드리지 않기)
기존 코드는 절대 건드리지 말고, 프로젝트 루트에 v2/ 폴더를 만들어서 
PostgreSQL 기반 신규 환경을 구축해줘. 
1) docker-compose.yml에 app 서비스와 postgres 서비스 정의
2) PostgreSQL 스키마 SQL 파일 작성
3) .env.example 파일에 필요한 환경변수 정의
4) README.md에 실행 방법 작성
아직 데이터 이전은 하지 말고 빈 DB 상태로 띄울 수 있게만 해줘.
여기서 일단 docker compose up 해서 신규 환경이 잘 뜨는지 확인하세요. 데이터 없이도 띄워지는지 먼저 검증합니다.
단계 4: 코드 포팅
v2/ 폴더에서 기존 코드를 PostgreSQL 기반으로 포팅해줘.
- 기존 SQLite 쿼리를 PostgreSQL 호환으로 변환
- DB 연결 코드를 단일 모듈로 통합 (이전처럼 분산되지 않게)
- 기존 API 엔드포인트와 동일한 동작 보장
한 라우트씩 작업하면서 진행 상황을 알려줘.
전체를 한 번에 시키지 말고, 라우트 단위로 나눠서 작업시키는 게 안전해요.
단계 5: 데이터 이전 스크립트
기존 SQLite DB들의 데이터를 PostgreSQL로 옮기는 일회성 마이그레이션 
스크립트를 v2/scripts/migrate-data.js로 만들어줘.
- 기존 SQLite는 읽기 전용으로만 열기
- 여러 SQLite 파일에 흩어진 데이터를 통합해서 옮기기
- 중복 데이터 처리 방침 명시
- 이전 후 건수 비교 검증 로직 포함
- 실패 시 PostgreSQL을 초기 상태로 되돌리는 옵션
단계 6: 검증
신규 v2 환경과 기존 환경의 데이터가 일치하는지 검증하는 
스크립트를 만들어줘. 주요 테이블별 행 개수, 핵심 필드 합계 등을 비교해줘.
단계 7: 배포 패키징
검증까지 끝나면 마지막 단계.
v2/ 환경을 윈도우 사용자도 쉽게 설치할 수 있게 패키징해줘.
1) README.md에 Docker Desktop 설치부터 시작하는 단계별 가이드 작성
2) .env.example을 .env로 복사하는 안내
3) docker compose up -d로 실행
4) 초기 관리자 계정 생성 방법
5) 백업/복원 방법
가능하면 스크린샷이 들어갈 자리를 [스크린샷: ~~~] 형태로 표시해줘.

핵심 원칙 정리
작업하시면서 꼭 지키시면 좋을 원칙들입니다.
한 번에 한 단계씩만. Claude Code에게 "전부 마이그레이션해줘"라고 하면 망가집니다. 단계별로 결과 확인하고 다음으로 넘어가세요.
기존 시스템은 끝까지 안 건드림. v2/ 폴더에서만 작업하고, 기존은 운영 그대로 두세요. 신규가 완전히 검증되기 전까지는요.
각 단계 끝에 git commit. "1단계 완료" "2단계 완료" 식으로 커밋해두면 문제 생겼을 때 되돌리기 쉬워요.
Claude Code가 헷갈려 하면 ARCHITECTURE.md 다시 읽으라고 시키기. 대화가 길어지면 컨텍스트를 놓치는데, "ARCHITECTURE.md와 MIGRATION_PLAN.md를 다시 읽고 작업해줘"라고 하면 다시 정렬됩니다.

---

## 1-1. 프로젝트 구조 (조사 결과)

### 주요 라이브러리 (package.json)

| 패키지 | 버전 | 역할 |
|--------|------|------|
| `better-sqlite3` | ^9.6.0 | SQLite DB 드라이버 (동기 API) |
| `express` | ^4.21.0 | 웹 프레임워크 |
| `ejs` | ^3.1.10 | 서버사이드 템플릿 엔진 |
| `express-session` | ^1.18.0 | 세션 관리 (메모리 스토어) |
| `express-flash` | ^0.0.2 | Flash 메시지 |
| `cookie-parser` | ^1.4.6 | 쿠키 파싱 |
| `morgan` | ^1.10.0 | HTTP 요청 로깅 |
| `multer` | ^2.0.2 | 파일 업로드 (multipart) |
| `ssh2` | ^1.15.0 | SSH 원격 접속 (하드웨어 디스커버리) |
| `xlsx` | ^0.18.5 | 엑셀 파일 읽기/쓰기 |
| `nodemon` | ^3.1.0 | (dev) 파일 변경 시 자동 재시작 |

### 디렉토리 구조

```
hpc_it_management/
├── app/                        ← 애플리케이션 루트
│   ├── server.js               ← 진입점 (Express 앱 설정 + 서버 시작)
│   ├── package.json
│   ├── config/
│   │   ├── app.js              ← 앱 설정값 (포트, 자산유형, 서브넷 등)
│   │   └── database.js         ← DB 연결 + 스키마 초기화 + 마이그레이션
│   ├── db/
│   │   └── schema.sql          ← 초기 DDL (CREATE TABLE IF NOT EXISTS)
│   ├── data/
│   │   ├── it_assets.db        ← ★ 운영 DB (유일하게 데이터 있음)
│   │   ├── backups/            ← 자동 백업 저장 위치
│   │   ├── hpc_assets.db       ← 빈 파일 (미사용)
│   │   ├── database.sqlite     ← 빈 파일 (미사용)
│   │   └── db.sqlite3          ← 빈 파일 (미사용)
│   ├── models/                 ← 20개 모델 (DB CRUD 캡슐화)
│   ├── routes/                 ← 23개 라우트 파일
│   ├── views/                  ← EJS 템플릿 (21개 폴더/파일)
│   ├── middleware/
│   │   ├── auth.js             ← 인증/권한 미들웨어
│   │   ├── errorHandler.js     ← 404/500 핸들러
│   │   └── upload.js           ← multer 설정
│   ├── services/
│   │   ├── sshDiscovery.js     ← SSH 접속 후 하드웨어 정보 수집
│   │   ├── hardwareParser.js   ← SSH 출력 파싱
│   │   ├── gpuMonitor.js       ← GPU 모니터링
│   │   └── specLookup.js       ← 부품 스펙 조회
│   ├── scripts/                ← 유틸리티 스크립트
│   └── public/
│       ├── css/
│       ├── js/
│       └── uploads/photos/     ← 업로드된 사진 저장
├── backup/                     ← 수동 DB 백업 (2026-05-17)
└── ARCHITECTURE.md             ← 이 문서
```

### 진입점과 서버 실행 방식

- **진입점**: `app/server.js`
- **실행 명령**: `node server.js` (또는 `nodemon server.js`)
- **프로세스**: **단일 프로세스** — 1개의 Node.js 프로세스가 모든 요청 처리
- **현재 실행 중**: PID 1990801, 5월 15일부터 가동 중

### 포트

- **HTTP**: `3000` (기본값, `process.env.PORT || 3000`)
- **바인딩**: `0.0.0.0` (모든 네트워크 인터페이스)

### 아키텍처 특성

| 항목 | 현재 상태 |
|------|----------|
| 프로세스 수 | 단일 (1개) |
| 세션 저장소 | 메모리 (express-session 기본값) |
| DB 연결 방식 | 싱글턴 — `getDb()`로 한 번 열고 전역 재사용 |
| 인증 | 세션 기반 (쿠키, 24시간 만료) |
| 파일 업로드 | 로컬 디스크 (`public/uploads/photos/`) |
| 자동 백업 | 7일마다 `db.backup()` → `data/backups/` |
| 시작 시 마이그레이션 | `database.js`의 `runMigrations()`에서 스키마 변경 자동 적용 |

### 발견 사항 (1-2 선행 확인용)

- DB 연결은 `config/database.js` → `getDb()` 한 곳에서만 생성
- 모든 모델/라우트는 `const db = getDb()`로 동일 인스턴스 사용
- **빈 DB 파일들은 코드에서 열지 않음** — 과거 개발 과정에서 생성되었다가 방치된 잔재
- DB 분산 문제는 없음: **단일 DB 파일(`it_assets.db`) + 단일 연결 인스턴스** 구조

---

## 1-2. DB 현황 및 증상 원인 조사 (조사 결과)

### DB 기본 현황

**DB 파일**: `app/data/it_assets.db` (1.9 MB)
**저널 모드**: WAL (Write-Ahead Logging)
**테이블 수**: 22개 (sqlite_sequence 포함)

### 테이블 목록 및 행 개수

| 테이블 | 행 수 | 역할 |
|--------|-------|------|
| `assets` | 168 | 자산 마스터 |
| `asset_ips` | 206 | 자산별 IP 주소 |
| `asset_credentials` | 198 | 자산별 접속 계정 |
| `computing_modules` | 553 | 자산에 설치된 컴퓨팅 모듈 |
| `module_inventory` | 188 | 부품 재고 현황 (부품현황) |
| `module_inventory_logs` | 273 | 부품 변경 이력 |
| `module_transfer_logs` | 296 | 모듈 이동 이력 |
| `equipment_usage_logs` | 727 | 입출고/사용 이력 (레거시) |
| `inventory_logs` | 0 | 입출고 이력 (미사용) |
| `audit_logs` | 1,253 | 감사 로그 |
| `users` | 13 | 사용자 계정 |
| `server_rooms` | 9 | 서버실/사무실/장비실 |
| `racks` | 27 | 랙 |
| `vendor_info` | 13 | 업체 정보 |
| `vendor_intake_requests` | 1 | 업체 입고 요청 |
| `ip_addresses` | 2,304 | IP 주소 관리 (별도 관리) |
| `network_connections` | 0 | 네트워크 연결 |
| `power_nodes` | 0 | 전원 배선 |
| `photos` | 34 | 사진 첨부 |
| `lendings` | 1 | 대여 |
| `lending_items` | 1 | 대여 항목 |

### 주요 외래키 관계

```
server_rooms ─┬─ racks ──── assets ─┬─ asset_ips
              │                     ├─ asset_credentials
              │                     ├─ computing_modules
              │                     ├─ photos (entity_type='asset')
              │                     └─ assets (parent_asset_id, 블레이드)
              ├─ power_nodes
              └─ network_connections

vendor_info ──┬─ assets (vendor_id)
              └─ computing_modules (owner_vendor_id)

module_inventory ── module_inventory_logs (item_code)
                 ── module_transfer_logs

equipment_usage_logs (management_number로 assets와 연결, FK 없음)
```

### 인덱스 현황

총 42개 인덱스. 주요 테이블 모두 적절한 인덱스 보유.
특이사항: `equipment_usage_logs`와 `assets` 사이에 **외래키 없이 `management_number` 문자열로만 연결**.

---

### 증상 원인 후보 조사

#### ✅ 배제된 후보

| 후보 | 결과 | 상세 |
|------|------|------|
| DB 분산 | **해당 없음** | 단일 DB 파일, 단일 연결 |
| 메모리 캐싱 | **해당 없음** | 20개 모델 파일 전수 검사 — 모듈 레벨 데이터 캐싱 없음 |
| HTTP 캐싱 | **해당 없음** | `Cache-Control` 설정 없음 (SSE 제외), 서비스워커 없음 |
| 브라우저 캐싱 | **해당 없음** | `express.static()` 기본 옵션, 동적 응답에 캐시 헤더 없음 |
| 미들웨어 선행 조회 | **해당 없음** | 라우트 핸들러 내에서만 DB 조회, 미들웨어는 인증만 |

#### 🔴 발견된 근본 원인: 이중 데이터 소스 (Dual Source of Truth)

**핵심 문제: `assets` + `computing_modules` vs `equipment_usage_logs`**

이 시스템에는 같은 정보를 **두 곳에** 저장하는 구조적 문제가 있음:

| 정보 | 정규 저장소 (쓰기) | 레거시 저장소 (읽기) |
|------|-------------------|---------------------|
| 자산 위치/상태 | `assets` 테이블 | `equipment_usage_logs` 테이블 |
| IP 주소 | `asset_ips` 테이블 | `equipment_usage_logs.ip1~ip4,bmc,ib1~ib2` |
| 계정 정보 | `asset_credentials` | `equipment_usage_logs.credential_*` |
| 하드웨어 구성 | `computing_modules` | `equipment_usage_logs.hardware_json` + `cpu_type,mem1_type,...` 개별 컬럼 |

**결과**: 자산을 수정하면 `assets` 테이블은 갱신되지만, `equipment_usage_logs`는 **조건부로만 동기화**됨.
입출고 관리 화면은 `equipment_usage_logs`에서 읽으므로 → **업데이트 안 됨** 증상 발생.

---

#### 🔴 의심 근거 1: 입출고 화면은 equipment_usage_logs만 읽음

**`app/routes/inventory.js:240-241`**
```javascript
const logs = EquipmentUsageLog.findAllEquipment(filters);
const counts = EquipmentUsageLog.countByStatusEquipment();
```
입출고 관리(장비) 탭은 `assets` 테이블을 **전혀 참조하지 않음**.
`equipment_usage_logs` 테이블만으로 목록을 렌더링.

→ 자산 상세에서 수정한 내용이 입출고 화면에 반영되려면 `equipment_usage_logs`까지 동기화되어야 하는데, 이 동기화는 **관리번호가 있는 자산만, 그리고 성공할 때만** 일어남.

---

#### 🔴 의심 근거 2: 동기화가 조건부 + 오류 무시

**`app/routes/assets.js:917-1006`**
```javascript
// ===== 입출고 동기화: 관리번호가 있는 자산만 =====
if (afterAsset.management_number) {    // ← 관리번호 없으면 동기화 안 함
  try {
    EquipmentUsageLog.returnActiveByManagement(...);
    // ... IP/credential 매핑 ...
    EquipmentUsageLog.create({...});   // ← 새 "사용중" 레코드 생성
    moduleInventoryRouter.syncModulesToUsageLog(req.params.id);
  } catch (syncErr) {
    console.error('입출고 동기화 오류:', syncErr);
    // ← 오류 발생해도 사용자에게 알리지 않음!
  }
}
```

**문제점**:
- `management_number`가 없는 자산은 **영원히 동기화 안 됨**
- 동기화 중 오류가 나면 **조용히 무시** → 사용자는 성공으로 인식

---

#### 🔴 의심 근거 3: hardware_json에서 모듈 자동 복원

**`app/routes/assets.js:276-304`**
```javascript
// Auto-sync: if no computing_modules but latest usage log has hardware_json, create modules
if (modules.length === 0 && equipmentLogs.length > 0) {
  const latest = equipmentLogs[equipmentLogs.length - 1];
  if (latest.hardware_json) {
    // ... 오래된 hardware_json에서 computing_modules를 다시 생성!
  }
}
```

**문제점**: 모듈을 전부 삭제(반납/장비실 이동)한 후 자산 상세 페이지를 열면,
오래된 `hardware_json`에서 **삭제한 모듈이 되살아남**. 이것은 의도적 "복원"이 아니라 버그.

---

#### 🟡 의심 근거 4: 재고 수량 silent 실패

**`app/routes/moduleInventory.js:480-532`** (모듈 설치 시)
```javascript
const inv = ModuleInventory.findByCode(req.body.specification);
if (inv && inv.storage_quantity >= installCount) {
  // storage_quantity 감소
}
// else → 아무것도 안 함! 오류도 안 남김!
```

재고가 부족해도 모듈은 생성되고, `storage_quantity`만 안 줄어듦 → 수량 불일치 누적.

---

#### 🟡 의심 근거 5: 데이터 중복 저장

| 데이터 | 테이블 A | 테이블 B | 동기화 방식 |
|--------|---------|---------|------------|
| IP 주소 | `asset_ips` | `equipment_usage_logs.ip1~4,bmc,ib1~2` | 자산 수정 시 조건부 |
| 계정 | `asset_credentials` | `equipment_usage_logs.credential_*` | 자산 수정 시 조건부 |
| 하드웨어 | `computing_modules` | `equipment_usage_logs.hardware_json` + 개별컬럼 | `syncModulesToUsageLog()` 호출 시 |
| 자산 기본정보 | `assets` | `equipment_usage_logs.model_name,room,rack` | 자산 수정 시 조건부 |

→ **동기화가 빠지거나 실패하면 두 테이블의 데이터가 달라짐**

---

### 결론

"업데이트가 반영 안 되는" 증상의 원인은 **DB 분산이 아니라 "이중 데이터 소스"** 문제:

1. **정규 테이블** (`assets`, `computing_modules`, `asset_ips`, ...): 자산 CRUD 시 정상 갱신
2. **레거시 테이블** (`equipment_usage_logs`): 입출고 화면의 데이터 소스인데, 동기화가 불완전
3. 동기화 실패 시 오류를 무시하므로 사용자는 문제를 인지하지 못함
4. `hardware_json`에서 삭제된 모듈이 되살아나는 부작용까지 존재

**PostgreSQL 마이그레이션 시 이 구조를 그대로 옮기면 안 됨.**
`equipment_usage_logs`의 역할을 재정의하고 이중 저장 구조를 제거해야 함.
