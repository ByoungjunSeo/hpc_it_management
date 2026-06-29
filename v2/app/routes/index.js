const express = require('express');
const router = express.Router();
const Asset = require('../models/asset');
const Rack = require('../models/rack');
const IpAddress = require('../models/ipAddress');
const EquipmentUsageLog = require('../models/equipmentUsageLog');
const appConfig = require('../config/app');

// Dashboard
router.get('/', async (req, res, next) => {
  try {
    // Initialize IP subnets if needed
    await IpAddress.initializeSubnets();

    const [totalAssets, assetsByType, assetsByOwnership, assetsByStatus, assetsByRoom,
           rackUsage, roomRackUsage, ipStats, recentLogs, usageCounts, monthlyTrend] =
      await Promise.all([
        Asset.totalCount(),
        Asset.countByType(),
        Asset.countByOwnership(),
        Asset.countByStatus(),
        Asset.countByRoom(),
        Rack.getUsageStats(),
        Rack.getRoomUsageStats(),
        IpAddress.getTotalStats(),
        EquipmentUsageLog.getRecent(10),
        EquipmentUsageLog.countByStatus(),
        EquipmentUsageLog.getMonthlyTrend()
      ]);

    res.render('dashboard', {
      title: '대시보드',
      currentPath: '/',
      extraCss: null,
      extraJs: null,
      totalAssets,
      assetsByType,
      assetsByOwnership,
      assetsByStatus,
      assetsByRoom,
      rackUsage,
      roomRackUsage,
      ipStats,
      recentLogs,
      usageCounts,
      monthlyTrend,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
