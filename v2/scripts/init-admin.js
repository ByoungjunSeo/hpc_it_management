#!/usr/bin/env node
/**
 * Admin 초기 계정 생성 스크립트
 *
 * 실행: node scripts/init-admin.js
 * 호출 시점: docker compose up 시 app 컨테이너 시작 직전
 *
 * 동작:
 *   1. process.env.INITIAL_ADMIN_PASSWORD 읽기 (필수)
 *   2. DB에 admin 계정 존재 확인
 *   3. 없으면 PBKDF2 해시 후 INSERT
 *   4. 있으면 skip (idempotent)
 *
 * v1 hashPassword와 호환 (PBKDF2 SHA-512, 100K회, 16B salt)
 *
 * TODO: B-3 코드 포팅 단계에서 구현
 *   - pg 클라이언트 연결
 *   - hashPassword() 함수 (app/models/user.js와 동일 로직)
 *   - users 테이블 INSERT
 *   - 에러 처리
 */

console.log('init-admin.js: 구현 예정 (B-3 단계)');
process.exit(0);
