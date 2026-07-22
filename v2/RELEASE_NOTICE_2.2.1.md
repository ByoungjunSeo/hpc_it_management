# IT 자산관리 시스템 v2.2.1 배포 공지

수신: 배포 대상 팀 인프라 담당자 (Docker 운용 가능 전제)

## 1. 개요

HPC/AIDC 장비실의 서버·모듈·IP·입출고를 웹에서 통합 관리하는 자산관리 시스템입니다.
이번 **2.2.1**은 v2.2.0 대비 **코드만 변경한 버그 수정 릴리스**입니다. 스키마(DB) 변경은 없으며,
부품 사용현황·반납 시 재고/이력 정합, 부품 이동 병합, 미매칭 화면의 외부 IP 노출 제거를 바로잡았습니다.
전달물은 아래 1파일입니다.

- `it-assets-dist-2.2.1.tar.gz` (전달 번들)
- 앱 이미지 tar `it-assets-2.2.1.tar` (번들 내부, `docker load` 대상)
  - sha256: `<빌드 후 기입>`
  - 적재 전 `sha256sum it-assets-2.2.1.tar` 로 **반드시 대조**하세요(이미지 `it-assets:2.2.1`).

tar 안에 앱/DB docker 이미지 2종(오프라인 설치용), 설치 문서(DEPLOY.md), compose 파일,
환경변수 템플릿(.env.example), 스키마 SQL, 백업/복원 스크립트가 모두 들어 있어
**인터넷 없이 설치 가능**합니다.

## 2. v2.2.0 → v2.2.1 주요 변경 (버그 수정 — 사용자 관점)

| 버그 | 사용자 관점 변경 |
|------|------|
| BUG-14 | **부품 사용 현황**이 실제로 표시됩니다 — 스텁(빈 목록)으로 배선돼 있던 사용현황 API를 실제 조회로 교체 |
| BUG-15 | **반납하면 그 장비의 컴퓨팅 모듈 재고가 정확히 차감**됩니다 — 블레이드 섀시 반납 시 자식 노드까지 연쇄 반납·재고 재계산 |
| BUG-15-b | **과거 반납분 재고/이력 소급 보정** 절차 마련(글루시스-008 등, 게이트 SQL — 운영 실행은 관리자 승인 후 1회) |
| BUG-15-c | **반납 시 부품 '이력' 탭에 removed(제거) 항목이 자동 기록**됩니다 — 모듈별로, 반납 처리자·시각과 함께(재고 이중 차감 없음) |
| BUG-16 | **부품 사용 현황의 중복 행 정리** — 같은 슬롯 수량을 합산 표시(GROUP BY), 부품 이동 시 동일 슬롯 수량 병합 |
| BUG-17 | **미매칭 화면의 'AI 스펙 조회'(Ollama 연동) 완전 제거** — 화면에서 사라졌고, 외부 IP가 노출되던 경로도 소멸(미매칭 처리 3옵션은 그대로) |

> **Ollama 'AI 스펙 조회' 기능은 제거되었습니다.** 자산 미매칭 화면에서 외부 LLM 서버로 조회하던 버튼과
> 그 배선(`specLookup`)을 삭제했습니다. 미매칭 자산 처리(신규 등록/기존 연결/보류) 3옵션은 그대로 유지됩니다.

## 3. 설치 (신규)

동봉 **DEPLOY.md §1(리눅스)/§2(윈도우)** 절차 그대로. 이미지 적재(docker load) → `.env` 작성 →
`docker compose up -d` → 브라우저 접속(`http://<서버IP>:3001`, 최초 admin / INITIAL_ADMIN_PASSWORD).
DB 스키마는 첫 기동 시 자동 생성됩니다. (v2.2.0과 **스키마 동일** — 아래 §5 참조.)

> ⚠ **재설치/이전 버전 위 재설치 시 볼륨 청결 필수.** DB 스키마는 **빈 데이터 볼륨에서만** 자동 생성됩니다.
> 완전 새 설치는 `docker compose -f docker-compose.prod.yml down -v`(⚠ 데이터 삭제)로 볼륨을 비운 뒤
> `up -d` 하세요.

## 4. ★ 보안 필수 조치 (.env)

`.env.example` → `.env` 복사 후 **CHANGE_ME 값 변경**. v2.2.0과 **동일**(POSTGRES_PASSWORD·
INITIAL_ADMIN_PASSWORD·SESSION_SECRET·CREDENTIAL_ENCRYPTION_KEY·SSH_DEFAULT_PASSWORD·LENDING_ORG_LABEL).
**신규 환경변수 없음.**

> ⚠ **CREDENTIAL_ENCRYPTION_KEY 분실 시 저장된 장비 자격증명을 복구할 수 없습니다.** DB 백업과 **별도 장소**에
> 보관하세요.

## 5. 업그레이드 (2.2.0 → 2.2.1) — **코드만 변경, DDL 없음**

v2.2.1은 **애플리케이션 코드만 바뀐 릴리스**입니다. **DB 스키마 변경·신규 마이그레이션이 없으므로**
이미지 교체 + 재기동만 하면 됩니다.

```bash
# 1) 백업(권장) → 2) 새 이미지 적재
bash scripts/backup.sh
docker load -i it-assets-2.2.1.tar
# 3) .env에 APP_IMAGE=it-assets:2.2.1 로 교체(또는 기본값 사용) 후 재기동
docker compose -f docker-compose.prod.yml up -d
```

- **마이그레이션 실행 불필요** — v2.2.0에서 2.2.1로 올릴 때 적용할 신규 `.sql`이 **없습니다**
  (v2.2.0 태그 이후 db/스키마/migrations 변경 0건 확인).
- ⚠ `down -v` 절대 금지(데이터·업로드 named volume 보존). 재기동 전 SESSION_SECRET(32자+)·
  CREDENTIAL_ENCRYPTION_KEY(hex64) 실값 확인.
- 호스트에서 앱을 직접 구동하는 배포(비-compose)라면 `git pull` 후 `sudo systemctl restart it-assets-v2`
  로 충분합니다(npm 신규 의존성 없음).
- 신규 설치는 위 과정 불필요(첫 기동에 자동 생성, 스키마는 v2.2.0과 동일).

## 6. Known limitation (v2.2.0에서 승계 — 변동 없음)

- **웹 백업 생성은 표준 compose 배포에서 동작하지 않습니다.** compose 배포는 백업을 호스트에서
  `bash scripts/backup.sh`(CLI)로 생성하세요(웹의 목록/다운로드/복원 가이드는 참고용).
- 재고 점검은 MVP 범위(대시보드 배지·추이 차트·PDF/Excel 보고서는 다음 릴리스).

## 7. 지원/문의
- 컴퓨팅지원팀 sbj8388@tta.or.kr
