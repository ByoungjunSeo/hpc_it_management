#!/bin/bash
# IT 자산관리 v2 — 복원 (B-5b)
# 복원 전 현재 상태를 자동 백업한 뒤 pg_restore --clean. uploads는 --with-uploads 시 함께.
#
# 사용: bash scripts/restore.sh backups/db_YYYYMMDD_HHMMSS.dump [--with-uploads] [--yes]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
[ -f .env ] && set -a && . ./.env && set +a

PROJECT="${COMPOSE_PROJECT:-it-assets}"
# T4: 웹 백업 UI와 동일 env(DB_CONTAINER_NAME) 우선. 기존 DB_CONTAINER/compose 기본값과 호환.
DB_CONTAINER="${DB_CONTAINER_NAME:-${DB_CONTAINER:-${PROJECT}-db-1}}"
APP_CONTAINER="${APP_CONTAINER:-${PROJECT}-app-1}"

DUMP="${1:-}"
WITH_UPLOADS=0; ASSUME_YES=0
for a in "$@"; do
  [ "$a" = "--with-uploads" ] && WITH_UPLOADS=1
  [ "$a" = "--yes" ] && ASSUME_YES=1
done

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "사용: bash scripts/restore.sh <db_dump 파일> [--with-uploads] [--yes]"
  exit 1
fi

echo "[restore] 대상 DB: $POSTGRES_DB @ $DB_CONTAINER"
echo "[restore] 복원 파일: $DUMP"
echo "[restore] ⚠ 현재 데이터는 --clean으로 덮어써집니다."
if [ "$ASSUME_YES" != "1" ]; then
  read -r -p "계속하려면 'yes' 입력: " CONFIRM
  [ "$CONFIRM" = "yes" ] || { echo "취소됨"; exit 1; }
fi

# 복원 전 안전 백업
SAFETY="$HERE/backups/pre_restore_$(date +%Y%m%d_%H%M%S).dump"
mkdir -p "$HERE/backups"
echo "[restore] 사전 안전백업 → $SAFETY"
docker exec "$DB_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom > "$SAFETY"

echo "[restore] pg_restore --clean 실행"
docker exec -i "$DB_CONTAINER" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner < "$DUMP"

if [ "$WITH_UPLOADS" = "1" ]; then
  UP="${DUMP/db_/uploads_}"; UP="${UP%.dump}.tar.gz"
  if [ -f "$UP" ]; then
    echo "[restore] uploads 복원 ← $UP"
    docker exec -i "$APP_CONTAINER" tar xzf - -C /app/public < "$UP"
  else
    echo "[restore] uploads 파일 없음: $UP (스킵)"
  fi
fi

echo "[restore] 완료. 앱 재시작 권장: docker compose -f docker-compose.prod.yml restart app"
