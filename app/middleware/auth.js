function requireLogin(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || (req.originalUrl && req.originalUrl.startsWith('/api/'))) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  // Only save returnTo for actual page navigations, not static resources
  if (!req.originalUrl.match(/\.(ico|png|jpg|css|js|map|woff|ttf)(\?|$)/)) {
    req.session.returnTo = req.originalUrl;
  }
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || (req.originalUrl && req.originalUrl.startsWith('/api/'))) {
      return res.status(401).json({ error: '로그인이 필요합니다.' });
    }
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (req.session.userRole !== 'admin') {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || (req.originalUrl && req.originalUrl.startsWith('/api/'))) {
      return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    req.flash('error', '관리자 권한이 필요합니다.');
    return res.redirect('/');
  }
  next();
}

function requireMaintenance(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || (req.originalUrl && req.originalUrl.startsWith('/api/'))) {
      return res.status(401).json({ error: '로그인이 필요합니다.' });
    }
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (req.session.userRole === 'viewer') {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || (req.originalUrl && req.originalUrl.startsWith('/api/'))) {
      return res.status(403).json({ error: '수정 권한이 없습니다.' });
    }
    req.flash('error', '수정 권한이 없습니다. (관리자 또는 유지보수 계정 필요)');
    return res.redirect('back');
  }
  next();
}

module.exports = { requireLogin, requireAdmin, requireMaintenance };
