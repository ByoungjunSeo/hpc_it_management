-- ============================================================
-- IT 자산관리 시스템 v2 — 세션 저장 테이블
-- ============================================================
-- connect-pg-simple 라이브러리가 사용
-- 만료된 세션은 라이브러리가 자동 삭제 (기본 24시간)
-- 참고: https://github.com/voxpelli/node-connect-pg-simple
-- ============================================================

CREATE TABLE IF NOT EXISTS session (
    sid VARCHAR NOT NULL COLLATE "default",
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (sid)
);

CREATE INDEX idx_session_expire ON session(expire);
