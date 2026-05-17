const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { requireAdmin } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// Login page
router.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  res.render('auth/login', {
    title: '로그인',
    currentPath: '/login',
    extraCss: null,
    extraJs: null
  });
});

// Login POST
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = User.authenticate(username, password);
  if (!user) {
    req.flash('error', '아이디 또는 비밀번호가 올바르지 않습니다.');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.userRole = user.role;
  req.session.displayName = user.display_name || user.username;
  AuditLog.log(req, { action: 'login', targetType: 'user', targetId: user.id, targetLabel: user.username });
  const returnTo = req.session.returnTo || '/';
  delete req.session.returnTo;
  res.redirect(returnTo);
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// User management (admin only)
router.get('/admin/users', requireAdmin, (req, res) => {
  const users = User.findAll();
  res.render('auth/users', {
    title: '계정 관리',
    currentPath: '/admin/users',
    extraCss: null,
    extraJs: null,
    users
  });
});

// Create user
router.post('/admin/users', requireAdmin, (req, res) => {
  try {
    const existing = User.findByUsername(req.body.username);
    if (existing) throw new Error('이미 존재하는 사용자명입니다.');
    User.create(req.body);
    req.flash('success', '계정이 생성되었습니다.');
  } catch (err) {
    req.flash('error', '계정 생성 실패: ' + err.message);
  }
  res.redirect('/admin/users');
});

// Update user
router.post('/admin/users/:id', requireAdmin, (req, res) => {
  try {
    const existingUser = User.findByUsername(req.body.username);
    if (existingUser && existingUser.id !== parseInt(req.params.id)) {
      throw new Error('이미 존재하는 사용자명입니다.');
    }
    User.update(req.params.id, req.body);
    req.flash('success', '계정이 수정되었습니다.');
  } catch (err) {
    req.flash('error', '계정 수정 실패: ' + err.message);
  }
  res.redirect('/admin/users');
});

// Delete user
router.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) {
      throw new Error('현재 로그인된 계정은 삭제할 수 없습니다.');
    }
    User.delete(req.params.id);
    req.flash('success', '계정이 삭제되었습니다.');
  } catch (err) {
    req.flash('error', '삭제 실패: ' + err.message);
  }
  res.redirect('/admin/users');
});

module.exports = router;
