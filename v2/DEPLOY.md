# IT 자산관리 시스템 v2 — 배포 가이드

데이터 0에서 `docker compose up` 한 번으로 기동되는 자립형 패키지입니다.
사내망(인터넷 불확실)을 전제로 이미지는 `docker save` tar로 전달합니다.

---

## 0. 구성 요소

| 파일 | 역할 |
|------|------|
| `it-assets-2.0.1.tar` | 앱 이미지 (별도 전달, `docker load`). 로드 태그: **`it-assets:2.0.1`** |
| `postgres-16-alpine.tar` | **DB 이미지 (오프라인 필수 — 아래 ⚠)** |
| `docker-compose.prod.yml` | DB(postgres:16-alpine) + 앱 스택 |
| `db/*.sql` | 최초 기동 시 스키마 자동 생성 |
| `.env.example` | 환경변수 템플릿 (`.env`로 복사해 작성) |
| `scripts/backup.sh` / `restore.sh` | 백업 / 복원 |

> ⚠ **DB 이미지도 반드시 함께 전달하세요.** 인터넷이 있는 환경에서
> `docker pull postgres:16-alpine && docker save postgres:16-alpine -o postgres-16-alpine.tar`
> 로 만들어 앱 tar와 같이 넘깁니다. 이게 없으면 오프라인 환경에서 `compose up` 시
> DB 컨테이너가 이미지를 내려받지 못해 뜨지 않고, **앱 컨테이너도 DB를 기다리다 종료됩니다.**

이미지는 인터넷/사내미러가 있는 환경에서 빌드해 tar로 만듭니다(앱 이미지에 ipmitool 포함 — apt 필요).
빌드 예: `docker build -t it-assets:2.0.1 .` → `docker save it-assets:2.0.1 -o it-assets-2.0.1.tar`
(용량을 줄이려면 `docker save ... | gzip > it-assets-2.0.1.tar.gz` 도 가능 — `docker load -i`는 tar/tar.gz 모두 자동 인식.)

> **deb.debian.org 차단 환경(사내망) 빌드**: `--build-arg APT_MIRROR=<미러>`로 apt 소스를
> 사내/공개 미러로 교체(main·updates만, security는 스킵)합니다. 미지정 시 기본값은 원본
> deb.debian.org(회귀 0).
> ```
> docker build --build-arg APT_MIRROR=http://mirror.kakao.com/debian -t it-assets:2.0.1 .
> ```
> 실검증 이력: 2.0.1 이미지는 사무 PC(윈도우)에서 사무망의 deb.debian.org 도메인 차단으로
> kakao 미러(http, security 제외)를 경유해 빌드·전달했고, 서버 격리 스택에서 정품 검증(amd64,
> ipmitool 1.8.19, 버전 2.0.1) 통과. (서버 자체도 deb.debian.org egress가 막혀 기본 경로
> 실빌드는 불가 — 미러 ARG 경로로만 재현 확인됨. 기본 경로 동작은 Dockerfile 로직상
> 원본 소스 무변경으로 보장.)
> compose.prod.yml의 앱 이미지 태그는 **`it-assets:2.0.1`** 고정입니다. 다른 태그로 로드했다면
> `.env`에 `APP_IMAGE=<태그>` 를 지정하세요. (배포 tar에는 Dockerfile이 없어 compose가 빌드하지 않습니다.)

---

## 1. 리눅스 서버 설치

```bash
# 1) 이미지 적재 — 앱 + DB 둘 다 (→ "Loaded image: ..." 출력 확인)
#    docker load -i는 .tar(무압축)·.tar.gz(압축) 모두 자동 인식
docker load -i it-assets-2.0.1.tar       # → it-assets:2.0.1
docker load -i postgres-16-alpine.tar    # → postgres:16-alpine
#   (온라인 환경이면 이 두 줄 대신 첫 up에서 자동 pull됨)

# 2) 환경변수 작성 (CHANGE_ME 전부 채움 — 특히 아래 필수 키)
cp .env.example .env
vi .env

# 3) 기동 (DB 스키마 자동 생성 + admin 자동 시드)
docker compose -f docker-compose.prod.yml up -d

# 4) 접속: http://<서버IP>:<APP_PORT>  (기본 3001)
#    최초 로그인: admin / <INITIAL_ADMIN_PASSWORD>

# 5) IP 관리를 쓸 경우: IP 관리 화면에서 [＋ 서브넷 등록]으로 사용 대역을 등록
#    (CIDR /16~/30, 등록 시 IP 풀 자동 생성). 서버실→랙→자산 등록은 화면에서 진행.
```

> DB가 먼저 정상 기동해야 앱이 뜹니다(앱은 `depends_on: db(service_healthy)`로 대기).
> 앱이 바로 꺼지면 먼저 `docker compose -f docker-compose.prod.yml ps` 로 **db가 healthy인지** 확인하세요.

> 여러 인스턴스를 한 호스트에서 돌리려면 프로젝트명을 분리하세요:
> `docker compose -p <이름> -f docker-compose.prod.yml up -d` (컨테이너명이 `<이름>-app-1` 등이 됨).
> backup/restore도 `COMPOSE_PROJECT=<이름>` 환경변수로 같은 컨테이너를 가리킵니다.

필수 `.env` 키(미설정 시 기동 실패):
- `POSTGRES_PASSWORD` — DB 비밀번호
- `SESSION_SECRET` — 세션 암호화 키. **32자 이상 무작위 문자열 필수** —
  미설정·CHANGE_ME 방치·32자 미만이면 기동이 차단됩니다(생성 예: `openssl rand -hex 32`).
- `INITIAL_ADMIN_PASSWORD` — 최초 admin 비밀번호(첫 기동에만 사용, 멱등)
---

## 2. 윈도우 데스크탑 설치

> **한글 파일 편집 주의**: `.env`·`DEPLOY.md` 등은 **메모장 또는 VS Code**로 여세요.
> PowerShell `cat`(=Get-Content)은 UTF-8 한글이 깨져 보이지만 **파일이 손상된 것은 아닙니다**.
> 콘솔에서 한글 확인이 필요하면 먼저 `chcp 65001`(UTF-8 코드페이지) 실행.

1. **Docker 런타임 설치** — 둘 중 하나:
   - **Docker Desktop** (WSL2 백엔드): 개인/소규모는 무료, 대기업은 유료 구독 확인 필요.
   - **Rancher Desktop** (오픈소스 대안, 라이선스 부담 없음) — dockerd(moby) 모드 선택.
   - 설치 시 WSL2 활성화 필요(Windows 기능 → "Linux용 Windows 하위 시스템").
2. PowerShell 또는 WSL 터미널에서 §1과 동일. 윈도우는 `docker load -i`로 tar를 바로 적재:
   ```powershell
   docker load -i it-assets-2.0.1.tar
   docker load -i postgres-16-alpine.tar
   copy .env.example .env    # 메모장/VS Code로 열어 CHANGE_ME 채움
   docker compose -f docker-compose.prod.yml up -d
   ```
3. named volume(pgdata/uploads)을 쓰므로 윈도우 경로 퍼미션 문제 없음.
   브라우저 주소창에 **`http://localhost:3001`** — 반드시 `http://` 부터 입력(§8 SSL 오류 참고).

---

## 3. `.env` 키 표

| 키 | 필수 | 설명 |
|----|:---:|------|
| POSTGRES_DB / POSTGRES_USER | | DB 이름/계정 (기본 it_assets/itadmin) |
| POSTGRES_PASSWORD | ✔ | DB 비밀번호 |
| APP_PORT | | 웹 공개 포트 (기본 3001) |
| SESSION_SECRET | ✔ | 세션 키 (32자+ 랜덤) |
| INITIAL_ADMIN_PASSWORD | ✔ | 최초 admin 비밀번호 |
| SUBNETS_JSON | | **선택(레거시)**. 최초 기동 시 대역 자동 시드용. 표준은 IP 관리 화면 등록 |
| LENDING_ORG_LABEL | | 대여 라벨 기관명 (예: TTA) |
| SSH_DEFAULT_USER / SSH_DEFAULT_PASSWORD | | 스캔 fallback 계정/비번 |
| OLLAMA_HOST / PORT / MODEL | | AI 스펙조회(선택). 미기동이어도 앱 정상 |

> **서브넷 등록은 IP 관리 화면의 [＋ 서브넷 등록]이 표준입니다** (CIDR /16~/30, 등록 시 IP 풀 자동 생성).
> `SUBNETS_JSON`은 최초 기동 시 대역을 미리 시드하고 싶을 때만 쓰는 선택(레거시) 항목이며,
> 설정하지 않아도 화면에서 얼마든지 등록·삭제할 수 있습니다.

---

## 4. SSH 수집(스캔) 기능 활성화

1. 화면에서 **서버실 → 랙 → 자산 등록** 시 대상의 **관리 IP**와 **자격증명(root 등)** 입력.
2. `/discovery`에서 자산별 스캔 → 하드웨어 자동 수집.
3. **네트워크 요건**: 앱 컨테이너 → 대상 장비로 **22/TCP(SSH)**, PSU 감지 시 **623/UDP(IPMI)** 아웃바운드 허용.
   기본 bridge 네트워크로 충분(NAT 아웃바운드). 방화벽에서 컨테이너 호스트의 위 포트 아웃바운드만 열면 됩니다.
4. ipmitool은 이미지에 포함(PSU IPMI 감지). Ollama/DuckDuckGo는 선택 — 없으면 AI 스펙조회만 빈 결과.

---

## 5. 백업 / 복원

```bash
# 백업 (db dump + uploads tar, backups/에 타임스탬프 + 14개 회전)
bash scripts/backup.sh

# 복원 (복원 전 자동 안전백업 + 확인 프롬프트)
bash scripts/restore.sh backups/db_YYYYMMDD_HHMMSS.dump --with-uploads
```

정기 백업은 cron 예: `0 20 * * * cd <설치 디렉토리> && bash scripts/backup.sh >> backups/backup.log 2>&1`
(`<설치 디렉토리>` = 배포 tar를 전개한 경로. 예: `/opt/it-assets-dist-2.0.1`)

---

## 6. 업데이트(업그레이드) 절차

패치/기능 릴리스는 새 버전 dist tar 재배포 방식입니다(오프라인 전제 — `pull` 없음).

```bash
# 0) 수령 확인: 릴리스 노트의 sha256과 대조
sha256sum it-assets-dist-<새버전>.tar.gz

# 1) 업그레이드 전 백업 (필수)
bash scripts/backup.sh

# 2) 새 앱 이미지 적재
docker load -i it-assets-<새버전>.tar

# 3) 이미지 태그 반영: compose의 앱 이미지는 ${APP_IMAGE:-it-assets:2.0.1} —
#    .env에 APP_IMAGE=it-assets:<새버전> 지정 (compose 파일 자체가 갱신 전달된
#    릴리스면 새 compose 파일로 교체)
vi .env

# 4) 재기동 (앱만 재생성, named volume 데이터 유지 — ⚠ -v 금지)
docker compose -f docker-compose.prod.yml up -d
```

DB **스키마 변경이 포함된 릴리스**는 마이그레이션 SQL과 적용 순서를 릴리스 노트에
동봉합니다 — 반드시 그 순서대로 적용하세요(`db/*.sql`은 빈 볼륨 최초 기동 시에만
자동 실행되므로 기존 설치에는 적용되지 않습니다). 데이터 보정이 수반되는 릴리스
(예: 랙 실장 단위 개선)도 동일하게 보정 절차를 릴리스 노트로 안내합니다.

---

## 7. 재시작 / 중지 / 초기화

데이터(DB·업로드 사진)는 named volume(`pgdata`, `uploads`)에 보존됩니다. 아래 명령을 구분해서 쓰세요.

```bash
# 잠깐 중지 → 재기동 (데이터 유지)
docker compose -f docker-compose.prod.yml stop
docker compose -f docker-compose.prod.yml start

# 컨테이너 재생성 (업데이트·설정 변경 시. 볼륨은 유지되므로 데이터 유지)
docker compose -f docker-compose.prod.yml down     # ⚠ -v 절대 붙이지 말 것
docker compose -f docker-compose.prod.yml up -d
```

> ⚠ **`down -v` 는 모든 데이터(DB·업로드 사진)를 영구 삭제합니다.**
> named volume(pgdata/uploads)까지 지우므로 **완전 초기화 목적일 때만** 사용하세요.
> 평소 재시작·재생성에는 절대 `-v` 를 붙이지 마세요 — 되돌릴 수 없습니다(백업본으로만 복구).

---

## 8. 문제 해결

| 증상 | 원인 / 조치 |
|------|------------|
| `ERR_SSL_PROTOCOL_ERROR` | 브라우저가 주소를 https로 자동 승격 — 주소를 지우고 `http://` 부터 명시 입력(자동완성 주의, 시크릿 창 활용) |
| `failed to read dockerfile` / `app Pulling` | 로드된 이미지 태그가 compose 기대(`it-assets:2.0.1`)와 다름 — 태그 확인 후 `.env`에 `APP_IMAGE=<태그>` 지정 |
| 앱 컨테이너가 바로 종료 | ① DB 이미지 누락(오프라인) — `docker images`에 `postgres:16-alpine` 있는지 + `... ps`로 db healthy 확인 ② `.env`에 INITIAL_ADMIN_PASSWORD/SESSION_SECRET/POSTGRES_PASSWORD 누락 — `docker compose logs app` 확인 |
| 로그인 안 됨 | INITIAL_ADMIN_PASSWORD는 **최초 기동에만** 적용. 변경은 컨테이너 내 `node scripts/init-admin.js --reset` |
| **재시작 후 데이터 사라짐** | `down -v` 사용 여부 확인 — **`-v` 가 named volume(DB·사진)을 삭제**함. 재시작·재생성은 §7(stop/start 또는 `-v` 없는 down→up)로. 복구는 백업본에서만 |
| 스키마 없음(테이블 0) | pgdata 볼륨이 이미 초기화됨 — 스키마는 빈 볼륨에만 생성. **완전 초기화 목적일 때만** `down -v`(⚠ 전 데이터 삭제, §7 경고 참조) |
| IP 관리 화면이 비어있음 | 서브넷 미등록 — 정상. **IP 관리 화면의 [＋ 서브넷 등록]으로 대역 추가**(CIDR /16~/30) |
| 스캔 실패(unreachable/auth) | 대상 IP·자격증명 등록 확인 + 컨테이너→대상 22/TCP 방화벽 |
| 사진 안 보임 | uploads named volume 확인: `docker volume ls` |
