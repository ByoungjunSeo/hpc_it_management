# MIGRATION_PLAN.md 검토 Q&A

> **작성일**: 2026-05-19
> **기반 문서**: MIGRATION_PLAN.md, ARCHITECTURE.md
> **분석 방법**: 실제 코드 전수 검사 (20개 모델, 23개 라우트, EJS 템플릿)

---

## 질문 1: async 전환 작업의 실제 범위

### 1-1) 20개 모델 파일의 함수 개수

| 모델 파일 | 함수 수 | 주요 함수 |
|-----------|--------|----------|
| asset.js | 23 | findAll, findById, create, update, delete, findByIpWithCredentials 등 |
| equipmentUsageLog.js | 21 | findAll, findAllEquipment, getHistory, create, update, countByStatus 등 |
| moduleInventory.js | 13 | findAll, findByCode, recalculateInUse, adjustQuantity, upsert 등 |
| ipAddress.js | 12 | initializeSubnets, findBySubnet, assign, release, syncAllAssets 등 |
| rack.js | 12 | findAll, findById, create, update, delete, getRoomUsageStats 등 |
| vendorIntake.js | 13 | findAll, findByToken, generateToken, submit, approve, reject 등 |
| networkConnection.js | 12 | findByRoom, create, update, batchUpdateFields, batchDelete 등 |
| computingModule.js | 10 | findAll, findById, findByAsset, create, update, delete, bulkCreate |
| lending.js | 10 | findAll, create, update, markReturned, markFaultReturned 등 |
| user.js | 9 | findAll, findById, authenticate, create, update, delete, ensureAdmin |
| photo.js | 9 | findByEntity, findById, create, bulkCreate, delete |
| inventoryLog.js | 9 | findAll, create, delete, findByAsset, countByType |
| powerNode.js | 8 | findByRoom, findById, create, update, delete, buildTree |
| serverRoom.js | 7 | findAll, findById, findByName, create, update, delete |
| moduleInventoryLog.js | 7 | create, findByItemCode, findByAsset, findAll |
| moduleTransferLog.js | 6 | create, bulkCreate, findByAsset, findAll |
| auditLog.js | 6 | log, findAll, findByTarget, getUsers |
| vendor.js | 5 | findAll, findById, create, update, delete |
| assetCredential.js | 4 | findByAsset, bulkCreate, deleteByAsset |
| assetIp.js | 4 | findByAsset, bulkCreate, deleteByAsset |
| **합계** | **200** | |

### 1-2) 영향받는 라우트 핸들러 수

- 전체 라우트 핸들러: **147개** (23개 파일)
- 현재 async인 핸들러: **3개** (discovery.js 1개, racks.js 2개)
- **async 전환이 필요한 핸들러: 144개 (97.96%)**

핸들러 수가 많은 라우트:

| 라우트 파일 | 핸들러 수 | 전환 필요 |
|------------|----------|----------|
| inventory.js | 18 | 18 |
| moduleInventory.js | 16 | 16 |
| assets.js | 14 | 14 |
| discovery.js | 14 | 13 |
| lendings.js | 10 | 10 |
| racks.js | 10 | 8 |
| (나머지 17개) | 65 | 65 |

### 1-3) await 누락 시 나타나는 증상

```javascript
// 실수 예시: await 누락
router.get('/:id', (req, res) => {
  const asset = Asset.findById(req.params.id);  // await 빠짐
  res.render('detail', { asset });  // asset = Promise 객체
});
```

증상:
- **EJS 템플릿에 `[object Promise]` 출력** — 가장 흔한 증상. 데이터 대신 Promise 객체가 전달됨
- **`Cannot read property 'xxx' of undefined`** — Promise에서 .model_name 등 접근 시
- **빈 페이지 / 빈 목록** — `.length`가 undefined가 되어 반복문 미실행
- **조건 분기 오류** — `if (asset)` → Promise는 항상 truthy이므로 항상 통과
- **데이터 미저장** — INSERT/UPDATE의 await 누락 시 실행 순서 보장 안 됨, 트랜잭션 깨짐
- **에러가 조용히 사라짐** — unhandled promise rejection이 catch 없이 무시됨

핵심: **앱이 크래시하지 않고 "이상하게 동작"하는 게 가장 위험**. 디버깅이 어려움.

### 1-4) await 누락 자동 검출 방법

**ESLint로 자동 검출 가능:**

```json
// .eslintrc.json
{
  "rules": {
    "@typescript-eslint/no-floating-promises": "error",  // TS 전용
    "require-await": "warn",                              // async 함수 내 await 없으면 경고
    "no-return-await": "warn"                             // 불필요한 return await 경고
  }
}
```

다만 이 프로젝트는 TypeScript가 아니므로 `@typescript-eslint/no-floating-promises`는 못 씀. 대안:

1. **`eslint-plugin-promise`의 `no-floating-promise` 룰** — JS에서도 사용 가능하지만 한계 있음
2. **수동 검증 패턴**: 모든 모델 함수가 `async`이므로, 호출부에서 `await` 없이 쓰이는 곳을 grep:
   ```bash
   # 모든 모델 호출 중 await 없는 것 찾기
   grep -n "= [A-Z][a-zA-Z]*\." routes/*.js | grep -v "await\|require\|const.*=.*require"
   ```
3. **가장 확실한 방법**: B-3 완료 후 모든 페이지를 한 번씩 열어서 `[object Promise]` 텍스트가 렌더링되는지 확인. 기계적으로 전수 검사 가능.
4. **Node.js 옵션**: `--unhandled-rejections=throw` 플래그로 실행하면 누락된 await가 있을 때 프로세스 크래시 → 발견 용이

### 1-5) B-3에서 async 전환이 차지하는 비중

B-3의 세부 작업을 분해하면:

| 하위 작업 | 변경 대상 | 비중 추정 |
|-----------|----------|----------|
| 모델 200함수 async 전환 + `?` → `$1` 파라미터 변환 | 20개 파일 | **35%** |
| 라우트 144핸들러 async/await 적용 | 23개 파일 | **25%** |
| 이중 저장 코드 제거 + 화면 전환 (핵심 리팩토링) | 3개 파일 | **25%** |
| 트랜잭션 패턴 전환 + server.js/config 변경 | 5개 파일 | **10%** |
| SQL 구문 변환 (LIKE→ILIKE, GROUP_CONCAT→STRING_AGG 등) | 전체 | **5%** |

async 전환 자체(모델+라우트)가 **약 60%**로 가장 큰 비중. 하지만 대부분 기계적 변환(패턴이 동일)이라 난이도는 중간. 실제 난이도가 높은 건 이중 저장 제거(25%)쪽.

---

## 질문 2: 병행 운영(B-6) 동안 데이터 흐름

### 2-1) 검증 기간 동안 어느 쪽이 쓰기를 받나

MIGRATION_PLAN.md에서는 명확히 정의하지 않았는데, 이것이 가장 중요한 정책 결정 사항.

**현실적 선택지 2가지**:

| 정책 | v1 쓰기 | v2 쓰기 | 장점 | 단점 |
|------|---------|---------|------|------|
| A. v1만 쓰기 | O | X (읽기만) | 롤백 시 데이터 손실 없음 | v2 쓰기 기능을 검증 못함 |
| B. v2만 쓰기 | X (읽기만) | O | v2를 실전 검증 가능 | 롤백 시 v2 데이터를 v1으로 옮겨야 함 |

**양쪽 동시 쓰기는 절대 불가** — DB가 다르므로 데이터 불일치 발생.

### 2-2) v2에서 쓰기 받다가 롤백할 때 데이터 처리

v2에서 쓰기를 받았다면:
- v2의 PostgreSQL에 쌓인 데이터는 **PostgreSQL에 그대로 남아있음**
- v1의 SQLite에는 해당 데이터가 **없음**
- 롤백(v1 복귀) 시: PostgreSQL에서 해당 기간의 신규/수정 데이터를 수동으로 SQLite에 옮겨야 함
- 이 "역방향 이전"(PG → SQLite)은 MIGRATION_PLAN.md에 **마련되어 있지 않음** — 보강 필요

### 2-3) "데이터 재동기화"가 구체적으로 하는 것

MIGRATION_PLAN.md에서 제시한 2가지 방법:

- **방법 A (전체 재이전)**: v1 SQLite → v2 PostgreSQL 방향. `migrate-data.js`를 다시 실행하여 PostgreSQL을 통째로 교체. v2에서 작업한 데이터는 사라짐.
- **방법 B (증분 동기화)**: v1 SQLite에서 `updated_at > 마지막 동기화 시각`인 행만 골라서 v2 PostgreSQL에 반영. v2 데이터 보존 가능하지만 충돌 해결 로직 필요.

두 방법 모두 **v1 → v2** 방향만 정의되어 있고, **v2 → v1** 역방향은 없음.

### 2-4) 가장 안전한 정책 추천

**3단계 전환 정책**:

```
[1주차] v1만 쓰기, v2는 읽기 전용 검증
  - 전체 사용자: v1(:3000) 사용
  - 관리자만: v2(:3001)에서 조회/검색 검증
  - 매일 퇴근 후 migrate-data.js로 v1 → v2 동기화

[2주차] v2만 쓰기, v1은 동결
  - v1 쓰기 차단 (viewer 권한으로 변경 또는 별도 플래그)
  - 전체 사용자: v2(:3001) 사용
  - v1은 롤백용 스냅샷으로 보존

[전환] v2를 :3000으로 변경
  - 문제 없으면 v2 포트 전환
  - v1 프로세스 중지
```

핵심: **쓰기를 한쪽에만 집중**하여 데이터 분기를 방지. 1주차의 v1 → v2 동기화는 전체 재이전(방법 A)으로 충분 (데이터가 1.9MB로 작아서 수초 내 완료).

---

## 질문 3: 데이터 이전 순서와 손실 위험

### 3-1) 외래키 의존성 그래프

```
Level 0 (부모 없음):
  server_rooms
  vendor_info
  users
  lendings
  module_inventory (FK 없음, 논리적 참조만)

Level 1 (→ Level 0):
  racks → server_rooms
  audit_logs → users

Level 2 (→ Level 0~1):
  assets → racks, vendor_info, server_rooms, assets(자기참조)

Level 3 (→ Level 2):
  computing_modules → assets, vendor_info
  asset_ips → assets
  asset_credentials → assets
  ip_addresses → assets
  lending_items → lendings
  vendor_intake_requests → assets
  power_nodes → server_rooms, power_nodes(자기참조), assets
  network_connections → server_rooms, assets, vendor_info
  photos → (다형성, FK 없음)

Level 4 (→ Level 3):
  module_inventory_logs → assets (신규 FK)
  module_transfer_logs → assets (신규 FK)
  equipment_usage_logs → assets (신규 FK)
```

**이전 순서** (MIGRATION_PLAN.md 대로):
```
1. server_rooms → 2. vendor_info → 3. users → 4. racks
→ 5. assets (자기참조: parent_asset_id가 NULL인 것 먼저, 자식은 후순위)
→ 6. computing_modules → 7. ip_addresses → 8. asset_ips
→ 9. asset_credentials → 10. module_inventory
→ 11. module_inventory_logs → 12. module_transfer_logs
→ 13. equipment_usage_logs → 14. lendings → 15. lending_items
→ 16. photos → 17. audit_logs → 18. vendor_intake_requests
→ 19. power_nodes (자기참조: parent_id=NULL 먼저)
→ 20. network_connections
```

**자기참조 테이블 주의점**:
- `assets.parent_asset_id → assets.id`: 부모 자산 먼저, 블레이드 자식 나중
- `power_nodes.parent_id → power_nodes.id`: 루트 노드 먼저, 자식 나중
- 두 테이블 모두 FK OFF 상태에서 한 번에 넣고, FK ON 후 무결성 검증하는 방법도 가능

### 3-2) equipment_usage_logs 727행 JSONB 변환 시 손실 여부

실제 코드를 분석한 결과, equipment_usage_logs에서 **검색/필터에 사용되는 컬럼**은:

| 컬럼 | 필터 방식 | JSONB 전환 후 |
|------|----------|-------------|
| status | WHERE = | **새 스키마에 `event_type` 컬럼으로 유지** — 손실 없음 |
| room | WHERE = | **새 스키마에 `room` 컬럼으로 유지** — 손실 없음 |
| rack | (room과 함께 표시) | **새 스키마에 `rack` 컬럼으로 유지** — 손실 없음 |
| unit | (room과 함께 표시) | **새 스키마에 `unit` 컬럼으로 유지** — 손실 없음 |
| user_name | WHERE = | **새 스키마에 `user_name` 컬럼으로 유지** — 손실 없음 |
| ownership | WHERE = | **새 스키마에 `ownership` 컬럼으로 유지** — 손실 없음 |
| usage_date | DATE RANGE | **새 스키마에 `event_date`로 매핑** — 손실 없음 |
| management_number | WHERE = / LIKE | **새 스키마에 유지** — 손실 없음 |
| model_name | LIKE | **새 스키마에 유지** — 손실 없음 |
| test_name | LIKE | **새 스키마에 `test_name` 추가 필요** — 현재 MIGRATION_PLAN.md에 빠져 있음 |
| asset_number | LIKE | **새 스키마에 유지** — 손실 없음 |
| notes | LIKE | **새 스키마에 유지** — 손실 없음 |
| return_date | DATE RANGE | **새 스키마에 보존 방법 필요** — 현재 빠져 있음 |

**JSONB로 들어가는 컬럼** (ip1~ip4, bmc, ib1~ib2, cpu_type, mem1_type, ...):
- 현재 이 컬럼들로 **검색/필터하는 UI가 없음** — 코드 전수 검사 확인 완료
- 따라서 JSONB 통합으로 인한 **검색 기능 손실 없음**
- 데이터 자체는 JSONB 안에 그대로 보존 (필드명까지 포함)

**보강 필요 사항 2건**:
1. 새 스키마에 `test_name`, `test_detail` 컬럼 추가 (현재 누락)
2. 새 스키마에 `return_date` 컬럼 추가 또는 이벤트 분리 방안 (반납 이벤트에서 사용)

### 3-3) 이전 중 50% 시점에 실패하면

`migrate-data.js`는 **테이블 단위 트랜잭션**으로 설계:

```
서버 시작 → BEGIN
  server_rooms 9행 INSERT → COMMIT

BEGIN
  vendor_info 13행 INSERT → COMMIT

...실패 지점 (예: assets 이전 중)...
  → ROLLBACK (assets 테이블만 롤백)
```

복구 방법:
```bash
# PostgreSQL 전체 초기화
docker-compose exec db psql -U itadmin -d it_assets -c "
  DO \$\$ DECLARE r RECORD;
  BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
  END \$\$;
"
# 처음부터 다시 실행
node scripts/migrate-data.js
```

SQLite 원본은 읽기만 했으므로 영향 없음.

### 3-4) 지우고 다시 이전하는 절차

**마련되어 있음** — MIGRATION_PLAN.md B-2 롤백 절차:

```bash
# 방법 1: TRUNCATE + 재이전
docker-compose exec db psql -U itadmin -d it_assets -c "
  DO \$\$ DECLARE r RECORD;
  BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
  END \$\$;
"
node scripts/migrate-data.js

# 방법 2: 볼륨 삭제 + 처음부터
docker-compose down -v && docker-compose up -d db
# init.sql 자동 실행 → 빈 스키마 생성
node scripts/migrate-data.js
```

데이터가 1.9MB로 작아서 전체 재이전이 수초 내 완료되므로, 증분보다 전체 재이전이 항상 안전.

---

## 질문 4: JSONB 변환의 검색/필터 영향

### 4-1) equipment_usage_logs를 검색/필터하는 화면

코드 전수 검사 결과, 입출고 관리 장비 탭(`/inventory?tab=equipment`)에 **필터 UI가 존재**:

| 필터 | 대상 컬럼 | JSONB 전환 영향 |
|------|----------|----------------|
| 상태 드롭다운 | status | 없음 (독립 컬럼 유지) |
| 소유 드롭다운 | ownership | 없음 (독립 컬럼 유지) |
| 장소 드롭다운 | room | 없음 (독립 컬럼 유지) |
| 사용자 드롭다운 | user_name | 없음 (독립 컬럼 유지) |
| 날짜 범위 | usage_date, return_date | 없음 (독립 컬럼 유지) |
| 텍스트 검색 | management_number, model_name, user_name, test_name, asset_number, notes | 없음 (독립 컬럼 유지) |

**하드웨어 컬럼(cpu_type, mem1_type, ip1 등)으로 검색하는 UI는 없음.**
따라서 **JSONB 통합에 의한 검색 기능 손실은 없음.**

### 4-2) 만약 향후 JSONB 검색이 필요하다면

```sql
-- hardware_snapshot에서 GPU 모델 검색
SELECT * FROM equipment_usage_logs
WHERE hardware_snapshot @> '{"gpu": [{"type": "NVIDIA A100"}]}';

-- network_snapshot에서 특정 IP 검색
SELECT * FROM equipment_usage_logs
WHERE network_snapshot @> '[{"ip": "192.168.1.100"}]';

-- 부분 텍스트 검색 (JSONB 내 값에 LIKE 적용)
SELECT * FROM equipment_usage_logs
WHERE hardware_snapshot::text ILIKE '%A100%';
```

### 4-3) GIN 인덱스 계획

현재 MIGRATION_PLAN.md에는 GIN 인덱스 언급이 **없음**. 이유:

- 하드웨어 컬럼을 검색하는 기능이 현재 없음
- 727행 (이력 테이블)에서는 인덱스 없이도 충분히 빠름
- 향후 필요 시:
  ```sql
  CREATE INDEX idx_eul_hardware ON equipment_usage_logs USING GIN (hardware_snapshot);
  CREATE INDEX idx_eul_network ON equipment_usage_logs USING GIN (network_snapshot);
  ```

### 4-4) 이력 테이블 5년 후 규모 추정

현재 데이터 기준:

| 테이블 | 현재 행 수 | 증가 속도 (추정) | 5년 후 |
|--------|----------|----------------|--------|
| equipment_usage_logs | 727 | ~300행/년 (입출고 빈도 기준) | ~2,200행 |
| audit_logs | 1,253 | ~500행/년 | ~3,750행 |
| module_inventory_logs | 273 | ~200행/년 | ~1,300행 |
| module_transfer_logs | 296 | ~200행/년 | ~1,300행 |

**5년 후 전체 DB 크기 추정: 10~20MB**

성능 저하 우려: **없음.**
- PostgreSQL은 수백만 행까지 기본 인덱스만으로 충분
- 현재 자산 168개 × 5년 = 자산 500~800개 수준
- JSONB 컬럼이 있어도 행 수가 수천 단위이므로 풀스캔도 밀리초 단위

---

## 질문 5: 다양한 규모 배포 지원

### 5-1) 규모별 추가 설정 필요 여부

| 항목 | 소규모 (50개/2명) | 중규모 (500개/10명) | 대규모 (5000개/50명) |
|------|------------------|--------------------|--------------------|
| Docker Compose | 그대로 사용 | 그대로 사용 | 그대로 사용 |
| PostgreSQL 설정 | 기본값 | 기본값 | `shared_buffers`, `work_mem` 튜닝 권장 |
| Node.js | 단일 프로세스 | 단일 프로세스 | PM2 클러스터 모드 고려 |
| 세션 저장소 | connect-pg-simple | 동일 | 동일 |
| 디스크 | 100MB | 500MB | 2~5GB |
| RAM | 512MB | 1GB | 2~4GB |
| `.env` 변경 | 없음 | 없음 | `DB_POOL_MAX=20` 등 |

**결론: 소/중규모는 추가 설정 불필요. 대규모만 `.env`에서 풀 크기 조정 정도.**

### 5-2) 신규 설치 회사의 설치 절차 (B-2 불필요)

```bash
# 1. 소스 받기
git clone <repo> && cd v2

# 2. 환경 설정
cp .env.example .env
# .env에서 DB_PASSWORD, SESSION_SECRET만 변경

# 3. 실행
docker-compose up -d
# init.sql → 빈 스키마 생성
# seed.sql → admin 계정 생성

# 4. 접속
http://localhost:3000
# admin / (seed.sql에 정의된 초기 비밀번호) 로 로그인
```

B-2(데이터 이전)는 완전히 건너뜀. `init.sql`이 빈 테이블을 만들고, `seed.sql`이 admin 계정만 넣어줌. 이 절차는 MIGRATION_PLAN.md B-1에 이미 정의되어 있음.

### 5-3) 백업/복원 안내

MIGRATION_PLAN.md B-5에 `backup.sh`/`restore.sh` 스크립트가 정의되어 있음. README에는:

```
## 백업
./scripts/backup.sh
# → backups/2026-05-18/it_assets_153000.dump 생성

## 복원
./scripts/restore.sh backups/2026-05-18/it_assets_153000.dump
# → 기존 데이터 덮어쓰고 백업 시점으로 복원

## 자동 백업 (crontab 등록)
0 2 * * * /path/to/v2/scripts/backup.sh
```

### 5-4) .env 외에 추가 설정이 필요한가

| 설정 파일 | 내용 | 필수 여부 |
|-----------|------|----------|
| `.env` | DB 비밀번호, 포트, 세션 시크릿 | 필수 |
| `app/config/app.js` | 자산유형, 모듈유형, 서브넷, SSH 기본값 | 회사마다 다를 수 있음 |

`app.js`에 하드코딩된 설정:
- 자산 유형 목록 (server, switch, pdu, ...)
- 모듈 유형 목록 (cpu, memory, gpu, ...)
- 서브넷 목록 (10.10.x.x/24 등)
- SSH 기본 계정 (root/qwe123)

이것들은 현재 코드에 하드코딩되어 있어서, 다른 회사가 쓰려면 `app.js`를 수정해야 함. `.env`나 DB 설정 테이블로 빼는 것은 B-3 이후 후속 작업으로 고려 가능.

### 5-5) 대규모(자산 5000개)에서 성능 이슈 가능 지점

| 지점 | 현재 코드 | 자산 5000개 시 문제 | 대응 |
|------|----------|-------------------|------|
| 자산 목록 GET /assets | `SELECT * ... ORDER BY` 전체 반환 | 5000행 한 번에 렌더링 | 페이징 추가 필요 |
| 대시보드 통계 | 여러 COUNT 쿼리 | 큰 문제 없음 (인덱스 있음) | — |
| IP 관리 초기화 | /24 서브넷 × 여러 개 = 수만 행 | 이미 2,304행, 서브넷 추가 시 증가 | 서브넷별 지연 로딩 |
| 모듈 재고 재계산 | 서버 시작 시 전체 computing_modules 스캔 | 5000 × 5모듈 = 25,000행 | 시작 시간 수초 증가, 허용 범위 |
| 엑셀 업로드 | 한 번에 수백 행 INSERT | 트랜잭션 크기 증가 | 배치 단위 분할 |
| 서버실/랙 렌더링 | 한 서버실의 전체 자산 렌더링 | 한 방에 수백 자산 가능 | 페이징 또는 가상 스크롤 |

**가장 시급한 것: 목록 페이지들의 페이징**. 현재 모든 목록이 전체 데이터를 한 번에 반환. 자산 5000개면 브라우저 렌더링이 느려질 수 있음. 다만 이것은 B-3 이후 후속 개선 사항.

---

## 질문 6: 운영 서버 작업 관련

### 6-1) 운영 DB를 실수로 건드릴 가능성 차단

MIGRATION_PLAN.md에는 **원칙만 명시** ("운영 DB는 읽기 전용으로만 접근")되어 있고, **기술적 차단 수단은 없음**.

현재 DB 파일 권한:
```
-rw-r--r-- mlcommons:mlcommons  app/data/it_assets.db
```

보강 가능한 방법:
1. **v2 Docker 컨테이너에서 `app/data/` 경로를 아예 마운트하지 않음** — 가장 확실
2. 마운트하더라도 `read-only` 플래그: `volumes: - ../app/data:/legacy-data:ro`
3. `migrate-data.js`에서만 `better-sqlite3`로 읽기 전용 열기: `new Database(path, { readonly: true })`

### 6-2) v2 Docker 컨테이너가 운영 시스템에 영향 줄 가능성

| 위험 | 가능성 | 대응 |
|------|--------|------|
| 포트 충돌 | v1(:3000)과 v2(:3001) 분리 | 없음 |
| 디스크 가득 참 | Docker 데이터가 /mlcommons_cm에 있으므로 루트 영향 없음 | 없음 |
| 메모리 과다 사용 | 아래 6-4 참조 | 영향 미미 |
| 운영 DB 수정 | 위 6-1 참조 | 마운트 안 하면 불가 |
| 네트워크 충돌 | Docker 브릿지는 172.17.0.0/16, 운영과 무관 | 없음 |

### 6-3) v2 환경 디스크 공간 요구 추정

| 항목 | 크기 |
|------|------|
| PostgreSQL 16 Alpine 이미지 | ~230MB |
| Node.js 18 Alpine 이미지 | ~180MB |
| 앱 소스 + node_modules | ~200MB |
| PostgreSQL 데이터 (DB) | ~15MB |
| 업로드 사진 (복사 시) | ~100MB |
| Docker 빌드 캐시 | ~300MB |
| **합계** | **~1GB** |

현재 /mlcommons_cm에 5.9TB 여유이므로 전혀 문제 없음.

### 6-4) v1 + v2 동시 실행 시 리소스 영향

현재 서버 상태:
```
CPU:  72코어 Intel Xeon Gold 6140
RAM:  1TB 중 9.7GB 사용 (991GB 여유)
```

| 프로세스 | CPU | RAM |
|---------|-----|-----|
| v1 Node.js (현재) | ~0% | 117MB |
| v2 Node.js (예상) | ~0% | ~120MB |
| PostgreSQL (예상) | ~0% | ~100MB (기본 shared_buffers 128MB) |
| Docker daemon | ~0% | 136MB |
| **합계 추가분** | 무시 가능 | ~350MB |

**영향: 사실상 없음.** 서버 리소스가 매우 여유로움 (RAM 991GB 중 350MB 추가).
