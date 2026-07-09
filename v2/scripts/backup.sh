#!/bin/bash
# IT 자산관리 v2 — 백업 (B-5b)
# PostgreSQL(pg_dump custom) + uploads(tar). 타임스탬프 파일명 + 14개 회전.
#
# 사용: bash scripts/backup.sh
# 환경: .env의 POSTGRES_* 사용. 컨테이너명은 COMPOSE_PROJECT(기본 it-assets) 기준.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
[ -f .env ] && set -a && . ./.env && set +a

PROJECT="${COMPOSE_PROJECT:-it-assets}"
DB_CONTAINER="${DB_CONTAINER:-${PROJECT}-db-1}"
APP_CONTAINER="${APP_CONTAINER:-${PROJECT}-app-1}"
BACKUP_DIR="${BACKUP_DIR:-$HERE/backups}"
RETAIN="${BACKUP_RETAIN:-14}"
TS="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$BACKUP_DIR"

echo "[backup] DB dump → $BACKUP_DIR/db_$TS.dump"
docker exec "$DB_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom > "$BACKUP_DIR/db_$TS.dump"

echo "[backup] uploads tar → $BACKUP_DIR/uploads_$TS.tar.gz"
docker exec "$APP_CONTAINER" tar czf - -C /app/public uploads > "$BACKUP_DIR/uploads_$TS.tar.gz" 2>/dev/null \
  || echo "[backup] (uploads 비어있음 — 스킵 가능)"

echo "[backup] 회전: 최근 $RETAIN개 유지"
ls -1t "$BACKUP_DIR"/db_*.dump 2>/dev/null | tail -n +$((RETAIN+1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/uploads_*.tar.gz 2>/dev/null | tail -n +$((RETAIN+1)) | xargs -r rm -f

echo "[backup] 완료: db_$TS.dump ($(du -h "$BACKUP_DIR/db_$TS.dump" | cut -f1))"
