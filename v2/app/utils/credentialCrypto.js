// BL-11: 장비 접속 자격증명(SSH/BMC 비밀번호) 암호화 유틸.
// AES-256-GCM(앱 레벨 대칭키). 페이로드 형식: v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
// 키: .env CREDENTIAL_ENCRYPTION_KEY (32바이트 = hex 64자). 생성 예: openssl rand -hex 32
const crypto = require('crypto');

const PREFIX = 'v1:';
const ALG = 'aes-256-gcm';
const IV_LEN = 12;

function getKey() {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY 미설정 또는 형식 오류(hex 64자 필요). 생성: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
}

// 키 형식 유효성 — 기동 검사용(키 없으면 false, 있는데 형식 틀리면 throw 대신 false)
function keyConfigured() {
  return /^[0-9a-fA-F]{64}$/.test(process.env.CREDENTIAL_ENCRYPTION_KEY || '');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// 평문 → 암호문 페이로드. 빈 값/null은 그대로 반환(암호화 대상 아님).
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  if (isEncrypted(plain)) return plain; // 이미 암호문 — 이중 암호화 방지(멱등)
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('hex') + ':' + tag.toString('hex') + ':' + ct.toString('hex');
}

// 암호문 페이로드 → 평문. 평문(접두 없음)이면 그대로 반환(마이그레이션 전 호환).
// GCM 인증 태그 불일치(잘못된 키/변조)면 throw — 조용히 넘기지 않음.
function decrypt(payload) {
  if (payload === null || payload === undefined || payload === '') return payload;
  if (!isEncrypted(payload)) return payload; // 평문 잔존 — 그대로
  const parts = payload.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('자격증명 암호문 형식 오류');
  const [ivHex, tagHex, ctHex] = parts;
  const decipher = crypto.createDecipheriv(ALG, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted, keyConfigured, PREFIX };
