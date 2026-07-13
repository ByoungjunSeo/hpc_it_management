# IT 자산관리 시스템 v2.1.0 배포 공지

수신: 배포 대상 팀 인프라 담당자 (Docker 운용 가능 전제)

## 1. 개요

HPC/AIDC 장비실의 서버·모듈·IP·입출고를 웹에서 통합 관리하는 자산관리 시스템입니다.
이번 전달 버전은 **2.1.0**이며(타 팀 배포 첫 정식본 — 2.0.x는 사내 검증본으로 미발송),
전달물은 아래 1파일입니다.

- `it-assets-dist-2.1.0.tar.gz`
- sha256: `418f21528a83742a275bd7f41847ace15f4ea072d01dadee6b11a678c2adf88a`
  — 수령 후 `sha256sum`으로 반드시 대조하세요.

tar 안에 앱/DB docker 이미지 2종(오프라인 설치용), 설치 문서(DEPLOY.md),
compose 파일, 환경변수 템플릿(.env.example), 스키마 SQL(+마이그레이션),
백업/복원 스크립트가 모두 들어 있어 **인터넷 없이 설치 가능**합니다.

## 2. 주요 기능

기본 자산 관리(서버·랙 실장·부품 재고·IP·입출고·감사 로그·통합 검색)에 더해, 이번 버전은
데이터 정확성·보안·운영 편의를 다음과 같이 강화했습니다.

| 구분 | 내용 |
|------|------|
| 검색 | 통합 검색이 **관리번호/자산번호**로도 자산을 찾습니다 |
| 랙 배치 | 선반을 **1/3U(홀) 단위**로 정밀 등록 ("선반 포함" U+홀 병행) |
| 데이터 품질 | 실(서버실/사무실) 이름 **중복 방지**(공백/대소문자 변형까지 차단) |
| 보안 — 세션 | **SESSION_SECRET 기동 시 강제 검사**(미설정/기본값 방치 불가) |
| 보안 — 자격증명 | 장비 접속 비밀번호(SSH/BMC)를 **DB에 AES-256-GCM 암호화** 저장. 화면·API는 기본적으로 값을 숨기고 **[보기]/[복사]** 로만 조회(조회 시 감사 로그 기록) |
| 재고 점검 | **장비실 재고 실사 기능 신규** — 점검 세션 생성 → 실물 수량 입력(모바일/인쇄표) → 시스템 재고와 차이 대조 → 보정 적용/원복, 이력 관리 |

## 3. 설치 (신규)

동봉된 **DEPLOY.md §1(리눅스) / §2(윈도우)** 절차를 그대로 따르면 됩니다.
이미지 적재(docker load) → `.env` 작성 → `docker compose up -d` → 브라우저 접속,
실측 수 분 내 완료(`http://<서버IP>:3001`, 최초 로그인 admin / INITIAL_ADMIN_PASSWORD).
DB 스키마(재고 점검·자격증명 암호화 컬럼 포함)는 첫 기동 시 자동 생성됩니다.

## 4. ★ 보안 필수 조치

`.env.example`을 `.env`로 복사한 뒤 **CHANGE_ME 값 6종을 실제 값으로 변경**하세요.

| 키 | 구분 | 미변경 시 |
|----|------|-----------|
| POSTGRES_PASSWORD | **기동 필수** | compose가 기동 차단(에러) |
| INITIAL_ADMIN_PASSWORD | **최초 기동 필수** | 앱이 안내와 함께 기동 중단 |
| SESSION_SECRET | **기동 필수** | 미설정/CHANGE_ME/32자 미만이면 기동 차단. 32자 이상 무작위(`openssl rand -hex 32`) |
| CREDENTIAL_ENCRYPTION_KEY | **자격증명 기능 사용 시 필수** | hex 64자(`openssl rand -hex 32`). **형식이 틀리면 기동 차단**. 미설정이면 기동은 되나 장비 자격증명 저장/조회 불가 — 이 기능을 쓰면 반드시 설정 |
| SSH_DEFAULT_PASSWORD | 기능 사용 시(SSH 스캔 fallback) | 미설정이어도 기동·일반 사용 무영향 |
| LENDING_ORG_LABEL | 표기용(대여 라벨 기관명) | 기본값 "TTA"로 표기 — 자기 기관명으로 변경 |

> ⚠ **CREDENTIAL_ENCRYPTION_KEY 분실 시 저장된 장비 자격증명을 복구할 수 없습니다.**
> 이 키는 **DB 백업과 별도 장소**(비밀번호 관리자/봉인 봉투 등)에 보관하세요 — 키와 DB를
> 함께 잃으면 자격증명 재입력만이 복구 수단입니다.

최초 로그인 후 관리자 비밀번호를 즉시 변경하기를 권장합니다.

## 5. 업그레이드 안내 (2.0.x → 2.1.0, 미래용)

현재 수신 팀은 **모두 신규 설치**이므로 이 절은 향후 v2.1.0을 운영하다 다음 릴리스로
올릴 때의 참고입니다(2.0.x 운영본이 있는 경우의 절차). **DEPLOY.md §6** 체계를 따르되,
스키마 변경이 있는 릴리스는 아래처럼 마이그레이션을 순서대로 적용합니다.

```bash
# 1) 백업(필수) → 2) 새 이미지 적재
bash scripts/backup.sh
docker load -i it-assets-<새버전>.tar
# 3) 마이그레이션 적용 (db/migrations/*.sql — 파일명 순번(_1/_2/_3)이 적용 순서를 보장, 전부 멱등)
for f in db/migrations/*.sql; do
  docker compose -f docker-compose.prod.yml exec -T db psql -U itadmin -d it_assets < "$f"
done
# 4) (자격증명 암호화 최초 도입 시) .env에 CREDENTIAL_ENCRYPTION_KEY 설정 + 서버 외부 백업 후
#    새 compose로 재기동(아래 5) → 평문→암호문 이관 스크립트를 컨테이너에서 실행:
#    docker compose -f docker-compose.prod.yml exec -T app node scripts/encrypt-credentials.js
#    (순서: 마이그레이션 → 키 설정 → 재기동 → encrypt-credentials.js. 스크립트는 앱 이미지에 포함)
# 5) .env에 APP_IMAGE=it-assets:<새버전> + 새 compose 교체 후 재기동
docker compose -f docker-compose.prod.yml up -d
```

- ⚠ 재기동 전 `.env`의 SESSION_SECRET(32자+)·CREDENTIAL_ENCRYPTION_KEY(hex64) 실값 확인.
- DB 데이터·업로드 사진은 named volume에 보존(`down -v` 절대 금지 — DEPLOY.md §7).
- 신규 설치는 위 과정이 불필요합니다(스키마·컬럼이 첫 기동에 자동 생성).

## 6. Known limitation

- 재고 점검은 MVP 범위입니다 — 세션·실물 입력·보정·원복·이력을 제공하며, 대시보드 알림
  배지·이력 추이 차트·PDF/Excel 보고서는 다음 릴리스 예정입니다.

## 7. 지원/문의

- 컴퓨팅지원팀 sbj8388@tta.or.kr
