const express = require('express');
const router = express.Router();
const Asset = require('../models/asset');
const Rack = require('../models/rack');
const IpAddress = require('../models/ipAddress');
const EquipmentUsageLog = require('../models/equipmentUsageLog');
const appConfig = require('../config/app');

// Dashboard
router.get('/', (req, res) => {
  // Initialize IP subnets if needed
  IpAddress.initializeSubnets();

  const totalAssets = Asset.totalCount();
  const assetsByType = Asset.countByType();
  const assetsByOwnership = Asset.countByOwnership();
  const assetsByStatus = Asset.countByStatus();
  const assetsByRoom = Asset.countByRoom();
  const rackUsage = Rack.getUsageStats();
  const roomRackUsage = Rack.getRoomUsageStats();
  const ipStats = IpAddress.getTotalStats();
  const recentLogs = EquipmentUsageLog.getRecent(10);
  const usageCounts = EquipmentUsageLog.countByStatus();
  const monthlyTrend = EquipmentUsageLog.getMonthlyTrend();

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
});

module.exports = router;
