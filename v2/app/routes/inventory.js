const express = require('express');
const router = express.Router();
const ModuleInventory = require('../models/moduleInventory');
const Vendor = require('../models/vendor');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const { pool } = require('../config/database');
const { generateVendorManagementNumber } = require('../utils/inventoryHelpers');

// B-4d-6c-A: 무접촉 7EP(#2,4,5,6,7,8,17)만 구현.
// EUL 접촉 11EP(#1,3,9,10,11,12,13,14,15,16,18)는 501 스텁 — B-4d-6c 후속 조각에서 구현.
const notImplemented = (req, res) => {
  res.status(501).json({ error: '미구현 - B-4d-6c 후속 조각' });
};

// EP#1: Inventory list (EUL 읽기) — 스텁
router.get('/', notImplemented);

// === Incoming Registration (입고 등록) ===

// EP#2: GET /incoming - incoming registration form
router.get('/incoming', async (req, res, next) => {
  try {
    const vendors = await Vendor.findAll();
    const moduleInventoryItems = await ModuleInventory.findAll();

    res.render('inventory/incoming-form', {
      title: '입고 등록',
      currentPath: '/inventory',
      extraCss: null,
      extraJs: null,
      vendors,
      moduleInventoryItems,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// EP#3: POST /incoming - create incoming record (EUL 쓰기) — 스텁
router.post('/incoming', requireMaintenance, notImplemented);

// EP#4: API: get next vendor management number (for preview)
router.get('/api/vendor-mgmt-number', async (req, res) => {
  try {
    let vendorName = 'VND';
    if (req.query.vendor_name) {
      vendorName = req.query.vendor_name.trim();
    } else if (req.query.vendor_id) {
      const v = await Vendor.findById(req.query.vendor_id);
      if (v) vendorName = v.vendor_name;
    }
    res.json({ management_number: await generateVendorManagementNumber(vendorName) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#5: API: get returned (inactive) assets for a vendor (for re-incoming datalist)
router.get('/api/vendor-returned-assets', async (req, res) => {
  try {
    const vendorId = req.query.vendor_id;
    if (!vendorId) return res.json({ assets: [] });
    const { rows } = await pool.query(
      "SELECT id, management_number, model_name, asset_type FROM assets WHERE vendor_id = $1 AND status IN ('inactive','returned') ORDER BY management_number",
      [vendorId]
    );
    res.json({ assets: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#6: API: get next management number suggestions by asset type
router.get('/api/next-mgmt-number', async (req, res) => {
  try {
    const assetType = req.query.asset_type;
    if (!assetType) return res.json({ suggestions: [], recent: [] });

    const { rows } = await pool.query(
      "SELECT management_number FROM assets WHERE asset_type = $1 AND management_number IS NOT NULL AND management_number != ''",
      [assetType]
    );

    // Group by prefix: split management_number into prefix + trailing number
    const prefixMap = {}; // prefix -> { numbers: [], padLen }
    const re = /^(.+?)(\d+)$/;
    rows.forEach(row => {
      const m = row.management_number.match(re);
      if (m) {
        const prefix = m[1];
        const num = parseInt(m[2], 10);
        const padLen = m[2].length;
        if (!prefixMap[prefix]) prefixMap[prefix] = { numbers: [], padLen };
        prefixMap[prefix].numbers.push(num);
        // Track max pad length seen
        if (m[2].length > prefixMap[prefix].padLen) {
          prefixMap[prefix].padLen = m[2].length;
        }
      }
    });

    // Build suggestions sorted by count descending
    const suggestions = Object.entries(prefixMap).map(([prefix, data]) => {
      const maxNum = Math.max(...data.numbers);
      const nextNum = maxNum + 1;
      const padLen = data.padLen;
      return {
        prefix,
        last: prefix + String(maxNum).padStart(padLen, '0'),
        next: prefix + String(nextNum).padStart(padLen, '0'),
        count: data.numbers.length
      };
    }).sort((a, b) => b.count - a.count);

    // Recent management numbers (last 5 created)
    const { rows: recentRows } = await pool.query(
      "SELECT management_number FROM assets WHERE asset_type = $1 AND management_number IS NOT NULL AND management_number != '' ORDER BY id DESC LIMIT 5",
      [assetType]
    );
    const recent = recentRows.map(r => r.management_number);

    res.json({ suggestions, recent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#7: API: check if management number already exists
router.get('/api/check-mgmt-number', async (req, res) => {
  try {
    const mgmtNumber = req.query.management_number;
    if (!mgmtNumber) return res.json({ exists: false });

    const { rows } = await pool.query(
      "SELECT id, management_number, status, model_name, ownership FROM assets WHERE management_number = $1",
      [mgmtNumber]
    );
    const row = rows[0];
    if (!row) return res.json({ exists: false });
    // inactive/returned asset → re-incoming possible
    if (row.status === 'inactive' || row.status === 'returned') {
      return res.json({ exists: true, reIncoming: true, asset: { id: row.id, status: row.status, model_name: row.model_name, ownership: row.ownership } });
    }
    res.json({ exists: true, reIncoming: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#8: API: get module inventory items by type (for AJAX)
router.get('/api/modules/:type', async (req, res) => {
  try {
    const items = await ModuleInventory.findAll(req.params.type);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#16: Asset detail API (AJAX for auto-fill, EUL 읽기) — 스텁
// ★ /api/* 구체 경로는 /:id 동적 경로보다 먼저 등록 (매칭 순서)
router.get('/api/asset/:id', notImplemented);

// EP#17: Component spec API (AJAX)
router.get('/api/component/:code', async (req, res) => {
  try {
    const spec = await ModuleInventory.findByCode(req.params.code);
    if (!spec) return res.status(404).json({ error: 'Not found' });
    res.json(spec);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#18: One-time migration: add default PSU entries (EUL 쓰기) — 스텁
router.post('/api/migrate-psu', requireMaintenance, notImplemented);

// EP#9: New usage registration form (EUL prefill) — 스텁
router.get('/new', notImplemented);

// EP#10: Create usage (EUL 쓰기 + 자산 동기화) — 스텁
router.post('/', requireMaintenance, notImplemented);

// EP#11: Equipment detail by management number (EUL 이력) — 스텁
router.get('/equipment/:mgmt', notImplemented);

// EP#12: Edit form (EUL 읽기) — 스텁
router.get('/:id/edit', notImplemented);

// EP#13: Update (EUL 쓰기) — 스텁
router.post('/:id', requireMaintenance, notImplemented);

// EP#14: Return 반납 (EUL append) — 스텁
router.post('/:id/return', requireMaintenance, notImplemented);

// EP#15: Delete (EUL 삭제) — 스텁
router.post('/:id/delete', requireMaintenance, notImplemented);

module.exports = router;
