const express = require('express');
const router = express.Router();
const appConfig = require('../config/app');
const { requireMaintenance } = require('../middleware/auth');

// Index - show both form options
router.get('/', (req, res) => {
  res.render('requests/index', {
    title: '신청서 작성',
    currentPath: '/requests',
    extraCss: null,
    extraJs: null,
    appConfig
  });
});

// Intake request form
router.get('/intake', (req, res) => {
  res.render('requests/intake', {
    title: '입고 신청서',
    currentPath: '/requests',
    extraCss: null,
    extraJs: null,
    appConfig
  });
});

// Setup/maintenance request form
router.get('/setup', (req, res) => {
  res.render('requests/setup', {
    title: '구축 요청서',
    currentPath: '/requests',
    extraCss: null,
    extraJs: null,
    appConfig
  });
});

// Parse conversational text into structured tasks
router.post('/parse-text', requireMaintenance, (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.json({ tasks: [] });

  const tasks = [];

  // Protect periods in IPs and version numbers before splitting
  let processed = text.replace(/(\d)\.(\d)/g, '$1\x00$2');
  const segments = processed.split(/[.。!\n]+/)
    .map(s => s.replace(/\x00/g, '.').trim())
    .filter(s => s.length > 1);

  // Also split on Korean conjunctions like "~하고," "~해주시고,"
  const finerSegments = [];
  for (const seg of segments) {
    const parts = seg.split(/(?:하고|해주시고|주시고|주고),\s*/).map(s => s.trim()).filter(s => s.length > 1);
    finerSegments.push(...parts);
  }

  for (const seg of finerSegments) {
    const foundTasks = parseSegment(seg);
    tasks.push(...foundTasks);
  }

  // If nothing was parsed, add the whole text as "other"
  if (tasks.length === 0 && text.length > 2) {
    tasks.push({ type: 'other', target: extractServer(text), source: '', detail: text, quantity: 1, notes: '' });
  }

  res.json({ tasks });
});

function parseSegment(s) {
  const results = [];
  const servers = extractAllServers(s);
  const mainTarget = servers[0] || '';
  let hwMatched = false;

  // OS installation
  const osMatch = s.match(/(Ubuntu|CentOS|Rocky\s*Linux?|RHEL|Red\s*Hat|Windows\s*Server?|Debian|AlmaLinux)\s*([\d.]*)/i);
  if (osMatch && /설치|인스톨|install|깔아|올려/i.test(s)) {
    results.push({
      type: 'os_install',
      target: mainTarget,
      source: '',
      detail: osMatch[1] + (osMatch[2] ? ' ' + osMatch[2] : ''),
      quantity: 1,
      notes: ''
    });
  }

  // IP configuration - filter out IPs that are part of OS version string
  const ipMatches = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g);
  if (ipMatches) {
    const osVersion = osMatch ? osMatch[2] : '';
    const realIps = ipMatches.filter(ip => ip !== osVersion && ip.split('.').length === 4);
    if (realIps.length > 0 && /IP|아이피|설정|config|세팅|으로|로\s/i.test(s)) {
      realIps.forEach(ip => {
        results.push({
          type: 'ip_config',
          target: mainTarget,
          source: '',
          detail: ip,
          quantity: 1,
          notes: ''
        });
      });
    }
  }

  // Hardware move: "서버X에서 Y를 빼서/꺼내서/옮겨서 서버Z에"
  if (/에서.*(빼|꺼내|분리|이동|옮|제거|떼)/.test(s) || /이동|옮겨|옮기/.test(s)) {
    const hw = extractHardware(s);
    const qty = extractQuantity(s);
    if (hw) {
      results.push({
        type: 'hw_move',
        target: servers.length > 1 ? servers[1] : mainTarget,
        source: servers[0] || '',
        detail: hw,
        quantity: qty,
        notes: ''
      });
      hwMatched = true;
    }
  }

  // Hardware replace
  if (!hwMatched && /(교체|교환|바꿔|변경|업그레이드)/.test(s)) {
    const hw = extractHardware(s);
    const qty = extractQuantity(s);
    if (hw) {
      results.push({
        type: 'hw_replace',
        target: mainTarget,
        source: '',
        detail: hw,
        quantity: qty,
        notes: ''
      });
      hwMatched = true;
    }
  }

  // Hardware install/add (only if not already matched as move/replace and not an OS install)
  if (!hwMatched && /(장착|추가|부착|삽입|꽂아|넣어|달아|증설)/.test(s)) {
    const hw = extractHardware(s);
    const qty = extractQuantity(s);
    if (hw) {
      const source = /재고|장비실|여분|남는|보관/.test(s) ? '장비실 재고' : '';
      results.push({
        type: 'hw_install',
        target: mainTarget,
        source: source,
        detail: hw,
        quantity: qty,
        notes: ''
      });
      hwMatched = true;
    }
  }

  // Cable work
  if (!hwMatched && /(케이블|랜선|광케이블|UTP|광선|인터넷선)/.test(s) && /(정리|연결|작업|교체|설치|뽑아|꽂아)/.test(s)) {
    results.push({ type: 'cable', target: mainTarget, source: '', detail: s, quantity: 1, notes: '' });
  }

  // Rack mount
  if (!hwMatched && /(랙|마운트|탑재)/.test(s) && /(장착|설치|마운트|해체|분리|올려|내려)/.test(s)) {
    results.push({ type: 'rack_mount', target: mainTarget, source: '', detail: s, quantity: 1, notes: '' });
  }

  // If nothing matched for this segment but it seems meaningful
  if (results.length === 0 && s.length > 5) {
    if (/(해주|부탁|요청|확인|점검|테스트|해 주)/.test(s)) {
      results.push({ type: 'other', target: mainTarget, source: '', detail: s, quantity: 1, notes: '' });
    }
  }

  return results;
}

function extractServer(text) {
  const patterns = [
    /서버\s*[#]?([A-Za-z0-9가-힣][\w\-]*)/,
    /([A-Za-z]\-?\d+[\-\w]*)\s*서버/,
    /([A-Za-z]+\-\d+[\-\w]*)/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return '';
}

function extractAllServers(text) {
  const results = [];
  const seen = new Set();
  const regex = /서버\s*[#]?([A-Za-z0-9가-힣][\w\-]*)|([A-Za-z]\-?\d+[\-\w]*)\s*서버|(?:^|\s)([A-Za-z]+\-\d+[\-\w]*)(?:\s|$|에|의|를|을|로|으로|에서|까지)/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const v = (m[1] || m[2] || m[3] || '').trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      results.push(v);
    }
  }
  return results;
}

function extractHardware(text) {
  const hwPatterns = [
    { regex: /(?:GPU|그래픽\s*카드?)\s*([\w\-\.\/\s]*)/i, prefix: 'GPU' },
    { regex: /(?:CPU|프로세서)\s*([\w\-\.\/\s]*)/i, prefix: 'CPU' },
    { regex: /(?:메모리|RAM|DIMM|DDR[45]?)\s*([\w\-\.\/\s]*)/i, prefix: '메모리' },
    { regex: /(?:SSD)\s*([\w\-\.\/\s]*)/i, prefix: 'SSD' },
    { regex: /(?:HDD|하드)\s*([\w\-\.\/\s]*)/i, prefix: 'HDD' },
    { regex: /(?:NVMe)\s*([\w\-\.\/\s]*)/i, prefix: 'NVMe' },
    { regex: /(?:디스크)\s*([\w\-\.\/\s]*)/i, prefix: '디스크' },
    { regex: /(?:NIC|네트워크\s*카드?|랜\s*카드?)\s*([\w\-\.\/\s]*)/i, prefix: 'NIC' },
    { regex: /(?:RAID|레이드)\s*([\w\-\.\/\s]*)/i, prefix: 'RAID' },
    { regex: /(?:PSU|파워|전원\s*공급)\s*([\w\-\.\/\s]*)/i, prefix: 'PSU' }
  ];

  for (const { regex, prefix } of hwPatterns) {
    const m = text.match(regex);
    if (m) {
      let spec = (m[1] || '').trim();
      // Clean up trailing Korean particles/verbs
      spec = spec.replace(/\s*(을|를|에|에서|으로|로|이|가|는|은|도|장착|추가|설치|이동|옮|빼|꺼내|교체|부착|삽입|꽂|분리|제거|해주|해줘|부탁|합니다|하고|해서).*$/g, '').trim();
      return prefix + (spec ? ' ' + spec : '');
    }
  }
  return '';
}

function extractQuantity(text) {
  const m = text.match(/(\d+)\s*(개|장|대|ea|EA|매|벌|세트|쌍)/);
  if (m) return parseInt(m[1]);
  return 1;
}

module.exports = router;
