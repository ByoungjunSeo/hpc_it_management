function errorHandler(err, req, res, next) {
  console.error('Error:', err.message);
  console.error(err.stack);

  const statusCode = err.statusCode || 500;
  const message = err.message || '서버 오류가 발생했습니다.';

  if (req.xhr || req.headers.accept?.includes('application/json') || req.originalUrl.startsWith('/api/')) {
    return res.status(statusCode).json({ error: message });
  }

  res.status(statusCode).render('error', {
    title: '오류',
    statusCode,
    message,
    currentPath: req.path
  });
}

function notFoundHandler(req, res) {
  if (req.xhr || req.headers.accept?.includes('application/json') || req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ error: '페이지를 찾을 수 없습니다.' });
  }

  res.status(404).render('error', {
    title: '404',
    statusCode: 404,
    message: '페이지를 찾을 수 없습니다.',
    currentPath: req.path
  });
}

module.exports = { errorHandler, notFoundHandler };
