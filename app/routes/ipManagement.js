const express = require('express');
const router = express.Router();
const IpAddress = require('../models/ipAddress');
const Asset = require('../models/asset');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');

// Initialize subnets on first access
let initialized = false;

router.use((req, res, next) => {
  if (!initialized) {
    IpAddress.initializeSubnets();
    IpAddress.syncAllAssets();
    initialized = true;
  }
  next();
});

// IP dashboard
router.get('/', (req, res) => {
  const subnetStats = IpAddress.getSubnetStats();
  const totalStats = IpAddress.getTotalStats();
  res.render('ip-management/index', {
    title: 'IP 관리',
    currentPath: '/ip-management',
    extraCss: 'ip-management.css',
    extraJs: null,
    subnetStats,
    totalStats,
    appConfig
  });
});

// Subnet detail
router.get('/subnet/:subnet', (req, res) => {
  const subnet = decodeURIComponent(req.params.subnet);
  const subnetConfig = appConfig.subnets.find(s => s.subnet === subnet);
  if (!subnetConfig) {
    req.flash('error', '서브넷을 찾을 수 없습니다.');
    return res.redirect('/ip-management');
  }
  const addresses = IpAddress.findBySubnet(subnet);
  const assets = Asset.findAll();
  res.render('ip-management/subnet', {
    title: subnetConfig.label,
    currentPath: '/ip-management',
    extraCss: 'ip-management.css',
    extraJs: 'ip-grid.js',
    subnet,
    subnetConfig,
    addresses,
    assets,
    appConfig
  });
});

// Update IP allocation (API)
router.post('/ip/:ip', requireMaintenance, (req, res) => {
  try {
    const ip = req.params.ip;
    const { allocation_type, asset_id, assigned_to, description } = req.body;

    if (allocation_type === 'available') {
      IpAddress.release(ip);
    } else {
      IpAddress.updateAllocation(ip, { allocation_type, asset_id, assigned_to, description });
    }

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true });
    }
    req.flash('success', 'IP가 업데이트되었습니다.');
    res.redirect('back');
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ error: err.message });
    }
    req.flash('error', '업데이트 실패: ' + err.message);
    res.redirect('back');
  }
});

module.exports = router;
