const express = require('express');
const router = express.Router();
const ServerRoom = require('../models/serverRoom');
const Rack = require('../models/rack');
const Asset = require('../models/asset');
const appConfig = require('../config/app');

// Office equipment list
router.get('/', (req, res) => {
  const rooms = ServerRoom.findAll('office');

  rooms.forEach(room => {
    room.assets = Asset.findAll({ room_id: room.id });
  });

  res.render('offices/index', {
    title: '사무실',
    currentPath: '/offices',
    extraCss: null,
    extraJs: null,
    rooms,
    appConfig
  });
});

module.exports = router;
