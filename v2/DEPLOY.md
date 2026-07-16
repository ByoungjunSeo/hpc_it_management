# IT 자산관리 시스템 v2 — 배포 가이드

데이터 0에서 `docker compose up` 한 번으로 기동되는 자립형 패키지입니다.
사내망(인터넷 불확실)을 전제로 이미지는 `docker save` tar로 전달합니다.

---

## 0. 구성 요소

| 파일 | 역할 |
|------|------|
| `it-assets-2.1.0.tar` | 앱 이미지 (별도 전달, `docker load`). 로드 태그: **`it-assets:2.1.0`** |
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
빌드 예: `docker build -t it-assets:2.1.0 .` → `docker save it-assets:2.1.0 -o it-assets-2.1.0.tar`
(용량을 줄이려면 `docker save ... | gzip > it-assets-2.1.0.tar.gz` 도 가능 — `docker load -i`는 tar/tar.gz 모두 자동 인식.)

> **deb.debian.org 차단 환경(사내망) 빌드**: `--build-arg APT_MIRROR=<미러>`로 apt 소스를
> 사내/공개 미러로 교체(main·updates만, security는 스킵)합니다. 미지정 시 기본값은 원본
> deb.debian.org(회귀 0).
> ```
> docker build --build-arg APT_MIRROR=http://mirror.kakao.com/debian -t it-assets:2.2.0 .
> ```
> 실검증 이력: 2.0.1 이미지는 사무 PC(윈도우)에서 사무망의 deb.debian.org 도메인 차단으로
> kakao 미러(http, security 제외)를 경유해 빌드·전달했고, 서버 격리 스택에서 정품 검증(amd64,
> ipmitool 1.8.19, 버전 2.0.1) 통과. (서버 자체도 deb.debian.org egress가 막혀 기본 경로
> 실빌드는 불가 — 미러 ARG 경로로만 재현 확인됨. 기본 경로 동작은 Dockerfile 로직상
> 원본 소스 무변경으로 보장.)
> compose.prod.yml의 앱 이미지 태그는 **`it-assets:2.1.0`** 고정입니다. 다른 태그로 로드했다면
> `.env`에 `APP_IMAGE=<태그>` 를 지정하세요. (배포 tar에는 Dockerfile이 없어 compose가 빌드하지 않습니다.)

---

## 1. 리눅스 서버 설치

```bash
# 1) 이미지 적재 — 앱 + DB 둘 다 (→ "Loaded image: ..." 출력 확인)
#    docker load -i는 .tar(무압축)·.tar.gz(압축) 모두 자동 인식
docker load -i it-assets-2.1.0.tar       # → it-assets:2.1.0
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
   docker load -i it-assets-2.1.0.tar
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
| CREDENTIAL_ENCRYPTION_KEY | 자격증명 사용 시 | 장비 접속 자격증명 DB 암호화 키(hex 64자, `openssl rand -hex 32`). 형식 오류면 기동 차단. **⚠ 분실 시 자격증명 복구 불가 — DB 백업과 별도 장소 보관** |
| SUBNETS_JSON | | **선택(레거시)**. 최초 기동 시 대역 자동 시드용. 표준은 IP 관리 화면 등록 |
| LENDING_ORG_LABEL | | 대여 라벨 기관명 (예: TTA) |
| SSH_DEFAULT_USER / SSH_DEFAULT_PASSWORD | | 스캔 fallback 계정/비번. **(.env 파일 권한으로 보호되는 영역 — DB 암호화 대상과 위협 모델이 다름)** |
| SSH_TERM_MAX_TOTAL | | 웹 SSH 터미널 전체 동시 세션 상한(기본 5) |
| SSH_TERM_MAX_PER_USER | | 웹 SSH 터미널 사용자당 동시 세션 상한(기본 2) |
| SSH_TERM_IDLE_MINUTES | | 웹 SSH 터미널 유휴(무입력) 타임아웃 분(기본 15) |
| SOL_TERM_MAX_TOTAL | | 웹 BMC SOL 콘솔 전체 동시 세션 상한(기본 3) |
| SOL_TERM_MAX_PER_USER | | 웹 BMC SOL 콘솔 사용자당 동시 세션 상한(기본 1) |
| SOL_TERM_IDLE_MINUTES | | 웹 BMC SOL 콘솔 유휴(무입력) 타임아웃 분(기본 15) |
| DB_CONTAINER_NAME | 백업 사용 시 | 웹 백업 관리·backup.sh/restore.sh가 `docker exec`할 **DB 컨테이너명**. 기본값 `it-assets-db-1`(compose 표준). **compose 표준명과 다르면 반드시 지정**(예 단독 DB 컨테이너 `it-assets-db`) |
| BACKUP_KEEP_COUNT | | 웹 백업 보존 개수(기본 14). 생성 시 초과분을 오래된 순 자동 삭제 |
| OLLAMA_HOST / PORT / MODEL | | AI 스펙조회(선택). 미기동이어도 앱 정상 |

> **서브넷 등록은 IP 관리 화면의 [＋ 서브넷 등록]이 표준입니다** (CIDR /16~/30, 등록 시 IP 풀 자동 생성).
> `SUBNETS_JSON`은 최초 기동 시 대역을 미리 시드하고 싶을 때만 쓰는 선택(레거시) 항목이며,
> 설정하지 않아도 화면에서 얼마든지 등록·삭제할 수 있습니다.

---

> **웹 SSH 터미널(관리자 한정)**: 자산 상세의 [SSH 터미널] 버튼 → 브라우저 셸.
> - **호스트가 대상 장비망에 도달 가능한 위치**에 설치돼야 동작합니다(미도달 시 이 기능만
>   실패, 다른 기능 무영향). 접속 비밀번호는 서버 내부에서만 복호화되어 브라우저로 전송되지
>   않습니다. 호스트키는 TOFU(최초 저장, 이후 불일치 시 경고만).
> - **앞단에 reverse proxy(nginx 등)를 두는 경우** WebSocket이 통과하도록 `/ws/ssh-terminal`
>   경로에 `Upgrade`/`Connection` 헤더 전달 설정이 필요합니다(예: nginx `proxy_set_header
>   Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`). 직노출(프록시 없음)이면 불요.
> - 동시 세션·유휴 타임아웃은 위 표의 `SSH_TERM_*` env로 조정합니다.

> **웹 BMC SOL 콘솔(관리자 한정)**: 자산 상세·랙 팝업의 [BMC 콘솔] 버튼 → 브라우저 직렬 콘솔(SOL).
> - **요건**: 자산에 **BMC IP**(ip_type=bmc)와 **BMC 자격증명**(credential_type=bmc)이 등록돼 있어야
>   버튼이 활성화됩니다. 호스트 → BMC로 **623/UDP(IPMI lanplus)** 아웃바운드 도달 가능해야 하며,
>   대상 BMC에서 **SOL/payload가 enabled** 여야 합니다(장비 BMC 설정). `ipmitool`은 앱 이미지에 포함.
> - 접속 비밀번호는 서버 내부에서만 사용(ipmitool `-E`/`IPMI_PASSWORD` env — argv·로그·audit 미노출),
>   브라우저로 전송되지 않습니다. 접속 전·종료 시 `sol deactivate`로 잔류 세션을 정리합니다.
> - **동일 BMC는 동시 1세션**(직렬 콘솔 특성). reverse proxy 사용 시 `/ws/sol-terminal` 경로도
>   WebSocket `Upgrade` 통과 설정이 필요합니다(SSH 터미널과 동일).
> - 동시 세션·유휴 타임아웃은 위 표의 `SOL_TERM_*` env로 조정합니다.

## 4. SSH 수집(스캔) 기능 활성화

1. 화면에서 **서버실 → 랙 → 자산 등록** 시 대상의 **관리 IP**와 **자격증명(root 등)** 입력.
2. `/discovery`에서 자산별 스캔 → 하드웨어 자동 수집.
3. **네트워크 요건**: 앱 컨테이너 → 대상 장비로 **22/TCP(SSH)**, PSU 감지 시 **623/UDP(IPMI)** 아웃바운드 허용.
   기본 bridge 네트워크로 충분(NAT 아웃바운드). 방화벽에서 컨테이너 호스트의 위 포트 아웃바운드만 열면 됩니다.
4. ipmitool은 이미지에 포함(PSU IPMI 감지). Ollama/DuckDuckGo는 선택 — 없으면 AI 스펙조회만 빈 결과.

---

## 5. 백업 / 복원

### 5-1. 웹 백업 관리 (관리자 · 권장)
관리자 메뉴 **[백업 관리]**(`/backups`)에서:
- **생성**: [백업 생성](사진 포함 옵션) → `db/itassets_YYYYMMDD_HHMMSS.dump`(pg_dump `-Fc`) 생성. `BACKUP_KEEP_COUNT`
  개(기본 14) 초과분 자동 정리.
- **목록/다운로드/삭제**: 목록에서 파일별 다운로드·삭제. 다운로드는 관리자만·감사 기록.
- **복원 가이드**: [복원 가이드]로 이 서버 실값(컨테이너명·파일 경로)이 채워진 복원 명령을 표시(웹에서 복원을
  **직접 실행하지 않음** — 아래 CLI로 수행).
- **요건**: `docker exec`로 DB 컨테이너에 접근하므로 **앱이 호스트의 docker에 접근 가능**해야 하고, `.env`에
  **`DB_CONTAINER_NAME`**(단독 DB 컨테이너면 예: `it-assets-db`)를 지정해야 합니다(§3 표).

> ⚠ **표준 compose 배포에서는 웹 [백업 생성]이 동작하지 않습니다.** compose의 앱은 컨테이너로 실행되며
> docker 소켓/CLI가 없어(보안상 미마운트) 컨테이너 안에서 `docker exec`를 할 수 없습니다. **compose 배포는
> 백업 생성을 아래 §5-2 CLI(`bash scripts/backup.sh`, 호스트에서 실행)로 수행**하세요. 웹 백업 생성은 앱을
> **호스트에서 직접 실행하고 그 계정이 docker 그룹인 배포**(예: systemd 노드 + 단독 DB 컨테이너)에서 동작합니다.
> (compose의 앱 컨테이너에서 웹 백업까지 지원하는 방식은 후속 개선 항목 — 릴리스 노트 Known limitation 참조.)
> ※ 웹 백업은 `backups/db/`에, CLI(`backup.sh`)는 `backups/`에 저장하므로 서로 목록이 겹치지 않습니다.

### 5-2. CLI 백업/복원
```bash
# 백업 (db dump + uploads tar, backups/에 타임스탬프 + 14개 회전)
bash scripts/backup.sh

# 복원 (복원 전 자동 안전백업 + 확인 프롬프트) — ⚠ 전체 덮어쓰기·전 사용자 로그아웃, 서비스 정지 후 권장
sudo systemctl stop it-assets-v2   # (컨테이너 배포면: docker compose ... stop app)
bash scripts/restore.sh backups/db_YYYYMMDD_HHMMSS.dump --with-uploads
sudo systemctl start it-assets-v2
```
> 스크립트/웹 모두 `.env`의 **`DB_CONTAINER_NAME`**(없으면 compose 기본 `it-assets-db-1`)를 컨테이너명으로 사용합니다.

정기 백업은 cron 예: `0 20 * * * cd <설치 디렉토리> && bash scripts/backup.sh >> backups/backup.log 2>&1`
(`<설치 디렉토리>` = 배포 tar를 전개한 경로. 예: `/opt/it-assets-dist-2.1.0`)

> ⚠ **자격증명 암호화 키(BL-11) 주의**: 백업 덤프에는 장비 자격증명이 **암호문**으로만 들어 있고 **암호화 키
> (`.env`의 `CREDENTIAL_ENCRYPTION_KEY`)는 포함되지 않습니다.** **다른 서버로 복원**하면 그 서버의 키가 달라
> 자격증명을 복호화할 수 없습니다 → **백업 파일과 `CREDENTIAL_ENCRYPTION_KEY`를 (서로 다른 안전한 장소에)
> 함께 보관**하고, 복원 대상 서버에 **동일한 키**를 먼저 준비하세요. (백업 파일 자체도 민감 — 접근 통제 필수.)

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

# 3) 이미지 태그 반영: compose의 앱 이미지는 ${APP_IMAGE:-it-assets:2.1.0} —
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
| `failed to read dockerfile` / `app Pulling` | 로드된 이미지 태그가 compose 기대(`it-assets:2.2.0`)와 다름 — 태그 확인 후 `.env`에 `APP_IMAGE=<태그>` 지정 |
| 앱 컨테이너가 바로 종료 | **먼저 `docker compose -f docker-compose.prod.yml logs app` 로 원인 확인** — ① DB 이미지 누락(오프라인): `docker images`에 `postgres:16-alpine` 있는지 + db healthy 확인 ② 아래 (a)~(c) 메시지별 대응 |
| (a) `exec … : no such file or directory` (엔트리포인트) | **셸 스크립트 CRLF**(Windows에서 clone/편집). `.sh`·`docker-entrypoint.sh`는 LF여야 함 — `.gitattributes`(eol=lf)로 재발 방지, 이미 CRLF면 `sed -i 's/\r$//' scripts/*.sh docker-entrypoint.sh` 후 재빌드 |
| (b) `[session-secret] 오류 …` (기동 로그) | `.env` 필수값 미설정 — **SESSION_SECRET·CREDENTIAL_ENCRYPTION_KEY를 32자 이상 무작위**로(`openssl rand -hex 32`). POSTGRES_PASSWORD·INITIAL_ADMIN_PASSWORD도 CHANGE_ME 교체 |
| (c) `column "password_enc" does not exist` 류(런타임) | **잔류 `pgdata` 볼륨에 구 스키마**가 남음(스키마는 빈 볼륨에만 생성). 신규 설치면 `docker compose -f docker-compose.prod.yml down -v`(⚠ 데이터 삭제) 후 `up -d`. 업그레이드면 §6 마이그레이션 적용. 앱 기동 로그의 `[schema]` 안내 참고 |
| 로그인 안 됨 | INITIAL_ADMIN_PASSWORD는 **최초 기동에만** 적용. 변경은 컨테이너 내 `node scripts/init-admin.js --reset` |
| **재시작 후 데이터 사라짐** | `down -v` 사용 여부 확인 — **`-v` 가 named volume(DB·사진)을 삭제**함. 재시작·재생성은 §7(stop/start 또는 `-v` 없는 down→up)로. 복구는 백업본에서만 |
| 스키마 없음(테이블 0) | pgdata 볼륨이 이미 초기화됨 — 스키마는 빈 볼륨에만 생성. **완전 초기화 목적일 때만** `down -v`(⚠ 전 데이터 삭제, §7 경고 참조) |
| IP 관리 화면이 비어있음 | 서브넷 미등록 — 정상. **IP 관리 화면의 [＋ 서브넷 등록]으로 대역 추가**(CIDR /16~/30) |
| 스캔 실패(unreachable/auth) | 대상 IP·자격증명 등록 확인 + 컨테이너→대상 22/TCP 방화벽 |
| 사진 안 보임 | uploads named volume 확인: `docker volume ls` |
