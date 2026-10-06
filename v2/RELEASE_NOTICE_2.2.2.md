# IT 자산관리 시스템 v2.2.2 배포 공지

수신: 배포 대상 팀 인프라 담당자 (Docker 운용 가능 전제)

## 1. 개요

HPC/AIDC 장비실의 서버·모듈·IP·입출고를 웹에서 통합 관리하는 자산관리 시스템입니다.
이번 **2.2.2**는 v2.2.1 대비 **코드만 변경한 버그 수정 릴리스**입니다. 스키마(DB) 변경은 없으며,
입출고 사진이 엉뚱한 장비에 보이던 문제, 사용등록 시 입출고 이력에 장비 연결 누락, 부품 입고 사진 유실,
반납 시 IP 미회수를 바로잡았습니다. 전달물은 아래 1파일입니다.

- `it-assets-dist-2.2.2.tar.gz` (전달 번들)
- 앱 이미지 tar `it-assets-2.2.2.tar` (번들 내부, `docker load` 대상)
  - sha256: `707f868fc9815aa50da000bd39bf94e4b2985e42c6d650667c9393a99e3e27ff`
  - 적재 전 `sha256sum it-assets-2.2.2.tar` 로 **반드시 대조**하세요(이미지 `it-assets:2.2.2`).

tar 안에 앱/DB docker 이미지 2종(오프라인 설치용), 설치 문서(DEPLOY.md), compose 파일,
환경변수 템플릿(.env.example), 스키마 SQL, 백업/복원 스크립트가 모두 들어 있어
**인터넷 없이 설치 가능**합니다.

## 2. v2.2.1 → v2.2.2 주요 변경 (버그 수정 — 사용자 관점)

| 버그 | 사용자 관점 변경 |
|------|------|
| BUG-19 | **입출고 사진이 엉뚱한 장비에 보이던 문제를 바로잡았습니다** — 과거 데이터 이관(7/11) 때 사진-장비 연결이 어긋나, 한 장비 상세에 다른 장비의 입고 사진이 섞여 보이던 문제. 잘못 연결된 사진 10장을 원래 장비로 되돌렸고(데이터 정정 완료), 이후 연결이 다시 어긋나지 않도록 사진을 **장비 고유 번호(id) 기준**으로 묶도록 바꿨습니다. |
| BUG-22 | **사용등록하면 그 기록이 해당 장비에 제대로 연결**됩니다 — 입고·사용등록 시 입출고 이력에 장비 연결(asset_id)이 비어 있던 경로를 메꿔, 장비 상세의 입출고 사진·이력이 올바로 묶입니다. |
| BUG-24 | **부품 입고 때 올린 사진이 부품 현황에서 보입니다** — 기존에는 입고 사진이 '0번'으로 잘못 저장돼 어느 화면에도 안 뜨고 사실상 유실됐는데, 해당 부품에 정확히 연결되도록 고쳤습니다. |
| BUG-25 | **장비를 반납하면 그 장비가 쓰던 IP가 자동으로 회수**됩니다 — 반납 후에도 IP가 '사용 중'으로 묶여 재배정이 막히던 문제를 해소(IP 풀에서 '사용 가능'으로 복귀). 예약(reserved) IP는 건드리지 않습니다. |

> 참고(진단 정정): 앞선 조사에서 사진 오노출 원인을 "관리번호 조인" 문제(BUG-18)로 봤으나, 실제 원인은
> 데이터 이관 시 사진-장비 연결 어긋남(BUG-19)으로 확인되어 정정했습니다. 코드상 사진 조회는 장비 id 기준으로 유지합니다.

## 3. 설치 (신규)

동봉 **DEPLOY.md §1(리눅스)/§2(윈도우)** 절차 그대로. 이미지 적재(docker load) → `.env` 작성 →
`docker compose up -d` → 브라우저 접속(`http://<서버IP>:3001`, 최초 admin / INITIAL_ADMIN_PASSWORD).
DB 스키마는 첫 기동 시 자동 생성됩니다. (v2.2.1과 **스키마 동일** — 아래 §5 참조.)

> ⚠ **재설치/이전 버전 위 재설치 시 볼륨 청결 필수.** DB 스키마는 **빈 데이터 볼륨에서만** 자동 생성됩니다.
> 완전 새 설치는 `docker compose -f docker-compose.prod.yml down -v`(⚠ 데이터 삭제)로 볼륨을 비운 뒤
> `up -d` 하세요.

## 4. ★ 보안 필수 조치 (.env)

`.env.example` → `.env` 복사 후 **CHANGE_ME 값 변경**. v2.2.1과 **동일**(POSTGRES_PASSWORD·
INITIAL_ADMIN_PASSWORD·SESSION_SECRET·CREDENTIAL_ENCRYPTION_KEY·SSH_DEFAULT_PASSWORD·LENDING_ORG_LABEL).
**신규 환경변수 없음.**

> ⚠ **CREDENTIAL_ENCRYPTION_KEY 분실 시 저장된 장비 자격증명을 복구할 수 없습니다.** DB 백업과 **별도 장소**에
> 보관하세요.

## 5. 업그레이드 (2.2.1 → 2.2.2) — **코드만 변경, DDL 없음**

v2.2.2는 **애플리케이션 코드만 바뀐 릴리스**입니다. **DB 스키마 변경·신규 마이그레이션이 없으므로**
이미지 교체 + 재기동만 하면 됩니다.

```bash
# 1) 백업(권장) → 2) 새 이미지 적재
bash scripts/backup.sh
docker load -i it-assets-2.2.2.tar
# 3) .env에 APP_IMAGE=it-assets:2.2.2 로 교체(또는 기본값 사용) 후 재기동
docker compose -f docker-compose.prod.yml up -d
```

- **마이그레이션 실행 불필요** — v2.2.1에서 2.2.2로 올릴 때 적용할 신규 `.sql`이 **없습니다**
  (v2.2.1 이후 db/스키마/migrations 변경 0건 확인).
- ⚠ `down -v` 절대 금지(데이터·업로드 named volume 보존). 재기동 전 SESSION_SECRET(32자+)·
  CREDENTIAL_ENCRYPTION_KEY(hex64) 실값 확인.
- 호스트에서 앱을 직접 구동하는 배포(비-compose)라면 `git pull` 후 `sudo systemctl restart it-assets-v2`
  로 충분합니다(npm 신규 의존성 없음).
- 신규 설치는 위 과정 불필요(첫 기동에 자동 생성, 스키마는 v2.2.1과 동일).

## 6. ★ 기존 데이터는 자동 보정되지 않습니다 (설치본별 수동 점검)

v2.2.2의 코드 수정은 **업그레이드 이후 발생하는 동작**을 고칩니다. **이미 쌓인 과거 데이터는 자동으로 바뀌지 않으므로**,
각 설치본에서 아래 쿼리로 자가 점검한 뒤, 해당분이 있으면 관리자 판단으로 1회 수동 보정하세요.
(쿼리는 모두 **읽기 전용 확인용**입니다. 접속: `docker exec -i <DB컨테이너> psql -U <유저> -d <DB>`.)

### 6-1. BUG-24 — 부품 사진 entity_id=0 (유실 사진 점검)
업그레이드 전에 부품 입고 중 올린 사진은 `entity_id=0`으로 저장돼 화면에 안 보일 수 있습니다.
```sql
-- 유실(미연결) 부품 사진 조회
SELECT id, file_path, uploaded_at, uploaded_by
FROM photos
WHERE entity_type = 'module' AND entity_id = 0
ORDER BY uploaded_at;
```
- 결과가 있으면, 각 사진이 어느 부품(module_inventory.id)의 입고분인지 업로드 시각·파일로 식별해
  `UPDATE photos SET entity_id = <해당 module_inventory.id> WHERE id = <photo.id>;` 로 1회 보정(트랜잭션 권장).
- **사진 파일 자체는 삭제하지 마세요**(UI 삭제는 디스크 파일을 함께 지웁니다).

### 6-2. BUG-25 — 반납/비활성 장비가 아직 점유 중인 IP 점검
업그레이드 전 반납분은 IP가 풀에 `assigned`로 남아 있을 수 있습니다.
```sql
-- 이미 반납/비활성인데 IP를 아직 점유 중인 건 조회
SELECT ip.ip_address, ip.allocation_type, a.management_number, a.status
FROM ip_addresses ip
JOIN assets a ON a.id = ip.asset_id
WHERE ip.allocation_type = 'assigned'
  AND a.status IN ('returned', 'inactive', 'decommissioned')
ORDER BY a.status, ip.ip_address;
```
- 회수할 범위를 정한 뒤(예: 반납분만) 1회 보정:
  ```sql
  BEGIN;
  UPDATE ip_addresses ip
  SET allocation_type = 'available', asset_id = NULL, assigned_to = NULL, updated_at = NOW()
  FROM assets a
  WHERE ip.asset_id = a.id AND ip.allocation_type = 'assigned'
    AND a.status = 'returned';   -- 'inactive' 포함 여부는 운영 판단
  -- 영향 행수 확인 후 COMMIT (아니면 ROLLBACK)
  COMMIT;
  ```
- **reserved(예약) IP는 포함하지 마세요**(의도적 홀드).

> 참고(운영본 현황): 본 시스템(컴퓨팅지원팀 운영본)은 BUG-19 사진 오귀속 10장, BUG-25 **반납(returned)분 IP 2건**을 수동 보정했습니다.
> 다만 **BUG-24 유실 사진 4건(photos 58~61)과 BUG-25 비활성(inactive) 장비 점유 IP 25건은 운영본도 미보정**입니다.
> 따라서 위 점검은 **운영본을 포함한 모든 설치본**에 적용됩니다.

## 7. 검증 범위 (중요)

- 위 수정(BUG-19/22/24/25)은 **격리 스택에서 HTTP 실경로 검증까지 완료**했습니다.
- **운영 인수(실 사용자 브라우저 확인)는 미완**입니다. 업그레이드 후 아래를 인수하세요:
  - 장비 상세의 입출고 사진이 올바른 장비 것만 보이는지(BUG-19)
  - 신규 사용등록 시 입출고 이력·사진이 그 장비에 묶이는지(BUG-22)
  - 부품 입고 사진이 부품 현황에 뜨는지(BUG-24)
  - 장비 반납 후 IP가 '사용 가능'으로 회수되는지(BUG-25)

## 8. Known limitation (v2.2.1에서 승계 — 변동 없음)

- **웹 백업 생성은 표준 compose 배포에서 동작하지 않습니다.** compose 배포는 백업을 호스트에서
  `bash scripts/backup.sh`(CLI)로 생성하세요(웹의 목록/다운로드/복원 가이드는 참고용).
- 재고 점검은 MVP 범위(대시보드 배지·추이 차트·PDF/Excel 보고서는 다음 릴리스).

## 9. 지원/문의
- 인프라검증팀 sbj8388@tta.or.kr
