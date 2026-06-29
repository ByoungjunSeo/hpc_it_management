const express = require('express');
const router = express.Router();
const ServerRoom = require('../models/serverRoom');
const Asset = require('../models/asset');
const appConfig = require('../config/app');

router.get('/', async (req, res, next) => {
  try {
    const rooms = await ServerRoom.findAll('office');

    for (const room of rooms) {
      room.assets = await Asset.findAll({ room_id: room.id });
    }

    res.render('offices/index', {
      title: '사무실',
      currentPath: '/offices',
      extraCss: null,
      extraJs: null,
      rooms,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
