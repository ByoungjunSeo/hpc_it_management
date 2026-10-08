# IT 자산관리 시스템 v2.4.1 배포 공지 — 보안 보완

수신: 배포 대상 팀 인프라 담당자 (Docker 운용 가능 전제)

## 1. 개요

v2.4.1은 **자격증명(비밀번호) 노출을 차단하는 보안 보완 릴리스**입니다(AI-ON 검토 지적 대응).
응답·이력·감사 로그에 남던 평문 비밀번호를 제거하고, 복호화 조회 권한을 상향했습니다.
**스키마 변경(DDL)은 없으나, 기존 데이터의 평문 비밀번호 제거를 위한 마이그레이션 실행이 필수**입니다.

- `it-assets-dist-2.4.1.tar.gz` (전달 번들) · 앱 이미지 `it-assets-2.4.1.tar`
  - sha256(image): `9ce3960fd30a4ee1f1b1060b27967978a9f81d4c635e8de2fc4f944116064e01`
  - 적재 전 `sha256sum it-assets-2.4.1.tar` 대조(이미지 `it-assets:2.4.1`).

## 2. 보안 보완 내역

### 2-1. 응답/화면에서 비밀번호 제거
- `GET /inventory/api/asset/:id`(사용등록 prefill): 복호화 비밀번호·레거시 `ssh_password` 제거 → 마스킹본(`has_password`)만.
- `GET /discovery/assets`(JSON)·서버실 자산목록: 비밀번호 제거(마스킹본). 스캔 접속용 복호화는 **서버 내부에서만** 수행.
- 자격증명 **[보기](reveal)**: **viewer 차단** — 유지보수/관리자만 복호화 조회(감사 로그 유지).
- 이력관리 화면(`/audit-log`): viewer 접근 차단(유지보수 이상).

### 2-2. 이력(입출고 스냅샷) 평문 제거
- 사용등록 이력(`credentials_snapshot`)에 비밀번호를 저장하지 않음 — `type·username·has_password`만.
- 장비 상세·사용등록 화면: 비밀번호는 `●●●●●● 등록됨/미등록`으로만 표시.
- **prefill 후 비밀번호 칸을 비우고 저장하면 기존 비밀번호가 유지**됩니다(덮어쓰기·삭제 안 함).

### 2-3. 감사 로그 마스킹
- 신규 감사 로그 저장 시 `password/ssh_password/cred_passwords` 등 비밀번호성 키 값을 **자동 마스킹**(한 곳에서 처리).
- 기존 감사 로그의 평문 비밀번호 값은 운영 조치 스크립트로 1회 치환(§5 절차, 관리자 승인 후).

### 2-4. 레거시 `ssh_password` 비저장
- discovery 스캔/자동 생성 시 자산 행에 `ssh_password`를 **저장하지 않고**, 접속 시 `.env`의 `SSH_DEFAULT_PASSWORD`에서 읽습니다. (컬럼 자체 폐기는 v2.5.0)

## 3. 설치 (신규)
신규 설치는 §DEPLOY 그대로. 마이그레이션 불필요(빈 DB에 최신 스키마 생성).

## 4. ★ 보안 필수 조치 (.env)
v2.4.0과 동일, **신규 환경변수 없음**.

## 5. 업그레이드 (2.4.x → 2.4.1) — 마이그레이션 필수

마이그레이션/감사 스크립트는 `CREDENTIAL_ENCRYPTION_KEY`·`POSTGRES_*`가 있는 환경에서 실행합니다.
먼저 **`--dry-run`으로 대상을 확인**(쓰기 없음)한 뒤 실제 실행하세요. 배포 형태에 따라 실행 방식만 다릅니다.

**(A) compose 배포 — 앱 컨테이너 안에서 실행**(컨테이너 env 사용):
```bash
# 1) 백업
DB_CONTAINER_NAME=<DB컨테이너> bash scripts/backup.sh
# 2) 마이그레이션 (dry-run → 실제). 스크립트를 컨테이너로 복사해 실행:
docker cp db/migrations/2026-10-09_1_v241_credentials_plaintext.js <APP컨테이너>:/app/_mig.js
docker exec <APP컨테이너> node /app/_mig.js --dry-run     # 대상 확인(①이전 N / ②snapshot M행)
docker exec <APP컨테이너> node /app/_mig.js               # 실제 적용
# 3) (승인 후) 기존 감사 로그 평문 치환
docker cp db/ops/v241_audit_mask_20261009.js <APP컨테이너>:/app/_audit.js
docker exec <APP컨테이너> node /app/_audit.js --dry-run   # 대상 id·키 확인
docker exec <APP컨테이너> node /app/_audit.js             # 실제 치환
docker exec <APP컨테이너> rm -f /app/_mig.js /app/_audit.js
# 4) 확인(평문 0) — eul_rows_with_plaintext / legacy_plaintext_password_rows / audit_plaintext 모두 0
docker exec -i <DB컨테이너> psql -U itadmin -d it_assets -v ON_ERROR_STOP=1 < db/migrations/2026-10-09_1_v241_credentials_plaintext.verify.sql
# 5) 새 이미지 적재 + .env APP_IMAGE=it-assets:2.4.1 → 재기동
docker load -i it-assets-2.4.1.tar
docker compose -f docker-compose.prod.yml up -d
# 6) 재기동 후 새 백업(평문 없는 상태) — §6 경고 참조
DB_CONTAINER_NAME=<DB컨테이너> bash scripts/backup.sh
```

**(B) systemd(호스트) 배포 — 호스트에서 직접 실행**(`.env`는 스크립트가 dotenv로 로드, `NODE_PATH`만 지정):
```bash
cd <repo>/v2
NODE=<node경로>; export NODE_PATH=<repo>/v2/app/node_modules
DB_CONTAINER_NAME=<DB컨테이너> bash scripts/backup.sh
$NODE db/migrations/2026-10-09_1_v241_credentials_plaintext.js --dry-run   # 확인
$NODE db/migrations/2026-10-09_1_v241_credentials_plaintext.js             # 적용
$NODE db/ops/v241_audit_mask_20261009.js --dry-run                        # 확인(승인 후)
$NODE db/ops/v241_audit_mask_20261009.js                                   # 치환
docker exec -i <DB컨테이너> psql -U itadmin -d it_assets -v ON_ERROR_STOP=1 < db/migrations/2026-10-09_1_v241_credentials_plaintext.verify.sql
sudo systemctl restart it-assets-v2        # systemd는 docker load·APP_IMAGE 변경 불필요
DB_CONTAINER_NAME=<DB컨테이너> bash scripts/backup.sh
```
> `--dry-run`은 BEGIN 후 ROLLBACK(마이그레이션)·SELECT만(감사)으로 **쓰기 없이** 대상 수·운영 키 암호화 왕복만 확인합니다. `db/ops/`는 전달 번들에 미포함(저장소에만) — compose 사이트는 저장소/별도 전달본에서 복사하세요.

## 6. ★ 기존 백업·장비 비밀번호 주의
- **업그레이드 이전에 만든 DB 백업(`db/*.dump`)·평문 덤프에는 비밀번호 평문이 그대로 남아 있습니다.** 업그레이드·마이그레이션 후 **새 백업을 생성**하고, **이전 백업은 관리자 판단으로 안전 폐기**하세요(폐기 목록은 관리자가 직접 결정·실행).
- 평문 노출 이력이 있으므로, 노출되었을 수 있는 **장비 접속 비밀번호는 변경을 권고**합니다.

## 7. Known limitation / 알려진 이슈
- **감사 로그가 제한적인 화면**: 랙 작업(이동·배치·생성/수정/삭제 다수), 로그인 실패, 벤더 입고 신청 일부는 변경 감사가 남지 않거나 제한적입니다("전 화면 감사"는 과장이라 문구 정정). *(감사 커버리지 확대는 후속)*
- (승계) BUG-26(사용등록 U겹침 미검사)·BUG-28(관리번호 UNIQUE 부재)·BUG-29(일부 반납 rack_id 미해제, 조사 예정).
- 레거시 `assets.ssh_password` 컬럼 폐기는 v2.5.0 예정(현재는 비저장·응답 제거까지).

## 8. 지원/문의
- 인프라검증팀 sbj8388@tta.or.kr
