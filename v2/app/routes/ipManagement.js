const express = require('express');
const router = express.Router();
const IpAddress = require('../models/ipAddress');
const Asset = require('../models/asset');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// Initialize subnets on first access (guard: only runs if table empty)
let initialized = false;

router.use(async (req, res, next) => {
  if (!initialized) {
    await IpAddress.initializeSubnets();
    // syncAllAssets removed — §5: v2 EUL has no ip1~ip4/bmc/ib columns
    initialized = true;
  }
  next();
});

// IP dashboard
router.get('/', async (req, res, next) => {
  try {
    const subnetStats = await IpAddress.getSubnetStats();
    const totalStats = await IpAddress.getTotalStats();
    res.render('ip-management/index', {
      title: 'IP 관리',
      currentPath: '/ip-management',
      extraCss: 'ip-management.css',
      extraJs: null,
      subnetStats,
      totalStats,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// Subnet detail
router.get('/subnet/:subnet', async (req, res, next) => {
  try {
    const subnet = decodeURIComponent(req.params.subnet);
    const subnetConfig = appConfig.subnets.find(s => s.subnet === subnet);
    if (!subnetConfig) {
      req.flash('error', '서브넷을 찾을 수 없습니다.');
      return res.redirect('/ip-management');
    }
    const addresses = await IpAddress.findBySubnet(subnet);
    const assets = await Asset.findAll();
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
  } catch (err) {
    next(err);
  }
});

// Update IP allocation (API)
router.post('/ip/:ip', requireMaintenance, async (req, res) => {
  try {
    const ip = req.params.ip;
    const { allocation_type, asset_id, assigned_to, description } = req.body;

    if (allocation_type === 'available') {
      await IpAddress.release(ip);
    } else {
      await IpAddress.updateAllocation(ip, { allocation_type, asset_id, assigned_to, description });
    }

    await AuditLog.log(req, {
      action: 'update', targetType: 'ip', targetLabel: ip + ' → ' + allocation_type
    });

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
