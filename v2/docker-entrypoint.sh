#!/bin/sh
# B-5b: 첫 기동 시 admin 자동 시드(멱등) 후 서버 기동.
# INITIAL_ADMIN_PASSWORD 미설정 + admin 부재면 bootstrap이 명확한 에러로 중단시킨다.
set -e
node /app/bootstrap-admin.js
exec node /app/server.js
