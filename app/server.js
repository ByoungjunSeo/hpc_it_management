const express = require('express');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const session = require('express-session');
const flash = require('express-flash');
const cookieParser = require('cookie-parser');
const appConfig = require('./config/app');
const { getDb, closeDb } = require('./config/database');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { requireLogin, requireMaintenance, requireAdmin } = require('./middleware/auth');

const app = express();

// Initialize database
getDb();

// Ensure backups directory exists
const backupsDir = path.join(__dirname, 'data', 'backups');
if (!fs.existsSync(backupsDir)) {
  fs.mkdirSync(backupsDir, { recursive: true });
}

// Ensure photo upload directories exist
const photoAssetsDir = path.join(__dirname, 'public', 'uploads', 'photos', 'assets');
const photoModulesDir = path.join(__dirname, 'public', 'uploads', 'photos', 'modules');
if (!fs.existsSync(photoAssetsDir)) {
  fs.mkdirSync(photoAssetsDir, { recursive: true });
}
if (!fs.existsSync(photoModulesDir)) {
  fs.mkdirSync(photoModulesDir, { recursive: true });
}
const photoLendingsDir = path.join(__dirname, 'public', 'uploads', 'photos', 'lendings');
if (!fs.existsSync(photoLendingsDir)) {
  fs.mkdirSync(photoLendingsDir, { recursive: true });
}

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser('it-asset-secret'));
app.use(session({
  secret: 'it-asset-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(flash());
app.use(express.static(path.join(__dirname, 'public')));

// Flash messages + current user available to all views
app.use((req, res, next) => {
  res.locals.flash = {
    success: req.flash('success')[0],
    error: req.flash('error')[0]
  };
  res.locals.appConfig = appConfig;
  res.locals.currentUser = req.session.userId ? {
    id: req.session.userId,
    username: req.session.username,
    role: req.session.userRole,
    displayName: req.session.displayName
  } : null;
  next();
});

// Auth routes (no login required)
app.use('/', require('./routes/auth'));

// Public intake (no login required - external vendor use)
app.use('/intake', require('./routes/publicIntake'));

// All other routes require login
app.use(requireLogin);

// Photo API
app.use('/api/photos', require('./routes/photos'));

// Routes
app.use('/', require('./routes/index'));
app.use('/assets', require('./routes/assets'));
app.use('/rooms', require('./routes/serverRooms'));
app.use('/racks', require('./routes/racks'));
app.use('/computing-modules', (req, res) => res.redirect('/module-inventory?tab=installed'));
app.use('/ip-management', require('./routes/ipManagement'));
app.use('/inventory', require('./routes/inventory'));
app.use('/discovery', require('./routes/discovery'));
app.use('/offices', require('./routes/offices'));
app.use('/storage', require('./routes/storage'));
app.use('/lendings', require('./routes/lendings'));
app.use('/module-inventory', require('./routes/moduleInventory'));
app.use('/vendor-intake', require('./routes/vendorIntake'));
app.use('/requests', require('./routes/requests'));
app.use('/excel', require('./routes/excelUpload'));
app.use('/power-panel', require('./routes/powerPanel'));
app.use('/network-layout', require('./routes/networkLayout'));
app.use('/audit-log', require('./routes/auditLog'));
app.use('/backup', require('./routes/backup'));
app.use('/gpu-monitoring', require('./routes/gpuMonitoring'));
app.use('/chat', require('./routes/chat'));

// Global search API
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  const db = getDb();
  const like = '%' + q + '%';
  const results = [];

  // Search assets
  const assets = db.prepare(`
    SELECT a.id, a.asset_number, a.model_name, a.asset_type, a.ip_address,
           a.assigned_user, a.purpose, r.name as rack_name, sr.name as room_name
    FROM assets a
    LEFT JOIN racks r ON a.rack_id = r.id
    LEFT JOIN server_rooms sr ON r.room_id = sr.id
    WHERE a.asset_number LIKE ? OR a.model_name LIKE ? OR a.ip_address LIKE ?
       OR a.assigned_user LIKE ? OR a.purpose LIKE ? OR a.serial_number LIKE ?
       OR a.manufacturer LIKE ?
    LIMIT 15
  `).all(like, like, like, like, like, like, like);
  assets.forEach(a => {
    results.push({
      type: 'asset',
      id: a.id,
      title: a.model_name || a.asset_number || a.asset_type,
      subtitle: [a.asset_number, a.ip_address, a.assigned_user].filter(Boolean).join(' | '),
      location: [a.room_name, a.rack_name].filter(Boolean).join(' > '),
      url: '/assets/' + a.id
    });
  });

  // Search asset_ips
  const ips = db.prepare(`
    SELECT ai.ip_address, ai.ip_type, ai.description, a.id as asset_id,
           a.model_name, a.asset_number
    FROM asset_ips ai
    JOIN assets a ON ai.asset_id = a.id
    WHERE ai.ip_address LIKE ? OR ai.description LIKE ?
    LIMIT 10
  `).all(like, like);
  ips.forEach(ip => {
    if (!results.find(r => r.type === 'asset' && r.id === ip.asset_id)) {
      results.push({
        type: 'ip',
        id: ip.asset_id,
        title: ip.ip_address + ' (' + ip.ip_type + ')',
        subtitle: ip.model_name || ip.asset_number || '',
        location: ip.description || '',
        url: '/assets/' + ip.asset_id
      });
    }
  });

  // Search computing modules
  const mods = db.prepare(`
    SELECT cm.module_type, cm.model, cm.manufacturer, cm.capacity,
           a.id as asset_id, a.model_name, a.asset_number
    FROM computing_modules cm
    JOIN assets a ON cm.asset_id = a.id
    WHERE cm.model LIKE ? OR cm.manufacturer LIKE ? OR cm.capacity LIKE ?
    LIMIT 10
  `).all(like, like, like);
  mods.forEach(m => {
    if (!results.find(r => r.type === 'asset' && r.id === m.asset_id)) {
      results.push({
        type: 'module',
        id: m.asset_id,
        title: m.module_type.toUpperCase() + ': ' + (m.model || m.manufacturer || ''),
        subtitle: (m.model_name || m.asset_number || '') + (m.capacity ? ' | ' + m.capacity : ''),
        url: '/assets/' + m.asset_id
      });
    }
  });

  res.json(results.slice(0, 20));
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Auto backup: every 7 days
const BACKUP_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days
function performAutoBackup() {
  try {
    const db = getDb();
    const now = new Date();
    const filename = 'it_assets_backup_' +
      now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0') + '.db';
    const destPath = path.join(backupsDir, filename);
    db.backup(destPath).then(() => {
      console.log('[AutoBackup] Created: ' + filename);
      // Clean up backups older than 1 year
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      const files = fs.readdirSync(backupsDir);
      files.forEach(f => {
        if (!f.endsWith('.db')) return;
        const filePath = path.join(backupsDir, f);
        const stat = fs.statSync(filePath);
        if (stat.mtime < oneYearAgo) {
          fs.unlinkSync(filePath);
          console.log('[AutoBackup] Deleted old backup: ' + f);
        }
      });
    }).catch(err => {
      console.error('[AutoBackup] Failed:', err.message);
    });
  } catch (err) {
    console.error('[AutoBackup] Error:', err.message);
  }
}

setInterval(performAutoBackup, BACKUP_INTERVAL);
console.log('[AutoBackup] Scheduled every 7 days');

// One-time migration: sync hardware_json → computing_modules for all assets
(function syncHardwareToModules() {
  try {
    const db = getDb();
    const ComputingModule = require('./models/computingModule');
    // Find assets with no computing_modules but have hardware_json in usage logs
    const rows = db.prepare(`
      SELECT a.id, a.management_number, a.vendor_id,
        (SELECT l.hardware_json FROM equipment_usage_logs l
         WHERE l.management_number = a.management_number AND l.hardware_json IS NOT NULL
         ORDER BY l.id DESC LIMIT 1) as latest_hw_json
      FROM assets a
      WHERE a.asset_type IN ('server','storage','switch')
        AND (SELECT COUNT(*) FROM computing_modules cm WHERE cm.asset_id = a.id) = 0
    `).all();

    let synced = 0;
    for (const row of rows) {
      if (!row.latest_hw_json) continue;
      let hwItems;
      try { hwItems = JSON.parse(row.latest_hw_json); } catch(e) { continue; }
      if (!Array.isArray(hwItems) || hwItems.length === 0) continue;

      for (const hw of hwItems) {
        if (!hw.type || !hw.code) continue;
        const ownerVal = hw.ownership || 'company';
        ComputingModule.create({
          asset_id: row.id,
          module_type: hw.type,
          model: hw.code,
          manufacturer: null,
          capacity: null,
          count: hw.num || 1,
          specification: null,
          slot_info: null,
          notes: hw.role || null,
          owner: ownerVal,
          owner_vendor_id: ownerVal === 'vendor' ? (row.vendor_id || null) : null
        });
      }
      synced++;
    }
    if (synced > 0) {
      console.log('[Migration] Synced hardware_json → computing_modules for ' + synced + ' assets');
    }

    // Backfill: fix existing modules with owner='vendor' but no owner_vendor_id
    const fixed = db.prepare(`
      UPDATE computing_modules SET owner_vendor_id = (
        SELECT a.vendor_id FROM assets a WHERE a.id = computing_modules.asset_id
      )
      WHERE owner = 'vendor' AND owner_vendor_id IS NULL
        AND EXISTS (SELECT 1 FROM assets a WHERE a.id = computing_modules.asset_id AND a.vendor_id IS NOT NULL)
    `).run();
    if (fixed.changes > 0) {
      console.log('[Migration] Backfilled owner_vendor_id for ' + fixed.changes + ' vendor modules');
    }
  } catch (err) {
    console.error('[Migration] hardware sync error:', err.message);
  }
})();

// Start server
const PORT = appConfig.port;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`IT Asset Management running on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

module.exports = app;
