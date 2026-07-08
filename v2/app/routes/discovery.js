const express = require('express');
const router = express.Router();
const Asset = require('../models/asset');
const ComputingModule = require('../models/computingModule');
const AssetIp = require('../models/assetIp');
const AssetCredential = require('../models/assetCredential');
const ServerRoom = require('../models/serverRoom');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const ModuleTransferLog = require('../models/moduleTransferLog');
const ModuleInventory = require('../models/moduleInventory');
const ModuleInventoryLog = require('../models/moduleInventoryLog');
const Vendor = require('../models/vendor');
const AuditLog = require('../models/auditLog');
const { pool } = require('../config/database');
const { fixRowDates } = require('../utils/dateFix');
const { connectAndDiscover, discoverRange } = require('../services/sshDiscovery');
const { lookupSpec } = require('../services/specLookup');

// ── Helper: generate vendor item_code like {업체명}-{유형한글}-{NNN} ──
const TYPE_LABELS = {
  cpu: 'CPU', memory: '메모리', disk: '스토리지', network: '네트워크',
  raid: 'RAID', gpu: 'GPU', cable: '케이블', psu: 'PSU'
};

// BUG-6 (B) notes 합성용 타입 라벨 (disk는 사용자 요청 표기 '디스크')
const NOTE_TYPE_LABELS = {
  cpu: 'CPU', memory: '메모리', disk: '디스크', network: '네트워크',
  raid: 'RAID', gpu: 'GPU', cable: '케이블', psu: 'PSU', npu: 'NPU'
};

async function generateVendorItemCode(vendorName, moduleType) {
  const typeName = TYPE_LABELS[moduleType] || moduleType;
  const newPrefix = vendorName + '-' + typeName + '-';
  const oldPrefix = vendorName + '-부품-' + typeName + '-';

  // 신규 + 기존(부품) 형식 모두 검색하여 최대 번호 산출
  const { rows } = await pool.query(
    'SELECT item_code FROM module_inventory WHERE item_code ILIKE $1 OR item_code ILIKE $2 ORDER BY item_code',
    [newPrefix + '%', oldPrefix + '%']
  );

  let maxNum = 0;
  for (const row of rows) {
    const prefix = row.item_code.startsWith(oldPrefix) ? oldPrefix : newPrefix;
    const num = parseInt(row.item_code.substring(prefix.length));
    if (!isNaN(num) && num > maxNum) maxNum = num;
  }

  return newPrefix + String(maxNum + 1).padStart(3, '0');
}

// B-4d-7 discovery 14EP 이식 완료:
//  7b 읽기 6EP(#1,2,5,6,9,11) / 7c 쓰기 3EP(#4 apply-asset §5+BUG-6, #7 register, #8 link)
//  / 7d 능동·legacy 5EP(#3 scan-asset, #10 ai-spec-lookup, #12 scan, #13 scan-range, #14 apply).
// [능동] EP는 SSH(ssh2)/Ollama/DuckDuckGo 접촉 — 실스캔 검증은 7e(사용자 입회).

// ── Helper: compare registered modules vs discovered modules (v1 L52–137, 순수함수) ──
function normalizeModel(model) {
  return (model || '').toLowerCase().trim().replace(/\s*x\d+\s*$/, '').replace(/\s+/g, ' ');
}

function modelsMatch(a, b) {
  const na = normalizeModel(a);
  const nb = normalizeModel(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function compareModules(registered, discovered) {
  const result = { matched: [], mismatched: [], missing: [], extra: [] };
  const types = ['cpu', 'memory', 'disk', 'network', 'raid', 'gpu'];

  for (const type of types) {
    const regList = registered.filter(m => m.module_type === type).map(m => ({ ...m }));
    const discList = discovered.filter(m => m.module_type === type).map(m => ({ ...m }));
    const usedDisc = new Set();

    // 1:1 matching — only compare modules that exist on both sides
    const unmatchedReg = [];
    regList.forEach(reg => {
      let bestIdx = -1;
      let bestExact = false;
      for (let i = 0; i < discList.length; i++) {
        if (usedDisc.has(i)) continue;
        if (modelsMatch(reg.model, discList[i].model)) {
          const exact = normalizeModel(reg.model) === normalizeModel(discList[i].model);
          if (bestIdx < 0 || (exact && !bestExact)) {
            bestIdx = i;
            bestExact = exact;
          }
        }
      }
      if (bestIdx >= 0) {
        usedDisc.add(bestIdx);
        const disc = discList[bestIdx];
        const regCount = reg.count || 1;
        const discCount = disc.count || 1;
        if (regCount === discCount) {
          result.matched.push({
            _type: type, model: reg.model || disc.model,
            registered_count: regCount, discovered_count: discCount,
            registered_items: [reg], discovered_items: [disc]
          });
        } else {
          result.mismatched.push({
            _type: type, model: reg.model || disc.model,
            registered_count: regCount, discovered_count: discCount,
            registered_items: [reg], discovered_items: [disc]
          });
        }
      } else {
        unmatchedReg.push(reg);
      }
    });

    // Collect unmatched discovered modules for this type
    const unmatchedDisc = discList.filter((d, i) => !usedDisc.has(i));

    // If both sides have unmatched modules of the same type → mismatch
    const pairCount = Math.min(unmatchedReg.length, unmatchedDisc.length);
    for (let p = 0; p < pairCount; p++) {
      result.mismatched.push({
        _type: type,
        model: unmatchedReg[p].model || unmatchedDisc[p].model,
        registered_count: unmatchedReg[p].count || 1,
        discovered_count: unmatchedDisc[p].count || 1,
        registered_items: [unmatchedReg[p]],
        discovered_items: [unmatchedDisc[p]]
      });
    }
    // Remaining registered modules with no discovered counterpart → missing
    for (let p = pairCount; p < unmatchedReg.length; p++) {
      result.missing.push({ ...unmatchedReg[p], _type: type });
    }
    // Remaining discovered modules with no registered counterpart → extra
    for (let p = pairCount; p < unmatchedDisc.length; p++) {
      result.extra.push({ ...unmatchedDisc[p], _type: type });
    }
  }
  return result;
}

// ── Helper: resolve IP and credentials for an asset (v1 L185–229, pg 전환) ──
async function resolveAssetConnection(asset) {
  const ips = await AssetIp.findByAsset(asset.id);
  const creds = await AssetCredential.findByAsset(asset.id);

  // Find SSH-connectable IP: os → management(10.100.x only) → first non-BMC → any → legacy
  // 192.168.x.x management IP는 서버에서 접근 불가하므로 os IP 우선
  let ip = null;
  const osIp = ips.find(i => i.ip_type === 'os');
  const mgmtIp = ips.find(i => i.ip_type === 'management' && i.ip_address && i.ip_address.startsWith('10.'));
  const mgmtIpAny = ips.find(i => i.ip_type === 'management');
  const nonBmcIp = ips.find(i => i.ip_type !== 'bmc' && i.ip_type !== 'management');
  if (osIp) {
    ip = osIp.ip_address;
  } else if (mgmtIp) {
    ip = mgmtIp.ip_address;
  } else if (nonBmcIp) {
    ip = nonBmcIp.ip_address;
  } else if (mgmtIpAny) {
    ip = mgmtIpAny.ip_address;
  } else if (ips.length > 0) {
    ip = ips[0].ip_address;
  } else if (asset.ip_address) {
    ip = asset.ip_address;
  }

  // Find SSH credential: root → first non-BMC → any → legacy
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

// ── Helper: get server-room assets with IPs, credentials, modules ──
async function getServerRoomAssets() {
  const rooms = await ServerRoom.findAll('server_room');
  if (rooms.length === 0) return [];

  const roomIds = rooms.map(r => r.id);

  // Top-level active assets in server rooms (via direct room_id or via rack→room_id)
  const { rows: assets } = await pool.query(`
    SELECT DISTINCT a.*, r.name as rack_name,
      COALESCE(sr_direct.name, sr.name) as room_name,
      COALESCE(a.room_id, sr.id) as effective_room_id
    FROM assets a
    LEFT JOIN racks r ON a.rack_id = r.id
    LEFT JOIN server_rooms sr ON r.room_id = sr.id
    LEFT JOIN server_rooms sr_direct ON a.room_id = sr_direct.id
    WHERE a.status = 'active'
      AND a.asset_type IN ('server', 'storage')
      AND a.parent_asset_id IS NULL
      AND (
        a.room_id = ANY($1)
        OR r.room_id = ANY($1)
      )
    ORDER BY a.rack_id, a.rack_unit_start, a.asset_number
  `, [roomIds]);

  // Enrich each asset
  for (const asset of assets) {
    fixRowDates(asset, ['purchase_date', 'warranty_end'],
      ['purchase_date', 'warranty_end', 'created_at', 'updated_at']);
    asset.ips = await AssetIp.findByAsset(asset.id);
    asset.credentials = await AssetCredential.findByAsset(asset.id);
    asset.registered_modules = await ComputingModule.findByAsset(asset.id);
    asset.children = await Asset.findChildren(asset.id);
    // Enrich children too
    for (const child of asset.children) {
      child.ips = await AssetIp.findByAsset(child.id);
      child.credentials = await AssetCredential.findByAsset(child.id);
      child.registered_modules = await ComputingModule.findByAsset(child.id);
    }
  }

  return assets;
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// EP#1: Page render
router.get('/', async (req, res) => {
  try {
    const assets = await getServerRoomAssets();
    res.render('discovery/index', {
      title: '자산 매칭',
      currentPath: '/discovery',
      extraCss: null,
      extraJs: 'discovery.js',
      appConfig,
      assets
    });
  } catch (err) {
    res.render('discovery/index', {
      title: '자산 매칭',
      currentPath: '/discovery',
      extraCss: null,
      extraJs: 'discovery.js',
      appConfig,
      assets: [],
      error: err.message
    });
  }
});

// EP#2: Server-room assets API (AJAX)
router.get('/assets', async (req, res) => {
  try {
    const assets = await getServerRoomAssets();
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#3: Scan single asset — [능동] SSH (v1 L272–350 충실이식)
router.post('/scan-asset', requireMaintenance, async (req, res) => {
  try {
    const { asset_id } = req.body;
    if (!asset_id) return res.status(400).json({ error: 'asset_id is required' });

    const asset = await Asset.findById(asset_id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const conn = await resolveAssetConnection(asset);
    if (!conn.ip) {
      return res.json({
        asset_id,
        status: 'error',
        error: 'IP 주소가 등록되지 않았습니다.'
      });
    }

    // BMC IP + credential for IPMI PSU detection (v1 충실 — PSU는 매칭 제외라 현재 미사용)
    const assetIps = await AssetIp.findByAsset(asset_id);
    const assetCreds = await AssetCredential.findByAsset(asset_id);
    const bmcIp = assetIps.find(i => i.ip_type === 'bmc');
    const bmcCred = assetCreds.find(c => c.credential_type === 'bmc');

    // SSH scan (PSU는 IPMI 감지 정확도 문제로 자산 매칭에서 제외)
    const scanResult = await connectAndDiscover(conn.ip, {
      user: conn.user || undefined,
      password: conn.password || undefined,
      port: conn.port || undefined
    });

    // Remove PSU from scan results — PSU는 수동 관리
    if (scanResult.modules) {
      scanResult.modules = scanResult.modules.filter(m => m.module_type !== 'psu');
    }

    // Compare with registered modules — enrich with item_code info
    const registeredModules = await ComputingModule.findByAsset(asset_id);
    const allInventory = await ModuleInventory.findAll();
    const inventoryByCode = {};
    allInventory.forEach(mi => { inventoryByCode[mi.item_code] = mi; });
    for (const mod of registeredModules) {
      if (mod.specification && inventoryByCode[mod.specification]) {
        const inv = inventoryByCode[mod.specification];
        mod.linked_item_code = mod.specification;
        mod.linked_item_label = inv.label || inv.model || null;
      }
    }

    let comparison = null;
    if (scanResult.status === 'success' && scanResult.modules) {
      comparison = compareModules(registeredModules, scanResult.modules);
    }

    // Fetch vendor list for owner dropdown and asset ownership info
    const vendors = await Vendor.findAll();
    const assetVendor = asset.vendor_id ? await Vendor.findById(asset.vendor_id) : null;

    res.json({
      asset_id,
      asset_number: asset.management_number || asset.asset_number,
      status: scanResult.status,
      hostname: scanResult.hostname,
      totalMemory: scanResult.totalMemory,
      osInfo: scanResult.osInfo || null,
      serial: scanResult.serial || null,
      error: scanResult.error,
      discovered_modules: scanResult.modules || [],
      registered_modules: registeredModules,
      comparison,
      rawOutput: scanResult.rawOutput || null,
      asset_ownership: asset.ownership || 'company',
      asset_vendor_id: asset.vendor_id || null,
      asset_vendor_name: assetVendor ? assetVendor.vendor_name : null,
      vendors: vendors.map(v => ({ id: v.id, vendor_name: v.vendor_name }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#4: Apply scan result to asset
// v1 L356–768 이식. 계획된 이탈: §5 EUL 이중기록 제거 / BUG-6 A′ diff 기준 교체 / BUG-6 B notes 합성.
// 트랜잭션: v1도 비트랜잭션(개별 실행) — 충실 유지. bulkCreate 내부만 자체 BEGIN/COMMIT.
router.post('/apply-asset', requireMaintenance, async (req, res) => {
  try {
    const { asset_id, modules } = req.body;
    if (!asset_id) return res.status(400).json({ error: 'asset_id is required' });

    const asset = await Asset.findById(asset_id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const assetLabel = asset.management_number || asset.asset_number || String(asset_id);
    let unmatchedModules = [];
    const auditChanges = {};

    if (modules && modules.length > 0) {
      // Snapshot existing modules before replacing
      const oldModules = await ComputingModule.findByAsset(asset_id);

      // If discovered memory is fallback-only (no DIMM detail), keep existing registered memory
      const discMemory = modules.filter(m => m.module_type === 'memory');
      const isFallbackMemory = discMemory.length > 0 && discMemory.every(m =>
        (m.model && m.model.includes('상세정보 없음')) || (m.specification === '/proc/meminfo')
      );
      // PSU는 스캔에서 제외 → 기존 등록된 PSU 유지
      const oldPsu = oldModules.filter(m => m.module_type === 'psu');
      let modulesToApply = modules.filter(m => m.module_type !== 'psu');
      if (oldPsu.length > 0) {
        modulesToApply = modulesToApply.concat(
          oldPsu.map(m => ({
            module_type: m.module_type, model: m.model, manufacturer: m.manufacturer,
            capacity: m.capacity, count: m.count || 1, specification: m.specification,
            slot_info: m.slot_info, notes: m.notes, owner: m.owner || 'company',
            owner_vendor_id: m.owner_vendor_id || null, is_onboard: m.is_onboard || 0
          }))
        );
      }
      if (isFallbackMemory) {
        const oldMemory = oldModules.filter(m => m.module_type === 'memory');
        if (oldMemory.length > 0) {
          // BUG-6 A′: v1은 여기서 원본 modules 기준으로 재구성해 PSU 보존분이 유실됨(L393) —
          // modulesToApply 기준으로 교체해 PSU+메모리 보존이 함께 유지되게 수정
          modulesToApply = modulesToApply.filter(m => m.module_type !== 'memory').concat(
            oldMemory.map(m => ({
              module_type: m.module_type, model: m.model, manufacturer: m.manufacturer,
              capacity: m.capacity, count: m.count || 1, specification: m.specification,
              slot_info: m.slot_info, notes: m.notes, owner: m.owner || 'company',
              owner_vendor_id: m.owner_vendor_id || null, is_onboard: m.is_onboard || 0
            }))
          );
        }
      }

      // Replace modules (with owner info)
      await ComputingModule.deleteByAsset(asset_id);
      await ComputingModule.bulkCreate(asset_id, modulesToApply);

      // Auto-link specification (item_code) for all modules (company + vendor)
      const allItemCodes = new Set((await ModuleInventory.findAll()).map(mi => mi.item_code));
      const newModules = await ComputingModule.findByAsset(asset_id);
      const userId = req.session.userId || null;
      const username = req.session.displayName || req.session.username || null;

      for (const mod of newModules) {
        // Skip only if specification is already a valid item_code
        if (mod.specification && allItemCodes.has(mod.specification)) continue;

        if (mod.owner && mod.owner !== 'company') {
          // ── Vendor module: auto-register to module_inventory ──
          const vendorInfo = mod.owner_vendor_id ? await Vendor.findById(mod.owner_vendor_id) : null;
          const vendorName = vendorInfo ? vendorInfo.vendor_name : '업체';

          // Step 1: Try matching existing vendor inventory item
          const vendorItems = await ModuleInventory.findAll(mod.module_type, 'vendor');
          const modModel = (mod.model || '').toLowerCase().trim();
          const existingMatch = modModel ? vendorItems.find(mi =>
            mi.owner_vendor_id == mod.owner_vendor_id &&
            (mi.model || '').toLowerCase().trim() === modModel
          ) : null;

          let itemCode;
          if (existingMatch) {
            // Already exists → just link specification
            itemCode = existingMatch.item_code;
          } else {
            // Step 2: Generate new item_code and create inventory entry
            itemCode = await generateVendorItemCode(vendorName, mod.module_type);
            await ModuleInventory.upsert({
              module_type: mod.module_type,
              item_code: itemCode,
              label: mod.model,
              manufacturer: mod.manufacturer || null,
              model: mod.model || null,
              capacity: mod.capacity || null,
              total_quantity: mod.count || 1,
              in_use_quantity: mod.count || 1,
              spare_quantity: 0,
              storage_quantity: 0,
              owner: 'vendor',
              owner_vendor_id: mod.owner_vendor_id
            });

            // Step 3: Log incoming event
            await ModuleInventoryLog.create({
              item_code: itemCode,
              event_type: 'incoming',
              quantity_change: mod.count || 1,
              user_id: userId,
              username: username,
              notes: vendorName + ' 업체 부품 자산매칭 자동 입고'
            });

            // §5: EUL 이중기록 제거 — 부품 이력은 mi_logs가 담당 (v1 L471–486의
            // EquipmentUsageLog.create 입고/사용중 2건 + L465 room/rack용 EUL 읽기 미이식)
          }

          // Step 5: Update specification
          await pool.query('UPDATE computing_modules SET specification = $1 WHERE id = $2',
            [itemCode, mod.id]);
          mod.specification = itemCode;
          allItemCodes.add(itemCode);

        } else {
          // ── Company module: existing matching logic ──
          const invItems = await ModuleInventory.findAll(mod.module_type, 'company');
          const modModel = (mod.model || '').toLowerCase().trim();
          const match = modModel ? invItems.find(mi => {
            const miModel = (mi.model || '').toLowerCase().trim();
            if (!miModel) return false;
            return miModel === modModel;
          }) || invItems.find(mi => {
            const miModel = (mi.model || '').toLowerCase().trim();
            if (!miModel) return false;
            return miModel.includes(modModel) || modModel.includes(miModel);
          }) : null;
          if (match) {
            await pool.query('UPDATE computing_modules SET specification = $1, capacity = COALESCE($2, capacity) WHERE id = $3',
              [match.item_code, match.capacity || null, mod.id]);
            mod.specification = match.item_code;
            if (match.capacity && !mod.capacity) mod.capacity = match.capacity;
          } else if (mod.model) {
            unmatchedModules.push({
              id: mod.id,
              module_type: mod.module_type,
              model: mod.model,
              manufacturer: mod.manufacturer,
              capacity: mod.capacity,
              count: mod.count || 1,
              candidates: invItems.map(mi => ({
                item_code: mi.item_code,
                model: mi.model,
                manufacturer: mi.manufacturer,
                capacity: mi.capacity,
                label: mi.label
              }))
            });
          }
        }
      }

      // ── spec 재매칭 케이스 식별 (같은 model인데 spec이 바뀐 모듈) ──
      const specRelinks = [];
      for (const newMod of newModules) {
        if (!newMod.specification || (newMod.owner && newMod.owner !== 'company')) continue;
        const newModel = (newMod.model || '').toLowerCase().trim();
        const oldMatch = oldModules.find(om => {
          if (om.specification === newMod.specification) return false;
          if (om.owner && om.owner !== 'company') return false;
          const oldModel = (om.model || '').toLowerCase().trim();
          return oldModel && newModel && (oldModel === newModel);
        });
        if (oldMatch && oldMatch.specification && oldMatch.specification !== newMod.specification) {
          specRelinks.push({
            old_spec: oldMatch.specification,
            new_spec: newMod.specification,
            module_type: newMod.module_type,
            model: newMod.model,
            count: newMod.count || 1
          });
        }
      }

      // ── storage_quantity 조정 (recalculateInUse 전에 실행해야 total이 정확함) ──
      // 자사(company) 모듈만 대상. specification(item_code) 기반 diff.
      const oldSpecMap = {};
      for (const m of oldModules) {
        if (m.specification && (!m.owner || m.owner === 'company')) {
          oldSpecMap[m.specification] = (oldSpecMap[m.specification] || 0) + (m.count || 1);
        }
      }
      const newSpecMap = {};
      for (const m of newModules) {
        if (m.specification && (!m.owner || m.owner === 'company')) {
          newSpecMap[m.specification] = (newSpecMap[m.specification] || 0) + (m.count || 1);
        }
      }
      const allSpecs = new Set([...Object.keys(oldSpecMap), ...Object.keys(newSpecMap)]);
      for (const spec of allSpecs) {
        const oldQty = oldSpecMap[spec] || 0;
        const newQty = newSpecMap[spec] || 0;
        const delta = newQty - oldQty;
        if (delta > 0) {
          // 신규 설치 → storage 차감
          const inv = await ModuleInventory.findByCode(spec);
          if (inv) {
            const deduct = Math.min(delta, inv.storage_quantity);
            if (deduct > 0) {
              await pool.query('UPDATE module_inventory SET storage_quantity = storage_quantity - $1, updated_at = CURRENT_TIMESTAMP WHERE item_code = $2',
                [deduct, spec]);
            }
            if (deduct < delta) {
              console.warn('[apply_scan] storage 부족: ' + spec + ' 필요:' + delta + ' 가용:' + inv.storage_quantity + ' 차감:' + deduct);
            }
          }
        } else if (delta < 0) {
          // 제거 → storage 복귀
          await pool.query('UPDATE module_inventory SET storage_quantity = storage_quantity + $1, updated_at = CURRENT_TIMESTAMP WHERE item_code = $2',
            [Math.abs(delta), spec]);
        }
      }

      // ── spec 재매칭 이력 기록 ──
      for (const relink of specRelinks) {
        const oldInv = await ModuleInventory.findByCode(relink.old_spec);
        const newInv = await ModuleInventory.findByCode(relink.new_spec);
        if (oldInv) {
          await ModuleInventoryLog.create({
            item_code: relink.old_spec,
            event_type: 'spec_relinked',
            quantity_change: relink.count,
            after_total: oldInv.total_quantity,
            asset_id: asset_id,
            asset_label: assetLabel,
            user_id: userId,
            username: username,
            notes: 'apply_scan: spec 재연결 (해제) → ' + relink.new_spec
          });
        }
        if (newInv) {
          await ModuleInventoryLog.create({
            item_code: relink.new_spec,
            event_type: 'spec_relinked',
            quantity_change: -relink.count,
            after_total: newInv.total_quantity,
            asset_id: asset_id,
            asset_label: assetLabel,
            user_id: userId,
            username: username,
            notes: 'apply_scan: spec 재연결 (연결) ← ' + relink.old_spec
          });
        }
      }

      await ModuleInventory.recalculateInUse();

      // ── Build transfer logs from diff ──
      // BUG-6 A′: 신규측 기준을 원본 modules(PSU 제거본)가 아닌 modulesToApply(보존본)로 —
      // 보존되는 PSU/메모리가 phantom removed로 기록되던 비대칭 해소 (v1 L634/L670)
      const transferLogs = [];
      const newKey = (m) => `${m.module_type}|${(m.model || '').toLowerCase()}|${m.owner || 'company'}|${m.owner_vendor_id || ''}`;
      const newMap = {};
      modulesToApply.forEach(m => {
        const k = newKey(m);
        if (!newMap[k]) newMap[k] = { count: 0, sample: m };
        newMap[k].count += (m.count || 1);
      });
      const oldMap = {};
      oldModules.forEach(m => {
        const k = newKey(m);
        if (!oldMap[k]) oldMap[k] = { count: 0, sample: m };
        oldMap[k].count += (m.count || 1);
      });

      // Detect removed modules (in old but not in new, or count decreased)
      for (const [k, old] of Object.entries(oldMap)) {
        const newCount = newMap[k] ? newMap[k].count : 0;
        if (newCount < old.count) {
          transferLogs.push({
            module_type: old.sample.module_type,
            model: old.sample.model,
            capacity: old.sample.capacity,
            count: old.count - newCount,
            owner: old.sample.owner || 'company',
            owner_vendor_id: old.sample.owner_vendor_id || null,
            from_asset_id: asset_id,
            from_asset_label: assetLabel,
            to_asset_id: null,
            to_asset_label: null,
            reason: 'apply_scan',
            user_id: userId,
            username: username
          });
        }
      }

      // Detect added modules (in new but not in old, or count increased)
      for (const [k, nw] of Object.entries(newMap)) {
        const oldCount = oldMap[k] ? oldMap[k].count : 0;
        if (nw.count > oldCount) {
          transferLogs.push({
            module_type: nw.sample.module_type,
            model: nw.sample.model,
            capacity: nw.sample.capacity,
            count: nw.count - oldCount,
            owner: nw.sample.owner || 'company',
            owner_vendor_id: nw.sample.owner_vendor_id || null,
            from_asset_id: null,
            from_asset_label: null,
            to_asset_id: asset_id,
            to_asset_label: assetLabel,
            reason: 'apply_scan',
            user_id: userId,
            username: username
          });
        }
      }

      if (transferLogs.length > 0) {
        await ModuleTransferLog.bulkCreate(transferLogs);
      }

      // BUG-6 (B): 타입별 old->new 수량으로 notes 합성 (변동 없는 타입은 diff에서 이미 제외)
      const typeOldCounts = {};
      oldModules.forEach(m => {
        typeOldCounts[m.module_type] = (typeOldCounts[m.module_type] || 0) + (m.count || 1);
      });
      const typeNewCounts = {};
      modulesToApply.forEach(m => {
        typeNewCounts[m.module_type] = (typeNewCounts[m.module_type] || 0) + (m.count || 1);
      });
      const applyScanNote = (moduleType) => {
        const label = NOTE_TYPE_LABELS[moduleType] || moduleType;
        const o = typeOldCounts[moduleType] || 0;
        const n = typeNewCounts[moduleType] || 0;
        return `apply_scan (${label} ${o}->${n})`;
      };

      // Log to module_inventory_logs by matching module_type+model to item_code (company + vendor)
      for (const tl of transferLogs) {
        const matchOwnerFilter = tl.owner === 'vendor' ? 'vendor' : 'company';
        const allItems = await ModuleInventory.findAll(tl.module_type, matchOwnerFilter);
        let match;
        if (tl.owner === 'vendor' && tl.owner_vendor_id) {
          // Vendor: match by owner_vendor_id + model
          match = allItems.find(mi =>
            mi.owner_vendor_id == tl.owner_vendor_id &&
            mi.model && tl.model &&
            mi.model.toLowerCase().trim() === tl.model.toLowerCase().trim()
          );
        } else {
          const tlModel = (tl.model || '').toLowerCase().trim();
          match = tlModel ? allItems.find(mi => {
            const miModel = (mi.model || '').toLowerCase().trim();
            return miModel === tlModel;
          }) || allItems.find(mi => {
            const miModel = (mi.model || '').toLowerCase().trim();
            return miModel && (miModel.includes(tlModel) || tlModel.includes(miModel));
          }) : null;
        }
        if (match) {
          const eventType = tl.from_asset_id && !tl.to_asset_id ? 'removed' : 'installed';
          const isCompanyTl = (!tl.owner || tl.owner === 'company');
          let qtyChange = 0;
          if (isCompanyTl) {
            qtyChange = eventType === 'installed' ? -(tl.count || 1) : (tl.count || 1);
          }
          const invAfter = await ModuleInventory.findByCode(match.item_code);
          const note = applyScanNote(tl.module_type);
          auditChanges[NOTE_TYPE_LABELS[tl.module_type] || tl.module_type] =
            (typeOldCounts[tl.module_type] || 0) + '->' + (typeNewCounts[tl.module_type] || 0);
          await ModuleInventoryLog.create({
            item_code: match.item_code,
            event_type: eventType,
            quantity_change: qtyChange,
            after_total: invAfter ? invAfter.total_quantity : null,
            asset_id: tl.to_asset_id || tl.from_asset_id || null,
            asset_label: tl.to_asset_label || tl.from_asset_label || null,
            from_asset_id: tl.from_asset_id || null,
            from_asset_label: tl.from_asset_label || null,
            to_asset_id: tl.to_asset_id || null,
            to_asset_label: tl.to_asset_label || null,
            user_id: userId,
            username: username,
            notes: note
          });
        } else {
          console.warn('[apply_scan] inventory 매칭 실패: module_type=' + tl.module_type + ' model=' + tl.model + ' asset=' + (tl.to_asset_label || tl.from_asset_label || ''));
        }
      }
    }

    await AuditLog.log(req, {
      action: 'scan',
      targetType: 'asset',
      targetId: asset_id,
      targetLabel: assetLabel,
      details: {
        moduleCount: modules ? modules.length : 0,
        source: 'asset_matching',
        changes: Object.keys(auditChanges).length > 0 ? auditChanges : undefined
      }
    });

    res.json({ success: true, asset_id, unmatched_modules: unmatchedModules || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#5: Get inventory item detail by item_code
router.get('/inventory-detail/:itemCode', async (req, res) => {
  try {
    const item = await ModuleInventory.findByCode(req.params.itemCode);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const usage = await ModuleInventory.getUsageByCode(req.params.itemCode);
    res.json({ item, usage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#6: Get next item_code suggestion for module_inventory
router.get('/next-item-code/:moduleType', async (req, res) => {
  try {
    const info = await ModuleInventory.getNextCodeInfo(req.params.moduleType);
    if (!info) return res.json({ prefix: '', format: '', example: '', nextSuffix: 'A' });
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#7: Register unmatched modules to module_inventory (v1 L794–869 + audit 공통원칙)
router.post('/register-inventory', requireMaintenance, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const userId = req.session.userId || null;
    const username = req.session.displayName || req.session.username || null;
    const registered = [];

    for (const item of items) {
      const { item_code, module_type, model, manufacturer, capacity, count, computing_module_id, specification, label } = item;
      if (!item_code || !module_type) continue;

      const quantity = parseInt(count) || 1;

      // Check if item_code already exists
      const existing = await ModuleInventory.findByCode(item_code);
      if (existing) {
        // Increase quantities
        await ModuleInventory.upsert({
          module_type,
          item_code,
          label: label || existing.label,
          manufacturer: manufacturer || existing.manufacturer,
          model: model || existing.model,
          capacity: capacity || existing.capacity,
          specification: specification || existing.specification,
          total_quantity: existing.total_quantity + quantity,
          in_use_quantity: existing.in_use_quantity + quantity,
          spare_quantity: existing.spare_quantity,
          storage_quantity: existing.storage_quantity
        });
      } else {
        // New module inventory entry
        await ModuleInventory.upsert({
          module_type,
          item_code,
          label: label || model || item_code,
          manufacturer: manufacturer || null,
          model: model || null,
          capacity: capacity || null,
          specification: specification || null,
          total_quantity: quantity,
          in_use_quantity: quantity,
          spare_quantity: 0,
          storage_quantity: 0
        });
      }

      // Link computing_module.specification to item_code
      if (computing_module_id) {
        await pool.query('UPDATE computing_modules SET specification = $1 WHERE id = $2',
          [item_code, computing_module_id]);
      }

      // Log incoming event
      await ModuleInventoryLog.create({
        item_code,
        event_type: 'incoming',
        quantity_change: quantity,
        user_id: userId,
        username: username,
        notes: '자산매칭에서 자동 등록'
      });

      registered.push(item_code);
    }

    await ModuleInventory.recalculateInUse();
    await AuditLog.log(req, {
      action: 'create', targetType: 'module_inventory',
      targetLabel: '자산매칭 재고등록: ' + registered.join(', '),
      details: { registered }
    });
    res.json({ success: true, registered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#8: Link unmatched modules to existing inventory item_code (v1 L872–944 + audit 공통원칙)
router.post('/link-inventory', requireMaintenance, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const linked = [];
    const userId = req.session.userId || null;
    const username = req.session.displayName || req.session.username || null;

    for (const item of items) {
      const { item_code, computing_module_id } = item;
      if (!item_code || !computing_module_id) continue;

      // Verify the item_code exists in module_inventory
      const existing = await ModuleInventory.findByCode(item_code);
      if (!existing) continue;

      // computing_module row 조회 (count, owner, asset_id)
      const { rows: cmRows } = await pool.query('SELECT * FROM computing_modules WHERE id = $1', [computing_module_id]);
      const cm = cmRows[0];
      if (!cm) continue;

      // Link computing_module.specification to item_code
      await pool.query('UPDATE computing_modules SET specification = $1 WHERE id = $2',
        [item_code, computing_module_id]);

      // 자사(company) 모듈만 storage 차감 + inventory_log 기록 (b56c430 계열 현행 유지)
      if (!cm.owner || cm.owner === 'company') {
        const count = cm.count || 1;
        const inv = await ModuleInventory.findByCode(item_code);
        if (inv) {
          const deduct = Math.min(count, inv.storage_quantity);
          if (deduct > 0) {
            await pool.query('UPDATE module_inventory SET storage_quantity = storage_quantity - $1, updated_at = CURRENT_TIMESTAMP WHERE item_code = $2',
              [deduct, item_code]);
          }
          if (deduct < count) {
            console.warn('[link-inventory] storage 부족: ' + item_code + ' 필요:' + count + ' 가용:' + inv.storage_quantity + ' 차감:' + deduct);
          }

          let assetLabel = null;
          if (cm.asset_id) {
            const { rows: aRows } = await pool.query('SELECT management_number, asset_number FROM assets WHERE id = $1', [cm.asset_id]);
            assetLabel = aRows[0] ? (aRows[0].management_number || aRows[0].asset_number) : null;
          }

          const invAfter = await ModuleInventory.findByCode(item_code);
          await ModuleInventoryLog.create({
            item_code: item_code,
            event_type: 'installed',
            quantity_change: -count,
            after_total: invAfter ? invAfter.total_quantity : null,
            asset_id: cm.asset_id,
            asset_label: assetLabel,
            to_asset_id: cm.asset_id,
            to_asset_label: assetLabel,
            user_id: userId,
            username: username,
            notes: 'link-inventory: 수동 매핑'
          });
        }
      }

      linked.push(item_code);
    }

    await ModuleInventory.recalculateInUse();
    await AuditLog.log(req, {
      action: 'update', targetType: 'module_inventory',
      targetLabel: '자산매칭 수동매핑: ' + linked.join(', '),
      details: { linked }
    });
    res.json({ success: true, linked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#9: Transfer logs for an asset
router.get('/transfer-logs/:assetId', async (req, res) => {
  try {
    const assetId = parseInt(req.params.assetId, 10);
    if (!assetId) return res.status(400).json({ error: 'Invalid asset ID' });
    const logs = await ModuleTransferLog.findByAsset(assetId);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#10: AI Spec Lookup — [능동] Ollama(로컬)/DuckDuckGo. 실패 시 degrade (v1 L960–969 충실이식)
router.post('/ai-spec-lookup', async (req, res) => {
  try {
    const { module_type, model, manufacturer, capacity } = req.body;
    if (!model) return res.status(400).json({ error: '모델명이 필요합니다.' });
    const result = await lookupSpec({ module_type, model, manufacturer, capacity });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'AI 스펙 조회 실패: ' + err.message, confidence: 0 });
  }
});

// ══════════════════════════════════════════════════════════════
//  LEGACY ROUTES (kept for backward compatibility — UI 사용 중)
// ══════════════════════════════════════════════════════════════

// EP#11: IP lookup - find asset and credentials by IP
router.get('/lookup-ip', async (req, res) => {
  try {
    const ip = (req.query.ip || '').trim();
    if (!ip) return res.json({ results: [] });
    const results = await Asset.findByIpWithCredentials(ip);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#12: Scan single IP — [능동] SSH (v1 L988–1000)
// 계획된 이탈: v1은 입력 미검증(빈 ip도 connect 시도) → v2는 400 선반환 (검증 가능성 + 안전 입력검증)
router.post('/scan', requireMaintenance, async (req, res) => {
  try {
    const { ip, user, password, port } = req.body;
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip).trim())) {
      return res.status(400).json({ error: '유효한 IP 주소가 필요합니다.' });
    }
    const result = await connectAndDiscover(String(ip).trim(), {
      user: user || undefined,
      password: password || undefined,
      port: port ? parseInt(port, 10) : undefined
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#13: Scan IP range — [능동] SSH, 세마포어 10동시(sshDiscovery 내부) (v1 L1003–1015)
// 계획된 이탈: v1은 입력 미검증(undefined.split 크래시→500) → v2는 400 선반환
router.post('/scan-range', requireMaintenance, async (req, res) => {
  try {
    const { start_ip, end_ip, user, password, port } = req.body;
    const ipRe = /^\d{1,3}(\.\d{1,3}){3}$/;
    if (!start_ip || !end_ip || !ipRe.test(String(start_ip).trim()) || !ipRe.test(String(end_ip).trim())) {
      return res.status(400).json({ error: '유효한 시작/끝 IP 주소가 필요합니다.' });
    }
    const results = await discoverRange(String(start_ip).trim(), String(end_ip).trim(), {
      user: user || undefined,
      password: password || undefined,
      port: port ? parseInt(port, 10) : undefined
    });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EP#14: Apply discovery result to asset (legacy, v1 L1018–1057)
// ssh_password 기본값은 env 경유(appConfig.ssh.defaultPassword ← SSH_DEFAULT_PASSWORD). audit는 공통원칙으로 create 보강.
router.post('/apply', requireMaintenance, async (req, res) => {
  try {
    const { ip, hostname, modules, asset_id, create_new } = req.body;

    let targetAssetId = asset_id;
    let createdNew = false;

    if (create_new) {
      targetAssetId = await Asset.create({
        asset_type: 'server',
        model_name: hostname || ip,
        ip_address: ip,
        ssh_password: appConfig.ssh.defaultPassword,
        status: 'active'
      });
      createdNew = true;
    } else if (!targetAssetId) {
      const existing = await Asset.findByIp(ip);
      if (existing) {
        targetAssetId = existing.id;
      } else {
        targetAssetId = await Asset.create({
          asset_type: 'server',
          model_name: hostname || ip,
          ip_address: ip,
          ssh_password: appConfig.ssh.defaultPassword,
          status: 'active'
        });
        createdNew = true;
      }
    }

    if (modules && modules.length > 0) {
      await ComputingModule.deleteByAsset(targetAssetId);
      await ComputingModule.bulkCreate(targetAssetId, modules);
    }

    // 공통원칙: 자산 생성 쓰기는 create audit 별도 기록 (v1은 scan audit만)
    if (createdNew) {
      await AuditLog.log(req, { action: 'create', targetType: 'asset', targetId: targetAssetId, targetLabel: 'discovery 자산 생성: ' + (hostname || ip) });
    }
    await AuditLog.log(req, { action: 'scan', targetType: 'asset', targetId: targetAssetId, targetLabel: ip, details: { hostname, moduleCount: modules ? modules.length : 0 } });
    res.json({ success: true, asset_id: targetAssetId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
