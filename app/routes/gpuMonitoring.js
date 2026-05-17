const express = require('express');
const router = express.Router();
const { collectGpuMetrics } = require('../services/gpuMonitor');
const Asset = require('../models/asset');
const AssetIp = require('../models/assetIp');
const AssetCredential = require('../models/assetCredential');
const ComputingModule = require('../models/computingModule');
const ServerRoom = require('../models/serverRoom');
const { getDb } = require('../config/database');
const { requireMaintenance } = require('../middleware/auth');

// ── Helper: get assets that have GPU computing modules ──
function getGpuAssets() {
  const db = getDb();
  const rooms = ServerRoom.findAll('server_room');
  if (rooms.length === 0) return { assets: [], rooms: [] };

  const roomIds = rooms.map(r => r.id);
  const placeholders = roomIds.map(() => '?').join(',');

  // Assets with at least one GPU module, active, in server rooms
  const assets = db.prepare(`
    SELECT DISTINCT a.*, r.name as rack_name,
      COALESCE(sr_direct.name, sr.name) as room_name,
      COALESCE(a.room_id, sr.id) as effective_room_id
    FROM assets a
    INNER JOIN computing_modules cm ON cm.asset_id = a.id AND cm.module_type = 'gpu'
    LEFT JOIN racks r ON a.rack_id = r.id
    LEFT JOIN server_rooms sr ON r.room_id = sr.id
    LEFT JOIN server_rooms sr_direct ON a.room_id = sr_direct.id
    WHERE a.status = 'active'
      AND a.parent_asset_id IS NULL
      AND (
        a.room_id IN (${placeholders})
        OR r.room_id IN (${placeholders})
      )
    ORDER BY COALESCE(sr_direct.name, sr.name), r.name, a.rack_unit_start, a.asset_number
  `).all(...roomIds, ...roomIds);

  // Enrich each asset with IPs, credentials, GPU modules
  for (const asset of assets) {
    asset.ips = AssetIp.findByAsset(asset.id);
    asset.credentials = AssetCredential.findByAsset(asset.id);
    asset.gpu_modules = ComputingModule.findByAsset(asset.id).filter(m => m.module_type === 'gpu');
  }

  return { assets, rooms };
}

// ── Helper: resolve IP and credentials for an asset ──
function resolveAssetConnection(asset) {
  const ips = AssetIp.findByAsset(asset.id);
  const creds = AssetCredential.findByAsset(asset.id);

  let ip = null;
  const mgmtIp = ips.find(i => i.ip_type === 'management');
  const osIp = ips.find(i => i.ip_type === 'os');
  const nonBmcIp = ips.find(i => i.ip_type !== 'bmc');
  if (mgmtIp) {
    ip = mgmtIp.ip_address;
  } else if (osIp) {
    ip = osIp.ip_address;
  } else if (nonBmcIp) {
    ip = nonBmcIp.ip_address;
  } else if (ips.length > 0) {
    ip = ips[0].ip_address;
  } else if (asset.ip_address) {
    ip = asset.ip_address;
  }

  let user = null, password = null;
  const rootCred = creds.find(c => c.credential_type === 'root' || c.username === 'root');
  const nonBmcCred = creds.find(c => c.credential_type !== 'bmc');
  if (rootCred) {
    user = rootCred.username;
    password = rootCred.password;
  } else if (nonBmcCred) {
    user = nonBmcCred.username;
    password = nonBmcCred.password;
  } else if (creds.length > 0) {
    user = creds[0].username;
    password = creds[0].password;
  } else if (asset.ssh_user) {
    user = asset.ssh_user;
    password = asset.ssh_password;
  }

  return { ip, user, password, port: asset.ssh_port || 22 };
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// ── Page render ──
router.get('/', (req, res) => {
  try {
    const { assets, rooms } = getGpuAssets();
    res.render('gpu-monitoring/index', {
      title: 'GPU 모니터링',
      currentPath: '/gpu-monitoring',
      extraCss: 'gpu-monitoring.css',
      assets,
      rooms
    });
  } catch (err) {
    res.render('gpu-monitoring/index', {
      title: 'GPU 모니터링',
      currentPath: '/gpu-monitoring',
      extraCss: 'gpu-monitoring.css',
      assets: [],
      rooms: [],
      error: err.message
    });
  }
});

// ── Collect GPU metrics for a single asset ──
router.post('/api/collect', requireMaintenance, async (req, res) => {
  try {
    const { asset_id } = req.body;
    if (!asset_id) return res.status(400).json({ error: 'asset_id is required' });

    const asset = Asset.findById(asset_id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const conn = resolveAssetConnection(asset);
    if (!conn.ip) {
      return res.json({
        asset_id,
        status: 'error',
        error: 'IP 주소가 등록되지 않았습니다.',
        gpus: []
      });
    }

    const result = await collectGpuMetrics(conn.ip, {
      user: conn.user || undefined,
      password: conn.password || undefined,
      port: conn.port || undefined
    });

    res.json({
      asset_id,
      ip: conn.ip,
      status: result.status,
      tool: result.tool || null,
      error: result.error || null,
      gpus: result.gpus || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
