# HPC/AIDC IT 자산관리 시스템 — 아키텍처 문서

## 0. 요약 (Executive Summary)

**시스템**: HPC/AIDC 데이터센터 IT 자산(서버, 스위치, PDU 등)의 입출고, 위치, 모듈 재고를 관리하는 Node.js + SQLite 웹 애플리케이션.

**발견된 핵심 문제**:
1. `assets`(정규 테이블)과 `equipment_usage_logs`(레거시 테이블)에 **같은 데이터가 이중 저장**되며, 양방향 동기화가 조건부로만 동작하여 "업데이트가 반영 안 되는" 증상 발생
2. 동기화 실패 시 오류를 **조용히 무시**(silent catch)하여 사용자가 문제를 인지하지 못함
3. 삭제된 모듈이 레거시 `hardware_json`에서 **자동 복원**되는 버그 존재

**결정된 방향**: **길 B — PostgreSQL 마이그레이션 + 코드 리팩토링**
- 이중 저장 구조를 제거하고 `equipment_usage_logs`를 순수 이력 테이블로 재정의
- Docker + PostgreSQL 기반 v2/ 환경을 별도 구축 후 점진적 전환
- B-1 ~ B-7 단계로 쪼개서 진행 (각 단계 검증 후 다음 진행)

---

## 1-1. 프로젝트 구조

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
│   │   ├── it_assets.db        ← ★ 운영 DB (유일하게 데이터 있음, 1.9MB)
│   │   └── backups/            ← 자동 백업 저장 위치
│   ├── models/                 ← 20개 모델 (DB CRUD 캡슐화)
│   ├── routes/                 ← 23개 라우트 파일
│   ├── views/                  ← EJS 템플릿 (21개 폴더/파일)
│   ├── middleware/
│   │   ├── auth.js             ← 인증/권한 (admin, maintenance, viewer)
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
- **실행**: `node server.js` (또는 `nodemon server.js`)
- **프로세스**: **단일** Node.js 프로세스
- **포트**: `3000` (기본값, `process.env.PORT || 3000`)
- **바인딩**: `0.0.0.0` (모든 네트워크 인터페이스)

### 아키텍처 특성

| 항목 | 현재 상태 |
|------|----------|
| 프로세스 수 | 단일 (1개) |
| 세션 저장소 | 메모리 (express-session 기본값) |
| DB 연결 방식 | 싱글턴 — `getDb()`로 한 번 열고 전역 재사용 |
| DB 파일 | `app/data/it_assets.db` 1개만 사용 (빈 파일 3개는 잔재) |
| 인증 | 세션 기반 (쿠키, 24시간 만료) |
| 파일 업로드 | 로컬 디스크 (`public/uploads/photos/`) |
| 자동 백업 | 7일마다 `db.backup()` → `data/backups/` |
| 시작 시 마이그레이션 | `database.js`의 `runMigrations()`에서 스키마 변경 자동 적용 |

---

## 1-2. DB 현황 및 증상 원인 조사

### DB 기본 현황

- **DB 파일**: `app/data/it_assets.db` (1.9 MB), 저널 모드: WAL
- **테이블 수**: 22개 (sqlite_sequence 포함)

### 테이블 목록 및 행 개수

| 테이블 | 행 수 | 역할 |
|--------|-------|------|
| `assets` | 168 | 자산 마스터 |
| `asset_ips` | 206 | 자산별 IP 주소 |
| `asset_credentials` | 198 | 자산별 접속 계정 |
| `computing_modules` | 553 | 자산에 설치된 컴퓨팅 모듈 |
| `module_inventory` | 188 | 부품 재고 현황 |
| `module_inventory_logs` | 273 | 부품 변경 이력 |
| `module_transfer_logs` | 296 | 모듈 이동 이력 |
| `equipment_usage_logs` | 727 | 입출고/사용 이력 (**레거시, 이중 저장 원인**) |
| `inventory_logs` | 0 | **고아 테이블** (미사용, module_inventory_logs로 대체됨) |
| `audit_logs` | 1,253 | 감사 로그 |
| `users` | 13 | 사용자 계정 |
| `server_rooms` | 9 | 서버실/사무실/장비실 |
| `racks` | 27 | 랙 |
| `vendor_info` | 13 | 업체 정보 |
| `vendor_intake_requests` | 1 | 업체 입고 요청 |
| `ip_addresses` | 2,304 | IP 주소 관리 |
| `network_connections` | 0 | 네트워크 연결 (아직 미입력) |
| `power_nodes` | 0 | 전원 배선 (아직 미입력) |
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

### 배제된 원인 후보

| 후보 | 결과 |
|------|------|
| DB 분산 (여러 DB 파일) | 해당 없음 — 단일 DB 파일, 단일 연결 |
| 메모리 캐싱 | 해당 없음 — 20개 모델 전수 검사, 데이터 캐싱 없음 |
| HTTP/브라우저 캐싱 | 해당 없음 — Cache-Control 미설정, 서비스워커 없음 |
| 미들웨어 선행 조회 | 해당 없음 — 미들웨어는 인증만 담당 |

### 발견된 근본 원인: 이중 데이터 소스 (Dual Source of Truth)

같은 정보가 **정규 테이블**과 **레거시 테이블**에 이중 저장됨:

| 정보 | 정규 테이블 | 레거시 테이블 (`equipment_usage_logs`) |
|------|-----------|--------------------------------------|
| 자산 위치/상태 | `assets` | `.room, .rack, .unit, .status` |
| IP 주소 | `asset_ips` | `.ip1~4, .bmc, .ib1~2, .ips_json` |
| 계정 정보 | `asset_credentials` | `.credential_*, .credentials_json` |
| 하드웨어 구성 | `computing_modules` | `.hardware_json` + `cpu_type, mem1_type...` 개별컬럼 |
| 자산 기본정보 | `assets.model_name` | `.model_name` |

**양방향 동기화**가 조건부로만 동작:
- 자산 수정 → equipment_usage_logs 갱신 (`assets.js:917`, 관리번호 있을 때만)
- 사용 등록 → assets 갱신 (`inventory.js:794`, 자산 존재할 때만)
- 어느 쪽이든 실패 시 silent catch로 무시

---

## 1-3. API-DB 매핑 및 추가 위험 코드

### 전체 API 엔드포인트 매핑

23개 라우트 파일, 총 **약 110개 엔드포인트**.

#### assets.js (`/assets`) — 13개

| 메서드 | 경로 | 용도 | 읽는 테이블 | 쓰는 테이블 | 비고 |
|--------|------|------|------------|------------|------|
| GET | / | 자산 목록 | assets, server_rooms | — | |
| GET | /vendor | 업체 장비 | assets, vendor_info | — | |
| GET | /new | 등록 폼 | server_rooms, racks, vendor_info, **equip_usage_logs** | — | 레거시 prefill |
| POST | / | 자산 등록 | server_rooms, racks, assets | assets, asset_ips, asset_credentials, ip_addresses, vendor_info, server_rooms, racks, audit_logs | |
| GET | /:id/json | JSON | assets, computing_modules, asset_ips, asset_credentials | — | |
| GET | /:id | 상세 | assets, computing_modules, asset_ips, asset_credentials, **equip_usage_logs**, module_inventory, module_inventory_logs, module_transfer_logs, photos | **computing_modules** | 🔴 모듈 자동복원 |
| POST | /:id/fault-repair | 장애/수리 | assets, computing_modules, module_inventory | computing_modules, module_inventory, module_inventory_logs, module_transfer_logs, **equip_usage_logs**, audit_logs | |
| POST | /:id/module-action | 모듈 처리 | assets, computing_modules, module_inventory | computing_modules, module_inventory, module_inventory_logs, module_transfer_logs, **equip_usage_logs**, audit_logs | |
| POST | /:id/restore | 복귀 | assets | assets, audit_logs | |
| GET | /:id/edit | 수정 폼 | assets, server_rooms, racks, vendor_info, asset_ips, asset_credentials, computing_modules, photos | — | |
| POST | /:id | 자산 수정 | assets, server_rooms, racks | assets, asset_ips, asset_credentials, ip_addresses, **equip_usage_logs**, vendor_info, server_rooms, racks, audit_logs | 🔴 조건부 동기화 + silent catch |
| POST | /:id/delete | 삭제 | assets, racks, photos | assets, racks, photos, audit_logs | |
| GET | /api/* | API 3종 | assets, ip_addresses, racks | — | |

#### inventory.js (`/inventory`) — 16개

| 메서드 | 경로 | 용도 | 읽는 테이블 | 쓰는 테이블 | 비고 |
|--------|------|------|------------|------------|------|
| GET | / | 입출고 관리 | module_inventory_logs **또는** **equip_usage_logs** | — | 🔴 장비 탭: 레거시만 읽음 |
| GET | /incoming | 입고 폼 | vendor_info, module_inventory | — | |
| POST | /incoming | 입고 등록 | vendor_info, module_inventory, assets | module_inventory, module_inventory_logs, **equip_usage_logs**, assets, photos, vendor_info, audit_logs | |
| GET | /new | 사용 등록 폼 | **equip_usage_logs**, module_inventory, server_rooms, racks, assets | — | |
| POST | / | 사용 등록 | module_inventory, assets, server_rooms, racks | **equip_usage_logs**, computing_modules, module_inventory, module_inventory_logs, assets, asset_ips, asset_credentials, ip_addresses, audit_logs | 🔴 역방향 동기화 |
| GET | /equipment/:mgmt | 장비 상세 | **equip_usage_logs**, module_inventory, assets, computing_modules, module_inventory_logs, photos | — | 🔴 레거시가 1차 소스 |
| GET | /:id/edit | 수정 폼 | **equip_usage_logs**, module_inventory, server_rooms, racks, assets, photos | — | |
| POST | /:id | 수정 | **equip_usage_logs**, assets | **equip_usage_logs**, assets, asset_ips, asset_credentials, audit_logs | 🔴 양방향 동기화 |
| POST | /:id/return | 반납 | **equip_usage_logs**, assets | **equip_usage_logs**, assets, audit_logs | |
| POST | /:id/delete | 삭제 | photos | **equip_usage_logs**, photos, audit_logs | |
| GET | /api/* | API 6종 | vendor_info, assets, module_inventory, **equip_usage_logs**, computing_modules | — | |

#### moduleInventory.js (`/module-inventory`) — 15개

| 메서드 | 경로 | 용도 | 읽는 테이블 | 쓰는 테이블 | 비고 |
|--------|------|------|------------|------------|------|
| GET | / | 부품 현황 | module_inventory, computing_modules, module_inventory_logs, vendor_info | — | |
| POST | /api/.../adjust | 수량 조정 | module_inventory | module_inventory, module_inventory_logs, audit_logs | |
| POST | /api/.../update-storage | 재고 수정 | module_inventory | module_inventory, module_inventory_logs, audit_logs | |
| POST | /api/.../inline-update | 인라인 수정 | module_inventory | module_inventory, computing_modules, audit_logs | |
| POST | /api/.../return-vendor | 업체 반납 | module_inventory, computing_modules | computing_modules, module_inventory, module_inventory_logs, **equip_usage_logs**, audit_logs | |
| POST | /modules/:id/transfer | 모듈 이동 | computing_modules, assets | computing_modules, **equip_usage_logs**, module_transfer_logs, module_inventory_logs | |
| POST | /modules | 모듈 등록 | module_inventory, assets | computing_modules, module_inventory, module_inventory_logs, **equip_usage_logs**, audit_logs | 🟡 재고 부족 silent skip |
| POST | /modules/:id | 모듈 수정 | computing_modules, module_inventory, assets | computing_modules, module_inventory, module_inventory_logs, **equip_usage_logs**, audit_logs | |
| POST | /modules/:id/inline-update | 인라인 수정 | computing_modules, assets | computing_modules, **equip_usage_logs**, module_inventory_logs, audit_logs | |
| POST | /modules/:id/delete | 모듈 삭제 | computing_modules, module_inventory, assets | computing_modules, module_inventory, module_inventory_logs, **equip_usage_logs**, audit_logs | |
| GET | /api/* | API 4종 | module_inventory, module_inventory_logs, computing_modules, assets, vendor_info | — | |

#### discovery.js (`/discovery`) — 13개

| 메서드 | 경로 | 용도 | 읽는 테이블 | 쓰는 테이블 | 비고 |
|--------|------|------|------------|------------|------|
| GET | / | 디스커버리 | server_rooms, assets, asset_ips, asset_credentials, computing_modules | — | |
| POST | /scan-asset | SSH 스캔 | assets, asset_ips, asset_credentials, computing_modules, module_inventory, vendor_info | — | 외부 SSH |
| POST | /apply-asset | 결과 적용 | assets, computing_modules, module_inventory, vendor_info, **equip_usage_logs** | computing_modules, module_inventory, module_inventory_logs, **equip_usage_logs**, module_transfer_logs, audit_logs | 🔴 이중기록 |
| POST | /register-inventory | 부품 등록 | module_inventory | module_inventory, computing_modules, module_inventory_logs | |
| POST | /link-inventory | 부품 연결 | module_inventory | computing_modules, module_inventory | |
| GET | /api/* | API 5종 | module_inventory, module_transfer_logs, assets | — | |

#### racks.js (`/racks`) — 10개

| 메서드 | 경로 | 용도 | 읽는 테이블 | 쓰는 테이블 | 비고 |
|--------|------|------|------------|------------|------|
| GET | /:id | 랙 상세 | racks, assets | — | |
| GET | /:id/slots | 슬롯 레이아웃 | racks, assets | — | |
| GET | /:id/power-status | IPMI 전원 | racks, assets, asset_ips, asset_credentials | — | 외부 IPMI |
| POST | /:id/power-control | 전원 제어 | racks, assets, asset_ips, asset_credentials | audit_logs | 외부 IPMI |
| POST | /:id | 랙 수정 | racks | racks | |
| POST | /:id/delete | 삭제 | racks | racks | |
| POST | /:id/move-asset | U이동 | racks, assets | assets | |
| POST | /:id/move-switch-slot | 슬롯 이동 | racks, assets | assets | |
| POST | /:id/position | 위치 변경 | racks | racks | |

#### serverRooms.js (`/rooms`) — 8개

| 메서드 | 경로 | 용도 | 읽는 테이블 | 쓰는 테이블 |
|--------|------|------|------------|------------|
| GET | / | 서버실 목록 | server_rooms, racks, assets | — |
| GET | /:id | 상세 | server_rooms, racks, assets, module_inventory | — |
| GET | /:id/assets | 자산 목록 | server_rooms, assets, asset_ips, asset_credentials, computing_modules | — |
| GET | /:id/modules | 모듈 현황 | server_rooms, racks, assets, computing_modules | — |
| POST | / | 생성 | server_rooms | server_rooms, audit_logs |
| POST | /:id/edit | 수정 | server_rooms | server_rooms, audit_logs |
| POST | /:id/racks | 랙 생성 | — | racks, audit_logs |
| POST | /:id/delete | 삭제 | server_rooms, racks, assets | server_rooms, audit_logs |

#### 나머지 라우트

| 파일 | 마운트 | 엔드포인트 | 주요 테이블 | 비고 |
|------|--------|-----------|------------|------|
| auth.js | `/` | 7 | users | 로그인/사용자 관리 |
| index.js | `/` | 1 | assets, racks, asset_ips, **equip_usage_logs**, server_rooms | 🟡 대시보드에서 레거시 읽음 |
| photos.js | `/api/photos` | 3 | photos | 사진 CRUD |
| lendings.js | `/lendings` | 10 | lendings, lending_items, assets, computing_modules, module_inventory, module_inventory_logs, module_transfer_logs, photos | 장애반납 시 모듈 재고 처리 |
| vendorIntake.js | `/vendor-intake` | 6 | vendor_intake_requests | |
| publicIntake.js | `/intake` | 4 | vendor_intake_requests | 인증 불필요 (외부 공개) |
| requests.js | `/requests` | 4 | — | DB 미접근 |
| excelUpload.js | `/excel` | 3 | assets, racks, server_rooms, vendor_info, asset_ips, asset_credentials, computing_modules | 트랜잭션 사용 |
| ipManagement.js | `/ip-management` | 3 | ip_addresses, assets | 서브넷 자동 초기화 |
| networkLayout.js | `/network-layout` | 7 | network_connections, server_rooms, racks, assets, vendor_info | |
| powerPanel.js | `/power-panel` | 5 | power_nodes, server_rooms, assets | |
| offices.js | `/offices` | 1 | server_rooms, assets | |
| storage.js | `/storage` | 1 | server_rooms, racks, assets, module_inventory | |
| auditLog.js | `/audit-log` | 1 | audit_logs | 읽기 전용 |
| backup.js | `/backup` | 4 | (파일시스템), audit_logs | |
| gpuMonitoring.js | `/gpu-monitoring` | 2 | assets, computing_modules, asset_ips, asset_credentials, server_rooms, racks | SSH GPU 메트릭 |
| chat.js | `/chat` | 4 | assets, computing_modules, server_rooms, racks | AI 채팅, SELECT만 허용 |

### 양방향 동기화 흐름

```
[자산 수정] assets.js POST /:id
  assets UPDATE → equipment_usage_logs INSERT (→ 방향)

[사용 등록] inventory.js POST /
  equipment_usage_logs INSERT → assets UPDATE (← 방향)

[입출고 수정] inventory.js POST /:id
  equipment_usage_logs UPDATE → assets UPDATE (← 방향)
```

두 화면이 서로의 데이터를 동기화하려 하며, 실패 시 불일치 누적.

### 고아 테이블

| 테이블 | 행 수 | 상태 | 설명 |
|--------|-------|------|------|
| `inventory_logs` | 0 | **고아** | 스키마만 존재, 어떤 코드도 접근 안 함. `module_inventory_logs`로 대체됨 |

---

## 발견된 문제 전체 요약

### 이중 저장 (Dual Source of Truth) — 5건

| # | 데이터 | 정규 테이블 | 레거시 테이블 | 동기화 방향 | 위치 | 위험 |
|---|--------|-----------|-------------|-----------|------|------|
| 1 | 자산 위치/상태 | `assets` | `equip_usage_logs.room,rack,unit,status` | 양방향 | assets.js:917, inventory.js:794 | 🔴 |
| 2 | IP 주소 | `asset_ips` | `equip_usage_logs.ip1~4,bmc,ib1~2,ips_json` | 양방향 | assets.js:926, inventory.js:850 | 🔴 |
| 3 | 계정 정보 | `asset_credentials` | `equip_usage_logs.credential_*,credentials_json` | 양방향 | assets.js:945, inventory.js:870 | 🔴 |
| 4 | 하드웨어 구성 | `computing_modules` | `equip_usage_logs.hardware_json` + 개별컬럼 | →방향만 | moduleInventory.js:syncModulesToUsageLog() | 🔴 |
| 5 | 자산 기본정보 | `assets.model_name` | `equip_usage_logs.model_name` | 양방향 | assets.js:982, inventory.js:800 | 🟡 |

### Silent Catch (오류 무시) — 4곳

| # | 파일 | 줄 | 코드 | 영향 |
|---|------|-----|------|------|
| 1 | assets.js | 1003-1005 | `catch(syncErr) { console.error(...) }` | 🔴 자산 수정 후 입출고 동기화 실패 무시 |
| 2 | assets.js | 302 | `catch(e) { /* ignore */ }` | 🔴 hardware_json 파싱 실패 무시 |
| 3 | inventory.js | ~1002 | `catch(syncErr) { console.error(...) }` | 🔴 사용등록 후 자산 동기화 실패 무시 |
| 4 | database.js | 109 | `catch(e) { console.error(...) }` | 🟡 시작 시 레거시→정규 동기화 실패 무시 |

### 조건부 동기화 — 4곳

| # | 파일 | 줄 | 조건 | 결과 |
|---|------|-----|------|------|
| 1 | assets.js | 917 | `if (afterAsset.management_number)` | 🔴 관리번호 없는 자산은 동기화 안 됨 |
| 2 | assets.js | 276 | `if (modules.length === 0 && equipmentLogs.length > 0)` | 🔴 삭제된 모듈이 레거시에서 되살아남 |
| 3 | moduleInventory.js | ~495 | `if (inv && inv.storage_quantity >= installCount)` | 🟡 재고 부족 시 설치되지만 재고 미차감 |
| 4 | inventory.js | ~794 | `if (existingAsset && existingAsset.id)` | 🟡 자산 없으면 역방향 동기화 안 됨 |

### `equipment_usage_logs` 의존 화면 — 7곳

| 화면 | 라우트 | 위험 |
|------|--------|------|
| 입출고 관리 (장비 탭) | inventory.js GET / | 🔴 정규 테이블 무시 |
| 장비 상세 | inventory.js GET /equipment/:mgmt | 🔴 정규 테이블 무시 |
| 자산 상세 (모듈 복원) | assets.js GET /:id | 🔴 모듈 자동복원 부작용 |
| 사용 등록 폼 | inventory.js GET /new | 🟡 오래된 데이터 사용 가능 |
| 자산 등록 폼 | assets.js GET /new | 🟡 오래된 데이터 사용 가능 |
| 대시보드 | index.js GET / | 🟡 부정확한 통계 가능 |
| 디스커버리 | discovery.js POST /apply-asset | 🟡 room/rack 참조 |

---

## 진행 로드맵

| 단계 | 작업 | 기존 시스템 | 위험도 |
|------|------|------------|--------|
| B-1 | PostgreSQL + Docker 환경 구축 (빈 DB) | 영향 없음 | 낮음 |
| B-2 | 데이터 이전 스크립트 작성 + 검증 | 읽기만 함 | 중간 |
| B-3 | 이중 저장 구조 리팩토링 | 영향 없음 | 중간 |
| B-4 | 신규 환경 통합 테스트 | 영향 없음 | 낮음 |
| B-5 | 윈도우 배포 패키징 | 영향 없음 | 낮음 |
| B-6 | 병행 운영 (기존 + 신규) | 그대로 운영 | 낮음 |
| B-7 | 사용자 전환 후 기존 시스템 정리 | 점진적 종료 | 낮음 |

---

## 작업 원칙

1. **기존 `app/` 폴더는 절대 수정하지 않음**
2. **모든 신규 작업은 `v2/` 폴더에서 진행**
3. **운영 DB(`app/data/it_assets.db`)는 읽기 전용으로만 접근**
4. **각 단계 끝날 때마다 git 커밋**
5. **한 단계가 완료되고 검증되기 전까지 다음 단계로 넘어가지 않음**
