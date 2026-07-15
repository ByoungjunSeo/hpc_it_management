# IT 자산관리 시스템 v2.2.0 배포 공지

수신: 배포 대상 팀 인프라 담당자 (Docker 운용 가능 전제)

## 1. 개요

HPC/AIDC 장비실의 서버·모듈·IP·입출고를 웹에서 통합 관리하는 자산관리 시스템입니다.
이번 전달 버전은 **2.2.0**이며, v2.1.0 대비 **원격 접근 스위트**(전원제어·웹 SSH·BMC SOL 콘솔·백업 관리)와
블레이드 노드 일괄 등록·대여 장부를 추가하고 위치 데이터 정합 버그를 바로잡았습니다. 전달물은 아래 1파일입니다.

- `it-assets-dist-2.2.0.tar.gz`
- sha256: `<빌드 후 기입>` — 수령 후 `sha256sum`으로 반드시 대조하세요.

tar 안에 앱/DB docker 이미지 2종(오프라인 설치용), 설치 문서(DEPLOY.md), compose 파일,
환경변수 템플릿(.env.example), 스키마 SQL(+마이그레이션), 백업/복원 스크립트가 모두 들어 있어
**인터넷 없이 설치 가능**합니다.

## 2. v2.1.0 → v2.2.0 주요 변경

| 구분 | 내용 |
|------|------|
| 원격 — 전원 | **BMC 전원제어(on/off/reset)** 랙 팝업에서. 비밀번호는 `-E`(IPMI_PASSWORD env)로 전달(명령행 노출 없음) |
| 원격 — SSH | **웹 SSH 터미널**(관리자) — 브라우저 셸(ws+xterm), 서버 내부에서만 복호화, TOFU 호스트키, 동시세션·유휴 제한, 입출력 미기록 감사 |
| 원격 — BMC SOL | **웹 BMC SOL 콘솔**(관리자) — ipmitool `sol activate` 브릿지, 접속 전·종료 시 `sol deactivate`, 동일 BMC 동시 1세션. **[BMC 웹]** 버튼(BMC 웹 UI 새 탭) |
| 원격 — 백업 | **백업 관리 화면**(관리자) — 생성/목록/다운로드/삭제 + 복원 가이드(웹 실행은 안 함). pg_dump `-Fc`, 14개 회전 (**compose 배포 제약 — §6 Known limitation**) |
| 자산 | **블레이드 다노드 일괄 등록**(섀시 상세 → 노드 번호 범위로 일괄 생성, 단일 트랜잭션) |
| 대여 | **대여 장부** — 대여/반납·연체·자산 연결·재고 자동 차감/복귀·부분 반납 |
| 데이터 정합(수정) | 자식 노드 사용등록이 부모 섀시 위치를 덮어쓰던 문제(BUG-9), 다노드 입고 노드 식별자 미저장(BUG-10) 해소 — **`node_index` 신규 컬럼** |

## 3. 설치 (신규)

동봉 **DEPLOY.md §1(리눅스)/§2(윈도우)** 절차 그대로. 이미지 적재(docker load) → `.env` 작성 →
`docker compose up -d` → 브라우저 접속(`http://<서버IP>:3001`, 최초 admin / INITIAL_ADMIN_PASSWORD).
DB 스키마(node_index·ssh_host_keys 포함)는 첫 기동 시 자동 생성됩니다.

> ⚠ **재설치/이전 버전 위 재설치 시 볼륨 청결 필수.** DB 스키마는 **빈 데이터 볼륨에서만** 자동 생성됩니다.
> 같은 서버에서 이전 버전을 설치한 적이 있으면 `pgdata` 볼륨이 남아 **구 스키마가 유지**되어 "신규 설치"인데도
> `column ... does not exist` 오류가 날 수 있습니다. 완전 새 설치는 `docker compose -f docker-compose.prod.yml
> down -v`(⚠ 데이터 삭제)로 볼륨을 비운 뒤 `up -d` 하세요. 앱은 기동 시 스키마 최신 여부를 점검해 로그로 안내합니다.

## 4. ★ 보안 필수 조치 (.env)

`.env.example` → `.env` 복사 후 **CHANGE_ME 값 변경**. v2.1.0과 동일(POSTGRES_PASSWORD·
INITIAL_ADMIN_PASSWORD·SESSION_SECRET·CREDENTIAL_ENCRYPTION_KEY·SSH_DEFAULT_PASSWORD·LENDING_ORG_LABEL).

> ⚠ **CREDENTIAL_ENCRYPTION_KEY 분실 시 저장된 장비 자격증명을 복구할 수 없습니다.** DB 백업과 **별도 장소**에
> 보관하세요. 특히 **백업 파일을 다른 서버로 복원**할 때 그 서버의 키가 다르면 자격증명 복호화가 불가하니,
> 복원 대상 서버에 **동일한 키**를 먼저 준비하세요.

### v2.2.0 신규 환경변수(모두 선택 — 기본값 있음, `.env.example`에 주석으로 수록)
- `SSH_TERM_MAX_TOTAL`/`_PER_USER`/`_IDLE_MINUTES` (웹 SSH 터미널 세션 제한)
- `SOL_TERM_MAX_TOTAL`/`_PER_USER`/`_IDLE_MINUTES` (웹 BMC SOL 콘솔 세션 제한)
- `DB_CONTAINER_NAME` (웹 백업·backup.sh가 `docker exec`할 DB 컨테이너명, 기본 compose 표준 `it-assets-db-1`)
- `BACKUP_KEEP_COUNT` (웹 백업 보존 개수, 기본 14)

### 의존 요건
- **ipmitool**: 전원제어·SOL·PSU 감지 — **앱 이미지에 포함**.
- **네트워크**: BMC 623/UDP·SSH 22/TCP 아웃바운드(원격 기능 사용 시).
- **백업**: §6 Known limitation 참조.

## 5. 업그레이드 (2.1.0 → 2.2.0)

**DEPLOY.md §6** 체계. 스키마 마이그레이션 **4종**을 순서대로(파일명 순번이 순서·전부 멱등):
```bash
# 1) 백업(필수) → 2) 새 이미지 적재
bash scripts/backup.sh
docker load -i it-assets-2.2.0.tar
# 3) 마이그레이션 적용 (v2.1.0 이후 신규 4종)
for f in db/migrations/2026-07-14_1_bl13_lending_ledger.sql \
         db/migrations/2026-07-14_2_t2_ssh_host_keys.sql \
         db/migrations/2026-07-14_3_bl2_blade_slot_unique.sql \
         db/migrations/2026-07-15_1_bug9_10_node_index.sql; do
  docker compose -f docker-compose.prod.yml exec -T db psql -U itadmin -d it_assets < "$f"
done
# 4) .env에 APP_IMAGE=it-assets:2.2.0 + 새 compose 교체 후 재기동
docker compose -f docker-compose.prod.yml up -d
```
- ⚠ `down -v` 절대 금지(데이터·업로드 named volume 보존). 재기동 전 SESSION_SECRET(32자+)·
  CREDENTIAL_ENCRYPTION_KEY(hex64) 실값 확인.
- **검증됨(격리)**: v2.1.0 스키마 + 위 4종 마이그레이션 = v2.2.0 신규 설치 스키마와 **완전 동일**
  (컬럼 321·인덱스 78·제약 86 diff 0).
- 신규 설치는 위 과정 불필요(첫 기동에 자동 생성).

## 6. Known limitation

- **웹 백업 생성은 표준 compose 배포에서 동작하지 않습니다.** compose의 앱 컨테이너에는 docker 소켓/CLI가
  없어(보안상 미마운트) 컨테이너 안에서 `docker exec pg_dump`를 할 수 없습니다. **compose 배포는 백업을
  호스트에서 `bash scripts/backup.sh`(CLI)로 생성**하세요(웹의 목록/다운로드/복원 가이드는 참고용). 웹 백업
  생성은 앱을 호스트에서 직접 실행하고 그 계정이 docker 그룹인 배포에서 동작합니다. (compose 앱 컨테이너에서
  웹 백업까지 지원하는 개선은 후속 예정 — DEPLOY.md §5-1 참조.)
- 재고 점검은 MVP 범위(대시보드 배지·추이 차트·PDF/Excel 보고서는 다음 릴리스).

## 7. 지원/문의
- 컴퓨팅지원팀 sbj8388@tta.or.kr
