const express = require('express');
const router = express.Router();
const AuditLog = require('../models/auditLog');

router.get('/', (req, res) => {
  const filters = {
    date_from: req.query.date_from || '',
    date_to: req.query.date_to || '',
    username: req.query.username || '',
    target_type: req.query.target_type || '',
    action: req.query.action || '',
    search: req.query.search || ''
  };
  const logs = AuditLog.findAll(filters);
  const users = AuditLog.getUsers();
  const targetTypes = AuditLog.getTargetTypes();

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
});

module.exports = router;
