require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const flash = require('express-flash');
const cookieParser = require('cookie-parser');
const appConfig = require('./config/app');
const { pool, closeDb } = require('./config/database');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { requireLogin } = require('./middleware/auth');

// Ensure photo upload directories exist
const photoAssetsDir = path.join(__dirname, 'public', 'uploads', 'photos', 'assets');
const photoModulesDir = path.join(__dirname, 'public', 'uploads', 'photos', 'modules');
const photoLendingsDir = path.join(__dirname, 'public', 'uploads', 'photos', 'lendings');
[photoAssetsDir, photoModulesDir, photoLendingsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.SESSION_SECRET || 'it-asset-secret'));
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session',
  }),
  secret: process.env.SESSION_SECRET || 'it-asset-secret-key',
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

// ── Routes ──────────────────────────────────────────────────

// Auth routes (no login required)
app.use('/', require('./routes/auth'));

// Public intake (no login required - external vendor use)
// app.use('/intake', require('./routes/publicIntake'));

// All other routes require login
app.use(requireLogin);

app.use('/api/photos', require('./routes/photos'));
app.use('/', require('./routes/index'));
// app.use('/assets', require('./routes/assets'));
app.use('/rooms', require('./routes/serverRooms'));
// app.use('/racks', require('./routes/racks'));
// app.use('/computing-modules', (req, res) => res.redirect('/module-inventory?tab=installed'));
app.use('/ip-management', require('./routes/ipManagement'));
// app.use('/inventory', require('./routes/inventory'));
// app.use('/discovery', require('./routes/discovery'));
app.use('/offices', require('./routes/offices'));
app.use('/storage', require('./routes/storage'));
app.use('/lendings', require('./routes/lendings'));
// app.use('/module-inventory', require('./routes/moduleInventory'));
app.use('/vendor-intake', require('./routes/vendorIntake'));
// app.use('/requests', require('./routes/requests'));
// app.use('/excel', require('./routes/excelUpload'));
// app.use('/power-panel', require('./routes/powerPanel'));
// app.use('/network-layout', require('./routes/networkLayout'));
app.use('/audit-log', require('./routes/auditLog'));
// app.use('/backup', require('./routes/backup'));
// app.use('/gpu-monitoring', require('./routes/gpuMonitoring'));
// app.use('/chat', require('./routes/chat'));

// Global search API
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    const like = '%' + q + '%';
    const results = [];

    // Search assets
    const { rows: assets } = await pool.query(`
      SELECT a.id, a.asset_number, a.model_name, a.asset_type, a.ip_address,
             a.assigned_user, a.purpose, r.name as rack_name, sr.name as room_name
      FROM assets a
      LEFT JOIN racks r ON a.rack_id = r.id
      LEFT JOIN server_rooms sr ON r.room_id = sr.id
      WHERE a.asset_number ILIKE $1 OR a.model_name ILIKE $1 OR a.ip_address ILIKE $1
         OR a.assigned_user ILIKE $1 OR a.purpose ILIKE $1 OR a.serial_number ILIKE $1
         OR a.manufacturer ILIKE $1
      LIMIT 15
    `, [like]);
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
    const { rows: ips } = await pool.query(`
      SELECT ai.ip_address, ai.ip_type, ai.description, a.id as asset_id,
             a.model_name, a.asset_number
      FROM asset_ips ai
      JOIN assets a ON ai.asset_id = a.id
      WHERE ai.ip_address ILIKE $1 OR ai.description ILIKE $1
      LIMIT 10
    `, [like]);
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
    const { rows: mods } = await pool.query(`
      SELECT cm.module_type, cm.model, cm.manufacturer, cm.capacity,
             a.id as asset_id, a.model_name, a.asset_number
      FROM computing_modules cm
      JOIN assets a ON cm.asset_id = a.id
      WHERE cm.model ILIKE $1 OR cm.manufacturer ILIKE $1 OR cm.capacity ILIKE $1
      LIMIT 10
    `, [like]);
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
  } catch (err) {
    console.error('[/api/search] Error:', err.message);
    res.json([]);
  }
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const PORT = process.env.APP_PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`IT Asset Management v2 running on http://0.0.0.0:${PORT}`);
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
