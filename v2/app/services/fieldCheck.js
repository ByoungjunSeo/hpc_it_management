// v2.9 현장 확인 결과(field) 파일 형식 — 정의·검증·스캔 결과 변환(순수 함수, DB·네트워크 없음).
// 형식(itam-field-check v1):
// {
//   "format": "itam-field-check", "version": 1, "generated_at": "<ISO>", "source": "scan" | "manual",
//   "items": [ { "legacy_code": "<module_inventory.item_code>",          ← 필수
//               "module_type": "network", "asset": "<장비 관리번호>", "observed_at": "<ISO>", "evidence": "scan:lspci-vpd",   ← 선택
//               "field": { ...아래 FIELD_KEYS 중 하나 이상... } } ]                                                         ← 필수
// }
// 시리얼·IP·자격증명은 담지 않음(키가 없음 — 알 수 없는 키는 거부, 문자열 안 시리얼 패턴은 앞 4자 마스킹).
'use strict';

const FORMAT = 'itam-field-check';
const VERSION = 1;
const MODULE_TYPES = ['cpu', 'memory', 'disk', 'network', 'raid', 'gpu', 'npu', 'cable'];
const FIELD_KEYS = {
  part_number: 'str', product_name: 'str', model: 'str', name: 'str', form_factor: 'str',   // 문자열(≤128자)
  ports: 'int:1:16', memory_gb: 'num:1:1024', nominal_tb: 'num:0.05:200',                   // 숫자(범위)
  onboard: 'bool', pci_device_id: 'hex4'
};
const maskSerialText = (s) => String(s).replace(/(\b(?:S\/?N|SERIAL(?:\s*NUMBER)?)\s*[:：=]\s*)([A-Za-z0-9-]{4})[A-Za-z0-9-]*/gi, '$1$2…');

function checkValue(key, v) {
  const t = FIELD_KEYS[key];
  if (!t) return { error: '알 수 없는 키' };
  if (t === 'str') { if (typeof v !== 'string' || !v.trim() || v.length > 128) return { error: '문자열(1~128자) 아님' }; return { value: maskSerialText(v.trim()) }; }
  if (t === 'bool') return typeof v === 'boolean' ? { value: v } : { error: 'true/false 아님' };
  if (t === 'hex4') return (typeof v === 'string' && /^[0-9a-f]{4}$/i.test(v)) ? { value: v.toLowerCase() } : { error: 'PCI 장치 ID(16진 4자리) 아님' };
  const [kind, lo, hi] = t.split(':');
  const n = Number(v);
  if (typeof v !== 'number' || !isFinite(n) || n < Number(lo) || n > Number(hi) || (kind === 'int' && !Number.isInteger(n))) return { error: '숫자 범위(' + lo + '~' + hi + ') 아님' };
  return { value: n };
}

// 파일 검증 → { items: [{legacy_code, module_type, asset, field, evidence}], errors: [문자열] }
function validateFieldFile(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { items: [], errors: ['최상위가 객체가 아님'] };
  if (doc.format !== FORMAT) errors.push('format은 "' + FORMAT + '"이어야 함');
  if (doc.version !== VERSION) errors.push('version은 ' + VERSION + '이어야 함');
  if (doc.source != null && !['scan', 'manual'].includes(doc.source)) errors.push('source는 scan|manual');
  if (!Array.isArray(doc.items)) { errors.push('items 배열 없음'); return { items: [], errors }; }
  const items = [];
  doc.items.forEach((it, idx) => {
    const at = 'items[' + idx + ']';
    if (!it || typeof it !== 'object') { errors.push(at + ': 객체 아님'); return; }
    if (typeof it.legacy_code !== 'string' || !it.legacy_code.trim() || it.legacy_code.length > 64) { errors.push(at + ': legacy_code 필수(1~64자)'); return; }
    if (it.module_type != null && !MODULE_TYPES.includes(it.module_type)) { errors.push(at + ': module_type 값 오류'); return; }
    if (!it.field || typeof it.field !== 'object' || Array.isArray(it.field)) { errors.push(at + ': field 객체 필수'); return; }
    const field = {};
    let bad = false;
    Object.keys(it.field).forEach((k) => {
      if (it.field[k] == null) return;
      const r = checkValue(k, it.field[k]);
      if (r.error) { errors.push(at + '.field.' + k + ': ' + r.error); bad = true; } else field[k] = r.value;
    });
    if (bad) return;
    if (!Object.keys(field).length) { errors.push(at + ': field에 값이 하나도 없음'); return; }
    items.push({ legacy_code: it.legacy_code.trim(), module_type: it.module_type || null, asset: typeof it.asset === 'string' ? it.asset.slice(0, 64) : null,
      evidence: typeof it.evidence === 'string' ? it.evidence.slice(0, 64) : null, field });
  });
  return { items, errors };
}

// 같은 옛 코드의 여러 항목 병합 — 같은 키에 다른 값이면 충돌(그 품목은 반영하지 않음)
function mergeByCode(items) {
  const map = {}, conflicts = {};
  items.forEach((it) => {
    const cur = map[it.legacy_code] = map[it.legacy_code] || { legacy_code: it.legacy_code, module_type: it.module_type, assets: [], field: {} };
    if (it.asset && !cur.assets.includes(it.asset)) cur.assets.push(it.asset);
    Object.keys(it.field).forEach((k) => {
      if (cur.field[k] != null && cur.field[k] !== it.field[k]) (conflicts[it.legacy_code] = conflicts[it.legacy_code] || new Set()).add(k);
      else cur.field[k] = it.field[k];
    });
  });
  Object.keys(conflicts).forEach((k) => { conflicts[k] = Array.from(conflicts[k]); });
  return { map, conflicts };
}

// 스캔 결과 → field 항목. 등록 모듈과 "모델이 실제로 일치"한 짝만(옛 코드 = 등록 모듈 specification)
// opts.modelsMatch(a,b) 필수(라우트의 compareModules와 같은 판정), opts.asset = 관리번호
function scanToFieldItems(comparison, opts) {
  opts = opts || {};
  const out = [];
  if (!comparison || typeof opts.modelsMatch !== 'function') return out;
  const pairs = [].concat(comparison.matched || [], comparison.mismatched || []);
  pairs.forEach((p) => {
    const reg = (p.registered_items || [])[0], disc = (p.discovered_items || [])[0];
    if (!reg || !disc || !reg.specification || !opts.modelsMatch(reg.model, disc.model)) return;
    const f = {}, ev = [];
    if (p._type === 'network') {
      if (disc.card_part_number) { f.part_number = disc.card_part_number; ev.push('vpd'); }
      if (disc.card_product_name) f.product_name = disc.card_product_name;
      if (Number.isInteger(disc.ports) && disc.ports > 0) { f.ports = disc.ports; ev.push('functions'); }
    } else if (p._type === 'raid') {
      if (disc.card_part_number) { f.part_number = disc.card_part_number; ev.push('vpd'); }
      if (disc.card_product_name) { f.model = disc.card_product_name; ev.push('vpd'); }
    } else if (p._type === 'gpu') {
      if (disc.gpu_name) { f.name = disc.gpu_name; ev.push('nvidia-smi'); }
      if (disc.gpu_memory_gb) f.memory_gb = disc.gpu_memory_gb;
    }
    if (!Object.keys(f).length) return;
    const v = validateFieldFile({ format: FORMAT, version: VERSION, items: [{ legacy_code: reg.specification, module_type: p._type, field: f }] });
    if (!v.items.length) return;
    out.push({ legacy_code: reg.specification, module_type: p._type, asset: opts.asset || null, observed_at: opts.observed_at || null,
      evidence: 'scan:' + Array.from(new Set(ev)).join('+'), field: v.items[0].field });
  });
  return out;
}

function buildFieldDoc(items, source, now) {
  return { format: FORMAT, version: VERSION, generated_at: (now || new Date()).toISOString(), source: source || 'scan', items: items || [] };
}

module.exports = { FORMAT, VERSION, FIELD_KEYS, validateFieldFile, mergeByCode, scanToFieldItems, buildFieldDoc, maskSerialText };
