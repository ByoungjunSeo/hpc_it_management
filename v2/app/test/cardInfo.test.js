// v2.9 단계 3a 카드 정보 파서 + 현장 확인(field) 형식 단위 테스트 — node --test v2/app/test/
// 픽스처는 lspci/nvidia-smi 출력 형식을 본뜬 가짜 원문(실장비 출력 아님, 시리얼은 가공값).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hp = require('../services/hardwareParser');
const fc = require('../services/fieldCheck');
const sc = require('../services/specCatalog');

const NET = [
  '0000:3b:00.0 Ethernet controller: Intel Corporation Ethernet Controller X710 for 10GBASE-T (rev 02)',
  '0000:3b:00.1 Ethernet controller: Intel Corporation Ethernet Controller X710 for 10GBASE-T (rev 02)',
  '0000:5e:00.0 Ethernet controller: Intel Corporation I350 Gigabit Network Connection (rev 01)',
  '0000:5e:00.1 Ethernet controller: Intel Corporation I350 Gigabit Network Connection (rev 01)',
  '0000:5e:00.2 Ethernet controller: Intel Corporation I350 Gigabit Network Connection (rev 01)',
  '0000:5e:00.3 Ethernet controller: Intel Corporation I350 Gigabit Network Connection (rev 01)',
  '0000:af:00.0 Infiniband controller: Mellanox Technologies MT2910 Family [ConnectX-7]'
].join('\n');
const VPD = [
  '===CARD:0000:3b:00.0===',
  '0000:3b:00.0 Ethernet controller [0200]: Intel Corporation Ethernet Controller X710 for 10GBASE-T [8086:15ff] (rev 02)',
  '\tSubsystem: Intel Corporation Ethernet Network Adapter X710-T2L',
  '\t\tProduct Name: Intel(R) Ethernet Network Adapter X710-T2L',
  '\t\t\t[PN] Part number: X710T2L',
  '\t\t\t[SN] Serial number: ABCD…',
  '===CARD:0000:5e:00.0===',
  '0000:5e:00.0 Ethernet controller [0200]: Intel Corporation I350 Gigabit Network Connection [8086:1521] (rev 01)',
  '\tSubsystem: Intel Corporation Ethernet Server Adapter I350-T4',
  '===PERMISSION_DENIED:lspci-vpd===',
  '===CARD:0000:af:00.0===',
  '0000:af:00.0 Infiniband controller [0207]: Mellanox Technologies MT2910 Family [ConnectX-7] [15b3:1021]',
  '\t\tProduct Name: NVIDIA ConnectX-7 HHHL Adapter Card, 400GbE / NDR IB (default mode), Single-port OSFP',
  '\t\t\t[PN] Part number: MCX75310AAS-NEAT',
  '\t\t\t[SN] Serial number: MT2312345678',
  '===CARD:0000:a8:00.0===',
  '0000:a8:00.0 RAID bus controller [0104]: Broadcom / LSI MegaRAID SAS-3 3108 [Invader] [1000:005d] (rev 02)',
  '\t\tProduct Name: AVAGO MegaRAID SAS 9361-8i',
  '\t\t\t[PN] Part number: 03-25420-08B'
].join('\n');
const out = (o) => [
  '===NETWORK_START===', o.net || NET, '===NETWORK_END===',
  '===RAID_START===', o.raid || 'RAID: 0000:a8:00.0 RAID bus controller: Broadcom / LSI MegaRAID SAS-3 3108 [Invader] (rev 02)', '===RAID_END===',
  '===GPU_START===', o.gpu || '', '===GPU_END===',
  '===CARDVPD_START===', o.vpd != null ? o.vpd : VPD, '===CARDVPD_END===',
  '===GPUQ_START===', o.gpuq || '', '===GPUQ_END==='
].join('\n');

test('NIC — VPD 있는 카드: 품번·제품명·시리얼 앞 4자, function 수 = 포트', () => {
  const nets = hp.parseNetwork(out({}));
  const x710 = nets.find((m) => /X710/.test(m.model));
  assert.equal(x710.ports, 2); assert.equal(x710.card_part_number, 'X710T2L'); assert.match(x710.card_product_name, /X710-T2L/);
  assert.deepEqual(x710.card_serials_masked, ['ABCD…']); assert.equal(x710.pci_id, '8086:15ff');
  assert.equal(x710.specification, '2포트 10GbE');                      // 기존 키 값 그대로
  const cx7 = nets.find((m) => /MT2910/.test(m.model));
  assert.equal(cx7.card_part_number, 'MCX75310AAS-NEAT'); assert.deepEqual(cx7.card_serials_masked, ['MT23…']);   // 파서에서도 마스킹
  assert.ok(!JSON.stringify(nets).includes('MT2312345678'));
});

test('NIC — VPD 없는 멀티포트 카드: 포트 수만, 품번 키 없음', () => {
  const i350 = hp.parseNetwork(out({})).find((m) => /I350/.test(m.model));
  assert.equal(i350.ports, 4); assert.equal(i350.card_part_number, undefined); assert.equal(i350.pci_id, '8086:1521');
  const none = hp.parseNetwork(out({ vpd: '' })).find((m) => /I350/.test(m.model));
  assert.equal(none.ports, 4); assert.equal(none.card_part_number, undefined); assert.equal(none.pci_id, undefined);
});

test('NIC — 같은 모델·포트 카드 2장이면 count 2, 품번이 갈리면 복수 키', () => {
  const net = NET + '\n0000:d8:00.0 Ethernet controller: Intel Corporation Ethernet Controller X710 for 10GBASE-T (rev 02)\n0000:d8:00.1 Ethernet controller: Intel Corporation Ethernet Controller X710 for 10GBASE-T (rev 02)';
  const vpd = VPD + '\n===CARD:0000:d8:00.0===\n0000:d8:00.0 Ethernet controller [0200]: Intel X710 [8086:15ff]\n\t\t\t[PN] Part number: X710T2LBLK';
  const x = hp.parseNetwork(out({ net, vpd })).find((m) => /X710/.test(m.model));
  assert.equal(x.count, 2); assert.equal(x.ports, 2); assert.deepEqual(x.card_part_numbers, ['X710T2L', 'X710T2LBLK']); assert.equal(x.card_part_number, undefined);
});

test('RAID — PCI 주소로 VPD 짝맞춤(제품명·품번)', () => {
  const r = hp.parseRaid(out({}))[0];
  assert.match(r.model, /3108/); assert.equal(r.card_product_name, 'AVAGO MegaRAID SAS 9361-8i'); assert.equal(r.card_part_number, '03-25420-08B');
});

test('GPU — nvidia-smi 조회 2종(bus 주소 짝맞춤 / 주소 없는 단일 모델)', () => {
  const gpu = 'af:00.0 3D controller: NVIDIA Corporation Device 2bb5 (rev a1)\nd8:00.0 3D controller: NVIDIA Corporation GA100 [A100 PCIe 80GB] (rev a1)';
  const gpuq = 'NVIDIA RTX PRO 6000 Blackwell Server Edition, 97887 MiB, 00000000:AF:00.0, 0x2BB510DE\nNVIDIA A100 80GB PCIe, 81920 MiB, 00000000:D8:00.0, 0x20B510DE';
  const g = hp.parseGpu(out({ gpu, gpuq }));
  const b = g.find((m) => /2bb5/.test(m.model)), a = g.find((m) => /A100/.test(m.model));
  assert.equal(b.gpu_memory_gb, 96); assert.equal(b.gpu_device_id, '2bb5'); assert.match(b.gpu_name, /RTX PRO 6000/);
  assert.equal(a.gpu_memory_gb, 80); assert.equal(a.gpu_device_id, '20b5');
  assert.ok(!Object.keys(b).includes('_bus'));                         // 짝맞춤용 내부 값은 결과 키 아님
  const t4 = hp.parseGpu(out({ gpu: 'GPU 0: Tesla T4 (UUID: GPU-x)', gpuq: 'Tesla T4, 15360 MiB, 00000000:3B:00.0, 0x1EB810DE' }))[0];
  assert.equal(t4.gpu_memory_gb, 16);
});

test('parseAll — 카드 키는 선택 키로만 추가, 표식 없음이면 기존과 같은 모듈 구성', () => {
  const r = hp.parseAll(out({}));
  assert.ok(r.modules.some((m) => m.card_part_number === 'MCX75310AAS-NEAT'));
  const r0 = hp.parseAll(out({ vpd: '' }));
  const strip = (m) => { const c = Object.assign({}, m); ['ports', 'card_part_number', 'card_part_numbers', 'card_product_name', 'card_product_names', 'card_serials_masked', 'pci_id', 'gpu_name', 'gpu_memory_gb', 'gpu_device_id'].forEach((k) => delete c[k]); return c; };
  assert.deepEqual(r.modules.map(strip), r0.modules.map(strip));
});

test('field 형식 — 검증(알 수 없는 키·범위·형식 오류 거부, 문자열 시리얼 마스킹)', () => {
  const ok = fc.validateFieldFile({ format: 'itam-field-check', version: 1, source: 'manual', items: [
    { legacy_code: 'net-25-A', module_type: 'network', asset: 'TPC-SV-2U-05', field: { ports: 2, part_number: 'MCX4121A-ACAT' } },
    { legacy_code: 'x', field: { product_name: 'Card SN: ABCDEFGH' } }] });
  assert.equal(ok.errors.length, 0); assert.equal(ok.items[1].field.product_name, 'Card SN: ABCD…');
  const bad = fc.validateFieldFile({ format: 'itam-field-check', version: 1, items: [
    { legacy_code: 'a', field: { serial: 'X' } }, { legacy_code: 'b', field: { ports: 0 } }, { legacy_code: 'c', field: { pci_device_id: 'zz' } }, { field: { ports: 2 } }, { legacy_code: 'e', field: {} }] });
  assert.equal(bad.items.length, 0); assert.equal(bad.errors.length, 5);
  assert.ok(fc.validateFieldFile({ format: 'x', version: 2, items: [] }).errors.length >= 2);
});

test('field 형식 — 같은 옛 코드 병합, 값이 다르면 충돌', () => {
  const v = fc.validateFieldFile({ format: 'itam-field-check', version: 1, items: [
    { legacy_code: 'net-1-C', asset: 'A', field: { ports: 4 } }, { legacy_code: 'net-1-C', asset: 'B', field: { ports: 4, part_number: 'I350T4V2' } },
    { legacy_code: 'net-10-G', asset: 'A', field: { ports: 2 } }, { legacy_code: 'net-10-G', asset: 'C', field: { ports: 4 } }] });
  const m = fc.mergeByCode(v.items);
  assert.deepEqual(m.map['net-1-C'].field, { ports: 4, part_number: 'I350T4V2' }); assert.deepEqual(m.map['net-1-C'].assets, ['A', 'B']);
  assert.deepEqual(m.conflicts, { 'net-10-G': ['ports'] });
});

test('스캔 결과 → field 항목: 모델이 실제로 일치한 짝만, 시리얼 미포함', () => {
  const mm = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
  const comparison = { matched: [
      { _type: 'network', registered_items: [{ model: 'Mellanox Technologies MT2910 Family [ConnectX-7]', specification: '업체-네트워크-002' }],
        discovered_items: [{ model: 'Mellanox Technologies MT2910 Family [ConnectX-7]', ports: 1, card_part_number: 'MCX75310AAS-NEAT', card_serials_masked: ['MT23…'] }] },
      { _type: 'gpu', registered_items: [{ model: 'NVIDIA Corporation Device 2bb5 (rev a1)', specification: '코코링크-GPU-001' }],
        discovered_items: [{ model: 'NVIDIA Corporation Device 2bb5 (rev a1)', gpu_name: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', gpu_memory_gb: 96 }] }],
    mismatched: [{ _type: 'network', registered_items: [{ model: 'I350', specification: 'net-1-C' }], discovered_items: [{ model: 'X550', ports: 2 }] }] };
  const items = fc.scanToFieldItems(comparison, { modelsMatch: mm, asset: 'TPC-SV-X' });
  assert.equal(items.length, 2);                                        // 모델 불일치 짝(I350↔X550)은 제외
  assert.deepEqual(items[0].field, { part_number: 'MCX75310AAS-NEAT', ports: 1 });
  assert.ok(!JSON.stringify(items).includes('MT23'));
  const doc = fc.buildFieldDoc(items, 'scan', new Date('2026-10-24T00:00:00Z'));
  assert.equal(fc.validateFieldFile(doc).errors.length, 0);
  // 반영: 생성기에 넣으면 확정(high)
  const r = sc.generate({ module_type: 'gpu', model: 'NVIDIA Corporation Device 2bb5 (rev a1)', field: items[1].field });
  assert.equal(r.spec_code, 'GPU-RTXPRO6000-96G-PCIE'); assert.equal(r.confidence, 'high');
});
