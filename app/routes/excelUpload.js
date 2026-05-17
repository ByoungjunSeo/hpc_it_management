const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../config/database');
const Asset = require('../models/asset');
const AssetIp = require('../models/assetIp');
const AssetCredential = require('../models/assetCredential');
const ComputingModule = require('../models/computingModule');
const Vendor = require('../models/vendor');
const ServerRoom = require('../models/serverRoom');
const Rack = require('../models/rack');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Template column definitions
const SHEET_ASSET = {
  name: '자산',
  columns: ['자산번호', '관리번호', '유형(server/switch/pdu/ups/storage/other)', '소유(company/vendor)',
    '업체명', '제조사', '모델명', '시리얼번호', '장소명(서버실/사무실/장비실)', '위치유형(server_room/office/storage)', '랙',
    'U시작', '구멍(1-3)', 'U크기', '추가칸', '블레이드(left/right)', '담당자', '용도',
    '상태(active/inactive/maintenance/decommissioned)', '구매일', '보증만료', '비고']
};
const SHEET_IP = {
  name: 'IP주소',
  columns: ['자산번호', 'IP주소', '유형(management/bmc/ib/data)', '설명']
};
const SHEET_CRED = {
  name: '접속정보',
  columns: ['자산번호', 'SSH포트', '사용자', '비밀번호', '유형(root/user/bmc)', '설명']
};
const SHEET_MODULE = {
  name: '컴퓨팅모듈',
  columns: ['자산번호', '모듈유형(cpu/memory/disk/network/raid/gpu)', '모델', '제조사', '용량', '수량', '사양', '슬롯', '비고']
};

// GET /excel — render upload page
router.get('/', (req, res) => {
  res.render('excel/upload', {
    title: '엑셀 업로드',
    currentPath: '/excel',
    extraCss: null,
    appConfig
  });
});

// GET /excel/template — download template xlsx
router.get('/template', (req, res) => {
  const wb = XLSX.utils.book_new();

  // Sheet 1: 자산
  const ws1 = XLSX.utils.aoa_to_sheet([SHEET_ASSET.columns]);
  XLSX.utils.book_append_sheet(wb, ws1, SHEET_ASSET.name);

  // Sheet 2: IP주소
  const ws2 = XLSX.utils.aoa_to_sheet([SHEET_IP.columns]);
  XLSX.utils.book_append_sheet(wb, ws2, SHEET_IP.name);

  // Sheet 3: 접속정보
  const ws3 = XLSX.utils.aoa_to_sheet([SHEET_CRED.columns]);
  XLSX.utils.book_append_sheet(wb, ws3, SHEET_CRED.name);

  // Sheet 4: 컴퓨팅모듈
  const ws4 = XLSX.utils.aoa_to_sheet([SHEET_MODULE.columns]);
  XLSX.utils.book_append_sheet(wb, ws4, SHEET_MODULE.name);

  // Sheet 5: 참고(허용값)
  const refData = [
    ['필드', '허용값'],
    ['유형(asset_type)', 'server, switch, pdu, ups, storage, other'],
    ['소유(ownership)', 'company, vendor'],
    ['상태(status)', 'active, inactive, maintenance, decommissioned'],
    ['IP유형(ip_type)', 'management, bmc, ib, data'],
    ['접속유형(credential_type)', 'root, user, bmc'],
    ['모듈유형(module_type)', 'cpu, memory, disk, network, raid, gpu'],
    ['위치유형(location_type)', 'server_room (서버실), office (사무실), storage (장비실) — 기본: server_room'],
    ['블레이드(blade_slot)', 'left, right (비워두면 full-width)'],
    ['구멍(1-3)', '1=첫째칸, 2=둘째칸, 3=셋째칸 (기본 1)'],
    ['추가칸', '0~2 (기본 0). U크기*3 + 추가칸 = 실제 슬롯 크기']
  ];
  const ws5 = XLSX.utils.aoa_to_sheet(refData);
  XLSX.utils.book_append_sheet(wb, ws5, '참고(허용값)');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', "attachment; filename=\"asset_upload_template.xlsx\"; filename*=UTF-8''asset_upload_template.xlsx");
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// POST /excel/upload — process uploaded file
router.post('/upload', requireMaintenance, upload.single('file'), (req, res) => {
  if (!req.file) {
    req.flash('error', '파일을 선택해주세요.');
    return res.redirect('/excel');
  }

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const result = { assets: 0, ips: 0, credentials: 0, modules: 0, errors: [] };

    // Parse sheets
    const assetRows = parseSheet(wb, SHEET_ASSET.name, SHEET_ASSET.columns);
    const ipRows = parseSheet(wb, SHEET_IP.name, SHEET_IP.columns);
    const credRows = parseSheet(wb, SHEET_CRED.name, SHEET_CRED.columns);
    const moduleRows = parseSheet(wb, SHEET_MODULE.name, SHEET_MODULE.columns);

    const db = getDb();
    const txn = db.transaction(() => {
      // Pre-load lookups
      const vendorMap = {};
      Vendor.findAll().forEach(v => { vendorMap[v.vendor_name] = v.id; });

      const roomMap = {};
      ServerRoom.findAll().forEach(r => { roomMap[r.name] = r.id; });

      const rackMap = {};
      Rack.findAll().forEach(r => { rackMap[r.room_name + '/' + r.name] = r.id; });

      // Asset number → asset id map (for IP/cred/module linking)
      const assetNumMap = {};
      // Pre-populate from existing assets
      db.prepare('SELECT id, asset_number FROM assets WHERE asset_number IS NOT NULL').all()
        .forEach(a => { assetNumMap[a.asset_number] = a.id; });

      // 1. Process assets
      for (let i = 0; i < assetRows.length; i++) {
        const row = assetRows[i];
        const rowNum = i + 2;

        const assetNumber = str(row[SHEET_ASSET.columns[0]]);
        if (!assetNumber) {
          result.errors.push(`자산 시트 ${rowNum}행: 자산번호 없음`);
          continue;
        }

        // Vendor lookup/create
        let vendorId = null;
        const vendorName = str(row[SHEET_ASSET.columns[4]]);
        if (vendorName) {
          if (!vendorMap[vendorName]) {
            vendorMap[vendorName] = Vendor.create({ vendor_name: vendorName });
          }
          vendorId = vendorMap[vendorName];
        }

        // Room lookup/create
        let rackId = null;
        const roomName = str(row[SHEET_ASSET.columns[8]]);
        const locationType = str(row[SHEET_ASSET.columns[9]]) || 'server_room';
        const rackName = str(row[SHEET_ASSET.columns[10]]);
        if (roomName) {
          if (!roomMap[roomName]) {
            roomMap[roomName] = ServerRoom.create({ name: roomName, location_type: locationType });
          }
          const roomId = roomMap[roomName];

          if (rackName) {
            const rackKey = roomName + '/' + rackName;
            if (!rackMap[rackKey]) {
              rackMap[rackKey] = Rack.create({ room_id: roomId, name: rackName });
            }
            rackId = rackMap[rackKey];
          }
        }

        // U position calculation
        const uStart = parseInt(row[SHEET_ASSET.columns[11]]) || null;
        const hole = parseInt(row[SHEET_ASSET.columns[12]]) || 1;
        const uSize = parseInt(row[SHEET_ASSET.columns[13]]) || 1;
        const extraSlots = parseInt(row[SHEET_ASSET.columns[14]]) || 0;

        let rackUnitStart = null;
        let rackUnitSize = 3; // default 1U = 3 slots
        if (uStart) {
          rackUnitStart = (uStart - 1) * 3 + hole;
          rackUnitSize = uSize * 3 + extraSlots;
        }

        const assetData = {
          asset_number: assetNumber,
          management_number: str(row[SHEET_ASSET.columns[1]]),
          asset_type: str(row[SHEET_ASSET.columns[2]]) || 'server',
          ownership: str(row[SHEET_ASSET.columns[3]]) || 'company',
          vendor_id: vendorId,
          manufacturer: str(row[SHEET_ASSET.columns[5]]),
          model_name: str(row[SHEET_ASSET.columns[6]]),
          serial_number: str(row[SHEET_ASSET.columns[7]]),
          room_id: roomName ? roomMap[roomName] : null,
          rack_id: rackId,
          rack_unit_start: rackUnitStart,
          rack_unit_size: rackUnitSize,
          blade_slot: str(row[SHEET_ASSET.columns[15]]) || null,
          assigned_user: str(row[SHEET_ASSET.columns[16]]),
          purpose: str(row[SHEET_ASSET.columns[17]]),
          status: str(row[SHEET_ASSET.columns[18]]) || 'active',
          purchase_date: str(row[SHEET_ASSET.columns[19]]),
          warranty_end: str(row[SHEET_ASSET.columns[20]]),
          notes: str(row[SHEET_ASSET.columns[21]])
        };

        // Upsert: update if asset_number exists
        if (assetNumMap[assetNumber]) {
          Asset.update(assetNumMap[assetNumber], assetData);
        } else {
          const newId = Asset.create(assetData);
          assetNumMap[assetNumber] = newId;
        }
        result.assets++;
      }

      // 2. Process IPs
      for (let i = 0; i < ipRows.length; i++) {
        const row = ipRows[i];
        const rowNum = i + 2;
        const assetNumber = str(row[SHEET_IP.columns[0]]);
        const ipAddr = str(row[SHEET_IP.columns[1]]);
        if (!assetNumber || !ipAddr) {
          result.errors.push(`IP 시트 ${rowNum}행: 자산번호 또는 IP 없음`);
          continue;
        }
        const assetId = assetNumMap[assetNumber];
        if (!assetId) {
          result.errors.push(`IP 시트 ${rowNum}행: 자산번호 '${assetNumber}' 찾을 수 없음`);
          continue;
        }
        AssetIp.bulkCreate(assetId, [{
          ip_address: ipAddr,
          ip_type: str(row[SHEET_IP.columns[2]]) || 'management',
          description: str(row[SHEET_IP.columns[3]])
        }]);
        result.ips++;
      }

      // 3. Process credentials
      for (let i = 0; i < credRows.length; i++) {
        const row = credRows[i];
        const rowNum = i + 2;
        const assetNumber = str(row[SHEET_CRED.columns[0]]);
        const username = str(row[SHEET_CRED.columns[2]]);
        if (!assetNumber || !username) {
          result.errors.push(`접속정보 시트 ${rowNum}행: 자산번호 또는 사용자 없음`);
          continue;
        }
        const assetId = assetNumMap[assetNumber];
        if (!assetId) {
          result.errors.push(`접속정보 시트 ${rowNum}행: 자산번호 '${assetNumber}' 찾을 수 없음`);
          continue;
        }
        AssetCredential.bulkCreate(assetId, [{
          username: username,
          password: str(row[SHEET_CRED.columns[3]]),
          credential_type: str(row[SHEET_CRED.columns[4]]) || 'root',
          description: str(row[SHEET_CRED.columns[5]])
        }]);
        result.credentials++;
      }

      // 4. Process computing modules
      for (let i = 0; i < moduleRows.length; i++) {
        const row = moduleRows[i];
        const rowNum = i + 2;
        const assetNumber = str(row[SHEET_MODULE.columns[0]]);
        const moduleType = str(row[SHEET_MODULE.columns[1]]);
        if (!assetNumber || !moduleType) {
          result.errors.push(`모듈 시트 ${rowNum}행: 자산번호 또는 유형 없음`);
          continue;
        }
        const assetId = assetNumMap[assetNumber];
        if (!assetId) {
          result.errors.push(`모듈 시트 ${rowNum}행: 자산번호 '${assetNumber}' 찾을 수 없음`);
          continue;
        }
        ComputingModule.create({
          asset_id: assetId,
          module_type: moduleType,
          model: str(row[SHEET_MODULE.columns[2]]),
          manufacturer: str(row[SHEET_MODULE.columns[3]]),
          capacity: str(row[SHEET_MODULE.columns[4]]),
          count: parseInt(row[SHEET_MODULE.columns[5]]) || 1,
          specification: str(row[SHEET_MODULE.columns[6]]),
          slot_info: str(row[SHEET_MODULE.columns[7]]),
          notes: str(row[SHEET_MODULE.columns[8]])
        });
        result.modules++;
      }
    });

    txn();

    let msg = `업로드 완료: 자산 ${result.assets}건, IP ${result.ips}건, 접속정보 ${result.credentials}건, 모듈 ${result.modules}건`;
    if (result.errors.length > 0) {
      msg += ` (오류 ${result.errors.length}건: ${result.errors.slice(0, 5).join('; ')})`;
    }
    req.flash('success', msg);
    res.redirect('/excel');
  } catch (err) {
    req.flash('error', '업로드 실패: ' + err.message);
    res.redirect('/excel');
  }
});

// Helpers
function parseSheet(wb, sheetName, columns) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return data;
}

function str(val) {
  if (val === null || val === undefined || val === '') return null;
  return String(val).trim();
}

module.exports = router;
