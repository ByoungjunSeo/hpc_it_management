const { pool } = require('../config/database');
const appConfig = require('../config/app');

// ─── IP purpose 정규화 (v1 그대로) ───
const ipLabelToValue = {};
appConfig.ipTypes.forEach(t => {
  ipLabelToValue[t.label.toLowerCase()] = t.value;
  ipLabelToValue[t.value.toLowerCase()] = t.value;
});

function normalizePurpose(raw) {
  const key = (raw || '').trim().toLowerCase();
  return ipLabelToValue[key] || raw.trim();
}

// ─── mapHardwareToCols (v1 그대로) ───
// 입력: req.body (hw_types[], hw_codes[], hw_nums[], hw_ownerships[], hw_roles[])
// 출력: { hardware_json, cpu_type, cpu_num, ..., gpu2_num }
function mapHardwareToCols(body) {
  const types = body['hw_types[]'] || body.hw_types || [];
  const codes = body['hw_codes[]'] || body.hw_codes || [];
  const nums = body['hw_nums[]'] || body.hw_nums || [];
  const ownerships = body['hw_ownerships[]'] || body.hw_ownerships || [];
  const roles = body['hw_roles[]'] || body.hw_roles || [];
  const tArr = Array.isArray(types) ? types : [types];
  const cArr = Array.isArray(codes) ? codes : [codes];
  const nArr = Array.isArray(nums) ? nums : [nums];
  const oArr = Array.isArray(ownerships) ? ownerships : [ownerships];
  const rArr = Array.isArray(roles) ? roles : [roles];

  const items = [];
  for (let i = 0; i < tArr.length; i++) {
    const t = (tArr[i] || '').trim();
    const c = (cArr[i] || '').trim();
    const n = parseInt(nArr[i]) || 0;
    const o = (oArr[i] || 'company').trim();
    const r = (rArr[i] || '').trim();
    if (t && (c || n > 0)) {
      const item = { type: t, code: c, num: n, ownership: o };
      if (t === 'psu' && r) item.role = r;
      items.push(item);
    }
  }

  const result = {
    hardware_json: items.length > 0 ? JSON.stringify(items) : null,
    cpu_type: null, cpu_num: null,
    mem1_type: null, mem1_num: null, mem2_type: null, mem2_num: null,
    disk1_part: null, disk1_num: null, disk2_part: null, disk2_num: null,
    disk3_part: null, disk3_num: null, disk4_part: null, disk4_num: null,
    nic1_type: null, nic1_num: null, nic2_type: null, nic2_num: null,
    nic3_type: null, nic3_num: null, nic4_type: null, nic4_num: null,
    raid_type: null, raid_num: null,
    gpu1_type: null, gpu1_num: null, gpu2_type: null, gpu2_num: null
  };

  let cpuIdx = 0, memIdx = 0, diskIdx = 0, nicIdx = 0, raidIdx = 0, gpuIdx = 0;
  items.forEach(item => {
    switch (item.type) {
      case 'cpu':
        if (cpuIdx === 0) { result.cpu_type = item.code; result.cpu_num = item.num; }
        cpuIdx++; break;
      case 'memory':
        if (memIdx === 0) { result.mem1_type = item.code; result.mem1_num = item.num; }
        else if (memIdx === 1) { result.mem2_type = item.code; result.mem2_num = item.num; }
        memIdx++; break;
      case 'disk':
        if (diskIdx === 0) { result.disk1_part = item.code; result.disk1_num = item.num; }
        else if (diskIdx === 1) { result.disk2_part = item.code; result.disk2_num = item.num; }
        else if (diskIdx === 2) { result.disk3_part = item.code; result.disk3_num = item.num; }
        else if (diskIdx === 3) { result.disk4_part = item.code; result.disk4_num = item.num; }
        diskIdx++; break;
      case 'network':
        if (nicIdx === 0) { result.nic1_type = item.code; result.nic1_num = item.num; }
        else if (nicIdx === 1) { result.nic2_type = item.code; result.nic2_num = item.num; }
        else if (nicIdx === 2) { result.nic3_type = item.code; result.nic3_num = item.num; }
        else if (nicIdx === 3) { result.nic4_type = item.code; result.nic4_num = item.num; }
        nicIdx++; break;
      case 'raid':
        if (raidIdx === 0) { result.raid_type = item.code; result.raid_num = item.num; }
        raidIdx++; break;
      case 'gpu':
        if (gpuIdx === 0) { result.gpu1_type = item.code; result.gpu1_num = item.num; }
        else if (gpuIdx === 1) { result.gpu2_type = item.code; result.gpu2_num = item.num; }
        gpuIdx++; break;
    }
  });

  return result;
}

// ─── mapIpsToCols (v1 그대로) ───
// 입력: req.body (ip_purposes[], ip_values[])
// 출력: { ips_json, ip1~ip4, bmc, ib1, ib2 }
function mapIpsToCols(body) {
  const purposes = body['ip_purposes[]'] || body.ip_purposes || [];
  const values = body['ip_values[]'] || body.ip_values || [];
  const pArr = Array.isArray(purposes) ? purposes : [purposes];
  const vArr = Array.isArray(values) ? values : [values];

  const result = { ip1: null, ip2: null, ip3: null, ip4: null, bmc: null, ib1: null, ib2: null, ips_json: null };
  let mgmtIdx = 0, ibIdx = 0;
  const ipsItems = [];

  for (let i = 0; i < pArr.length; i++) {
    const purpose = normalizePurpose(pArr[i]);
    const val = (vArr[i] || '').trim();
    if (!val) continue;
    ipsItems.push({ purpose, ip: val });
    if (purpose === 'bmc') {
      result.bmc = val;
    } else if (purpose === 'ib') {
      if (ibIdx === 0) { result.ib1 = val; ibIdx++; }
      else if (ibIdx === 1) { result.ib2 = val; ibIdx++; }
    } else {
      if (mgmtIdx === 0) { result.ip1 = val; mgmtIdx++; }
      else if (mgmtIdx === 1) { result.ip2 = val; mgmtIdx++; }
      else if (mgmtIdx === 2) { result.ip3 = val; mgmtIdx++; }
      else if (mgmtIdx === 3) { result.ip4 = val; mgmtIdx++; }
    }
  }
  result.ips_json = ipsItems.length > 0 ? JSON.stringify(ipsItems) : null;
  return result;
}

// ─── mapCredsToCols (v1 그대로) ───
// 입력: req.body (cred_types[], cred_usernames[], cred_passwords[])
// 출력: { credentials_json, credential_root, credential_etc1, credential_etc2 }
function mapCredsToCols(body) {
  const types = body['cred_types[]'] || body.cred_types || [];
  const usernames = body['cred_usernames[]'] || body.cred_usernames || [];
  const passwords = body['cred_passwords[]'] || body.cred_passwords || [];
  const tArr = Array.isArray(types) ? types : [types];
  const uArr = Array.isArray(usernames) ? usernames : [usernames];
  const pArr = Array.isArray(passwords) ? passwords : [passwords];

  const items = [];
  for (let i = 0; i < tArr.length; i++) {
    const t = (tArr[i] || '').trim();
    const u = (uArr[i] || '').trim();
    const p = (pArr[i] || '').trim();
    if (t && (u || p)) {
      items.push({ type: t, username: u, password: p });
    }
  }

  const result = {
    credentials_json: items.length > 0 ? JSON.stringify(items) : null,
    credential_root: null, credential_etc1: null, credential_etc2: null
  };

  let etcIdx = 0;
  for (const item of items) {
    const pair = item.username + ' / ' + item.password;
    if (item.type === 'root' && !result.credential_root) {
      result.credential_root = pair;
    } else {
      if (etcIdx === 0) { result.credential_etc1 = pair; etcIdx++; }
      else if (etcIdx === 1) { result.credential_etc2 = pair; etcIdx++; }
    }
  }
  return result;
}

// ─── generateVendorManagementNumber (v1→async 전환) ───
// 업체명 기반 관리번호 생성: 업체명-NNN
async function generateVendorManagementNumber(vendorName) {
  const name = (vendorName || 'VND').trim();
  const prefix = name + '-';
  const { rows } = await pool.query(
    "SELECT management_number FROM assets WHERE management_number LIKE $1 ORDER BY management_number DESC LIMIT 1",
    [prefix + '%']
  );
  let seq = 1;
  if (rows[0]) {
    const suffix = rows[0].management_number.substring(prefix.length);
    const last = parseInt(suffix);
    if (!isNaN(last)) seq = last + 1;
  }
  return prefix + String(seq).padStart(3, '0');
}

module.exports = {
  mapHardwareToCols,
  mapIpsToCols,
  mapCredsToCols,
  normalizePurpose,
  generateVendorManagementNumber
};
