# HPC/AIDC IT 자산관리 시스템 — 마이그레이션 상세 계획서

> **문서 버전**: 1.1
> **작성일**: 2026-05-14 | **갱신일**: 2026-05-19
> **선행 문서**: `ARCHITECTURE.md` (단계 1 조사 결과), `MIGRATION_QA.md` (검토 Q&A)
> **대상 범위**: B-1 ~ B-7 전체 단계

---

## 목차

1. [기술 선택 및 근거](#1-기술-선택-및-근거)
2. [SQLite → PostgreSQL 타입 매핑](#2-sqlite--postgresql-타입-매핑)
3. [AUTOINCREMENT vs SERIAL/IDENTITY](#3-autoincrement-vs-serialidentity)
4. [외래키 정책 (ON DELETE / ON UPDATE)](#4-외래키-정책)
5. [equipment_usage_logs 처리 전략](#5-equipment_usage_logs-처리-전략)
6. [B-1: PostgreSQL + Docker 환경 구축](#b-1-postgresql--docker-환경-구축)
7. [B-2: 데이터 이전 스크립트 작성 + 검증](#b-2-데이터-이전-스크립트-작성--검증)
8. [B-3: 이중 저장 구조 리팩토링](#b-3-이중-저장-구조-리팩토링)
9. [B-3 이후 후속 작업](#b-3-이후-후속-작업)
10. [B-4: 통합 테스트](#b-4-통합-테스트)
11. [B-5: 배포 패키징](#b-5-배포-패키징)
12. [B-6: 병행 운영 — 3단계 전환 정책](#b-6-병행-운영--3단계-전환-정책)
13. [B-7: 전환 완료 + 정리](#b-7-전환-완료--정리)
14. [전체 롤백 전략](#13-전체-롤백-전략)

---

## 1. 기술 선택 및 근거

### ORM: **사용하지 않음 (Raw SQL + 헬퍼 모듈)**

| 고려 항목 | 결정 | 근거 |
|-----------|------|------|
| Sequelize | ❌ | 러닝커브, 마이그레이션 도구 복잡, 기존 20개 모델 전면 재작성 필요 |
| Knex.js | ❌ | 쿼리빌더 도입 시 기존 SQL 100개+ 전면 변환 필요 |
| Raw SQL + `pg` | ✅ | 기존 better-sqlite3 동기 SQL을 **async/await pg 비동기 SQL**로 1:1 변환 가능. 변경 범위 최소화 |

**방침**: `better-sqlite3`의 동기 API(`db.prepare().get()`, `.all()`, `.run()`)를 `pg`의 비동기 API(`pool.query()`)로 변환하되, 기존 SQL 구문은 최대한 유지. `$1, $2` 파라미터 바인딩만 변경.

**전환 패턴 예시**:
```
// 현재 (better-sqlite3, 동기)
const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);

// 변환 후 (pg, 비동기)
const { rows: [row] } = await pool.query('SELECT * FROM assets WHERE id = $1', [id]);
```

### 세션 저장소: **`connect-pg-simple`**

| 고려 항목 | 결정 | 근거 |
|-----------|------|------|
| 메모리 (현재) | ❌ | 서버 재시작 시 전 사용자 로그아웃, 메모리 누수 위험 |
| Redis | ❌ | 추가 인프라 필요, 사용자 13명에 과잉 |
| `connect-pg-simple` | ✅ | PostgreSQL에 세션 저장. 추가 인프라 없음. 재시작 후 세션 유지 |

### 개발 환경: **Docker Compose**

| 고려 항목 | 결정 | 근거 |
|-----------|------|------|
| 로컬 PostgreSQL 설치 | ❌ | OS별 설정 차이, 정리 어려움 |
| Docker Compose | ✅ | `docker-compose up` 한 줄로 PostgreSQL + 앱 실행. 서버에 Docker 23.0.1 + Compose v2.16.0 이미 설치됨 |

### Node.js 드라이버: **`pg` (node-postgres)**

| 고려 항목 | 결정 | 근거 |
|-----------|------|------|
| `pg` | ✅ | 가장 성숙한 PostgreSQL 드라이버, 커넥션 풀 내장, 트랜잭션 지원 |
| `postgres` (porsager) | ❌ | 상대적으로 새로움, 태그드 템플릿 방식은 기존 코드와 이질적 |

---

## 2. SQLite → PostgreSQL 타입 매핑

### 기본 타입 매핑표

| SQLite 타입 | 사용처 (예시) | PostgreSQL 타입 | 비고 |
|-------------|-------------|-----------------|------|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | 모든 테이블 id | `SERIAL PRIMARY KEY` 또는 `INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | 아래 §3 참조 |
| `TEXT` | model_name, notes 등 | `TEXT` | 동일 |
| `TEXT NOT NULL` | username, name 등 | `TEXT NOT NULL` | 동일 |
| `TEXT UNIQUE` | ip_addresses.ip_address | `TEXT UNIQUE` | 동일 |
| `TEXT NOT NULL UNIQUE` | server_rooms.name | `TEXT NOT NULL UNIQUE` | 동일 |
| `INTEGER` | count, cpu_num 등 | `INTEGER` | 동일 |
| `INTEGER DEFAULT 1` | rack_unit_size, quantity | `INTEGER DEFAULT 1` | 동일 |
| `INTEGER DEFAULT 0` | storage_quantity, is_onboard | `INTEGER DEFAULT 0` | 동일 |
| `REAL` | power_nodes.capacity_kw | `REAL` 또는 `NUMERIC(10,2)` | REAL 유지 (정밀도 이슈 없음) |
| `DATE` | purchase_date, usage_date | `DATE` | 동일 |
| `DATETIME DEFAULT CURRENT_TIMESTAMP` | created_at, updated_at | `TIMESTAMPTZ DEFAULT NOW()` | 타임존 포함으로 업그레이드 |
| `TEXT DEFAULT (datetime('now', 'localtime'))` | photos.uploaded_at | `TIMESTAMPTZ DEFAULT NOW()` | SQLite 함수 → PG 함수 |
| `TEXT DEFAULT (date('now'))` | module_transfer_logs.transfer_date | `DATE DEFAULT CURRENT_DATE` | SQLite 함수 → PG 함수 |

### CHECK 제약 조건 매핑

| 테이블 | SQLite CHECK | PostgreSQL CHECK | 비고 |
|--------|-------------|-----------------|------|
| assets | `CHECK(asset_type IN ('server','switch',...))` | `CHECK(asset_type IN ('server','switch',...))` | 구문 동일 |
| assets | `CHECK(ownership IN ('company','vendor'))` | 동일 | |
| assets | `CHECK(status IN ('active','inactive','returned','maintenance','decommissioned'))` | 동일 | |
| asset_ips | `CHECK(ip_type IN ('management','bmc','ib','data'))` | 동일 | |
| asset_credentials | `CHECK(credential_type IN ('root','user','bmc','os','etc'))` | 동일 | |
| equipment_usage_logs | `CHECK(status IN ('입고','사용중','반납완료'))` | 동일 (UTF-8 리터럴) | PostgreSQL은 UTF-8 네이티브 |
| ip_addresses | `CHECK(network_zone IN ('office','hpc','aidc'))` | 동일 | |
| ip_addresses | `CHECK(allocation_type IN ('available','assigned','reserved'))` | 동일 | |
| power_nodes | `CHECK(node_type IN ('main_panel','sub_panel','hvac','pdu','ups'))` | 동일 | |
| network_connections | `CHECK(ownership IN ('company','vendor'))` | 동일 | |
| network_connections | `CHECK(status IN ('active','inactive','planned'))` | 동일 | |
| users | `CHECK(role IN ('admin','maintenance','viewer'))` | 동일 | |
| lendings | `CHECK(direction IN ('outbound','inbound'))` | 동일 | |
| lendings | `CHECK(status IN ('active','returned'))` | 동일 | |
| vendor_intake_requests | `CHECK(status IN ('draft','pending','approved','rejected'))` | 동일 | |
| computing_modules | `CHECK(module_type IN ('cpu','memory','disk','network','raid','gpu','npu','psu'))` | 동일 | |

> **참고**: PostgreSQL의 CHECK 제약 구문은 SQLite와 호환됨. `CREATE TYPE ... AS ENUM`도 대안이지만, 기존 구조를 보존하기 위해 CHECK를 유지.

### 주의해야 할 SQLite → PostgreSQL 차이점

| 항목 | SQLite | PostgreSQL | 대응 |
|------|--------|------------|------|
| 파라미터 바인딩 | `?` | `$1, $2, ...` | SQL 문자열 치환 필요 |
| BOOLEAN | `INTEGER` (0/1) | `BOOLEAN` (true/false) | `is_onboard` 등은 INTEGER 유지 가능 (PG도 허용) |
| AUTOINCREMENT | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL` 또는 `IDENTITY` | §3 참조 |
| 날짜 함수 | `datetime('now')`, `date('now')` | `NOW()`, `CURRENT_DATE` | DEFAULT 절 + 쿼리 내 사용처 모두 변환 |
| UPSERT | `INSERT OR REPLACE` | `INSERT ... ON CONFLICT ... DO UPDATE` | 사용처 확인 후 변환 |
| 문자열 연결 | `||` | `||` | 동일 |
| LIKE | 대소문자 무시 (기본) | 대소문자 구분 (기본) | `ILIKE` 사용 또는 `LOWER()` |
| GLOB | 지원 | 미지원 | `~` (정규식) 또는 `LIKE` 변환 |
| PRAGMA | `PRAGMA foreign_keys = ON` 등 | 미지원 (기본적으로 FK ON) | 코드에서 PRAGMA 호출 제거 |
| 트랜잭션 | 동기 (`db.transaction(fn)`) | 비동기 (`BEGIN/COMMIT`) | `pg` 클라이언트의 트랜잭션 패턴 사용 |
| JSON | `json()` 함수 (제한적) | `jsonb` 타입 + 풍부한 연산자 | hardware_json 등에 `JSONB` 활용 가능 |
| GROUP_CONCAT | `GROUP_CONCAT(col, sep)` | `STRING_AGG(col, sep)` | 집계 쿼리 변환 |

---

## 3. AUTOINCREMENT vs SERIAL/IDENTITY

### 현재 상태 (SQLite)

모든 22개 테이블이 `INTEGER PRIMARY KEY AUTOINCREMENT` 사용:
- `AUTOINCREMENT`는 SQLite에서 id 값 재사용 방지를 보장 (삭제된 id가 재할당되지 않음)
- `sqlite_sequence` 테이블에 각 테이블의 마지막 시퀀스 값 저장

### PostgreSQL 선택: **`SERIAL`**

| 옵션 | 구문 | 장점 | 단점 |
|------|------|------|------|
| `SERIAL` | `id SERIAL PRIMARY KEY` | 간결, 널리 사용됨 | 내부적으로 시퀀스 + DEFAULT 조합 |
| `GENERATED ALWAYS AS IDENTITY` | `id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | SQL 표준, 외부 삽입 방지 | 구문이 길고, 데이터 이전 시 `OVERRIDING SYSTEM VALUE` 필요 |
| `GENERATED BY DEFAULT AS IDENTITY` | 위와 유사 | 외부 삽입 허용 | SERIAL과 기능적으로 거의 동일 |

**결정: `SERIAL`**
- 기존 id 값을 보존하며 데이터 이전할 때 `INSERT ... (id, ...)` 직접 삽입이 간단
- 이전 완료 후 `SELECT setval('tablename_id_seq', (SELECT MAX(id) FROM tablename))` 으로 시퀀스 재설정
- 프로젝트 규모에 IDENTITY의 추가 안전성은 불필요

### 시퀀스 재설정 전략

데이터 이전 후 각 테이블의 시퀀스를 현재 최대 id 값 기준으로 재설정:

```sql
-- 이전 스크립트 마지막에 자동 실행
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.column_default LIKE 'nextval%'
      AND c.table_schema = 'public'
  LOOP
    EXECUTE format(
      'SELECT setval(pg_get_serial_sequence(%L, %L), COALESCE((SELECT MAX(%I) FROM %I), 0) + 1, false)',
      r.table_name, r.column_name, r.column_name, r.table_name
    );
  END LOOP;
END $$;
```

---

## 4. 외래키 정책

### 현재 FK 관계 및 정책 (21개)

| # | 자식 테이블 | 컬럼 | 부모 테이블 | ON DELETE | ON UPDATE | 변경 여부 |
|---|-----------|------|-----------|-----------|-----------|----------|
| 1 | racks | room_id | server_rooms | CASCADE | 없음 | 유지 |
| 2 | racks | linked_asset_id | assets | SET NULL | 없음 | 유지 |
| 3 | assets | rack_id | racks | SET NULL | 없음 | 유지 |
| 4 | assets | vendor_id | vendor_info | SET NULL | 없음 | 유지 |
| 5 | assets | parent_asset_id | assets | CASCADE | 없음 | 유지 |
| 6 | assets | room_id | server_rooms | 없음(NO ACTION) | 없음 | **→ SET NULL** |
| 7 | computing_modules | asset_id | assets | CASCADE | 없음 | 유지 |
| 8 | computing_modules | owner_vendor_id | vendor_info | 없음(NO ACTION) | 없음 | **→ SET NULL** |
| 9 | asset_ips | asset_id | assets | CASCADE | 없음 | 유지 |
| 10 | asset_credentials | asset_id | assets | CASCADE | 없음 | 유지 |
| 11 | ip_addresses | asset_id | assets | SET NULL | 없음 | 유지 |
| 12 | inventory_logs | asset_id | assets | SET NULL | 없음 | **삭제 (고아 테이블)** |
| 13 | power_nodes | room_id | server_rooms | CASCADE | 없음 | 유지 |
| 14 | power_nodes | parent_id | power_nodes | CASCADE | 없음 | 유지 |
| 15 | power_nodes | asset_id | assets | SET NULL | 없음 | 유지 |
| 16 | network_connections | room_id | server_rooms | CASCADE | 없음 | 유지 |
| 17 | network_connections | from_asset_id | assets | CASCADE | 없음 | 유지 |
| 18 | network_connections | to_asset_id | assets | CASCADE | 없음 | 유지 |
| 19 | network_connections | vendor_id | vendor_info | SET NULL | 없음 | 유지 |
| 20 | lending_items | lending_id | lendings | CASCADE | 없음 | 유지 |
| 21 | vendor_intake_requests | asset_id | assets | SET NULL | 없음 | 유지 |

### 변경 사항 (3건)

**#6 assets.room_id → server_rooms: NO ACTION → SET NULL**
- 이유: 서버실 삭제 시 소속 자산의 room_id가 NULL이 되는 게 합리적 (랙 삭제와 일관)
- 현재 NO ACTION이면 서버실에 자산이 있으면 삭제 불가 (의도하지 않은 제약)

**#8 computing_modules.owner_vendor_id → vendor_info: NO ACTION → SET NULL**
- 이유: 업체 삭제 시 모듈의 소유자 참조만 NULL로 정리하는 게 안전

**#12 inventory_logs 테이블 자체를 삭제**
- 이유: 행 0개, 어떤 코드도 접근하지 않는 고아 테이블 (ARCHITECTURE.md 1-3 결과)
- module_inventory_logs로 완전 대체됨

### 추가할 FK (새로 정의)

| 자식 테이블 | 컬럼 | 부모 테이블 | ON DELETE | 근거 |
|-----------|------|-----------|-----------|------|
| module_inventory_logs | asset_id | assets | SET NULL | 현재 FK 없음, 자산 삭제 시 이력은 보존 (SET NULL) |
| module_transfer_logs | from_asset_id | assets | SET NULL | 현재 FK 없음 |
| module_transfer_logs | to_asset_id | assets | SET NULL | 현재 FK 없음 |
| audit_logs | user_id | users | SET NULL | 현재 FK 없음, 사용자 삭제 시 로그 보존 |
| photos | entity_id | (다형성) | — | 다형성 FK는 PG에서도 직접 설정 불가, 앱 레벨에서 무결성 보장 |

### ON UPDATE 정책

모든 FK에 `ON UPDATE CASCADE` 추가:
- 현재 모든 PK가 `SERIAL`이므로 UPDATE 될 일은 거의 없지만, 방어적 설정
- PostgreSQL의 기본값은 NO ACTION이므로 명시적으로 지정

---

## 5. equipment_usage_logs 처리 전략

### 결정: **순수 이력 테이블로 재정의 (Append-Only Audit Log)**

현재 `equipment_usage_logs`는 현재 상태(current state)와 이력(history)을 동시에 담당하는 이중 역할이 문제의 근본 원인. B-3에서 다음과 같이 재정의:

### 재정의 후 역할

```
[현재]
equipment_usage_logs = 현재 상태 + 이력 (727행, 양방향 동기화)

[변경 후]
equipment_usage_logs = 입출고 이벤트 이력 전용 (INSERT만, UPDATE/DELETE 금지)
assets + asset_ips + asset_credentials + computing_modules = 유일한 현재 상태 소스
```

### 새로운 equipment_usage_logs 스키마

```sql
CREATE TABLE equipment_usage_logs (
    id SERIAL PRIMARY KEY,

    -- 이벤트 정보
    event_type TEXT NOT NULL CHECK(event_type IN ('incoming','in_use','returned','transferred')),
    event_date DATE NOT NULL DEFAULT CURRENT_DATE,

    -- 자산 참조 (정규 테이블 FK)
    asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
    management_number TEXT,          -- 검색 편의용 비정규화 (이력 시점 스냅샷)
    asset_number TEXT,               -- 이력 시점 스냅샷
    model_name TEXT,                 -- 이력 시점 스냅샷

    -- 사용 정보
    user_name TEXT,
    test_name TEXT,
    test_detail TEXT,

    -- 위치 스냅샷 (이벤트 시점의 위치)
    room TEXT,
    rack TEXT,
    unit TEXT,

    -- 하드웨어 스냅샷 (이벤트 시점 구성)
    hardware_snapshot JSONB,         -- computing_modules 전체를 JSON 스냅샷

    -- 네트워크 스냅샷
    network_snapshot JSONB,          -- asset_ips 전체를 JSON 스냅샷

    -- 계정 스냅샷
    credentials_snapshot JSONB,      -- asset_credentials 전체를 JSON 스냅샷 (선택적)

    -- 메타
    ownership TEXT DEFAULT 'company',
    os TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- updated_at 의도적 제거: 이력 테이블은 수정하지 않음
```

### return_date 처리 방안

현재 v1에서 `return_date`는 `equipment_usage_logs.return_date` 컬럼에 저장되며, 반납 시점을 기록.

**결정: 이벤트 분리 방식 (별도 컬럼 추가하지 않음)**

새 스키마의 append-only 설계에서는 `return_date`를 별도 컬럼으로 관리하지 않는다:
- 반납 시 `event_type = 'returned'`, `event_date = 반납일` 인 새 이벤트를 INSERT
- 반납일 = 해당 `returned` 이벤트의 `event_date`
- 기존 `in_use` 이벤트를 UPDATE하지 않음 (append-only 원칙)

```
반납 흐름:
  1. event_type='in_use',  event_date='2026-01-15' (사용 시작)
  2. event_type='returned', event_date='2026-05-20' (반납)
     → 사용 기간 = event 2의 event_date - event 1의 event_date
```

데이터 이전 시: 기존 `return_date`가 있는 행은 `event_type='returned'` 이벤트로 별도 생성.

### 기존 데이터 이전 전략

1. 기존 727행의 `equipment_usage_logs` 데이터를 새 스키마로 변환
2. 기존 `status` → 새 `event_type` 매핑:
   - `'입고'` → `'incoming'`
   - `'사용중'` → `'in_use'`
   - `'반납완료'` → `'returned'`
3. 기존 50+ 개별 하드웨어 컬럼 (cpu_type, mem1_type, ...) → `hardware_snapshot` JSONB로 통합
4. 기존 ip1~ip4, bmc, ib1~ib2 → `network_snapshot` JSONB로 통합
5. 기존 credential_root/etc1/etc2 → `credentials_snapshot` JSONB로 통합
6. `management_number`로 `assets.id`를 찾아서 `asset_id` FK 설정

### 영향 받는 화면 — 변경 계획

| 화면 | 현재 동작 | 변경 후 동작 |
|------|----------|------------|
| 입출고 관리 (장비 탭) | equipment_usage_logs만 읽음 | **assets + computing_modules JOIN**으로 전환 |
| 장비 상세 | equipment_usage_logs가 1차 소스 | **assets 상세 페이지로 통합** (이력은 이력 탭으로) |
| 사용 등록 폼 | equipment_usage_logs에서 prefill | **assets 테이블에서 prefill** |
| 자산 등록 폼 | equipment_usage_logs에서 prefill | **assets 테이블에서 prefill** |
| 대시보드 | equipment_usage_logs에서 통계 | **assets 테이블에서 통계** |
| 디스커버리 | 결과를 equipment_usage_logs에 이중 기록 | **computing_modules에만 기록**, 이력 테이블에 스냅샷 INSERT |
| 자산 상세 (모듈 복원) | hardware_json에서 모듈 자동복원 | **자동복원 로직 제거** |

### 동기화 코드 제거 대상

| 파일 | 줄 | 동기화 방향 | 처리 |
|------|-----|-----------|------|
| assets.js | 917~1005 | assets → equipment_usage_logs | **삭제** (이벤트 발생 시에만 INSERT로 대체) |
| inventory.js | 794~870 | equipment_usage_logs → assets | **삭제** (새 사용등록은 assets에 직접 기록) |
| moduleInventory.js | syncModulesToUsageLog() | computing_modules → equipment_usage_logs | **삭제** (이벤트 시에만 스냅샷 INSERT) |
| database.js | syncUsageLogsToAssets() | equipment_usage_logs → asset_ips/credentials | **삭제** (시작 시 동기화 불필요) |
| assets.js | 276~304 | equipment_usage_logs → computing_modules | **삭제** (자동복원 제거) |
| database.js | 501~549 | computing_modules → module_inventory (재계산) | **유지** (이것은 정규 테이블 간 정합성 보장) |

---

## B-1: PostgreSQL + Docker 환경 구축

### 목표
- `v2/` 폴더에 Docker Compose 기반 개발 환경 구축
- PostgreSQL 데이터베이스 생성 + 전체 스키마 DDL 작성
- 빈 DB로 앱 부팅 확인 (데이터 없이 구조만)

### 산출물

```
v2/
├── docker-compose.yml          ← PostgreSQL + Node.js 앱 정의
├── Dockerfile                  ← Node.js 앱 이미지
├── .env.example                ← 환경변수 템플릿
├── db/
│   ├── init.sql               ← PostgreSQL DDL (전체 스키마)
│   └── seed.sql               ← 초기 데이터 (admin 계정 등)
├── config/
│   └── database.js            ← pg 풀 설정 + 연결 테스트
└── README.md                  ← 실행 방법 안내
```

### B-1-1: docker-compose.yml

```yaml
version: '3.8'
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: it_assets
      POSTGRES_USER: ${DB_USER:-itadmin}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-changeme}
    ports:
      - "${DB_PORT:-5432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/01-init.sql
      - ./db/seed.sql:/docker-entrypoint-initdb.d/02-seed.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-itadmin} -d it_assets"]
      interval: 5s
      timeout: 3s
      retries: 5

  app:
    build: .
    ports:
      - "${APP_PORT:-3000}:3000"
    environment:
      NODE_ENV: development
      DB_HOST: db
      DB_PORT: 5432
      DB_NAME: it_assets
      DB_USER: ${DB_USER:-itadmin}
      DB_PASSWORD: ${DB_PASSWORD:-changeme}
      SESSION_SECRET: ${SESSION_SECRET:-dev-secret-change-in-prod}
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./:/app
      - /app/node_modules
      - uploads:/app/public/uploads

volumes:
  pgdata:
  uploads:
```

### B-1-2: PostgreSQL DDL (init.sql) — 주요 변환 사항

**22개 테이블 → 21개** (inventory_logs 제거)

각 테이블별 변환 요약:

| 테이블 | 주요 변환 내용 |
|--------|-------------|
| `server_rooms` | AUTOINCREMENT → SERIAL, DATETIME → TIMESTAMPTZ, `location_type` 포함 |
| `racks` | 동일 변환 + `linked_asset_id`, `switch_slots` 포함 |
| `vendor_info` | 동일 변환 |
| `assets` | 동일 변환 + `room_id REFERENCES server_rooms(id) ON DELETE SET NULL`, `shelf_size` 포함 |
| `computing_modules` | 동일 변환 + `owner`, `owner_vendor_id`, `is_onboard` 포함 |
| `ip_addresses` | 동일 변환 |
| `asset_ips` | 동일 변환 + `interface_type`, `speed` 포함 |
| `asset_credentials` | 동일 변환 + CHECK에 'os','etc' 포함 |
| `module_inventory` | 동일 변환 + `storage_quantity`, `owner`, `owner_vendor_id` 포함 |
| `module_inventory_logs` | 동일 변환 + `asset_id` FK 추가 |
| `module_transfer_logs` | 동일 변환 + `from_asset_id`, `to_asset_id` FK 추가 |
| `equipment_usage_logs` | **새 스키마** (§5 참조) |
| `photos` | `uploaded_at` → `TIMESTAMPTZ DEFAULT NOW()` |
| `users` | 동일 변환 |
| `audit_logs` | 동일 변환 + `user_id` FK 추가 |
| `lendings` | 동일 변환 |
| `lending_items` | 동일 변환 |
| `vendor_intake_requests` | 동일 변환 |
| `power_nodes` | 동일 변환 |
| `network_connections` | 동일 변환 |
| ~~`inventory_logs`~~ | **삭제** |

### B-1-3: 세션 테이블

```sql
-- connect-pg-simple이 사용하는 세션 테이블
CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMPTZ(6) NOT NULL,
  PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
```

### B-1-4: config/database.js (pg 풀)

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'it_assets',
  user: process.env.DB_USER || 'itadmin',
  password: process.env.DB_PASSWORD || 'changeme',
  max: 10,                    // 최대 커넥션 수
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// 연결 테스트
pool.query('SELECT NOW()')
  .then(() => console.log('[DB] PostgreSQL connected'))
  .catch(err => {
    console.error('[DB] PostgreSQL connection failed:', err.message);
    process.exit(1);
  });

module.exports = { pool };
```

### B-1 검증 체크리스트

- [ ] `docker-compose up -d db` → PostgreSQL 컨테이너 실행
- [ ] `init.sql` 실행으로 21개 테이블 + 인덱스 생성 확인
- [ ] `seed.sql`로 admin 계정 생성 확인
- [ ] `pool.query('SELECT NOW()')` 연결 테스트 성공
- [ ] `\dt` 명령으로 테이블 목록 확인
- [ ] `\d assets` 등으로 개별 테이블 스키마 확인

### B-1 롤백

```bash
docker-compose down -v   # 컨테이너 + 볼륨 삭제
rm -rf v2/               # 폴더 삭제
```
기존 시스템에 전혀 영향 없음.

---

## B-2: 데이터 이전 스크립트 작성 + 검증

### 목표
- SQLite(`app/data/it_assets.db`)에서 데이터를 읽어 PostgreSQL에 삽입하는 스크립트 작성
- 데이터 무결성 검증 (행 수, FK 정합성, 고유 제약 등)
- **기존 DB는 읽기만** 함

### 산출물

```
v2/
├── scripts/
│   ├── migrate-data.js        ← SQLite → PostgreSQL 이전 스크립트
│   ├── verify-migration.js    ← 이전 후 검증 스크립트
│   └── reset-sequences.js     ← 시퀀스 재설정
```

### B-2-1: 이전 순서 (FK 의존성 순)

FK 참조를 위반하지 않도록 부모 테이블 → 자식 테이블 순서로 이전:

```
1. server_rooms          (부모 없음)
2. vendor_info           (부모 없음)
3. users                 (부모 없음)
4. racks                 (→ server_rooms)
5. assets                (→ racks, vendor_info, server_rooms, assets)
6. computing_modules     (→ assets, vendor_info)
7. ip_addresses          (→ assets)
8. asset_ips             (→ assets)
9. asset_credentials     (→ assets)
10. module_inventory     (부모 없음, 논리적으로는 computing_modules 이후)
11. module_inventory_logs (→ assets)
12. module_transfer_logs  (→ assets)
13. equipment_usage_logs  (→ assets) ← 새 스키마로 변환 이전
14. lendings             (부모 없음)
15. lending_items        (→ lendings)
16. photos               (부모 없음, 다형성)
17. audit_logs           (→ users)
18. vendor_intake_requests (→ assets)
19. power_nodes          (→ server_rooms, power_nodes, assets)
20. network_connections  (→ server_rooms, assets, vendor_info)
```

### B-2-2: equipment_usage_logs 변환 로직

```
기존 행 727개 → 새 스키마로 변환:

FOR EACH row IN sqlite.equipment_usage_logs:
  1. event_type = CASE row.status
       WHEN '입고'      THEN 'incoming'
       WHEN '사용중'    THEN 'in_use'
       WHEN '반납완료'  THEN 'returned'
     END
  2. event_date = row.usage_date OR row.created_at
  3. asset_id = (SELECT id FROM assets WHERE management_number = row.management_number)
  4. hardware_snapshot = 기존 개별 컬럼 → JSON 변환:
     {
       "cpu": {"type": row.cpu_type, "count": row.cpu_num},
       "memory": [
         {"type": row.mem1_type, "count": row.mem1_num},
         {"type": row.mem2_type, "count": row.mem2_num}
       ],
       "disk": [
         {"part": row.disk1_part, "count": row.disk1_num},
         ...
       ],
       "network": [
         {"type": row.nic1_type, "count": row.nic1_num},
         ...
       ],
       "raid": {"type": row.raid_type, "count": row.raid_num},
       "gpu": [
         {"type": row.gpu1_type, "count": row.gpu1_num},
         {"type": row.gpu2_type, "count": row.gpu2_num}
       ]
     }
     ※ 기존 hardware_json이 있으면 그것을 우선 사용
  5. network_snapshot = 기존 ip1~4, bmc, ib1~2 → JSON 변환:
     [
       {"ip": row.ip1, "type": "management"},
       {"ip": row.ip2, "type": "data"},
       ...
     ]
     ※ 기존 ips_json이 있으면 그것을 우선 사용
  6. credentials_snapshot = 기존 credential_root/etc → JSON 변환
     ※ 기존 credentials_json이 있으면 그것을 우선 사용
```

### B-2-3: 검증 스크립트 (verify-migration.js)

```
검증 항목:
1. 행 수 비교: 각 테이블의 SQLite 행 수 = PostgreSQL 행 수
   ※ equipment_usage_logs는 727행이 727행으로 (1:1 변환)
2. PK 범위: MAX(id) 일치 확인
3. FK 정합성: 고아 레코드 없음 확인
   SELECT * FROM assets WHERE rack_id IS NOT NULL AND rack_id NOT IN (SELECT id FROM racks);
   (각 FK 관계에 대해)
4. UNIQUE 제약: 중복 없음 확인
5. NOT NULL 제약: NULL 위반 없음 확인
6. CHECK 제약: 잘못된 enum 값 없음 확인
7. 시퀀스 확인: nextval > max(id) 확인
8. 날짜/시간: 타임존 변환 정확성 (KST → UTC)
```

### B-2-4: 날짜/시간 처리

| 원본 (SQLite) | 대상 (PostgreSQL) | 처리 방법 |
|--------------|------------------|----------|
| `2026-05-15` (DATE) | `2026-05-15` (DATE) | 그대로 복사 |
| `2026-05-15 14:30:00` (TEXT/DATETIME) | `2026-05-15 14:30:00+09` (TIMESTAMPTZ) | KST 기준으로 타임존 추가 |
| `datetime('now', 'localtime')` 결과 | TIMESTAMPTZ | 로컬 시간(KST)으로 해석하여 변환 |

SQLite의 기존 데이터는 모두 KST 로컬 시간으로 저장되어 있으므로, 이전 시 `Asia/Seoul` 타임존을 붙여서 삽입:

```sql
INSERT INTO assets (..., created_at) VALUES (..., $1::TIMESTAMPTZ)
-- $1 = '2026-05-15 14:30:00+09:00'
```

### B-2 검증 체크리스트

- [ ] `node scripts/migrate-data.js` 실행 → 에러 없이 완료
- [ ] `node scripts/verify-migration.js` 실행 → 모든 검증 통과
- [ ] 행 수 일치 (20개 테이블)
- [ ] FK 정합성 100%
- [ ] 시퀀스 값 정상
- [ ] equipment_usage_logs 변환 정확성 (샘플 10건 수동 대조)

### B-2 롤백

```bash
# PostgreSQL 데이터만 초기화 (스키마 유지)
docker-compose exec db psql -U itadmin -d it_assets -c "
  DO \$\$ DECLARE r RECORD;
  BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
  END \$\$;
"
# 또는 볼륨 삭제 후 init.sql 재실행
docker-compose down -v && docker-compose up -d db
```

기존 SQLite DB에는 읽기만 했으므로 영향 없음.

### B-2-5: 운영 DB 보호 3중 안전장치

> **핵심 원칙**: 마이그레이션 과정에서 운영 SQLite DB(`app/data/it_assets.db`)가 **절대 변경되지 않도록** 3중 보호.

#### 안전장치 1: Docker 볼륨 마운트 차단

`v2/docker-compose.yml`에서 `app/data/` 경로를 **절대 마운트하지 않음**:

```yaml
# v2/docker-compose.yml
services:
  app:
    volumes:
      - ./:/app
      - /app/node_modules
      - uploads:/app/public/uploads
      # ⚠️ 주의: 아래 경로는 절대 마운트하지 않음
      # - ../app/data:/legacy-data    ← 금지! 운영 DB 접근 경로 차단
      # v2 컨테이너 내부에서 app/data/it_assets.db에 접근할 수 없음
```

마이그레이션 스크립트(`migrate-data.js`)는 Docker 외부(호스트)에서 실행하여 SQLite를 직접 읽음.

#### 안전장치 2: SQLite readonly 모드로만 열기

`migrate-data.js`에서 SQLite를 **읽기 전용**으로 연결:

```javascript
// v2/scripts/migrate-data.js
const Database = require('better-sqlite3');

// ⚠️ readonly: true — 쓰기 시도 시 즉시 에러 발생
const sqliteDb = new Database('/mlcommons_cm/hpc_it_management/app/data/it_assets.db', {
  readonly: true,
  fileMustExist: true
});

// 검증: 쓰기 시도 시 에러 발생하는지 확인
try {
  sqliteDb.prepare("UPDATE assets SET id = id WHERE 1=0").run();
  console.error('❌ FATAL: SQLite가 readonly 모드가 아닙니다!');
  process.exit(1);
} catch (e) {
  if (e.message.includes('readonly')) {
    console.log('✅ SQLite readonly 모드 확인됨');
  } else {
    throw e;
  }
}
```

#### 안전장치 3: DB 파일 수정 시각 모니터링

마이그레이션 작업 전후로 `it_assets.db`의 mtime을 비교하여 변경 여부 감지:

```bash
#!/bin/bash
# v2/scripts/check-db-integrity.sh
# 사용법: 마이그레이션 전 실행 → 마이그레이션 후 실행 → 비교

DB_PATH="/mlcommons_cm/hpc_it_management/app/data/it_assets.db"
MARKER_FILE="/tmp/migration_db_mtime.txt"

case "$1" in
  before)
    stat -c '%Y %s %n' "$DB_PATH" > "$MARKER_FILE"
    md5sum "$DB_PATH" >> "$MARKER_FILE"
    echo "✅ 마이그레이션 전 상태 기록 완료"
    cat "$MARKER_FILE"
    ;;
  after)
    if [ ! -f "$MARKER_FILE" ]; then
      echo "❌ 'before' 기록이 없습니다. 먼저 'before'를 실행하세요."
      exit 1
    fi
    echo "=== 마이그레이션 전 ==="
    cat "$MARKER_FILE"
    echo ""
    echo "=== 마이그레이션 후 ==="
    stat -c '%Y %s %n' "$DB_PATH"
    md5sum "$DB_PATH"
    echo ""

    BEFORE_MTIME=$(head -1 "$MARKER_FILE" | awk '{print $1}')
    AFTER_MTIME=$(stat -c '%Y' "$DB_PATH")
    BEFORE_MD5=$(tail -1 "$MARKER_FILE" | awk '{print $1}')
    AFTER_MD5=$(md5sum "$DB_PATH" | awk '{print $1}')

    if [ "$BEFORE_MTIME" = "$AFTER_MTIME" ] && [ "$BEFORE_MD5" = "$AFTER_MD5" ]; then
      echo "✅ 운영 DB 무변경 확인 (mtime 동일, md5 동일)"
    else
      echo "❌ 경고: 운영 DB가 변경되었습니다!"
      echo "   mtime: $BEFORE_MTIME → $AFTER_MTIME"
      echo "   md5:   $BEFORE_MD5 → $AFTER_MD5"
      exit 1
    fi
    ;;
  *)
    echo "사용법: $0 {before|after}"
    exit 1
    ;;
esac
```

실행 순서:
```bash
bash scripts/check-db-integrity.sh before    # 마이그레이션 전
node scripts/migrate-data.js                 # 데이터 이전
bash scripts/check-db-integrity.sh after     # 변경 여부 확인
```

---

## B-3: 이중 저장 구조 리팩토링

### 목표
- 기존 `app/` 코드를 `v2/`에 복사하여 리팩토링
- 양방향 동기화 코드 제거
- 모든 화면을 정규 테이블 기준으로 전환
- `better-sqlite3` → `pg` 전환
- 동기 코드 → async/await 전환

### 산출물

```
v2/
├── app/                       ← 기존 app/ 복사 후 리팩토링
│   ├── server.js              ← pg 풀 초기화, connect-pg-simple 세션
│   ├── config/
│   │   ├── database.js        ← pg 풀 (B-1에서 작성)
│   │   └── app.js             ← 그대로 복사
│   ├── models/                ← 20개 모델: sync → async 전환
│   ├── routes/                ← 23개 라우트: sync → async + 이중저장 제거
│   ├── views/                 ← EJS 템플릿 (대부분 그대로, 일부 수정)
│   ├── middleware/            ← 그대로 복사 (session 로직만 약간 수정)
│   └── services/              ← 그대로 복사
```

### B-3 세부 단계

B-3은 범위가 크므로 내부적으로 하위 단계로 나눠 진행:

#### B-3-1: 기존 코드 복사 + pg 전환 기초

| 작업 | 상세 |
|------|------|
| `app/` → `v2/app/` 복사 | node_modules, data/, public/uploads/ 제외 |
| package.json 수정 | `better-sqlite3` 제거 → `pg`, `connect-pg-simple` 추가 |
| config/database.js 교체 | B-1에서 작성한 pg 풀 버전으로 교체 |
| server.js 수정 | DB 초기화 변경, 세션 저장소 변경 |
| PRAGMA 제거 | `db.pragma('foreign_keys = ON')` 등 SQLite 전용 코드 제거 |
| runMigrations() 제거 | PostgreSQL DDL이 이미 init.sql에서 처리 |
| syncUsageLogsToAssets() 제거 | 이중 저장 동기화 제거 |

#### B-3-2: 모델 파일 전환 (20개)

**전환 패턴**:

```javascript
// 현재 (better-sqlite3)
class Asset {
  static findById(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  }
  static update(id, data) {
    const db = getDb();
    db.prepare('UPDATE assets SET model_name = ? WHERE id = ?').run(data.model_name, id);
  }
}

// 변환 후 (pg)
class Asset {
  static async findById(id) {
    const { rows: [row] } = await pool.query('SELECT * FROM assets WHERE id = $1', [id]);
    return row;
  }
  static async update(id, data) {
    await pool.query('UPDATE assets SET model_name = $1 WHERE id = $2', [data.model_name, id]);
  }
}
```

**모델별 변환 난이도**:

| 모델 | 변환 난이도 | 주의사항 |
|------|-----------|---------|
| asset.js | 높음 | 가장 복잡, 다수 JOIN + 트랜잭션 |
| computingModule.js | 중간 | 벌크 INSERT, specification 매칭 |
| moduleInventory.js | 중간 | 재고 계산 트랜잭션 |
| moduleInventoryLog.js | 낮음 | INSERT 위주 |
| user.js | 낮음 | 단순 CRUD |
| photo.js | 낮음 | 단순 CRUD |
| auditLog.js | 낮음 | INSERT + SELECT |
| ipAddress.js | 낮음 | 서브넷 초기화 벌크 INSERT |
| vendor.js | 낮음 | 단순 CRUD |
| vendorIntake.js | 낮음 | 단순 CRUD |
| powerNode.js | 낮음 | 트리 구조 재귀 쿼리 (WITH RECURSIVE) |
| lending.js | 낮음 | 단순 CRUD + JOIN |
| (기타) | 낮음 | |

#### B-3-3: 라우트 파일 전환 (23개) — 핵심 리팩토링

**중요도별 분류**:

**🔴 1순위 — 이중 저장 제거 대상 (3개)**

| 파일 | 변경 내용 |
|------|----------|
| `routes/assets.js` | • 276~304행 모듈 자동복원 로직 삭제 • 917~1005행 equipment_usage_logs 동기화 삭제 • 자산 수정 시 이벤트 이력만 INSERT (스냅샷) |
| `routes/inventory.js` | • 장비 탭: equipment_usage_logs 읽기 → `assets JOIN computing_modules` 읽기로 전환 • 사용 등록: assets에 직접 기록, equipment_usage_logs에는 이벤트 INSERT만 • 794~870행 역방향 동기화 삭제 |
| `routes/moduleInventory.js` | • `syncModulesToUsageLog()` 삭제 • 모듈 변경 시 equipment_usage_logs에 스냅샷 INSERT만 |

**🟡 2순위 — 레거시 읽기 전환 (4개)**

| 파일 | 변경 내용 |
|------|----------|
| `routes/discovery.js` | apply-asset에서 이중 기록 → 정규 테이블만 기록 |
| `routes/index.js` | 대시보드 통계 → assets 테이블 기준으로 전환 |
| `routes/inventory.js` (추가) | 장비 상세, 수정 폼 → assets 기준으로 전환 |
| `routes/assets.js` (추가) | 등록 폼 prefill → assets 기준으로 전환 |

**🟢 3순위 — 단순 pg 전환 (16개)**

나머지 16개 라우트: `better-sqlite3` → `pg` 비동기 전환만 수행. 비즈니스 로직 변경 없음.

#### B-3-4: silent catch 수정

4곳의 silent catch를 proper error handling으로 교체:

| # | 파일 | 현재 | 변경 후 |
|---|------|------|---------|
| 1 | assets.js:1003 | `catch(e) { console.error(...) }` | **해당 동기화 코드 자체 삭제** |
| 2 | assets.js:302 | `catch(e) { /* ignore */ }` | **모듈 자동복원 코드 자체 삭제** |
| 3 | inventory.js:~1002 | `catch(e) { console.error(...) }` | **해당 동기화 코드 자체 삭제** |
| 4 | database.js:109 | `catch(e) { console.error(...) }` | **syncUsageLogsToAssets 자체 삭제** |

#### B-3-5: 트랜잭션 패턴 전환

```javascript
// 현재 (better-sqlite3, 동기)
const tx = db.transaction(() => {
  db.prepare('INSERT INTO ...').run(...);
  db.prepare('UPDATE ...').run(...);
});
tx();

// 변환 후 (pg, 비동기)
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO ...', [...]);
  await client.query('UPDATE ...', [...]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

#### B-3-6: SQL 구문 변환 체크리스트

| SQLite 구문 | PostgreSQL 구문 | 영향 범위 |
|-------------|-----------------|----------|
| `?` 파라미터 | `$1, $2, ...` | **모든 SQL 쿼리** |
| `INSERT OR REPLACE` | `INSERT ... ON CONFLICT ... DO UPDATE` | inventory.js 등 |
| `datetime('now')` | `NOW()` | DEFAULT 이외 쿼리 내 사용처 |
| `date('now')` | `CURRENT_DATE` | module_transfer_logs 등 |
| `GROUP_CONCAT` | `STRING_AGG` | discovery.js, assets.js 등 |
| `LIKE` (대소문자 무시) | `ILIKE` | 검색 기능 전반 |
| `db.prepare(sql).changes` | `result.rowCount` | DELETE/UPDATE 결과 확인 |
| `db.prepare(sql).run().lastInsertRowid` | `RETURNING id` | INSERT 후 id 획득 |
| `PRAGMA table_info(...)` | `information_schema.columns` | 마이그레이션 코드 (삭제 예정) |
| `json_group_array()` | `json_agg()` | JSON 집계 쿼리 |
| `GLOB` | `~` 또는 `LIKE` | 미사용 확인 필요 |

### B-3 검증 체크리스트

- [ ] `docker-compose up` → v2 앱 정상 부팅
- [ ] 로그인 → 세션 유지 (재시작 후에도)
- [ ] 자산 CRUD (생성, 조회, 수정, 삭제) → 정상 동작
- [ ] 모듈 CRUD → module_inventory 수량 정합성
- [ ] 입출고 관리 → assets 테이블 기준으로 정상 표시
- [ ] equipment_usage_logs에 이벤트 INSERT 확인 (UPDATE 없음)
- [ ] 장비 상세 → assets 기준으로 정상 표시
- [ ] 사용 등록 → assets + computing_modules에 직접 기록
- [ ] 디스커버리 → 정규 테이블에만 기록
- [ ] 대시보드 통계 → assets 기준 정확
- [ ] 모듈 자동복원 발생하지 않음 확인
- [ ] 사진 업로드/삭제 정상
- [ ] 엑셀 업로드 정상
- [ ] IP 관리 정상
- [ ] 대여 관리 정상

### B-3 롤백

```bash
# v2/app/ 삭제 후 원본 app/에서 재복사
rm -rf v2/app/
# 또는 git reset으로 B-3 커밋 전으로 복구
git log --oneline  # B-3 시작 커밋 확인
git reset --hard <B-2-commit>
```

기존 시스템(`app/`)은 계속 운영 중이므로 v2 작업 실패 시에도 영향 없음.

---

## B-3 이후 후속 작업

> B-3 범위 밖이지만 향후 개선이 필요한 항목. 마이그레이션 완료 후 순차 진행.

### 1. 목록 페이지 페이징

- **대상**: 자산 목록, 입출고 목록, 모듈 현황 등 전체 목록 페이지
- **이유**: 현재 전체 데이터를 한 번에 로딩. 자산 1,000개 이상 환경에서 성능 저하 예상
- **방안**: `LIMIT/OFFSET` 또는 커서 기반 페이징 + 프론트엔드 페이지네이션 UI
- **우선순위**: PostgreSQL 전환 후, 데이터 증가에 따라 판단

### 2. app/config/app.js 설정값 외부화

- **대상**: 자산 유형(assetTypes), 모듈 유형(moduleTypes), 서브넷 목록(subnets), SSH 기본값(sshDefaults) 등 하드코딩된 설정값
- **현재**: `app/config/app.js`에 JavaScript 객체로 직접 정의
- **방안**: 환경변수 또는 별도 설정 파일(JSON/YAML)로 분리하여 코드 변경 없이 설정 변경 가능하도록
- **우선순위**: 기능에 영향 없으므로 안정화 후 진행

### 3. 섀시-노드 구조 개선 (블레이드 서버 UI)

- **배경**: 2026-05-19 글루시스-008 블레이드 서버 랙 배치 작업 중 발견된 UI 불편
  - 사용등록 폼에 블레이드 좌/우 선택란 없음
  - 섀시 위치 설정과 노드별 IP/계정 입력이 분리되지 않음
  - 입고 후 노드 동적 추가/삭제 불가
- **방안**: 섀시 = 1개 랙 표기, 노드 동적 관리, 사용등록 흐름 개선
- **참고**: 별도 plan 파일 (`~/.claude/plans/golden-skipping-scroll.md`)에 상세 설계 기록
- **우선순위**: 다중 노드 서버 추가 입고 시 진행

---

## B-4: 통합 테스트

### 목표
- v2 환경에서 전체 기능을 체계적으로 테스트
- 기존 데이터와 대조하여 정합성 확인
- 엣지 케이스 및 에러 처리 검증

### 산출물

```
v2/
├── tests/
│   ├── api/                    ← API 엔드포인트 테스트
│   │   ├── assets.test.js
│   │   ├── inventory.test.js
│   │   ├── moduleInventory.test.js
│   │   └── ...
│   ├── integration/            ← 화면 통합 테스트
│   │   ├── dual-source-eliminated.test.js  ← 이중 저장 제거 확인
│   │   └── data-consistency.test.js        ← 데이터 정합성
│   └── setup.js                ← 테스트 환경 설정
```

### B-4-1: 기능 테스트 매트릭스

| 카테고리 | 테스트 항목 | 검증 방법 |
|---------|-----------|----------|
| **인증** | 로그인/로그아웃/세션유지 | API 호출 + 쿠키 확인 |
| **자산 CRUD** | 생성, 조회, 수정, 삭제 | API + DB 직접 확인 |
| **모듈 관리** | 등록, 이동, 삭제, 수량 정합 | module_inventory 수치 검증 |
| **입출고** | 입고, 사용등록, 반납 | equipment_usage_logs INSERT 확인 |
| **이중저장 제거** | 자산 수정 후 equipment_usage_logs UPDATE 없음 | DB 직접 확인 |
| **IP 관리** | 서브넷 초기화, 할당, 해제 | ip_addresses 테이블 확인 |
| **사진** | 업로드, 삭제, 라이트박스 | 파일 + DB 확인 |
| **엑셀** | 업로드, 벌크 등록 | 트랜잭션 정합성 |
| **디스커버리** | SSH 스캔, 결과 적용 | computing_modules만 변경 확인 |
| **랙/서버실** | CRUD, U 위치, 전원 | 정상 동작 확인 |

### B-4-2: 데이터 정합성 대조 테스트

기존 SQLite 데이터와 PostgreSQL 데이터를 테이블별로 비교:

```
FOR EACH table IN [assets, computing_modules, module_inventory, ...]:
  sqlite_rows = SQLite에서 SELECT * ORDER BY id
  pg_rows = PostgreSQL에서 SELECT * ORDER BY id
  ASSERT sqlite_rows.length == pg_rows.length
  FOR i IN range(sqlite_rows.length):
    ASSERT sqlite_rows[i].id == pg_rows[i].id
    ASSERT sqlite_rows[i].주요컬럼 == pg_rows[i].주요컬럼
```

### B-4-3: 이중 저장 제거 확인 테스트

```
1. 자산 수정 테스트:
   - 자산 A의 model_name 수정
   - assets 테이블에 반영됨 확인
   - equipment_usage_logs에 기존 행 UPDATE 없음 확인
   - equipment_usage_logs에 신규 이벤트 INSERT만 확인

2. 모듈 추가 테스트:
   - 자산 A에 GPU 모듈 추가
   - computing_modules에 INSERT 확인
   - module_inventory 수량 감소 확인
   - equipment_usage_logs의 기존 hardware_json 변경 없음 확인

3. 모듈 삭제 후 비복원 테스트:
   - 자산 A의 모듈 삭제
   - computing_modules에서 DELETE 확인
   - 자산 상세 페이지 재접속
   - 삭제된 모듈이 자동 복원되지 않음 확인
```

### B-4 검증 체크리스트

- [ ] 전체 테스트 스위트 통과
- [ ] 데이터 정합성 대조 100% 일치
- [ ] 이중 저장 제거 확인 테스트 통과
- [ ] 동시 접속 테스트 (2~3 사용자)
- [ ] 서버 재시작 후 세션 유지 확인
- [ ] 에러 발생 시 적절한 오류 메시지 표시

### B-4 롤백

테스트 단계이므로 롤백 불필요. 발견된 문제는 B-3으로 돌아가서 수정.

---

## B-5: 배포 패키징

### 목표
- 운영 환경용 Docker 이미지 및 구성 완성
- 백업/복원 스크립트 작성
- 운영 가이드 문서 작성

### 산출물

```
v2/
├── docker-compose.yml          ← 운영용 설정 (dev 설정과 분리)
├── docker-compose.prod.yml     ← 프로덕션 오버라이드
├── Dockerfile                  ← 멀티스테이지 빌드
├── scripts/
│   ├── backup.sh              ← PostgreSQL pg_dump 백업
│   ├── restore.sh             ← 복원 스크립트
│   └── health-check.sh        ← 헬스체크
├── .env.example
└── DEPLOY.md                  ← 운영 가이드
```

### B-5-1: 프로덕션 Docker 구성

```yaml
# docker-compose.prod.yml
version: '3.8'
services:
  db:
    restart: always
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}   # .env에서 강한 비밀번호
    volumes:
      - pgdata:/var/lib/postgresql/data
    # 포트 노출하지 않음 (앱에서만 접근)

  app:
    restart: always
    build:
      target: production
    environment:
      NODE_ENV: production
    ports:
      - "${APP_PORT:-3000}:3000"
    volumes:
      - uploads:/app/public/uploads       # 사진 영구 저장
```

### B-5-2: 백업 전략

```bash
#!/bin/bash
# scripts/backup.sh
BACKUP_DIR="./backups/$(date +%Y-%m-%d)"
mkdir -p "$BACKUP_DIR"

# PostgreSQL 전체 백업
docker-compose exec -T db pg_dump -U $DB_USER -d $DB_NAME \
  --format=custom \
  --file=/tmp/backup.dump

docker cp "$(docker-compose ps -q db):/tmp/backup.dump" \
  "$BACKUP_DIR/it_assets_$(date +%H%M%S).dump"

# 사진 백업
tar czf "$BACKUP_DIR/uploads.tar.gz" -C ./public uploads/

echo "Backup completed: $BACKUP_DIR"
```

### B-5-3: 기존 자동 백업 대체

| 항목 | 현재 (v1) | 변경 후 (v2) |
|------|----------|------------|
| 방법 | `db.backup()` (SQLite API) | `pg_dump` (PostgreSQL 네이티브) |
| 주기 | 7일마다 (server.js에서) | cron 또는 Docker 내 스케줄러 |
| 형식 | `.db` 파일 복사 | `.dump` (커스텀 포맷) |
| 복원 | 파일 교체 | `pg_restore` |
| 위치 | `app/data/backups/` | `v2/backups/` |

### B-5 검증 체크리스트

- [ ] `docker-compose -f docker-compose.yml -f docker-compose.prod.yml up` → 정상 실행
- [ ] 백업 스크립트 실행 → `.dump` 파일 생성
- [ ] 복원 스크립트 실행 → 데이터 정상 복원
- [ ] 서버 재시작 후 데이터 유지 확인
- [ ] 사진 파일 영구 저장 확인

### B-5 롤백

배포 패키징 자체는 기존 시스템에 영향 없음. 파일 삭제로 원복 가능.

---

## B-6: 병행 운영 — 3단계 전환 정책

### 목표
- 기존 시스템(v1, SQLite)과 신규 시스템(v2, PostgreSQL)을 3단계로 안전하게 전환
- 데이터 무결성 보장: 어느 시점이든 단일 쓰기 소스만 존재
- 문제 발생 시 즉시 v1으로 복귀 가능

### v1 운영 정책 (B-2 ~ B-6 전환 직전)

> **핵심**: B-2 데이터 1차 이전부터 B-6 2주차 진입 시점까지, **v1은 평소대로 운영**한다.

- v1(:3000)에서 자산 등록, 수정, 모듈 관리 등 모든 업무를 정상 수행
- v1에 새로 등록되는 데이터는 B-6 1주차의 **매일 동기화로 v2에 자동 반영**됨
- v1 운영 중단은 **B-6 2주차 진입 시점 단 한 번**뿐
- B-2~B-5 기간 중 v2에서 발생하는 작업은 개발/테스트 전용이며, 운영 데이터에 영향 없음

### 운영 구조

```
v1(:3000) — 기존 Node.js + SQLite (운영)
v2(:3001) — Docker + PostgreSQL (검증 → 운영 전환)

※ v2 포트는 3001로 설정하여 충돌 방지
```

### 3단계 전환 절차

#### 1주차: v1 쓰기 + v2 읽기 전용 검증

```
목표: v2 데이터 정합성 확인 + 사용자 UI/기능 검증

Day 0 (전환 준비):
  1. docker-compose up -d (v2 :3001 배포)
  2. migrate-data.js 실행 (v1 SQLite → v2 PostgreSQL 전체 이전)
  3. verify-migration.js 실행 (행 수, FK 정합성, 시퀀스 확인)
  4. v2에 읽기 전용 모드 활성화 (쓰기 차단)
  5. 관리자에게 :3001 URL 안내

Day 1~5 (검증):
  - 사용자: v1(:3000)에서 평소대로 업무 수행
  - 관리자: v2(:3001)에서 조회만 하며 UI/데이터 검증
  - 매일 퇴근 후: v1 → v2 데이터 동기화 (아래 "매일 동기화 절차" 참조)
  - 발견된 문제: B-3으로 돌아가서 수정 후 재배포
```

**v2 쓰기 차단 방법 (환경변수 방식 — 권장)**:

```javascript
// v2/app/middleware/readOnly.js
module.exports = function readOnlyGuard(req, res, next) {
  if (process.env.READ_ONLY === 'true' && ['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    // GET과 로그인(POST /auth/login)은 허용
    if (req.path === '/auth/login') return next();
    req.flash('error', '현재 읽기 전용 모드입니다. v1(:3000)에서 작업해주세요.');
    return res.redirect('back');
  }
  next();
};

// docker-compose.yml 환경변수:
//   READ_ONLY: "true"   ← 1주차
//   READ_ONLY: "false"  ← 2주차
```

대안 비교:

| 방법 | 장점 | 단점 |
|------|------|------|
| **환경변수 미들웨어 (권장)** | 재배포 없이 변수만 변경, 로그인은 허용 | 미들웨어 코드 추가 필요 |
| 코드 내 분기 | 세밀한 제어 가능 | 코드가 복잡해짐 |
| nginx proxy 차단 | 앱 코드 변경 없음 | nginx 설정 필요, 에러 메시지 제어 어려움 |

**매일 동기화 절차 (1주차)**:

```bash
#!/bin/bash
# v2/scripts/daily-sync.sh
# 매일 퇴근 후 실행 (cron 또는 수동)
# 전제: v2는 읽기 전용이므로 v2 데이터 손실 없음

set -e
echo "[$(date)] 일일 동기화 시작"

# 1. v2 PostgreSQL 전체 초기화
docker-compose exec -T db psql -U $DB_USER -d $DB_NAME -c "
  DO \$\$ DECLARE r RECORD;
  BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'session' LOOP
      EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
  END \$\$;
"

# 2. v1 → v2 전체 재이전
node scripts/migrate-data.js

# 3. 검증
node scripts/verify-migration.js

echo "[$(date)] 일일 동기화 완료"
```

- cron 설정 예시: `0 20 * * 1-5 cd /mlcommons_cm/hpc_it_management/v2 && bash scripts/daily-sync.sh >> logs/sync.log 2>&1`
- 동기화 중 v2 서비스 중단 불필요 (TRUNCATE + INSERT는 빠름, 데이터 6,000행 수준)
- 동기화 방식: 전체 재이전 (방법 A). 1주차에는 v2에 쓰기가 없으므로 데이터 손실 없음

#### 2주차: v1 동결 + v2만 쓰기

```
목표: v2를 유일한 쓰기 소스로 전환

Day 6 (전환일):
  1. v1 마지막 동기화: daily-sync.sh 실행
  2. v1 쓰기 차단:
     - 방법 A (권장): v1 Node.js 프로세스 중지
     - 방법 B: v1에도 읽기 전용 미들웨어 적용
  3. v2 읽기 전용 해제: READ_ONLY=false로 변경 → docker-compose restart app
  4. 전체 사용자 공지: "지금부터 :3001에서 작업해주세요"

Day 6~10:
  - 모든 사용자: v2(:3001)에서 업무 수행
  - v1은 읽기 전용 또는 중지 상태
  - 문제 발견 시 → 아래 "롤백" 절차 수행
```

#### 전환: v2를 :3000 포트로 변경

```
목표: v2가 기존 :3000 포트를 사용하도록 최종 전환

전환 순서 (다운타임 예상: 1~2분):
  1. v1 프로세스 완전 중지 (이미 2주차에서 중지한 상태라면 생략)
     $ pm2 stop all  # 또는 kill / systemctl stop
  2. v2 포트 변경
     $ cd /mlcommons_cm/hpc_it_management/v2
     # docker-compose.yml에서 APP_PORT를 3001 → 3000으로 변경
  3. v2 재시작
     $ docker-compose down && docker-compose up -d
  4. 접속 확인
     $ curl -s http://localhost:3000 | head -5
  5. 사용자 공지: "기존 주소(:3000)로 접속하세요"

※ 다운타임 = v2 down → up 시간 (~1분) + v1 중지 확인 (~10초)
※ v1 프로세스가 :3000을 점유 중이면 v2가 바인딩 실패하므로 반드시 v1을 먼저 중지
```

### B-6 검증 체크리스트

- [ ] **1주차**: v1(:3000)과 v2(:3001) 동시 접속 가능
- [ ] **1주차**: v2에서 쓰기 차단 동작 확인 (POST → 에러 메시지)
- [ ] **1주차**: 매일 동기화 후 v2 데이터 정합성 확인
- [ ] **2주차**: v2에서 전체 기능 정상 동작 (CRUD, 모듈, 입출고)
- [ ] **2주차**: v1 쓰기 차단 또는 중지 확인
- [ ] **전환**: v2가 :3000에서 정상 서비스
- [ ] **전환**: 모든 사용자 접속 확인

### B-6 롤백

```
[1주차 롤백] 아무 조치 불필요
  - v2를 중단해도 v1은 :3000에서 정상 운영 중
  - docker-compose down으로 v2만 정리

[2주차 롤백] v1 쓰기 재활성화
  1. v2 중단: docker-compose down
  2. v1 재시작: node app/server.js (또는 pm2 restart)
     → v1의 SQLite DB는 2주차 시작 시점까지의 데이터 보유
  3. 2주차 동안 v2에 입력된 데이터 → 수동 보충 필요 (필요 시)

[전환 후 롤백] v2 중단 → v1 복원
  1. docker-compose down
  2. v1 프로세스 재시작 (:3000)
  3. SQLite DB 기준으로 서비스 재개
  4. 전환 이후 v2에만 있는 데이터 → PostgreSQL에서 수동 추출하여 보충
```

---

## B-7: 전환 완료 + 정리

### 목표
- v1 시스템 완전 중지
- v2를 주 포트(:3000)로 전환
- 정리 작업 수행

### B-7-1: 최종 전환 절차

```
1. v1 마지막 데이터 이전
   - v1 중지 직전에 최종 migrate-data.js 실행
   - verify-migration.js로 정합성 확인

2. v1 중지
   - pm2 stop / systemctl stop 등으로 v1 Node.js 프로세스 중지
   - 단, 파일은 삭제하지 않음 (롤백 대비)

3. v2 포트 변경
   - docker-compose.yml에서 APP_PORT를 3000으로 변경
   - docker-compose restart app

4. DNS/방화벽 확인
   - :3000 포트가 v2(Docker)로 연결되는지 확인

5. 사용자 공지
   - 전환 완료 안내
```

### B-7-2: 정리 작업

| 항목 | 작업 | 시기 |
|------|------|------|
| v1 소스코드 | `app/` → `app.v1.bak/` 또는 별도 브랜치 보관 | 전환 후 1주일 |
| SQLite DB | `app/data/it_assets.db` → `archive/` 이동 | 전환 후 1주일 |
| 백업 파일 | `backup/` → 아카이브 | 전환 후 1개월 |
| v2 폴더 구조 | `v2/` → 프로젝트 루트로 정리 | 전환 후 안정화 확인 |
| Git 히스토리 | v1 마지막 상태 태깅: `git tag v1.0-final` | 전환 직전 |
| 고아 테이블 | `inventory_logs` — PostgreSQL에 미생성 (이미 제거됨) | B-1에서 처리 |
| 레거시 컬럼 | assets의 `ip_address`, `ssh_port`, `ssh_user`, `ssh_password` — 사용 여부 확인 후 DROP | 전환 후 |

### B-7-3: 레거시 컬럼 정리 (전환 후)

assets 테이블에 남아있는 SSH 관련 컬럼은 asset_ips/asset_credentials로 이전되어 중복:

| 컬럼 | 현재 용도 | 정리 방침 |
|------|----------|----------|
| `assets.ip_address` | 일부 코드에서 직접 참조 | B-3에서 asset_ips로 전환 후 DROP 가능 |
| `assets.ssh_port` | SSH 접속 시 사용 | B-3에서 확인 후 결정 |
| `assets.ssh_user` | SSH 접속 시 사용 | B-3에서 확인 후 결정 |
| `assets.ssh_password` | SSH 접속 시 사용 | B-3에서 확인 후 결정 |

### B-7 검증 체크리스트

- [ ] v2가 :3000에서 정상 서비스
- [ ] 모든 사용자 접속 확인
- [ ] 백업 스크립트 정상 동작
- [ ] v1 파일 안전하게 아카이브
- [ ] 1주일 안정 운영 확인

### B-7 롤백

```bash
# v2 중단
docker-compose down

# v1 복원
cd /mlcommons_cm/hpc_it_management
node app/server.js  # 또는 pm2/systemctl로 v1 재시작

# SQLite DB는 그대로 보존되어 있으므로 즉시 복귀 가능
```

---

## 13. 전체 롤백 전략

### 핵심 원칙

> **v1(`app/`)은 B-7 완료 전까지 절대 수정/삭제하지 않는다.**

어느 단계에서든 문제가 발생하면 v2 작업만 중단/삭제하고 v1으로 즉시 복귀할 수 있다.

### 단계별 롤백 요약

| 단계 | 롤백 방법 | 데이터 손실 | 기존 시스템 영향 |
|------|----------|-----------|----------------|
| B-1 | `docker-compose down -v` + `rm -rf v2/` | 없음 | 없음 |
| B-2 | DB 초기화: `TRUNCATE` + init.sql 재실행 | v2 DB만 | 없음 |
| B-3 | `git reset` + v2/app/ 재복사 | v2 코드만 | 없음 |
| B-4 | 테스트 수정 + 재실행 | 없음 | 없음 |
| B-5 | 설정 파일 수정 | 없음 | 없음 |
| B-6 | `docker-compose down` → v1 계속 운영 | v2 데이터만 | 없음 |
| B-7 | v2 중단 → v1 재시작 (파일 보존 상태) | v2 전환 후 데이터 | SQLite DB 기준 복구 |

### 최악의 시나리오 대비

```
만약 B-7 이후 v2에 심각한 문제 발견:
1. docker-compose down (v2 중단)
2. node app/server.js (v1 즉시 재시작)
3. SQLite DB로 서비스 재개
4. B-6 기간 중 마지막 SQLite → PostgreSQL 동기화 이후의 데이터만 손실
5. v2의 PostgreSQL에서 해당 기간 데이터를 수동으로 SQLite에 보충 (필요 시)
```

### Git 태그 전략

```bash
git tag v1.0-final          # B-7 시작 전 (v1 마지막 상태)
git tag v2.0-b1-complete     # B-1 완료 시
git tag v2.0-b2-complete     # B-2 완료 시
git tag v2.0-b3-complete     # B-3 완료 시
git tag v2.0-b4-complete     # B-4 완료 시
git tag v2.0-b5-complete     # B-5 완료 시
git tag v2.0-b6-start        # B-6 병행 운영 시작
git tag v2.0-released        # B-7 전환 완료
```

---

## 부록: 환경 정보

| 항목 | 값 |
|------|-----|
| OS | Linux 4.18.0-448.el8.x86_64 (RHEL/CentOS 8) |
| 아키텍처 | x86_64 |
| Docker | 23.0.1 |
| Docker Compose | v2.16.0 |
| Node.js | v18.20.5 |
| 현재 DB | SQLite 3.x (better-sqlite3 ^9.6.0) |
| 대상 DB | PostgreSQL 16 (Alpine) |
| 운영 포트 | 3000 |
| DB 파일 | app/data/it_assets.db (1.9MB) |
| 테이블 수 | 22개 (SQLite) → 21개 (PostgreSQL, inventory_logs 제거) |
| 행 수 | 약 6,000행 |
| 사용자 수 | 13명 |
