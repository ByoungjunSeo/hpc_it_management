const express = require('express');
const router = express.Router();
const IpAddress = require('../models/ipAddress');
const Subnet = require('../models/subnet');
const Asset = require('../models/asset');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// B-6e: CIDR /16~/30 검증. 반환 { ok, cidr, size, error }
const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
function parseCidr(input) {
  const m = (input || '').trim().match(CIDR_RE);
  if (!m) return { ok: false, error: 'CIDR 형식이 아닙니다 (예: 10.100.60.0/24).' };
  const oct = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = parseInt(m[5], 10);
  if (oct.some(o => o > 255)) return { ok: false, error: 'IP 옥텟은 0~255여야 합니다.' };
  if (prefix < 16 || prefix > 30) return { ok: false, error: '지원 범위 /16~/30 입니다.' };
  const cidr = oct.join('.') + '/' + prefix;
  // 네트워크 주소 정렬 검사
  const range = IpAddress.cidrRange(cidr);
  if (IpAddress.ipToInt(oct.join('.')) !== range.firstInt) {
    const f = range.firstInt;
    const alignedIp = [(f >>> 24) & 255, (f >>> 16) & 255, (f >>> 8) & 255, f & 255].join('.');
    return { ok: false, error: '네트워크 주소가 아닙니다. ' + alignedIp + '/' + prefix + ' 를 의도했는지 확인하세요.' };
  }
  return { ok: true, cidr, size: range.size };
}

// Initialize subnets on first access (guard: only runs if table empty)
let initialized = false;

router.use(async (req, res, next) => {
  try {
    if (!initialized) {
      await IpAddress.initializeSubnets();
      // syncAllAssets removed — §5: v2 EUL has no ip1~ip4/bmc/ib columns
      initialized = true;
    }
    next();
  } catch (err) {
    // B-6e-fix: 초기화 실패가 미처리 rejection으로 프로세스를 죽이던 경로 — next(err)로 수렴
    next(err);
  }
});

// IP dashboard — B-6e: subnets 테이블 기반 동적 섹션 (풀 집계 조인)
router.get('/', async (req, res, next) => {
  try {
    const subnets = await Subnet.findAllWithStats();
    const totalStats = await IpAddress.getTotalStats();
    res.render('ip-management/index', {
      title: 'IP 관리',
      currentPath: '/ip-management',
      extraCss: 'ip-management.css',
      extraJs: null,
      subnets,
      totalStats,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// Subnet detail — B-6e: subnets 테이블 기반 (UI 등록 서브넷도 상세 접근)
router.get('/subnet/:subnet', async (req, res, next) => {
  try {
    const subnet = decodeURIComponent(req.params.subnet);
    const row = await Subnet.findByCidr(subnet);
    if (!row) {
      req.flash('error', '서브넷을 찾을 수 없습니다.');
      return res.redirect('/ip-management');
    }
    const subnetConfig = { subnet: row.cidr, label: row.name, zone: row.network_zone };
    // B-6e: /24 초과 대역은 블록 페이지네이션 (그리드는 256칸/블록 재사용)
    const blocks = IpAddress.blocksOf(row.cidr);
    const currentBlock = (req.query.block && blocks.includes(req.query.block))
      ? req.query.block
      : (blocks.length > 1 ? blocks[0] : null);
    const addresses = await IpAddress.findBySubnet(subnet, currentBlock);
    const assets = await Asset.findAll();
    res.render('ip-management/subnet', {
      title: row.name,
      currentPath: '/ip-management',
      extraCss: 'ip-management.css',
      extraJs: 'ip-grid.js',
      subnet,
      subnetConfig,
      addresses,
      assets,
      blocks: blocks.length > 1 ? blocks : null,
      currentBlock,
      appConfig
    });
  } catch (err) {
    next(err);
  }
});

// B-6e: 서브넷 등록 (풀 자동 생성)
router.post('/subnets', requireMaintenance, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const network_zone = (req.body.network_zone || '').trim();
    const description = (req.body.description || '').trim() || null;

    if (!name) {
      req.flash('error', '이름이 필요합니다.');
      return res.redirect('/ip-management');
    }
    if (!['office', 'hpc', 'aidc'].includes(network_zone)) {
      req.flash('error', '네트워크 구분(office/hpc/aidc)을 선택하세요.');
      return res.redirect('/ip-management');
    }
    const parsed = parseCidr(req.body.cidr);
    if (!parsed.ok) {
      req.flash('error', parsed.error);
      return res.redirect('/ip-management');
    }
    const cidr = parsed.cidr;

    // 중복: 동일 cidr
    if (await Subnet.findByCidr(cidr)) {
      req.flash('error', '이미 등록된 대역입니다: ' + cidr);
      return res.redirect('/ip-management');
    }
    // 겹침: 기존 등록 대역과 IP 범위 교차 검사 (prefix 달라도)
    const all = await Subnet.findAllWithStats();
    const clash = all.find(s => IpAddress.cidrsOverlap(cidr, s.cidr));
    if (clash) {
      req.flash('error', '기존 대역과 범위가 겹칩니다: ' + clash.cidr + ' (' + clash.name + ')');
      return res.redirect('/ip-management');
    }

    await IpAddress.createPool(cidr, network_zone);
    const id = await Subnet.create({ name, cidr, network_zone, description, created_by: req.session.username || null });
    await AuditLog.log(req, {
      action: 'create', targetType: 'subnet', targetId: id,
      targetLabel: name + ' (' + cidr + ')'
    });
    req.flash('success', '서브넷이 등록되었습니다: ' + cidr + ' (IP 풀 ' + parsed.size + '개 생성)');
    res.redirect('/ip-management');
  } catch (err) {
    req.flash('error', '서브넷 등록 실패: ' + err.message);
    res.redirect('/ip-management');
  }
});

// B-6e: 서브넷 삭제 (assigned 존재 시 차단, reserved는 프론트 고지 후 진행)
router.post('/subnets/:id/delete', requireMaintenance, async (req, res) => {
  try {
    const subnet = await Subnet.findById(req.params.id);
    if (!subnet) {
      req.flash('error', '서브넷을 찾을 수 없습니다.');
      return res.redirect('/ip-management');
    }
    const counts = await IpAddress.countByAllocation(subnet.cidr);
    if (counts.assigned > 0) {
      req.flash('error', '삭제 불가: 이 대역에 할당된 IP ' + counts.assigned + '개가 있습니다. 먼저 반납하세요.');
      return res.redirect('/ip-management');
    }
    await IpAddress.deletePool(subnet.cidr);
    await Subnet.delete(subnet.id);
    await AuditLog.log(req, {
      action: 'delete', targetType: 'subnet', targetId: subnet.id,
      targetLabel: subnet.name + ' (' + subnet.cidr + ')' + (counts.reserved > 0 ? ' [예약 ' + counts.reserved + '개 포함]' : '')
    });
    req.flash('success', '서브넷이 삭제되었습니다: ' + subnet.cidr);
    res.redirect('/ip-management');
  } catch (err) {
    req.flash('error', '서브넷 삭제 실패: ' + err.message);
    res.redirect('/ip-management');
  }
});

// Update IP allocation (API)
router.post('/ip/:ip', requireMaintenance, async (req, res) => {
  try {
    const ip = req.params.ip;
    const { allocation_type, asset_id, assigned_to, description } = req.body;

    if (allocation_type === 'available') {
      await IpAddress.release(ip);
    } else {
      await IpAddress.updateAllocation(ip, { allocation_type, asset_id, assigned_to, description });
    }

    await AuditLog.log(req, {
      action: 'update', targetType: 'ip', targetLabel: ip + ' → ' + allocation_type
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true });
    }
    req.flash('success', 'IP가 업데이트되었습니다.');
    res.redirect('back');
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ error: err.message });
    }
    req.flash('error', '업데이트 실패: ' + err.message);
    res.redirect('back');
  }
});

module.exports = router;
