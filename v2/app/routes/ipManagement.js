const express = require('express');
const router = express.Router();
const IpAddress = require('../models/ipAddress');
const Subnet = require('../models/subnet');
const Asset = require('../models/asset');
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');
const AuditLog = require('../models/auditLog');

// /24 CIDR 형식 검증 (B-6e: 우선 /24만 지원)
const CIDR24_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/;
function validCidr24(cidr) {
  const m = (cidr || '').trim().match(CIDR24_RE);
  if (!m) return null;
  const oct = [m[1], m[2], m[3]].map(Number);
  if (oct.some(o => o > 255)) return null;
  return m[1] + '.' + m[2] + '.' + m[3] + '.0/24';
}

// Initialize subnets on first access (guard: only runs if table empty)
let initialized = false;

router.use(async (req, res, next) => {
  if (!initialized) {
    await IpAddress.initializeSubnets();
    // syncAllAssets removed — §5: v2 EUL has no ip1~ip4/bmc/ib columns
    initialized = true;
  }
  next();
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
    const addresses = await IpAddress.findBySubnet(subnet);
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
    const cidr = validCidr24(req.body.cidr);

    if (!name || !cidr) {
      req.flash('error', '이름과 유효한 대역(예: 10.0.0.0/24)이 필요합니다.');
      return res.redirect('/ip-management');
    }
    if (!['office', 'hpc', 'aidc'].includes(network_zone)) {
      req.flash('error', '네트워크 구분(office/hpc/aidc)을 선택하세요.');
      return res.redirect('/ip-management');
    }
    // 중복/겹침: /24 단위라 동일 cidr = 겹침. subnets 테이블 + ip_addresses 풀 양쪽 확인
    if (await Subnet.findByCidr(cidr)) {
      req.flash('error', '이미 등록된 대역입니다: ' + cidr);
      return res.redirect('/ip-management');
    }
    const existingPool = await IpAddress.countByAllocation(cidr);
    if (existingPool.total > 0) {
      req.flash('error', '해당 대역의 IP 풀이 이미 존재합니다: ' + cidr);
      return res.redirect('/ip-management');
    }

    await IpAddress.createPool(cidr, network_zone);
    const id = await Subnet.create({ name, cidr, network_zone, description, created_by: req.session.username || null });
    await AuditLog.log(req, {
      action: 'create', targetType: 'subnet', targetId: id,
      targetLabel: name + ' (' + cidr + ')'
    });
    req.flash('success', '서브넷이 등록되었습니다: ' + cidr + ' (IP 풀 256개 생성)');
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
