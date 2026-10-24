// v2.9 단계 1: 규격 코드 생성기(순수 함수 — DB·네트워크 접근 없음).
// 입력 { module_type, manufacturer, model, capacity, specification, legacy_code? }
// 출력 { spec_code, attrs, confidence(high|medium|low), reason, unresolved_fields, inventory(false면 재고 아님), exclude_reason, serialized }
// 형식(설계 4장): MEM-D5-64G-RD-5600 · SSD-NVME-U2-3.84T · HDD-SAS-25-600G · CPU-XEON-6530P · GPU-A100-80G-PCIE
//                NIC-400G-1P-OSFP-CX7 · RAID-9361-8I · NPU-RNGD · CBL-DAC-400G-OSFP-2.5M
// 해석 못 한 필드는 코드에 '?'를 넣지 않고 해당 마디를 빼며, confidence=low + unresolved_fields로 남김(사람 검토 대상).
'use strict';

const up = (s) => String(s == null ? '' : s).toUpperCase();
const squash = (s) => up(s).replace(/\s+/g, '');
function result(type, code, attrs, conf, reasons, unresolved, extra) {
  const r = Object.assign({ module_type: type, spec_code: code, attrs, confidence: conf, reason: reasons.filter(Boolean).join('; '),
    unresolved_fields: unresolved, inventory: true, exclude_reason: null }, extra || {});
  r.serialized = r.inventory && !!code ? isSerialized(type, attrs) : false;
  return r;
}
function excluded(type, why, attrs) {
  return { module_type: type, spec_code: null, attrs: attrs || {}, confidence: 'high', reason: '재고 아님: ' + why, unresolved_fields: [], inventory: false, exclude_reason: why, serialized: false };
}
const worst = (a, b) => (['high', 'medium', 'low'].indexOf(a) > ['high', 'medium', 'low'].indexOf(b) ? a : b);

// ───────────────────────── 시리얼 관리 대상(설계 확정 범위) ─────────────────────────
function isSerialized(type, attrs) {
  attrs = attrs || {};
  if (type === 'gpu' || type === 'npu') return true;
  if (type === 'network') return Number(attrs.gbps) >= 100;
  if (type === 'disk') return attrs.interface === 'NVME' && Number(attrs.tb) >= 3.84;
  return false;
}

// ───────────────────────── 메모리 ─────────────────────────
const SAM_TYPE = { M393: ['D4', 'RD'], M386: ['D4', 'LR'], M378: ['D4', 'UD'], M391: ['D4', 'EU'], M471: ['D4', 'SO'],
  M321: ['D5', 'RD'], M323: ['D5', 'UD'], M324: ['D5', 'EU'], M425: ['D5', 'SO'] };
const SAM_DEN4 = { A1: 8, A2: 16, A4: 32, A8: 64, AA: 128, AB: 256 };
const SAM_DEN5 = { R2: 16, R4: 32, R8: 64, RN: 128, RW: 96, RE: 48, RS: 24 };
const SAM_SPD = { CPB: 2133, CRC: 2400, CTD: 2666, CVF: 2933, CWE: 3200, CQK: 4800, CWM: 5600, CCP: 6400 };
const HYX_SPD = { TF: 2133, UH: 2400, VK: 2666, WM: 2933, XN: 3200 };
const MIC_SPD4 = { '2G1': 2133, '2G3': 2400, '2G6': 2666, '2G9': 2933, '3G2': 3200 };
const TYPE_WORD = { RDIMM: 'RD', LRDIMM: 'LR', UDIMM: 'UD', SODIMM: 'SO' };
// 품번 규칙: { mfr, gen, type, gb, mts, norm } — norm은 리비전 접미를 뗀 별칭 키
function decodeMemoryPart(model) {
  const s = squash(model);
  let m = s.match(/(M3\d\d|M4\d\d)([A-Z0-9]{2})[A-Z0-9]*?-(C[A-Z]{2})/) || s.match(/(M3\d\d|M4\d\d)([A-Z0-9]{2})[A-Z0-9]*/);
  if (m && SAM_TYPE[m[1]]) {
    const [gen, type] = SAM_TYPE[m[1]];
    const gb = (gen === 'D5' ? SAM_DEN5 : SAM_DEN4)[m[2]] || null;
    const sp = s.match(/-(C[A-Z]{2})/);
    const base = s.match(/(M[34]\d\d[A-Z0-9]+?)(?:-|\(|$)/);
    return { mfr: 'Samsung', gen, type, gb, mts: sp ? SAM_SPD[sp[1]] || null : null, norm: (base ? base[1] : s) + (sp ? '-' + sp[1] : '') };
  }
  m = s.match(/HMA([0-9A])([0-9A-Z])G([RL])7[A-Z0-9]*?N-([A-Z]{2})/) || s.match(/HMA([0-9A])([0-9A-Z])G([RL])7/);
  if (m) {
    const gb = { 84: 32, A8: 64, 82: 16, 81: 8, AA: 128 }[m[1] + m[2]] || null;
    return { mfr: 'SK hynix', gen: 'D4', type: m[3] === 'L' ? 'LR' : 'RD', gb, mts: m[4] ? HYX_SPD[m[4]] || null : null, norm: (s.match(/HMA[A-Z0-9]+?N-[A-Z]{2}/) || [s])[0] };
  }
  m = s.match(/HMCG([0-9A-Z]{2})[A-Z0-9]*/);
  if (m) {   // SK hynix DDR5 RDIMM — 속도 코드 공개 규칙 불명확 → 스펙 문자열 보조
    return { mfr: 'SK hynix', gen: 'D5', type: 'RD', gb: { 78: 16, 88: 32, 84: 32, 94: 64, A4: 128 }[m[1]] || null, mts: null, norm: (s.match(/HMCG[0-9A-Z]{6}/) || [m[0]])[0] };
  }
  m = s.match(/(?:MTA)?(\d{2})ASF(\d+)G72(P[DZ]+|AZ|L[DZ]+)-(\dG\d)/);
  if (m) {
    return { mfr: 'Micron', gen: 'D4', type: m[3].startsWith('L') ? 'LR' : (m[3] === 'AZ' ? 'UD' : 'RD'), gb: Number(m[2]) * 8, mts: MIC_SPD4[m[4]] || null, norm: 'MTA' + m[1] + 'ASF' + m[2] + 'G72' + m[3] + '-' + m[4] };
  }
  m = s.match(/MTC(\d+)F(\d{4})S1RC(\d\d)/);
  if (m) return { mfr: 'Micron', gen: 'D5', type: 'RD', gb: null, mts: Number(m[3]) * 100, norm: m[0] };
  return null;
}
function memoryFromSpec(spec, capacity) {
  const s = up(spec) + ' ' + up(capacity);
  const out = {};
  const g = s.match(/DDR([45])/); if (g) out.gen = 'D' + g[1];
  const t = s.match(/\b(LRDIMM|RDIMM|UDIMM|SODIMM)\b/); if (t) out.type = TYPE_WORD[t[1]];
  const sp = up(spec).match(/(\d{4})\s*(?:MT\/S|MBPS|MHZ)/); if (sp) out.mts = Number(sp[1]);   // 첫 값 = 정격(Configured 값은 뒤에 옴)
  const c = up(capacity).match(/(\d+)\s*(GB|GIB|G)\b/); if (c) out.gb = Number(c[1]);
  return out;
}
function genMemory(i) {
  const reasons = [], unresolved = [];
  let conf = 'high';
  const d = decodeMemoryPart(i.model);
  const f = memoryFromSpec(i.specification, i.capacity);
  const a = { gen: null, type: null, gb: null, mts: null };
  if (d) { Object.assign(a, { gen: d.gen, type: d.type, gb: d.gb, mts: d.mts }); reasons.push(d.mfr + ' 품번 규칙'); }
  else { conf = 'medium'; reasons.push('품번 규칙 불일치 — 스펙 문자열 보조'); }
  for (const k of ['gen', 'type', 'gb', 'mts']) {
    if (a[k] == null && f[k] != null) { a[k] = f[k]; conf = worst(conf, 'medium'); reasons.push(k + '=스펙 문자열'); }
    else if (a[k] != null && f[k] != null && a[k] !== f[k]) { conf = worst(conf, 'medium'); reasons.push(k + ' 품번(' + a[k] + ')≠스펙(' + f[k] + ') — 품번 우선'); }
  }
  if (a.gb == null && i.legacy_code) {
    const lc = String(i.legacy_code).match(/^mem-(\d+)-/i);
    if (lc) { a.gb = Number(lc[1]); conf = 'low'; reasons.push('gb=옛 코드 표기'); }
  }
  ['gen', 'type', 'gb', 'mts'].forEach((k) => { if (a[k] == null) unresolved.push(k); });
  if (unresolved.length) conf = 'low';
  const code = ['MEM', a.gen, a.gb ? a.gb + 'G' : null, a.type, a.mts].filter((x) => x != null).join('-');
  return result('memory', code, Object.assign(a, { manufacturer: (d && d.mfr) || i.manufacturer || null, part_norm: d ? d.norm : squash(i.model) || null }), conf, reasons, unresolved);
}

// ───────────────────────── 디스크 ─────────────────────────
// lsblk·storcli 이진 단위(TiB/GiB) 표시값 → 공칭 용량(10진). 근거: 공칭 N TB = N×10^12 B를 2^40으로 나눈 값의 lsblk 반올림 표시.
const BINARY_TO_NOMINAL = {
  '223.6G': 0.24, '238.5G': 0.256, '279.4G': 0.3, '447.1G': 0.48, '446.6G': 0.48, '465.8G': 0.5, '476.9G': 0.512, '558.9G': 0.6,
  '894.3G': 0.96, '931.5G': 1.0, '1.1T': 1.2, '1.5T': 1.6, '1.7T': 1.92, '1.8T': 2.0, '2.2T': 2.4, '2.7T': 3.0, '2.9T': 3.2,
  '3.5T': 3.84, '3.6T': 4.0, '5.8T': 6.4, '7T': 7.68, '7.3T': 8.0, '11.6T': 12.8, '12.7T': 14.0, '14T': 15.36, '27.9T': 30.72
};
const NOMINAL = [0.24, 0.256, 0.3, 0.48, 0.5, 0.512, 0.6, 0.8, 0.96, 1.0, 1.2, 1.6, 1.8, 1.92, 2.0, 2.4, 3.0, 3.2, 3.84, 4.0, 5.6, 6.4, 7.68, 8.0, 12.8, 14.0, 15.36, 30.72];
const DISK_RULES = [   // [정규식, 인터페이스, 폼팩터, 매체] — 위에서부터 첫 일치
  [/MZQL|PM9A3/, 'NVME', 'U2', 'SSD'], [/MZWL|PM173[35]/, 'NVME', 'U2', 'SSD'], [/MZ1L/, 'NVME', 'M2', 'SSD'], [/MZPL/, 'NVME', 'HHHL', 'SSD'],
  [/MZ7|PM8[0-9]3|SM843|SM963/, 'SATA', '25', 'SSD'], [/MTFDHAL|9300|9200/, 'NVME', 'U2', 'SSD'], [/MTFDKCC|7450/, 'NVME', 'U3', 'SSD'],
  [/MTFDDAK|5200/, 'SATA', '25', 'SSD'], [/SSDPE2K|P4500|P4610/, 'NVME', 'U2', 'SSD'], [/SSDPF2NV|P5316/, 'NVME', 'U2', 'SSD'],
  [/E3\.S/, 'NVME', 'E3S', 'SSD'], [/KCMY/, 'NVME', 'E3S', 'SSD'], [/KXDZ|KXG5|XG5/, 'NVME', 'M2', 'SSD'], [/XS\d{4}SE|NYTRO/, 'SAS', '25', 'SSD'],
  [/XP\d{4}SE/, 'NVME', 'U2', 'SSD'], [/ST\d+MX/, 'SAS', '25', 'SSD'], [/ST\d+MM|EXOS 10E/, 'SAS', '25', 'HDD'], [/AL1\dSE/, 'SAS', '25', 'HDD'],
  [/ST\d+DM|BARRACUDA/, 'SATA', '35', 'HDD'], [/HDWD1/, 'SATA', '35', 'HDD'], [/FMD/, 'SAS', 'FMD', 'SSD'],
  [/SSD 9[0-9]0|SSD9[0-9]0|970 EVO|990 EVO|980 PRO|9100 PRO|FIRECUDA|SN350|EX900|IM2P33|T500|M\.2/, 'NVME', 'M2', 'SSD'],
  [/DPRD|PASCARI|ISE PE|PE9010|HFS\d+GEJ/, 'NVME', null, 'SSD'], [/NVME/, 'NVME', null, 'SSD'], [/\bSAS\b/, 'SAS', null, null], [/SATA/, 'SATA', null, null]
];
const VIRTUAL_DISK_RE = /(^|[\s_/])(PERC|RAID|AVAGO|PIKE|BOSS|MR\d|LOGICAL[_\s]?VOLUME|SMART\s*ARRAY|MEGARAID)(?=[\s_\-]|\d|$)/i;
function nearestNominal(tb) {
  if (!tb) return null;
  const best = NOMINAL.reduce((b, n) => (Math.abs(n - tb) / n < Math.abs(b - tb) / b ? n : b), NOMINAL[0]);
  return Math.abs(best - tb) / best <= 0.03 ? best : null;
}
function capFromModelToken(s) {   // 품번 안 용량 토큰: 3T8→3.84 · 7T6→7.68 · 1T92→1.92 · 960G/480G · 010T→1.0 · 307T→30.72
  let m = s.match(/(\d)T(\d{1,2})(?![0-9])/);
  if (m) return nearestNominal(Number(m[1] + '.' + m[2])) || nearestNominal(Number(m[1] + '.' + m[2] + '4'));
  m = s.match(/SSDP[EF]2[A-Z]{2}(\d{3})T/); if (m) return nearestNominal(Number(m[1]) / (m[1].startsWith('0') ? 10 : 10));
  m = s.match(/MZ[A-Z0-9]{2}\d?(\d{3})H/); if (m && Number(m[1]) >= 100) return nearestNominal(Number(m[1]) / 1000);
  m = s.match(/\b(\d{3,4})\s?GB?\b/); if (m && Number(m[1]) >= 100) return nearestNominal(Number(m[1]) / 1000);
  m = s.match(/\b(\d{1,2}(?:\.\d{1,2})?)\s?TB\b/); if (m) return nearestNominal(Number(m[1]));
  return null;
}
function capFromField(c) {
  const raw = String(c || '').trim();
  if (!raw) return { tb: null };
  const key = raw.replace(/\s+/g, '').toUpperCase().replace(/B$/, '').replace(/I$/, '');
  if (BINARY_TO_NOMINAL[key.replace(/(\.\d)0+([GT])$/, '$1$2')] && /^\d+(\.\d+)?[GT]$/.test(key)) return { tb: BINARY_TO_NOMINAL[key], via: '이진 단위 환산(' + raw + '→' + BINARY_TO_NOMINAL[key] + 'T)' };
  const m = raw.toUpperCase().replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)(TB|GB|T|G)$/);
  if (!m) return { tb: null };
  let tb = Number(m[1]) / (m[2].startsWith('G') ? 1000 : 1);
  if (/^(TB|GB)$/.test(m[2])) return { tb: nearestNominal(tb) || tb, via: '용량 필드' };
  const n = nearestNominal(tb) || nearestNominal(tb * 1.0995) || nearestNominal(tb * 1.0737);
  return { tb: n, via: n ? '용량 필드(단위 추정 ' + raw + '→' + n + 'T)' : null };
}
const fmtCap = (tb) => (tb >= 1 ? String(Number(tb.toFixed(2))) + 'T' : String(Math.round(tb * 1000)) + 'G');
function genDisk(i) {
  const text = up([i.manufacturer, i.model, i.specification].filter(Boolean).join(' '));
  if (VIRTUAL_DISK_RE.test(up(i.model)) || /RAID VD/.test(up(i.specification))) return excluded('disk', 'RAID/BOSS 가상디스크(' + String(i.model || '').trim() + ')');
  const reasons = [], unresolved = [];
  let conf = 'high';
  let itf = null, ff = null, media = null;
  for (const [re, a, b, c] of DISK_RULES) { if (re.test(text)) { itf = itf || a; ff = ff || b; media = media || c; if (itf && ff && media) break; } }
  if (!media && /SSD/.test(text)) media = 'SSD';
  if (!media && /HDD/.test(text)) media = 'HDD';
  if (!media && itf === 'NVME') media = 'SSD';
  const tokTb = capFromModelToken(squash(i.model) + ' ' + up(i.model));
  const fld = capFromField(i.capacity);
  let tb = tokTb || fld.tb;
  if (tokTb) reasons.push('품번 용량 토큰'); else if (fld.via) { reasons.push(fld.via); if (/이진|추정/.test(fld.via)) conf = worst(conf, 'medium'); }
  if (tokTb && fld.tb && Math.abs(tokTb - fld.tb) / tokTb > 0.03) { conf = worst(conf, 'medium'); reasons.push('용량 필드(' + i.capacity + ')≠품번(' + fmtCap(tokTb) + ') — 품번 우선'); }
  if (!tb && i.legacy_code) {
    const lc = String(i.legacy_code).match(/^sto-(\d+(?:\.\d+)?)([GT])-/i);
    if (lc) { tb = nearestNominal(Number(lc[1]) / (lc[2].toUpperCase() === 'G' ? 1000 : 1)); if (tb) { conf = 'low'; reasons.push('용량=옛 코드 표기'); } }
  }
  if (!media) unresolved.push('media');
  if (!itf) unresolved.push('interface');
  if (!ff) unresolved.push('form_factor');
  if (!tb) unresolved.push('capacity');
  if (unresolved.length) conf = 'low';
  const code = [media || 'DSK', itf, ff, tb ? fmtCap(tb) : null].filter(Boolean).join('-');
  return result('disk', code, { media, interface: itf, form_factor: ff, tb, manufacturer: i.manufacturer || null }, conf, reasons.length ? reasons : ['키워드·접두 규칙'], unresolved);
}

// ───────────────────────── CPU ─────────────────────────
function genCpu(i) {
  const s = up(i.model).replace(/®|\(R\)|\(TM\)|™/g, ' ').replace(/제온/g, 'XEON').replace(/\s+/g, ' ');
  let fam = null, mdl = null, tier = null;
  let m = s.match(/XEON\s+(?:CPU\s+)?(E[357])-(\d{4}[A-Z]?)\s*(V\d)?/);
  if (m) { fam = 'XEON'; mdl = m[1] + '-' + m[2] + (m[3] || ''); }
  if (!fam) { m = s.match(/XEON\s+(?:(GOLD|SILVER|PLATINUM|BRONZE)\s+)?(\d{4}[A-Z]{0,2})\b/); if (m) { fam = 'XEON'; mdl = m[2]; tier = m[1] || null; } }
  if (!fam) { m = s.match(/\b(GOLD|SILVER|PLATINUM|BRONZE)\s+(\d{4}[A-Z]{0,2})\b/); if (m && /INTEL|XEON/.test(s)) { fam = 'XEON'; mdl = m[2]; tier = m[1]; } }
  if (!fam) { m = s.match(/EPYC\s+(\d{4}[A-Z]?)/); if (m) { fam = 'EPYC'; mdl = m[1]; } }
  if (!fam) { m = s.match(/CORE\s+(I[3579])-(\d{4,5}[A-Z]{0,2})/); if (m) { fam = 'CORE'; mdl = m[1] + '-' + m[2]; } }
  if (!fam) return result('cpu', null, { model_raw: i.model || null }, 'low', ['CPU 모델 해석 불가'], ['family', 'model']);
  const cores = (up(i.capacity) + ' ' + up(i.specification)).match(/(\d+)\s*(?:C\/|CORES)/);
  return result('cpu', 'CPU-' + fam + '-' + mdl, { family: fam, model: mdl, tier: tier ? tier.charAt(0) + tier.slice(1).toLowerCase() : null,
    manufacturer: fam === 'EPYC' ? 'AMD' : 'Intel', cores: cores ? Number(cores[1]) : null }, 'high', ['모델 문자열(제품군·모델번호)'], []);
}

// ───────────────────────── GPU ─────────────────────────
const GPU_MEM = { T4: 16, L40S: 48, RTXA4000: 16, H100NVL: 94, RTXPRO6000: 96, RTX5080: 16, A30: 24, A40: 48, L4: 24 };
function genGpu(i) {
  const s = up([i.model, i.specification].filter(Boolean).join(' '));
  if (/DEVICE [0-9A-F]{4}\b/.test(s) && !/\[/.test(s)) return result('gpu', null, { model_raw: i.model || null }, 'low', ['미식별 장치(lspci Device ID) — 보류'], ['model', 'memory', 'form_factor'], { hold: true });
  const br = (s.match(/\[([^\]]+)\]/) || [])[1] || s;
  let model = null;
  let m = br.match(/\b(A100|A30|A40|H100L?|H100\s*NVL|H200|L40S|L4|T4|RTX\s*A\d{4}|RTX\s*PRO\s*6000|RTX\s*\d{4}(?:\s*TI)?)\b/);
  if (m) model = m[1].replace(/\s+/g, '').replace(/^H100L$/, 'H100NVL');
  if (!model) return result('gpu', null, { model_raw: i.model || null }, 'low', ['GPU 모델 해석 불가'], ['model']);
  const reasons = ['모델 문자열'], unresolved = [];
  let conf = 'high';
  let gb = null;
  const mm = (br + ' ' + up(i.capacity)).match(/(\d{1,3})\s*GB?\b/);
  if (mm) gb = Number(mm[1]);
  if (!gb && GPU_MEM[model]) { gb = GPU_MEM[model]; conf = 'medium'; reasons.push('메모리=제품 고정값 표'); }
  if (!gb && i.legacy_code) { const lc = String(i.legacy_code).match(/^GPU-(\d+)G-/i); if (lc) { gb = Number(lc[1]); conf = 'low'; reasons.push('메모리=옛 코드 표기'); } }
  if (/H100L/.test(br)) { conf = worst(conf, 'medium'); reasons.push('lspci H100L → H100 NVL로 해석'); }
  const ff = /SXM/.test(s) ? 'SXM' : 'PCIE';
  if (!/PCIE|SXM/.test(s)) { conf = worst(conf, 'medium'); reasons.push('폼팩터 PCIe 가정'); }
  if (!gb) unresolved.push('memory');
  if (unresolved.length) conf = 'low';
  return result('gpu', ['GPU', model, gb ? gb + 'G' : null, ff].filter(Boolean).join('-'), { model, gb, form_factor: ff, manufacturer: 'NVIDIA' }, conf, reasons, unresolved);
}

// ───────────────────────── NIC ─────────────────────────
// 칩셋/카드 품번 표: [정규식, 칩셋, Gbps, 포트(null=모름), 커넥터, 온보드 후보]
const NIC_TABLE = [
  [/MCX75310AA/, 'CX7', 400, 1, 'OSFP'], [/CX75310AA/, 'CX7', 400, 1, 'OSFP'], [/MCX653106A/, 'CX6', 200, 2, 'QSFP56'], [/MCX653105A/, 'CX6', 200, 1, 'QSFP56'],
  [/CX653106A/, 'CX6', 200, 2, 'QSFP56'], [/CX653105A/, 'CX6', 200, 1, 'QSFP56'], [/MCX556A|CX556A/, 'CX5', 100, 2, 'QSFP28'], [/MCX555A|CX555A/, 'CX5', 100, 1, 'QSFP28'],
  [/MT2910|CONNECTX-7/, 'CX7', 400, null, 'OSFP'], [/MT28908|CONNECTX-6\b/, 'CX6', 200, null, 'QSFP56'], [/MT27710|CONNECTX-4 LX/, 'CX4LX', 25, null, 'SFP28'],
  [/MT27800|MT28800/, 'CX5', 100, null, 'QSFP28'], [/MT27500/, 'CX3', 10, null, 'SFP+'], [/E810-C|E810/, 'E810', 100, null, 'QSFP28'],
  [/X710 FOR 10GBASE-T/, 'X710', 10, null, 'RJ45'], [/X710/, 'X710', 10, null, 'SFP+'], [/X722/, 'X722', 10, null, null, true, true], [/X550/, 'X550', 10, null, 'RJ45'],
  [/X520|82599/, '82599', 10, null, 'SFP+'], [/E610/, 'E610', 10, null, 'RJ45'], [/I350/, 'I350', 1, null, 'RJ45'], [/I210/, 'I210', 1, 1, 'RJ45', true],
  [/BCM5720/, 'BCM5720', 1, 2, 'RJ45', true], [/BCM57416/, 'BCM57416', 10, 2, 'RJ45'], [/BCM57508/, 'BCM57508', 200, null, 'QSFP56'],
  [/BCM57810/, 'BCM57810', 10, null, 'SFP+'], [/BCM57840/, 'BCM57840', 10, null, 'SFP+'], [/LPE16002/, 'LPE16002', 16, 2, 'FC'],
  [/QLE2672/, 'QLE2672', 16, 2, 'FC'], [/QLE2694/, 'QLE2694', 16, 4, 'FC'], [/MBL400/, 'MBL400', 400, null, null]
];
function genNic(i) {
  const s = up([i.model, i.specification].filter(Boolean).join(' '));
  if (/DEVICE [0-9A-F]{4}\b/.test(s) && !NIC_TABLE.some(([re]) => re.test(s))) return result('network', null, { model_raw: i.model || null }, 'low', ['미식별 장치(lspci Device ID) — 보류'], ['chipset', 'speed', 'ports', 'connector'], { hold: true });
  const row = NIC_TABLE.find(([re]) => re.test(s));
  if (!row) return result('network', null, { model_raw: i.model || null }, 'low', ['NIC 칩셋 해석 불가'], ['chipset', 'speed', 'ports', 'connector']);
  const [, chip, gbps0, ports0, conn, onboardHint, speedVaries] = row;
  let gbps = gbps0;
  const reasons = ['칩셋/카드 표(' + chip + ')'], unresolved = [];
  let conf = 'high';
  let ports = ports0;
  const pm = (up(i.specification) + ' ' + up(i.capacity) + ' ' + up(i.model)).match(/(\d)\s*(?:포트|P\b|-PORT|PORT)|-(\d)SFP/);
  if (pm) { const p = Number(pm[1] || pm[2]); if (ports && ports !== p) { conf = 'medium'; reasons.push('포트 표(' + ports + ')≠기록(' + p + ') — 기록 우선'); } ports = p; reasons.push('포트=기록 문자열'); }
  const cm = up(i.capacity).match(/(\d+)\s*G/);
  const forG = s.match(/FOR (\d+)GBE/);
  if (speedVaries && (forG || cm)) {   // X722 등 속도 변형 칩: "for 1GbE" 문구 > 기록 속도
    gbps = Number(forG ? forG[1] : cm[1]); reasons.push('속도=' + (forG ? '모델 문구' : '기록') + '(변형 칩)');
    if (!forG) conf = worst(conf, 'medium');
  } else if (cm && Number(cm[1]) !== gbps) { conf = worst(conf, 'medium'); reasons.push('속도 기록(' + i.capacity + ')≠칩셋(' + gbps + 'G) — 칩셋 우선'); }
  if (!ports) unresolved.push('ports');
  if (!conn) unresolved.push('connector');
  if (unresolved.length) conf = 'low';
  const code = ['NIC', gbps + 'G', ports ? ports + 'P' : null, conn ? conn.replace('+', 'P') : null, chip].filter(Boolean).join('-');
  return result('network', code, { chipset: chip, gbps, ports: ports || null, connector: conn || null, onboard_candidate: !!onboardHint, manufacturer: i.manufacturer || null }, conf, reasons, unresolved);
}

// ───────────────────────── RAID ─────────────────────────
function genRaid(i) {
  const s = up([i.model, i.specification].filter(Boolean).join(' '));
  if (/SSATA|RAID MODE|ASMEDIA|106X/.test(s)) return excluded('raid', '온보드 RAID/SATA 컨트롤러(' + String(i.model || '').trim() + ')');
  let m = s.match(/PERC\s*(H\d{3,4}[A-Z]?)/); if (m) return result('raid', 'RAID-PERC-' + m[1], { family: 'PERC', model: m[1] }, 'high', ['모델 문자열'], []);
  m = s.match(/SR-?(\d{4})/); if (m && /GRAID/.test(s)) return result('raid', 'RAID-GRAID-SR' + m[1], { family: 'GRAID', model: 'SR' + m[1] }, 'high', ['모델 문자열'], []);
  m = s.match(/\b(9\d{3})-(\d{1,2}I)\b/); if (m) return result('raid', 'RAID-' + m[1] + '-' + m[2], { family: 'MegaRAID', model: m[1] + '-' + m[2] }, 'high', ['카드 품번'], []);
  m = s.match(/PIKE\s*(\d{4})-(\d{1,2}I)/); if (m) return result('raid', 'RAID-PIKE' + m[1] + '-' + m[2], { family: 'ASUS PIKE', model: m[1] + '-' + m[2] }, 'high', ['카드 품번'], []);
  m = s.match(/SAS-?3\s*(\d{4})|SAS\s*(\d{4})/);
  if (m) return result('raid', 'RAID-' + (m[1] || m[2]), { family: 'MegaRAID', chip: m[1] || m[2] }, 'low', ['칩만 식별(카드 품번·포트 미상)'], ['card_model']);
  return result('raid', null, { model_raw: i.model || null }, 'low', ['RAID 모델 해석 불가'], ['card_model']);
}

// ───────────────────────── NPU ─────────────────────────
function genNpu(i) {
  const s = up(i.model);
  const m = s.match(/\b(RNGD|WARBOY|ATOM\+?|REBEL)\b/);
  if (!m) return result('npu', null, { model_raw: i.model || null }, 'low', ['NPU 모델 해석 불가'], ['model']);
  return result('npu', 'NPU-' + m[1].replace('+', 'P'), { model: m[1], manufacturer: /FURIOSA/.test(s) ? 'FuriosaAI' : (/REBEL/.test(s) ? 'Rebellions' : i.manufacturer || null) }, 'high', ['모델 문자열'], []);
}

// ───────────────────────── 케이블 ─────────────────────────
function genCable(i) {
  const s = up([i.model, i.capacity, i.specification].filter(Boolean).join(' '));
  const reasons = ['모델·사양 문자열'], unresolved = [];
  let conf = 'high';
  const kind = /AOC/.test(s) ? 'AOC' : (/DAC|PASSIVE|CU\d?M|MCP\d/.test(s) ? 'DAC' : null);
  const sp = s.match(/(\d{2,3})G/); const gbps = sp ? Number(sp[1]) : null;
  const conns = [];
  const order = [['OSFP', /OSFP/], ['QSFPDD', /QSFP-?DD|QDD/], ['QSFP56', /QSFP56/], ['QSFP28', /QSFP28/], ['SFP28', /(?<!Q)SFP28/]];
  order.forEach(([n, re]) => { if (re.test(s)) conns.push(n); });
  const brk = s.match(/(\d)\s*X\s*(QSFP56|SFP28|QSFP28)/) || s.match(/분기\s*1→(\d)/);
  let conn = conns.length ? conns.slice(0, 2).join('-') : null;
  if (brk && brk[2]) conn = (conns.find((c) => c !== brk[2]) || conns[0]) + '-' + brk[1] + 'X' + brk[2];
  const len = s.match(/(\d+(?:\.\d+)?)\s*M\b/);
  if (!kind) unresolved.push('kind');
  if (!gbps) unresolved.push('speed');
  if (!conn) unresolved.push('connector');
  if (!len) unresolved.push('length');
  if (unresolved.length) conf = 'low';
  const code = ['CBL', kind, gbps ? gbps + 'G' : null, conn, len ? len[1] + 'M' : null].filter(Boolean).join('-');
  return result('cable', code, { kind, gbps, connector: conn, length_m: len ? Number(len[1]) : null, manufacturer: i.manufacturer || null }, conf, reasons, unresolved);
}

function generate(input) {
  const i = input || {};
  switch (i.module_type) {
    case 'memory': return genMemory(i);
    case 'disk': return genDisk(i);
    case 'cpu': return genCpu(i);
    case 'gpu': return genGpu(i);
    case 'network': return genNic(i);
    case 'raid': return genRaid(i);
    case 'npu': return genNpu(i);
    case 'cable': return genCable(i);
    case 'psu': return excluded('psu', 'PSU(재고 품목 폐지 — OPS-5)');
    default: return result(i.module_type || null, null, {}, 'low', ['알 수 없는 유형'], ['module_type']);
  }
}

// 모델 문자열의 시리얼 혼입 마스킹(앞 4자만): "(SN: S6JENC0Y312656)" → "(SN: S6JE…)"
function maskSerial(text) {
  return String(text == null ? '' : text).replace(/(\bS\/?N\s*[:：]\s*)([A-Za-z0-9-]{4})[A-Za-z0-9-]*/gi, '$1$2…');
}

module.exports = { generate, isSerialized, decodeMemoryPart, maskSerial, BINARY_TO_NOMINAL, NOMINAL, _internal: { capFromField, capFromModelToken, nearestNominal } };
