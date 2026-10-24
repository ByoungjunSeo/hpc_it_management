// v2.9 단계 1 규격 코드 생성기 단위 테스트 — 실행: node --test v2/app/test/ (Node 18 내장, npm 추가 없음)
// 입력 문자열은 운영 module_inventory의 실제 표기(시리얼은 마스킹·가공)에서 발췌.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../services/specCatalog');
const g = (module_type, model, capacity, specification, extra) => sc.generate(Object.assign({ module_type, model, capacity, specification }, extra || {}));

test('메모리 — 제조사 품번 규칙(대표 품번)', () => {
  const cases = [
    ['M321R8GA0BB0-CQKZJ', '64GB', 'DDR5 RDIMM 4800Mbps', 'MEM-D5-64G-RD-4800'],
    ['M321R4GA3EB0-CWMXJ', '32GB', 'DDR5 RDIMM 5600Mbps', 'MEM-D5-32G-RD-5600'],
    ['M321R8GA0PB2-CCPWF', '64 GB', '', 'MEM-D5-64G-RD-6400'],
    ['M393A2K40BB2-CTD', '16GB', 'DDR4 RDIMM 2666Mbps', 'MEM-D4-16G-RD-2666'],
    ['M393A2G40EB1-CPB', '16GB', 'DDR4 RDIMM 2133Mbps', 'MEM-D4-16G-RD-2133'],
    ['M378A4G43AB2-CWE', '32GB', 'DDR4 UDIMM 3200Mbps', 'MEM-D4-32G-UD-3200'],
    ['M386A8K40BM2-CTD', '64GB', 'DDR4 LRDIMM 2666Mbps', 'MEM-D4-64G-LR-2666'],
    ['M393A8G40AB2-CVF(BY|CO)', '64GB', 'DDR4 RDIMM 2933Mbps', 'MEM-D4-64G-RD-2933'],
    ['HMA84GR7AFR4N-UH', '32GB', 'DDR4 RDIMM 2400Mbps', 'MEM-D4-32G-RD-2400'],
    ['HMAA8GL7AMR4N-VK', '64GB', 'DDR4 LRDIMM 2666Mbps', 'MEM-D4-64G-LR-2666'],
    ['MTA36ASF4G72PZ-3G2R1', '32GB', 'DDR4 RDIMM 3200Mbps', 'MEM-D4-32G-RD-3200'],
    ['18ASF2G72PDZ-3G2E1', '16 GB', '', 'MEM-D4-16G-RD-3200']
  ];
  for (const [m, c, s, want] of cases) { const r = g('memory', m, c, s); assert.equal(r.spec_code, want, m); assert.equal(r.confidence, 'high', m); }
});

test('메모리 — 리비전 접미만 다른 같은 품번은 같은 규격·같은 별칭 키', () => {
  const a = g('memory', 'M321R4GA3PB0-CWMJJ', '32 GB'), b = g('memory', 'M321R4GA3PB0-CWMRF', '32 GB'), c = g('memory', 'M321R4GA3EB0-CWMKJ', '32 GB');
  assert.equal(a.spec_code, 'MEM-D5-32G-RD-5600'); assert.equal(b.spec_code, a.spec_code); assert.equal(c.spec_code, a.spec_code);
  assert.equal(a.attrs.part_norm, b.attrs.part_norm);          // -CWMJJ / -CWMRF → 같은 별칭
  assert.notEqual(a.attrs.part_norm, c.attrs.part_norm);       // 다이 리비전(PB0/EB0)은 별칭 구분, 규격은 같음
});

test('메모리 — 품번 규칙으로 못 푸는 필드는 스펙 문자열 보조(medium), 그래도 없으면 low+unresolved', () => {
  const hx = g('memory', 'HMCG88AHBRA478N', '32 GB', 'DDR5, 6400 MT/s');
  assert.equal(hx.spec_code, 'MEM-D5-32G-RD-6400'); assert.equal(hx.confidence, 'medium');
  const mc = g('memory', 'MTC10F1084S1RC48BA1 JGCC', '16 GB', '');
  assert.equal(mc.spec_code, 'MEM-D5-16G-RD-4800'); assert.equal(mc.confidence, 'medium');
  const unk = g('memory', 'HMCG94AGBRA179N', '', '');
  assert.equal(unk.confidence, 'low'); assert.deepEqual(unk.unresolved_fields, ['mts']);
  assert.ok(!/\?/.test(unk.spec_code));
});

test('메모리 — 업체 품목도 같은 규격으로(소유는 코드에 안 들어감)', () => {
  const comp = g('memory', 'M321R8GA0BB0-CQKZJ', '64GB', '', { owner: 'company', legacy_code: 'mem-64-F' });
  const vend = g('memory', 'M321R8GA0BB0-CQKZJ', '64 GB', 'DDR5, 4800 MT/s, Configured: 4800 MT/s', { owner: 'vendor', legacy_code: '글루시스-메모리-002' });
  assert.equal(comp.spec_code, vend.spec_code);
});

test('디스크 — 대표 품번(매체·인터페이스·폼팩터·공칭 용량)', () => {
  const cases = [
    ['SAMSUNG MZQL23T8HCLS-00A07', '3.5T', '', 'SSD-NVME-U2-3.84T'],
    ['SAMSUNG MZQL27T6HBLA-00A07', '7TB', '', 'SSD-NVME-U2-7.68T'],
    ['SAMSUNG MZ7L3480HCHQ-00A07', '447.1G', '', 'SSD-SATA-25-480G'],
    ['Micron_5200_MTFDDAK3T8TDC', '3.84TB', '5200 ECO', 'SSD-SATA-25-3.84T'],
    ['Micron 7450 Pro', '3.84TB', 'MTFDKCC3T8TFR-1BC1ZABYY', 'SSD-NVME-U3-3.84T'],
    ['TOSHIBA AL14SEB060N', '600GB', '', 'HDD-SAS-25-600G'],
    ['SEAGATE ST300MM0048', '300GB', '', 'HDD-SAS-25-300G'],
    ['Seagate Barracuda ST2000DM008 2 TB 3.5" HDD', '2TB', 'ST2000DM008', 'HDD-SATA-35-2T'],
    ['Samsung SSD 980 PRO 1TB', '931.5G', '', 'SSD-NVME-M2-1T'],
    ['KIOXIA KCMYXRUG1T92', '1.7T', '', 'SSD-NVME-E3S-1.92T'],
    ['Dell Ent NVMe P5316 RI 30.72TB(SN: XXXX)', '30.72TB', 'SSDPF2NV307TZE', 'SSD-NVME-U2-30.72T']
  ];
  for (const [m, c, s, want] of cases) assert.equal(g('disk', m, c, s).spec_code, want, m);
});

test('디스크 — lsblk 이진 단위 환산(3.5T→3.84T 등)과 환산표', () => {
  assert.equal(sc.BINARY_TO_NOMINAL['3.5T'], 3.84);
  assert.equal(sc.BINARY_TO_NOMINAL['447.1G'], 0.48);
  assert.equal(sc.BINARY_TO_NOMINAL['931.5G'], 1.0);
  const r = g('disk', 'Dell DC NVMe CD8P E3.S 3.84TB', '3.5T', '');
  assert.equal(r.spec_code, 'SSD-NVME-E3S-3.84T');
  const r2 = g('disk', 'Samsung SSD 990 EVO Plus 1TB', '931.5G', '');
  assert.equal(r2.spec_code, 'SSD-NVME-M2-1T');
  const fx = sc._internal.capFromField('3.5T'); assert.equal(fx.tb, 3.84); assert.match(fx.via, /이진 단위/);
});

test('디스크 — RAID/BOSS 가상디스크는 재고 아님', () => {
  for (const m of ['PERC H755 Front', 'Dell BOSS-N1', 'AVAGO AsustekPIKE3108', 'DELL RAID', 'DELL               PERC H730P Mini']) {
    const r = g('disk', m, '2.2T', ''); assert.equal(r.inventory, false, m); assert.equal(r.spec_code, null);
  }
  assert.equal(g('disk', 'X', '1T', 'RAID VD').inventory, false);
});

test('디스크 — 폼팩터를 모르면 마디를 빼고 low + unresolved', () => {
  const r = g('disk', 'ISE PE9010 GEN4 RI', '480GB', 'HFS480GEJ8X176N');
  assert.equal(r.confidence, 'low'); assert.ok(r.unresolved_fields.includes('form_factor')); assert.ok(!/\?/.test(r.spec_code));
});

test('CPU — 제품군-모델번호(제조사는 attrs)', () => {
  const cases = [['Intel(R) Xeon(R) 6530P', 'CPU-XEON-6530P'], ['AMD EPYC 9654 96-Core Processor', 'CPU-EPYC-9654'], ['Intel(R) Xeon(R) Gold 6140 CPU @ 2.30GHz', 'CPU-XEON-6140'],
    ['Intel(R) Xeon(R) CPU E5-2699 v4 @ 2.20GHz', 'CPU-XEON-E5-2699V4'], ['인텔® 제온® Platinum 8380 프로세서', 'CPU-XEON-8380'], ['12th Gen Intel(R) Core(TM) i7-12700', 'CPU-CORE-I7-12700'],
    ['AMD EPYC 9454 48-Core Emb Processor', 'CPU-EPYC-9454']];
  for (const [m, want] of cases) { const r = g('cpu', m, '', ''); assert.equal(r.spec_code, want, m); assert.ok(r.attrs.manufacturer); }
  assert.equal(g('cpu', 'Intel(R) Xeon(R) Gold 6140 CPU', '', '').attrs.tier, 'Gold');
});

test('GPU — 모델·메모리·폼팩터, Device xxxx 미식별은 보류(unresolved)', () => {
  assert.equal(g('gpu', 'NVIDIA Corporation GA100 [A100 PCIe 80GB] (rev a1)', '80GB HBM2', '').spec_code, 'GPU-A100-80G-PCIE');
  assert.equal(g('gpu', 'NVIDIA Corporation GA100 [A100 PCIe 40GB] (rev a1)', '40GB HBM2', '').spec_code, 'GPU-A100-40G-PCIE');
  assert.equal(g('gpu', 'L40S', '48GB', '').spec_code, 'GPU-L40S-48G-PCIE');
  const d = g('gpu', 'NVIDIA Corporation Device 2c31 (rev a1)', '', '');   // 2bb5는 결정으로 RTX PRO 6000 — 아래 별도 테스트
  assert.equal(d.spec_code, null); assert.equal(d.hold, true); assert.ok(d.unresolved_fields.includes('model'));
  assert.equal(g('gpu', 'L40S', '48GB', '').serialized, true);
});

test('NIC — 칩셋·속도·포트·커넥터, lspci로 포트 모르면 low + ports', () => {
  assert.equal(g('network', 'CX75310AA(MT2910 Mellanox)', '400Gbps', 'MCX75310AAS-NEAT').spec_code, 'NIC-400G-1P-OSFP-CX7');
  assert.equal(g('network', 'CX653106A(MT28908 Mellanox)', '200GbE', 'MCX653106A-HDAT').spec_code, 'NIC-200G-2P-QSFP56-CX6');
  assert.equal(g('network', 'LREC9812AF-2SFP+(BCM57810)', '10Gbps', '').spec_code, 'NIC-10G-2P-SFPP-BCM57810');
  const lx = g('network', 'Mellanox Technologies MT27710 Family [ConnectX-4 Lx]', '25Gbps', '');
  assert.equal(lx.confidence, 'low'); assert.deepEqual(lx.unresolved_fields, ['ports']); assert.ok(!/\?/.test(lx.spec_code));
  assert.equal(g('network', 'Intel Corporation Device 57b0', '', '2포트').hold, true);
  assert.equal(g('network', 'intel corporation ethernet connection x722 for 1gbe (rev 09)', '1GbE(2포트)', '').attrs.gbps, 1);
});

test('RAID·NPU·케이블 — 설계 형식', () => {
  assert.equal(g('raid', 'Broadcom / LSI MegaRAID SAS 9361-8i', '', 'MegaRaid SAS 9361-8i').spec_code, 'RAID-9361-8I');
  assert.equal(g('raid', 'Broadcom / LSI PERC H755 Front', '', '').spec_code, 'RAID-PERC-H755');
  assert.equal(g('raid', 'Intel Corporation sSATA Controller [RAID Mode] (rev 0a)', '', '').inventory, false);
  assert.equal(g('npu', 'FuriosaAI, Inc. RNGD', '', '').spec_code, 'NPU-RNGD');
  assert.equal(g('cable', 'QDD-400G-2QPC025', 'DAC(400G) 2.5m', '2.5m 400G QSFP-DD Passive DAC Cable').spec_code, 'CBL-DAC-400G-QSFPDD-2.5M');
  assert.equal(g('cable', 'MCP1600-E003', '100G 3m', '이더넷/IB (EDR/100G) / QSFP28 / DAC').spec_code, 'CBL-DAC-100G-QSFP28-3M');
  assert.equal(g('cable', '845416-B21', '100G→4x25G 3m', '이더넷 / QSFP28→4xSFP28 / DAC / 분기 1→4').spec_code, 'CBL-DAC-100G-QSFP28-4XSFP28-3M');
});

test('시리얼 관리 대상 판정(설계 확정 범위)', () => {
  assert.equal(sc.isSerialized('gpu', {}), true);
  assert.equal(sc.isSerialized('npu', {}), true);
  assert.equal(sc.isSerialized('network', { gbps: 100 }), true);
  assert.equal(sc.isSerialized('network', { gbps: 25 }), false);
  assert.equal(sc.isSerialized('disk', { interface: 'NVME', tb: 3.84 }), true);
  assert.equal(sc.isSerialized('disk', { interface: 'NVME', tb: 1.92 }), false);
  assert.equal(sc.isSerialized('disk', { interface: 'SATA', tb: 3.84 }), false);
  assert.equal(sc.isSerialized('memory', {}), false);
});

test('PSU·시리얼 마스킹', () => {
  assert.equal(g('psu', 'PWS-2K04A', '2000W', '').inventory, false);
  assert.equal(sc.maskSerial('Dell DC NVMe PM9A3 RI U.2 3.84TB(SN: S6JENC0Y312656)'), 'Dell DC NVMe PM9A3 RI U.2 3.84TB(SN: S6JE…)');
});

// ───── v2.9 단계 1-보완: 결정 반영 + 현장 확인값(field) ─────
test('GPU — Device 2bb5 = RTX PRO 6000 Blackwell 계열(medium), 현장 확인 시 high', () => {
  const d = g('gpu', 'NVIDIA Corporation Device 2bb5 (rev a1)', '', '');
  assert.equal(d.spec_code, 'GPU-RTXPRO6000-96G-PCIE'); assert.equal(d.confidence, 'medium'); assert.ok(!d.hold);
  const f = g('gpu', 'NVIDIA Corporation Device 2bb5 (rev a1)', '', '', { field: { name: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', memory_gb: 96, asset: 'X' } });
  assert.equal(f.spec_code, 'GPU-RTXPRO6000-96G-PCIE'); assert.equal(f.confidence, 'high'); assert.equal(f.field_confirmed, true);
  assert.equal(g('gpu', 'NVIDIA Corporation Device 2c31 (rev a1)', '', '').hold, true);   // 다른 미식별 ID는 계속 보류
  const ti = g('gpu', 'NVIDIA Corporation GB206 [GeForce RTX 5060 Ti] (rev a1)', '', '', { field: { memory_gb: 16 } });
  assert.equal(ti.spec_code, 'GPU-RTX5060TI-16G-PCIE'); assert.equal(ti.confidence, 'high');
});

test('NIC — 현장 확인 포트 수·카드 품번으로 확정(별칭 충돌 통합/분리)', () => {
  const x710 = 'Intel Corporation Ethernet Controller X710 for 10GBASE-T (rev 02)';
  const a = g('network', x710, '10GbE', '', { field: { ports: 2 } }), b = g('network', x710, '', '2포트');
  assert.equal(a.spec_code, 'NIC-10G-2P-RJ45-X710'); assert.equal(a.confidence, 'high'); assert.equal(a.spec_code, b.spec_code);   // 통합
  const c = g('network', 'Intel Corporation I350 Gigabit Network Connection (rev 01)', '', '', { field: { ports: 4 } });
  assert.equal(c.spec_code, 'NIC-1G-4P-RJ45-I350');                                                                                  // 포트 다르면 분리
  const cx = g('network', 'Mellanox Technologies MT2910 Family [ConnectX-7]', '400GbE', '', { field: { part_number: 'MCX75310AAS-NEAT' } });
  assert.equal(cx.spec_code, 'NIC-400G-1P-OSFP-CX7'); assert.equal(cx.confidence, 'high');
  const lx = g('network', 'Mellanox Technologies MT27710 Family [ConnectX-4 Lx]', '25Gbps', '', { field: { ports: 2, part_number: 'MCX4121A-ACAT' } });
  assert.equal(lx.spec_code, 'NIC-25G-2P-SFP28-CX4LX'); assert.equal(lx.confidence, 'high');
});

test('RAID — ASMedia 106x는 현장 확인 대상(보류) → 온보드면 재고 아님, 추가 카드면 규격', () => {
  const m = 'ASMedia Technology Inc. 106x SATA/RAID Controller (rev 01)';
  const h = g('raid', m, '', ''); assert.equal(h.inventory, true); assert.equal(h.hold, true); assert.equal(h.spec_code, null);
  assert.equal(g('raid', m, '', '', { field: { onboard: true } }).inventory, false);
  const card = g('raid', m, '', '', { field: { onboard: false, pci_device_id: '0612' } }); assert.equal(card.spec_code, 'RAID-ASM1062'); assert.equal(card.confidence, 'high');
  assert.equal(g('raid', 'Intel Corporation sSATA Controller [RAID Mode] (rev 0a)', '', '').inventory, false);   // sSATA는 확정
  const r = g('raid', 'Broadcom / LSI MegaRAID SAS-3 3108 [Invader] (rev 02)', '', '', { field: { model: 'AVAGO MegaRAID SAS 9361-8i' } });
  assert.equal(r.spec_code, 'RAID-9361-8I'); assert.equal(r.confidence, 'high');
});

test('디스크 — 현장 확인 폼팩터·공칭 용량 반영', () => {
  const r = g('disk', 'ISE PE9010 GEN4 RI', '480GB', 'HFS480GEJ8X176N', { field: { form_factor: 'U.2' } });
  assert.equal(r.spec_code, 'SSD-NVME-U2-480G'); assert.equal(r.confidence, 'high');
  const m = g('disk', 'Micron_5200_MTFDDAK3T8TDC', '2.7T', '', { field: { model: 'Micron_5200_MTFDDAK3T8TDC', form_factor: '2.5 inches', nominal_tb: 3.84 } });
  assert.equal(m.spec_code, 'SSD-SATA-25-3.84T'); assert.equal(m.confidence, 'high');
});
