const express = require('express');
const http = require('http');
const router = express.Router();
const { getDb } = require('../config/database');
const XLSX = require('xlsx');

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434', 10);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

// Build system prompt with DB stats and schema info
function buildSystemPrompt() {
  const db = getDb();

  // Gather stats
  const totalAssets = db.prepare('SELECT COUNT(*) as cnt FROM assets').get().cnt;
  const byType = db.prepare("SELECT asset_type, COUNT(*) as cnt FROM assets GROUP BY asset_type").all();
  const typeStr = byType.map(r => r.asset_type + ' ' + r.cnt + '개').join(', ');

  const rooms = db.prepare("SELECT name FROM server_rooms").all().map(r => r.name);
  const roomStr = rooms.join(', ') || '없음';

  const cpuCount = db.prepare("SELECT COUNT(DISTINCT model) as cnt FROM computing_modules WHERE module_type='cpu'").get().cnt;
  const memCount = db.prepare("SELECT COUNT(DISTINCT model) as cnt FROM computing_modules WHERE module_type='memory'").get().cnt;
  const gpuCount = db.prepare("SELECT COUNT(DISTINCT model) as cnt FROM computing_modules WHERE module_type='gpu'").get().cnt;
  const diskCount = db.prepare("SELECT COUNT(DISTINCT model) as cnt FROM computing_modules WHERE module_type='disk'").get().cnt;

  const activeAssets = db.prepare("SELECT COUNT(*) as cnt FROM assets WHERE status='active'").get().cnt;
  const rackCount = db.prepare("SELECT COUNT(*) as cnt FROM racks").get().cnt;

  return `당신은 IT 자산 관리 시스템의 AI 어시스턴트입니다. 한국어로 답변하세요.

현재 시스템 현황:
- 총 자산: ${totalAssets}개 (${typeStr})
- 운영중 자산: ${activeAssets}개
- 서버실: ${roomStr}
- 랙: ${rackCount}개
- 부품 현황: CPU ${cpuCount}종, 메모리 ${memCount}종, GPU ${gpuCount}종, 디스크 ${diskCount}종

DB 테이블 스키마:
- assets: id, asset_number, management_number, asset_type('server','switch','pdu','ups','storage','other'), ownership('company','vendor'), vendor_id, model_name, manufacturer, serial_number, rack_id, rack_unit_start, rack_unit_size, parent_asset_id, blade_slot, ip_address, assigned_user, purpose, status('active','inactive','maintenance','decommissioned'), purchase_date, warranty_end, notes, room_id
- computing_modules: id, asset_id, module_type('cpu','memory','disk','network','raid','gpu','psu'), model, manufacturer, capacity, count, specification, slot_info, notes, owner, owner_vendor_id, is_onboard
- server_rooms: id, name, location, description, location_type('server_room','office','storage')
- racks: id, room_id, name, total_units, row_position, col_position, description
- module_inventory: id, module_type, item_code(UNIQUE), label, manufacturer, model, capacity, specification, total_quantity, in_use_quantity, spare_quantity, storage_quantity, asset_number
- asset_ips: id, asset_id, ip_address, ip_type('management','bmc','ib','data'), description, interface_type, speed
- network_connections: id, room_id, from_asset_id, from_port, to_asset_id, to_port, cable_type, cable_label, speed, status
- power_nodes: id, room_id, parent_id, node_type('main_panel','sub_panel','hvac','pdu','ups'), name, capacity_kw
- vendor_info: id, vendor_name, contact_person, contact_email, contact_phone
- lendings: id, direction('outbound','inbound'), counterparty, loan_date, return_date, status('active','returned')

## 출력 규칙

차트, 엑셀, SQL이 필요하면 반드시 아래 형식의 코드 블록을 사용하세요. 코드 블록 언어 태그가 정확해야 합니다.
설명 텍스트와 코드 블록을 함께 출력하세요. 코드 블록만 출력하지 마세요.

### 차트 (\`\`\`chart)
\`\`\`chart 블록 안에 Chart.js config를 유효한 JSON으로 작성하세요. 주석, trailing comma 금지. 데이터를 직접 포함하세요.

예시:
\`\`\`chart
{"type":"bar","data":{"labels":["server","switch","storage"],"datasets":[{"label":"자산 수","data":[10,5,3],"backgroundColor":["#2563eb","#16a34a","#f59e0b"]}]},"options":{"responsive":true,"plugins":{"legend":{"display":false}}}}
\`\`\`

### 엑셀 (\`\`\`excel)
\`\`\`excel 블록 안에 JSON으로 작성하세요.

예시:
\`\`\`excel
{"headers":["이름","유형","상태"],"rows":[["서버1","server","active"],["스위치1","switch","active"]],"filename":"자산목록"}
\`\`\`

### SQL (\`\`\`sql)
\`\`\`sql 블록 안에 SELECT 쿼리만 작성하세요.

예시:
\`\`\`sql
SELECT asset_type, COUNT(*) as cnt FROM assets WHERE status='active' GROUP BY asset_type
\`\`\`

중요:
- 차트 데이터는 현재 시스템 현황의 실제 숫자를 사용하세요.
- SQL 쿼리 작성 시 위의 테이블 스키마를 정확히 따르세요.
- 코드 블록은 반드시 \`\`\`chart, \`\`\`excel, \`\`\`sql 태그를 사용하세요. \`\`\`json이나 \`\`\`javascript를 사용하면 안 됩니다.`;
}

// GET /chat — render chat page
router.get('/', (req, res) => {
  const db = getDb();
  const totalAssets = db.prepare('SELECT COUNT(*) as cnt FROM assets').get().cnt;
  const byType = db.prepare("SELECT asset_type, COUNT(*) as cnt FROM assets GROUP BY asset_type").all();
  const activeAssets = db.prepare("SELECT COUNT(*) as cnt FROM assets WHERE status='active'").get().cnt;
  const rooms = db.prepare("SELECT name FROM server_rooms").all();
  const rackCount = db.prepare("SELECT COUNT(*) as cnt FROM racks").get().cnt;
  const moduleStats = db.prepare("SELECT module_type, COUNT(DISTINCT model) as cnt FROM computing_modules GROUP BY module_type").all();

  res.render('chat/index', {
    title: 'AI 채팅',
    currentPath: '/chat',
    extraCss: 'chat.css',
    extraJs: null,
    stats: {
      totalAssets,
      activeAssets,
      byType,
      rooms,
      rackCount,
      moduleStats
    }
  });
});

// POST /chat/stream — SSE streaming endpoint
router.post('/stream', (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const systemPrompt = buildSystemPrompt();

  // Prepend system message
  const ollamaMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.slice(-20) // Keep last 20 messages
  ];

  const postData = JSON.stringify({
    model: OLLAMA_MODEL,
    messages: ollamaMessages,
    stream: true
  });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const ollamaReq = http.request({
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: '/api/chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, (ollamaRes) => {
    let buffer = '';

    ollamaRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message && parsed.message.content) {
            res.write('data: ' + JSON.stringify({ content: parsed.message.content }) + '\n\n');
          }
          if (parsed.done) {
            res.write('data: [DONE]\n\n');
          }
        } catch (e) {
          // Skip malformed JSON lines
        }
      }
    });

    ollamaRes.on('end', () => {
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          if (parsed.message && parsed.message.content) {
            res.write('data: ' + JSON.stringify({ content: parsed.message.content }) + '\n\n');
          }
        } catch (e) {
          // ignore
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });

    ollamaRes.on('error', (err) => {
      res.write('data: ' + JSON.stringify({ error: 'Ollama 응답 오류: ' + err.message }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  ollamaReq.on('error', (err) => {
    res.write('data: ' + JSON.stringify({ error: 'Ollama 연결 실패: ' + err.message + '. Ollama가 실행 중인지 확인하세요.' }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  // Handle client disconnect
  req.on('close', () => {
    ollamaReq.destroy();
  });

  ollamaReq.write(postData);
  ollamaReq.end();
});

// POST /chat/query — execute read-only SQL
router.post('/query', (req, res) => {
  const { sql } = req.body;
  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: 'SQL 쿼리가 필요합니다.' });
  }

  // Only allow SELECT statements
  const trimmed = sql.trim();
  if (!/^SELECT\b/i.test(trimmed)) {
    return res.status(403).json({ error: 'SELECT 쿼리만 허용됩니다.' });
  }

  // Block dangerous keywords
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i;
  if (forbidden.test(trimmed)) {
    return res.status(403).json({ error: '허용되지 않는 SQL 키워드가 포함되어 있습니다.' });
  }

  try {
    const db = getDb();
    const rows = db.prepare(trimmed).all();
    const limited = rows.slice(0, 100);
    const columns = limited.length > 0 ? Object.keys(limited[0]) : [];
    res.json({ columns, rows: limited, totalRows: rows.length });
  } catch (err) {
    res.status(400).json({ error: 'SQL 실행 오류: ' + err.message });
  }
});

// POST /chat/excel — generate and download Excel file
router.post('/excel', (req, res) => {
  const { headers, rows, filename } = req.body;
  if (!Array.isArray(headers) || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'headers와 rows 배열이 필요합니다.' });
  }

  try {
    const wb = XLSX.utils.book_new();
    const data = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(data);

    // Auto-width columns
    ws['!cols'] = headers.map((h, i) => {
      let maxLen = h.length;
      rows.forEach(row => {
        const val = row[i] != null ? String(row[i]) : '';
        if (val.length > maxLen) maxLen = val.length;
      });
      return { wch: Math.min(maxLen + 2, 50) };
    });

    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fname = (filename || 'export') + '.xlsx';
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(fname) + '"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: '엑셀 생성 오류: ' + err.message });
  }
});

module.exports = router;
