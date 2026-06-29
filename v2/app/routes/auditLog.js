const express = require('express');
const router = express.Router();
const AuditLog = require('../models/auditLog');

router.get('/', async (req, res, next) => {
  try {
    const filters = {
      date_from: req.query.date_from || '',
      date_to: req.query.date_to || '',
      username: req.query.username || '',
      target_type: req.query.target_type || '',
      action: req.query.action || '',
      search: req.query.search || ''
    };
    const [logs, users, targetTypes] = await Promise.all([
      AuditLog.findAll(filters),
      AuditLog.getUsers(),
      AuditLog.getTargetTypes()
    ]);

    res.render('audit-log/index', {
      title: '이력 관리',
      currentPath: '/audit-log',
      extraCss: null,
      extraJs: null,
      logs,
      filters,
      users,
      targetTypes
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
