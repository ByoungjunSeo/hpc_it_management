const express = require('express');
const router = express.Router();
const ServerRoom = require('../models/serverRoom');
const Rack = require('../models/rack');
const Asset = require('../models/asset');
const ModuleInventory = require('../models/moduleInventory');
const { getDb } = require('../config/database');
const appConfig = require('../config/app');

// Storage / equipment room list
router.get('/', (req, res) => {
  const rooms = ServerRoom.findAll('storage');

  rooms.forEach(room => {
    room.assets = Asset.findAll({ room_id: room.id });
  });

  // Unplaced assets (no rack) and inactive/decommissioned assets
  const unplacedAssets = getDb().prepare(`
    SELECT a.*, sr.name as room_name
    FROM assets a
    LEFT JOIN racks r ON a.rack_id = r.id
    LEFT JOIN server_rooms sr ON r.room_id = sr.id
    WHERE a.rack_id IS NULL AND a.status IN ('inactive', 'decommissioned')
    ORDER BY a.asset_type, a.asset_number
  `).all();

  // Storage module inventory
  const storageModules = ModuleInventory.findStorageModules();

  res.render('storage/index', {
    title: '장비실',
    currentPath: '/storage',
    extraCss: null,
    extraJs: null,
    rooms,
    unplacedAssets,
    storageModules,
    appConfig
  });
});

module.exports = router;
