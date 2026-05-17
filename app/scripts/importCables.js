const XLSX = require('xlsx');
const { getDb } = require('../config/database');
const db = getDb();

const path = require('path');
const wb = XLSX.readFile(path.join(__dirname, '../../케이블 장비실.xlsx'));
const data = XLSX.utils.sheet_to_json(wb.Sheets['Sheet1']);

const insertStmt = db.prepare(`
  INSERT INTO module_inventory (module_type, item_code, label, manufacturer, model, capacity, specification, total_quantity, in_use_quantity, spare_quantity, storage_quantity, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(item_code) DO UPDATE SET
    storage_quantity = excluded.storage_quantity,
    manufacturer = excluded.manufacturer,
    model = excluded.model,
    capacity = excluded.capacity,
    specification = excluded.specification,
    label = excluded.label,
    updated_at = CURRENT_TIMESTAMP
`);

const letterCounters = {};
const results = [];

data.forEach(row => {
  // Bandwidth without split notation: '100G→4x25G' → '100G'
  let bw = String(row['대역폭'] || '').replace(/→.*/, '');
  if (!letterCounters[bw]) letterCounters[bw] = 'A'.charCodeAt(0);
  const letter = String.fromCharCode(letterCounters[bw]++);
  const itemCode = 'cab-' + bw + '-' + letter;

  const model = row['모델'] || '';
  const manufacturer = row['제조사'] || '';
  const protocol = row['프로토콜'] || '';
  const bandwidth = row['대역폭'] || '';
  const length = row['길이'] || '';
  const split = row['분기'] || '';
  const connector = row['커넥터 타입'] || '';
  const cableType = row['케이블 타입'] || '';
  const qty = parseInt(row['수량']) || 0;

  const capacity = bandwidth + ' ' + length;
  const spec = [protocol, connector, cableType, split !== '1→1' ? '분기 ' + split : ''].filter(Boolean).join(' / ');
  const label = cableType;

  insertStmt.run('cable', itemCode, label, manufacturer, model, capacity, spec, qty);
  results.push({ itemCode, model, manufacturer, capacity, spec, qty });
});

console.log('Inserted', results.length, 'cables:');
results.forEach(r => {
  console.log('  ' + r.itemCode + ': ' + r.model + ' (' + r.manufacturer + ') ' + r.capacity + ' x' + r.qty);
});

// Verify
const cables = db.prepare("SELECT item_code, model, manufacturer, capacity, specification, storage_quantity FROM module_inventory WHERE module_type = 'cable' ORDER BY item_code").all();
console.log('\nDB verification (' + cables.length + ' cables):');
cables.forEach(c => console.log('  ' + c.item_code + ': ' + c.model + ' | ' + c.capacity + ' | ' + c.specification + ' | qty=' + c.storage_quantity));
