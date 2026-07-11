# IT 자산관리 v2 — 앱 이미지 (B-5b)
# 멀티스테이지: deps(npm ci) → runtime(slim + ipmitool)
# 전달 방식: docker save -o it-assets-app.tar it-assets-app:2.0 (사내망 tar 배포)

FROM node:18-bookworm-slim AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev

FROM node:18-bookworm-slim
# ipmitool: PSU IPMI 감지(sshDiscovery.detectPsuViaIpmi)가 execFile('ipmitool')로 PATH 탐색.
# 이 단계는 apt egress가 필요 — 인터넷/사내미러 있는 환경에서 빌드할 것.
# (HEALTHCHECK는 node 내장으로 처리해 curl 의존 제거)
#
# APT_MIRROR: deb.debian.org가 차단된 사내망 대응.
#   미지정(기본) → 원본 소스(deb.debian.org) 그대로 = 기존과 동일 동작(회귀 0).
#   지정 시 → main/updates만 해당 미러로 교체하고 security는 스킵.
#   예: --build-arg APT_MIRROR=http://mirror.kakao.com/debian
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
      printf 'Types: deb\nURIs: %s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "$APT_MIRROR" \
        > /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends ipmitool \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PGHOST=db \
    PGPORT=5432 \
    APP_PORT=3001

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY app/ ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p public/uploads/photos/assets public/uploads/photos/modules public/uploads/photos/lendings \
 && chown -R node:node /app

# 비루트 실행 (node 이미지 내장 uid 1000)
USER node
EXPOSE 3001

# 로그인 페이지는 무인증 GET — 앱+DB 세션스토어까지 살아있어야 200 (curl 없이 node로 체크)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/login',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
