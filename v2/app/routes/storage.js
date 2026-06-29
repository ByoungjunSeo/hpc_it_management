const express = require('express');
const router = express.Router();
const ServerRoom = require('../models/serverRoom');
const Asset = require('../models/asset');
const ModuleInventory = require('../models/moduleInventory');
const { pool } = require('../config/database');
const appConfig = require('../config/app');

router.get('/', async (req, res, next) => {
  try {
    const rooms = await ServerRoom.findAll('storage');

    for (const room of rooms) {
      room.assets = await Asset.findAll({ room_id: room.id });
    }

    // Unplaced assets (no rack) and inactive/decommissioned assets
    const { rows: unplacedAssets } = await pool.query(`
      SELECT a.*, sr.name as room_name
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      WHERE a.rack_id IS NULL AND a.status IN ('inactive', 'decommissioned')
      ORDER BY a.asset_type, a.asset_number
    `);

    // Storage module inventory
    const storageModules = await ModuleInventory.findStorageModules();

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
  } catch (err) {
    next(err);
  }
});

module.exports = router;
