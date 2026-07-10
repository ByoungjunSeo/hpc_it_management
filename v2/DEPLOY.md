# IT 자산관리 시스템 v2 — 배포 가이드

데이터 0에서 `docker compose up` 한 번으로 기동되는 자립형 패키지입니다.
사내망(인터넷 불확실)을 전제로 이미지는 `docker save` tar로 전달합니다.

---

## 0. 구성 요소

| 파일 | 역할 |
|------|------|
| `it-assets-2.0.0.tar.gz` | 앱 이미지 (별도 전달, `docker load`). 로드 태그: **`it-assets:2.0.0`** |
| `docker-compose.prod.yml` | DB(postgres:16-alpine) + 앱 스택 |
| `db/*.sql` | 최초 기동 시 스키마 자동 생성 |
| `.env.example` | 환경변수 템플릿 (`.env`로 복사해 작성) |
| `scripts/backup.sh` / `restore.sh` | 백업 / 복원 |

이미지는 인터넷/사내미러가 있는 환경에서 빌드해 tar로 만듭니다(앱 이미지에 ipmitool 포함 — apt 필요).
빌드 예: `docker build -t it-assets:2.0.0 .` → `docker save it-assets:2.0.0 | gzip > it-assets-2.0.0.tar.gz`
> compose.prod.yml의 앱 이미지 태그는 **`it-assets:2.0.0`** 고정입니다. 다른 태그로 로드했다면
> `.env`에 `APP_IMAGE=<태그>` 를 지정하세요. (배포 tar에는 Dockerfile이 없어 compose가 빌드하지 않습니다.)

---

## 1. 리눅스 서버 설치

```bash
# 1) 이미지 적재 (→ "Loaded image: it-assets:2.0.0" 출력 확인)
gunzip -c it-assets-2.0.0.tar.gz | docker load

# 2) 환경변수 작성 (CHANGE_ME 전부 채움 — 특히 아래 필수 키)
cp .env.example .env
vi .env

# 3) 기동 (DB 스키마 자동 생성 + admin 자동 시드)
docker compose -f docker-compose.prod.yml up -d

# 4) 접속: http://<서버IP>:<APP_PORT>  (기본 3001)
#    최초 로그인: admin / <INITIAL_ADMIN_PASSWORD>
```

> 여러 인스턴스를 한 호스트에서 돌리려면 프로젝트명을 분리하세요:
> `docker compose -p <이름> -f docker-compose.prod.yml up -d` (컨테이너명이 `<이름>-app-1` 등이 됨).
> backup/restore도 `COMPOSE_PROJECT=<이름>` 환경변수로 같은 컨테이너를 가리킵니다.

필수 `.env` 키(미설정 시 기동 실패):
- `POSTGRES_PASSWORD` — DB 비밀번호
- `SESSION_SECRET` — 세션 암호화 키(32자+ 랜덤)
- `INITIAL_ADMIN_PASSWORD` — 최초 admin 비밀번호(첫 기동에만 사용, 멱등)

---

## 2. 윈도우 데스크탑 설치

1. **Docker 런타임 설치** — 둘 중 하나:
   - **Docker Desktop** (WSL2 백엔드): 개인/소규모는 무료, 대기업은 유료 구독 확인 필요.
   - **Rancher Desktop** (오픈소스 대안, 라이선스 부담 없음) — dockerd(moby) 모드 선택.
   - 설치 시 WSL2 활성화 필요(Windows 기능 → "Linux용 Windows 하위 시스템").
2. PowerShell 또는 WSL 터미널에서 §1과 동일:
   ```powershell
   docker load -i it-assets-app.tar
   copy .env.example .env    # 편집기로 CHANGE_ME 채움
   docker compose -f docker-compose.prod.yml up -d
   ```
3. named volume(pgdata/uploads)을 쓰므로 윈도우 경로 퍼미션 문제 없음. 브라우저로 `http://localhost:3001`.

---

## 3. `.env` 키 표

| 키 | 필수 | 설명 |
|----|:---:|------|
| POSTGRES_DB / POSTGRES_USER | | DB 이름/계정 (기본 it_assets/itadmin) |
| POSTGRES_PASSWORD | ✔ | DB 비밀번호 |
| APP_PORT | | 웹 공개 포트 (기본 3001) |
| SESSION_SECRET | ✔ | 세션 키 (32자+ 랜덤) |
| INITIAL_ADMIN_PASSWORD | ✔ | 최초 admin 비밀번호 |
| SUBNETS_JSON | | IP 관리 초기 대역(JSON). 미설정 시 빈 상태 — 화면에서 등록 |
| LENDING_ORG_LABEL | | 대여 라벨 기관명 (예: TTA) |
| SSH_DEFAULT_USER / SSH_DEFAULT_PASSWORD | | 스캔 fallback 계정/비번 |
| OLLAMA_HOST / PORT / MODEL | | AI 스펙조회(선택). 미기동이어도 앱 정상 |

> `SUBNETS_JSON`에 서브넷 추가 UI는 아직 없습니다(백로그). 초기 대역은 이 키로 주입하세요.

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

정기 백업은 cron 예: `0 20 * * * cd /path/to/v2 && bash scripts/backup.sh >> backups/backup.log 2>&1`

---

## 6. 업데이트 절차

```bash
docker load -i it-assets-app-<새버전>.tar        # 새 이미지 적재
# docker-compose.prod.yml의 APP_IMAGE 태그 갱신(또는 :2.0 재사용)
docker compose -f docker-compose.prod.yml up -d   # 앱만 재생성, 볼륨 유지
```
스키마 변경이 있는 릴리스는 릴리스 노트의 마이그레이션 안내를 따르세요(db/*.sql은 최초 1회만 실행됨).

---

## 7. 문제 해결

| 증상 | 원인 / 조치 |
|------|------------|
| `failed to read dockerfile` / `app Pulling` | 로드된 이미지 태그가 compose 기대(`it-assets:2.0.0`)와 다름 — 태그 확인 후 `.env`에 `APP_IMAGE=<태그>` 지정 |
| 앱 컨테이너가 바로 종료 | `.env`에 INITIAL_ADMIN_PASSWORD/SESSION_SECRET/POSTGRES_PASSWORD 누락 — 로그 `docker compose logs app` 확인 |
| 로그인 안 됨 | INITIAL_ADMIN_PASSWORD는 **최초 기동에만** 적용. 변경은 컨테이너 내 `node scripts/init-admin.js --reset` |
| 스키마 없음(테이블 0) | pgdata 볼륨이 이미 초기화됨 — 스키마는 빈 볼륨에만 생성. 초기화하려면 `down -v`(데이터 삭제 주의) |
| IP 관리 화면이 비어있음 | SUBNETS_JSON 미설정 — 정상. `.env`에 대역 JSON 추가 후 재시작 |
| 스캔 실패(unreachable/auth) | 대상 IP·자격증명 등록 확인 + 컨테이너→대상 22/TCP 방화벽 |
| 사진 안 보임 | uploads named volume 확인: `docker volume ls` |
