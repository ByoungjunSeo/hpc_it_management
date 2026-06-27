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
// const { requireLogin, requireMaintenance, requireAdmin } = require('./middleware/auth');

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
// B-4a-2 이후 하나씩 해제 예정

// Auth routes (no login required)
app.use('/', require('./routes/auth'));

// Public intake (no login required - external vendor use)
// app.use('/intake', require('./routes/publicIntake'));

// All other routes require login
// app.use(requireLogin);

// app.use('/api/photos', require('./routes/photos'));
// app.use('/', require('./routes/index'));
// app.use('/assets', require('./routes/assets'));
// app.use('/rooms', require('./routes/serverRooms'));
// app.use('/racks', require('./routes/racks'));
// app.use('/computing-modules', (req, res) => res.redirect('/module-inventory?tab=installed'));
// app.use('/ip-management', require('./routes/ipManagement'));
// app.use('/inventory', require('./routes/inventory'));
// app.use('/discovery', require('./routes/discovery'));
// app.use('/offices', require('./routes/offices'));
// app.use('/storage', require('./routes/storage'));
// app.use('/lendings', require('./routes/lendings'));
// app.use('/module-inventory', require('./routes/moduleInventory'));
// app.use('/vendor-intake', require('./routes/vendorIntake'));
// app.use('/requests', require('./routes/requests'));
// app.use('/excel', require('./routes/excelUpload'));
// app.use('/power-panel', require('./routes/powerPanel'));
// app.use('/network-layout', require('./routes/networkLayout'));
// app.use('/audit-log', require('./routes/auditLog'));
// app.use('/backup', require('./routes/backup'));
// app.use('/gpu-monitoring', require('./routes/gpuMonitoring'));
// app.use('/chat', require('./routes/chat'));

// Global search API (async 전환은 B-4b에서)
// app.get('/api/search', async (req, res) => { ... });

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
