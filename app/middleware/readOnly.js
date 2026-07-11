// v2 컷오버 동결용: READ_ONLY=1 일 때만 쓰기 차단, 아니면 완전 no-op.
// 세션 미들웨어 이후·라우트 마운트 이전에 장착해야 함 (로그인 허용 판단에 req.path 사용).

const READ_ONLY_MESSAGE = 'v2 전환 작업으로 쓰기가 중지되었습니다. 조회만 가능합니다.';

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// 동결 중에도 로그인해서 조회는 가능해야 함 (routes/auth.js: POST /login)
const ALLOWED_WRITE_PATHS = ['/login'];

function readOnly(req, res, next) {
  if (process.env.READ_ONLY !== '1') {
    return next();
  }

  res.locals.readOnlyMode = true;

  if (SAFE_METHODS.includes(req.method)) {
    return next();
  }

  if (ALLOWED_WRITE_PATHS.includes(req.path)) {
    return next();
  }

  if (req.xhr || req.headers.accept?.includes('application/json') || req.originalUrl.startsWith('/api/')) {
    return res.status(503).json({ error: READ_ONLY_MESSAGE });
  }

  return res.status(503).render('error', {
    title: '쓰기 중지',
    statusCode: 503,
    message: READ_ONLY_MESSAGE,
    currentPath: req.path
  });
}

module.exports = readOnly;
