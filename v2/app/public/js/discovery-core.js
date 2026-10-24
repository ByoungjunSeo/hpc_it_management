// discovery-core.js — v2.6.0 B-5a 추출
// /discovery 단일 장비 자산 매칭 흐름(스캔→비교→소유변경/분할→적용→미매칭)의 공용 모듈.
// Phase A (A) 최소 침습 추출: "옮기기 + 컨테이너 주입"만. 서버·요청 payload·로직 불변.
// 컨테이너/목록셀 결선은 consumer 리졸버로 주입하되, 기본값이 기존 /discovery 전역 id 조회라
// /discovery 동작은 100% 보존된다. 서버실 팝업(B-5b)이 두 번째 소비자가 된다.
(function () {
  // 스캔 결과 상태(원 index.ejs L317). 일괄 스캔(runBatchScan)도 window.scanResults로 공유.
  var scanResults = {};

  // 소비자 결선(기본값 = /discovery 전역 id). configure()/mount()로 교체 가능(B-5b).
  var consumer = {
    contentEl: function (assetId) { return document.getElementById('asset-detail-content-' + assetId); },
    detailRow: function (assetId) { return document.getElementById('asset-detail-' + assetId); },
    statusCell: function (assetId) { return document.getElementById('match-status-' + assetId); },  // B-5b: 목록 상태 셀(팝업=null)
    onApplied: function (assetId, result, data) {
      var regModCell = document.getElementById('registered-modules-' + assetId);
      if (regModCell) { regModCell.innerHTML = moduleSummaryHtml(data.discovered_modules).replace(/badge-info/g, 'badge-secondary'); }
      var statusCell = document.getElementById('match-status-' + assetId);
      if (statusCell) { statusCell.innerHTML = '<span class="badge badge-success">&#x2705; 갱신됨</span>'; }
      var dr = document.getElementById('asset-detail-' + assetId);
      if (dr) dr.style.display = 'none';
    }
  };

function escapeHtml(text) {
    var d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

// B-9: 읽기 전용 스캔 진단 안내(도구 없음·권한 없음·RAID 가상디스크 대체) — 해당할 때만, 줄마다 한 항목
function scanDiagnosticsHtml(data) {
    if (!data) return '';
    var lines = [];
    var miss = Array.isArray(data.missing_tools) ? data.missing_tools : [];
    var deny = Array.isArray(data.permission_denied) ? data.permission_denied : [];
    if (miss.length) lines.push('이 장비에 없는 도구: ' + miss.map(escapeHtml).join(', ') + ' — 해당 항목은 수집되지 않았습니다(스캔은 도구를 설치하지 않음).');
    if (deny.length) lines.push('권한 부족으로 읽지 못한 도구: ' + deny.map(escapeHtml).join(', ') + ' (sudo -n 실패 · 비밀번호 없는 sudo 또는 root 계정 필요)');
    if (data.virtual_disk_fallback) lines.push('물리 디스크 미확인(RAID 가상디스크) — 디스크 항목이 RAID 가상디스크 기준으로 수집되었습니다.');
    if (!lines.length) return '';
    return '<div class="scan-diag" style="margin-bottom:8px; padding:6px 10px; font-size:12px; background:var(--surface-warn); border:1px solid var(--line-warn); color:var(--on-warn); border-radius:4px;">' +
        lines.map(function(l) { return '<div>&#x26A0; ' + l + '</div>'; }).join('') + '</div>';
}

// v2.9 3a: 스캔으로 읽은 카드 정보(품번·포트 수·GPU 메모리) — 있을 때만 실제 모듈 칸에 한 줄
function cardInfoLine(m) {
    if (!m) return '';
    var parts = [];
    if (m.card_part_number) parts.push('카드 품번 ' + escapeHtml(m.card_part_number));
    else if (m.card_part_numbers && m.card_part_numbers.length) parts.push('카드 품번 ' + m.card_part_numbers.map(escapeHtml).join(', '));
    if (m.module_type === 'network' && m.ports) parts.push('포트 ' + escapeHtml(String(m.ports)));
    if (m.gpu_memory_gb) parts.push('메모리 ' + escapeHtml(String(m.gpu_memory_gb)) + 'GB' + (m.gpu_name ? ' (' + escapeHtml(m.gpu_name) + ')' : ''));
    if (!parts.length) return '';
    return '<div class="card-info-line text-muted" style="font-size:11px;">' + parts.join(' · ') + '</div>';
}

function moduleTypeBadge(type) {
    var labels = { cpu: 'CPU', memory: 'MEM', disk: 'DISK', network: 'NIC', raid: 'RAID', gpu: 'GPU', npu: 'NPU' };
    return labels[type] || type;
}

function moduleSummaryHtml(modules) {
    if (!modules || modules.length === 0) return '<span class="text-muted">-</span>';
    var group = {};
    modules.forEach(function(m) {
        var t = m.module_type;
        if (!group[t]) group[t] = 0;
        group[t] += (m.count || 1);
    });
    var html = '';
    Object.keys(group).forEach(function(t) {
        html += '<span class="badge badge-info" style="font-size:10px; margin:1px;">' + moduleTypeBadge(t) + ' ' + group[t] + '</span>';
    });
    return html;
}

function moduleTypeLabel(type) {
    var labels = { cpu: 'CPU', memory: '메모리', disk: '디스크', network: '네트워크', raid: 'RAID', gpu: 'GPU', npu: 'NPU' };
    return labels[type] || type;
}

function ownerDisplayName(mod) {
    if (mod.owner === 'vendor') {
        return mod.owner_vendor_name || '업체';
    }
    return 'TTA';
}

function buildVendorOptions(vendors, selectedOwner, selectedVendorId) {
    var html = '<option value="company"' + (selectedOwner !== 'vendor' ? ' selected' : '') + '>TTA</option>';
    if (vendors && vendors.length > 0) {
        vendors.forEach(function(v) {
            var sel = (selectedOwner === 'vendor' && selectedVendorId == v.id) ? ' selected' : '';
            html += '<option value="vendor_' + v.id + '"' + sel + '>' + escapeHtml(v.vendor_name) + '</option>';
        });
    }
    return html;
}

function scanAsset(assetId) {
    var btn = document.getElementById('scan-btn-' + assetId);
    var statusCell = document.getElementById('match-status-' + assetId);
    var discoveredCell = document.getElementById('discovered-count-' + assetId);

    btn.disabled = true;
    btn.textContent = '...';
    statusCell.innerHTML = '<span class="badge badge-info">&#x1F50D; 스캔중</span>';

    fetch('/discovery/scan-asset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: assetId })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
        scanResults[assetId] = data;
        btn.disabled = false;
        btn.textContent = '\u{1F50D}';

        if (data.status === 'success') {
            discoveredCell.innerHTML = moduleSummaryHtml(data.discovered_modules);

            // Status will be set by renderComparison via showDetail
            statusCell.innerHTML = '<span class="badge badge-success">&#x2705; 완료</span>';

            // Show detail button
            document.getElementById('detail-btn-' + assetId).style.display = '';
            // Auto-show detail (renderComparison will update status badge)
            showDetail(assetId);
        } else if (data.status === 'auth_failed') {
            discoveredCell.innerHTML = '<span class="text-muted">-</span>';
            statusCell.innerHTML = '<span class="badge badge-danger" title="인증 실패">&#x274C; 인증실패</span>';
        } else if (data.status === 'unreachable') {
            discoveredCell.innerHTML = '<span class="text-muted">-</span>';
            statusCell.innerHTML = '<span class="badge badge-danger" title="접속 불가">&#x274C; 접속불가</span>';
        } else {
            discoveredCell.innerHTML = '<span class="text-muted">-</span>';
            statusCell.innerHTML = '<span class="badge badge-danger" title="' + escapeHtml(data.error || '오류') + '">&#x274C; 오류</span>';
        }
    })
    .catch(function(err) {
        btn.disabled = false;
        btn.textContent = '\u{1F50D}';
        statusCell.innerHTML = '<span class="badge badge-danger">&#x274C; 오류</span>';
        console.error('Scan error:', err);
    });
}

// ── Show Detail Comparison Panel ──
function showDetail(assetId, forceRefresh) {
    var detailRow = consumer.detailRow(assetId);
    var content = consumer.contentEl(assetId);
    var data = scanResults[assetId];

    if (!data) {
        detailRow.style.display = 'none';
        return;
    }

    // Toggle visibility (unless force refresh e.g. after split)
    if (!forceRefresh && detailRow.style.display !== 'none' && content.innerHTML !== '') {
        detailRow.style.display = 'none';
        return;
    }

    var html = '';

    if (data.status !== 'success') {
        html = '<div class="alert alert-error" style="margin:0;">오류: ' + escapeHtml(data.error || '알 수 없는 오류') + '</div>';
        content.innerHTML = html;
        detailRow.style.display = '';
        return;
    }

    // System info summary
    var sysInfoParts = [];
    if (data.hostname) sysInfoParts.push('<strong>호스트명:</strong> ' + escapeHtml(data.hostname));
    if (data.totalMemory) sysInfoParts.push('<strong>총 메모리:</strong> ' + escapeHtml(data.totalMemory));
    if (data.osInfo) {
        var osStr = data.osInfo.name || '';
        if (data.osInfo.version) osStr += ' ' + data.osInfo.version;
        if (data.osInfo.kernel) osStr += ' (kernel: ' + data.osInfo.kernel + ')';
        if (osStr.trim()) sysInfoParts.push('<strong>OS:</strong> ' + escapeHtml(osStr.trim()));
    }
    if (data.serial) {
        if (data.serial.serial_number) sysInfoParts.push('<strong>S/N:</strong> ' + escapeHtml(data.serial.serial_number));
        if (data.serial.product_name) sysInfoParts.push('<strong>제품:</strong> ' + escapeHtml(data.serial.product_name));
    }
    if (sysInfoParts.length > 0) {
        html += '<div style="margin-bottom:12px; font-size:13px; line-height:1.8; display:flex; flex-wrap:wrap; gap:4px 16px;">';
        sysInfoParts.forEach(function(p) { html += '<span>' + p + '</span>'; });
        html += '</div>';
    }
    html += scanDiagnosticsHtml(data);   // B-9

    if (data.discovered_modules && data.discovered_modules.length > 0) {
        // Check if memory is fallback-only
        var discMem = data.discovered_modules.filter(function(m) { return m.module_type === 'memory'; });
        var isFallbackMem = discMem.length > 0 && discMem.every(function(m) {
            return (m.model && m.model.indexOf('상세정보 없음') >= 0) || m.specification === '/proc/meminfo';
        });
        if (isFallbackMem) {
            html += '<div style="padding:8px 12px; margin-bottom:8px; background:var(--surface-warn-strong); border:1px solid var(--line-warn); border-radius:6px; font-size:13px;">';
            html += '<strong>&#x26A0; 메모리 상세정보 없음:</strong> dmidecode 권한 부족으로 DIMM 정보를 수집할 수 없습니다. ';
            html += '갱신 시 <b>기존 등록된 메모리가 유지</b>됩니다. (root 계정 등록 후 재스캔 권장)';
            html += '</div>';
        }
        html += renderComparison(data, assetId);
    } else {
        html += '<p class="text-muted">수집된 모듈이 없습니다.</p>';
    }

    // Apply button + history button + raw output button
    html += '<div style="margin-top:12px; display:flex; justify-content:space-between; align-items:center;">';
    html += '<div class="btn-group">';
    html += '<button class="btn btn-outline" onclick="showTransferLogs(' + assetId + ')">이력 보기</button>';
    if (data.rawOutput) {
        html += '<button class="btn btn-outline" onclick="toggleRawOutput(' + assetId + ')">원본 보기</button>';
    }
    html += '</div>';
    if (data.discovered_modules && data.discovered_modules.length > 0) {
        html += '<button class="btn btn-success" onclick="applyAsset(' + assetId + ')">실제 모듈로 갱신</button>';
    }
    html += '</div>';

    // Raw output container
    if (data.rawOutput) {
        html += '<div id="raw-output-' + assetId + '" style="display:none; margin-top:12px;">';
        html += '<pre style="background:#1e1e1e; color:#d4d4d4; padding:12px; border-radius:6px; font-size:11px; max-height:400px; overflow:auto; white-space:pre-wrap; word-break:break-all;">' + escapeHtml(data.rawOutput) + '</pre>';
        html += '</div>';
    }

    // Transfer log container
    html += '<div id="transfer-logs-' + assetId + '" style="display:none; margin-top:12px;"></div>';

    content.innerHTML = html;
    detailRow.style.display = '';
}

function normalizeModelClient(model) {
    return (model || '').toLowerCase().trim().replace(/\s*x\d+\s*$/, '').replace(/\s+/g, ' ');
}

function modelsMatchClient(a, b) {
    var na = normalizeModelClient(a);
    var nb = normalizeModelClient(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    return na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0;
}

function buildUnifiedRows(data) {
    var reg = (data.registered_modules || []).slice();
    var disc = data.discovered_modules || [];
    var rows = [];
    var usedDisc = {};
    var unmatchedReg = [];
    var typeOrder = {cpu:0, memory:1, disk:2, network:3, raid:4, gpu:5, npu:6};

    reg.sort(function(a,b) { return (typeOrder[a.module_type]||99) - (typeOrder[b.module_type]||99); });

    reg.forEach(function(r) {
        var bestIdx = -1;
        var bestExact = false;
        for (var i = 0; i < disc.length; i++) {
            if (usedDisc[i]) continue;
            if (disc[i].module_type !== r.module_type) continue;
            if (modelsMatchClient(r.model, disc[i].model)) {
                var exact = normalizeModelClient(r.model) === normalizeModelClient(disc[i].model);
                if (bestIdx < 0 || (exact && !bestExact)) {
                    bestIdx = i;
                    bestExact = exact;
                }
            }
        }
        if (bestIdx >= 0) {
            usedDisc[bestIdx] = true;
            var countMatch = (r.count || 1) === (disc[bestIdx].count || 1);
            rows.push({ type: r.module_type, reg: r, disc: disc[bestIdx], discIdx: bestIdx, status: countMatch ? 'matched' : 'mismatched' });
        } else {
            unmatchedReg.push(r);
        }
    });

    // Collect unmatched discovered per type
    var unmatchedDiscByType = {};
    disc.forEach(function(d, i) {
        if (!usedDisc[i]) {
            if (!unmatchedDiscByType[d.module_type]) unmatchedDiscByType[d.module_type] = [];
            unmatchedDiscByType[d.module_type].push({ d: d, idx: i });
        }
    });

    // Pair unmatched registered with unmatched discovered of same type → mismatched
    var usedUnmatchedDisc = {};
    unmatchedReg.forEach(function(r) {
        var pool = unmatchedDiscByType[r.module_type] || [];
        var found = false;
        for (var j = 0; j < pool.length; j++) {
            if (usedUnmatchedDisc[pool[j].idx]) continue;
            usedUnmatchedDisc[pool[j].idx] = true;
            rows.push({ type: r.module_type, reg: r, disc: pool[j].d, discIdx: pool[j].idx, status: 'mismatched' });
            found = true;
            break;
        }
        if (!found) {
            rows.push({ type: r.module_type, reg: r, disc: null, discIdx: -1, status: 'missing' });
        }
    });

    // Remaining discovered-only modules
    disc.forEach(function(d, i) {
        if (!usedDisc[i] && !usedUnmatchedDisc[i]) {
            rows.push({ type: d.module_type, reg: null, disc: d, discIdx: i, status: 'extra' });
        }
    });

    rows.sort(function(a,b) { return (typeOrder[a.type]||99) - (typeOrder[b.type]||99); });
    return rows;
}

function formatModuleInfo(model, capacity, spec, manufacturer, moduleType) {
    var lines = [];
    lines.push('<strong style="font-size:12px;">' + escapeHtml(model || '-') + '</strong>');
    if (manufacturer) {
        lines.push('<span style="color:#555; font-size:11px;">제조사: <b>' + escapeHtml(manufacturer) + '</b></span>');
    }
    if (capacity) {
        lines.push('<span style="color:#555; font-size:11px;">용량: <b>' + escapeHtml(capacity) + '</b></span>');
    }
    if (spec) {
        lines.push('<code style="font-size:11px;">' + escapeHtml(spec) + '</code>');
    }
    return lines.join('<br>');
}

function formatRegisteredModuleInfo(mod) {
    var lines = [];
    if (mod.linked_item_code) {
        var label = mod.linked_item_label || mod.model || '';
        lines.push('<a href="javascript:void(0)" onclick="showInventoryDetail(\'' + escapeHtml(mod.linked_item_code) + '\')" style="font-size:12px; font-weight:600; color:var(--primary, #0066cc); text-decoration:underline; cursor:pointer;">' + escapeHtml(mod.linked_item_code) + '</a> <span style="font-size:11px; color:#555;">(' + escapeHtml(label) + ')</span>');
    } else {
        lines.push('<span class="badge badge-secondary" style="font-size:10px; background:var(--surface-strong); color:var(--text-secondary, #666);">코드없음</span> <strong style="font-size:12px;">' + escapeHtml(mod.model || '-') + '</strong>');
    }
    if (mod.manufacturer) {
        lines.push('<span style="color:#555; font-size:11px;">제조사: <b>' + escapeHtml(mod.manufacturer) + '</b></span>');
    }
    if (mod.capacity) {
        lines.push('<span style="color:#555; font-size:11px;">용량: <b>' + escapeHtml(mod.capacity) + '</b></span>');
    }
    return lines.join('<br>');
}

function showInventoryDetail(itemCode) {
    fetch('/discovery/inventory-detail/' + encodeURIComponent(itemCode))
    .then(function(r) { return r.json(); })
    .then(function(data) {
        if (data.error) { alert('조회 오류: ' + data.error); return; }
        var item = data.item;
        var usage = data.usage || [];

        var old = document.getElementById('inventoryDetailModal');
        if (old) old.remove();

        var overlay = document.createElement('div');
        overlay.id = 'inventoryDetailModal';
        overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center;';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:var(--bg-primary, #fff); border-radius:8px; padding:24px; max-width:650px; width:95%; max-height:80vh; overflow-y:auto; box-shadow:0 8px 32px rgba(0,0,0,0.3);';

        var html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">';
        html += '<h3 style="margin:0;"><code style="color:var(--primary);">' + escapeHtml(item.item_code) + '</code> 상세 정보</h3>';
        html += '<button class="btn btn-sm btn-outline" onclick="document.getElementById(\'inventoryDetailModal\').remove()">&times;</button>';
        html += '</div>';

        html += '<table style="width:100%; font-size:13px; border-collapse:collapse; margin-bottom:16px;">';
        html += '<tbody>';
        html += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 8px; font-weight:600; width:100px; color:var(--text-secondary);">유형</td><td style="padding:6px 8px;"><span class="badge badge-secondary">' + moduleTypeLabel(item.module_type) + '</span></td></tr>';
        html += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 8px; font-weight:600; color:var(--text-secondary);">라벨</td><td style="padding:6px 8px;">' + escapeHtml(item.label || '-') + '</td></tr>';
        html += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 8px; font-weight:600; color:var(--text-secondary);">모델</td><td style="padding:6px 8px;">' + escapeHtml(item.model || '-') + '</td></tr>';
        html += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 8px; font-weight:600; color:var(--text-secondary);">제조사</td><td style="padding:6px 8px;">' + escapeHtml(item.manufacturer || '-') + '</td></tr>';
        html += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 8px; font-weight:600; color:var(--text-secondary);">용량</td><td style="padding:6px 8px;">' + escapeHtml(item.capacity || '-') + '</td></tr>';
        if (item.specification) {
            html += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 8px; font-weight:600; color:var(--text-secondary);">사양</td><td style="padding:6px 8px;">' + escapeHtml(item.specification) + '</td></tr>';
        }
        html += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px 8px; font-weight:600; color:var(--text-secondary);">수량</td><td style="padding:6px 8px;">';
        html += '총 <b>' + item.total_quantity + '</b> / 사용중 <b>' + item.in_use_quantity + '</b> / 여유 <b>' + item.spare_quantity + '</b> / 보관 <b>' + item.storage_quantity + '</b>';
        html += '</td></tr>';
        html += '</tbody></table>';

        if (usage.length > 0) {
            html += '<h4 style="margin:0 0 8px; font-size:13px;">사용중인 자산 (' + usage.length + '건)</h4>';
            html += '<table style="width:100%; font-size:12px; border-collapse:collapse;">';
            html += '<thead><tr style="border-bottom:2px solid var(--border);"><th style="padding:4px 6px;">관리번호</th><th style="padding:4px 6px;">모델</th><th style="padding:4px 6px;">수량</th><th style="padding:4px 6px;">위치</th></tr></thead><tbody>';
            usage.forEach(function(u) {
                html += '<tr style="border-bottom:1px solid var(--border);">';
                html += '<td style="padding:4px 6px;"><a href="/assets" target="_blank">' + escapeHtml(u.management_number || '-') + '</a></td>';
                html += '<td style="padding:4px 6px;">' + escapeHtml(u.model_name || '-') + '</td>';
                html += '<td style="padding:4px 6px; text-align:center;">' + (u.count || 1) + '</td>';
                html += '<td style="padding:4px 6px;">' + escapeHtml(u.location || '-') + '</td>';
                html += '</tr>';
            });
            html += '</tbody></table>';
        } else {
            html += '<p class="text-muted" style="font-size:13px;">사용중인 자산이 없습니다.</p>';
        }

        modal.innerHTML = html;
        overlay.appendChild(modal);
        overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    })
    .catch(function(err) { alert('조회 오류: ' + err.message); });
}

function renderComparison(data, assetId) {
    var vendors = data.vendors || [];
    var defaultOwner = (data.asset_ownership === 'vendor') ? 'vendor' : 'company';
    var defaultVendorId = (data.asset_ownership === 'vendor') ? data.asset_vendor_id : null;

    // Assign default owner to discovered modules
    (data.discovered_modules || []).forEach(function(m, idx) {
        if (!m.owner) { m.owner = defaultOwner; m.owner_vendor_id = defaultVendorId; }
        m._idx = idx;
    });

    var rows = buildUnifiedRows(data);

    var html = '<table style="width:100%; font-size:13px; border-collapse:collapse;" id="compare-table-' + assetId + '">';
    html += '<thead><tr style="border-bottom:2px solid var(--border);">';
    html += '<th style="width:28px; text-align:center;">#</th>';
    html += '<th style="width:50px;">유형</th>';
    html += '<th style="border-right:2px solid var(--border);">등록 모듈</th>';
    html += '<th style="width:36px; text-align:center;">수량</th>';
    html += '<th style="width:56px; text-align:center;">설치</th>';
    html += '<th style="border-right:2px solid var(--border);">실제 모듈</th>';
    html += '<th style="width:36px; text-align:center;">수량</th>';
    html += '<th style="width:90px;">소유자</th>';
    html += '<th style="width:36px; text-align:center;"></th>';
    html += '</tr></thead><tbody>';

    var matchCount = 0, mismatchCount = 0, missingCount = 0, extraCount = 0;

    rows.forEach(function(row, idx) {
        var rowStyle = 'border-bottom:1px solid var(--border);';
        var statusIcon = '';
        if (row.status === 'matched') { statusIcon = '&#x2705;'; matchCount++; }
        else if (row.status === 'mismatched') { statusIcon = '&#x26A0;&#xFE0F;'; rowStyle += 'background:rgba(255,193,7,0.08);'; mismatchCount++; }
        else if (row.status === 'missing') { statusIcon = '&#x274C;'; rowStyle += 'background:rgba(220,53,69,0.08);'; missingCount++; }
        else if (row.status === 'extra') { statusIcon = '&#x1F195;'; rowStyle += 'background:rgba(0,123,255,0.08);'; extraCount++; }

        html += '<tr style="' + rowStyle + '">';
        html += '<td style="text-align:center; color:var(--text-secondary); font-size:11px;">' + (idx + 1) + '</td>';
        html += '<td><span class="badge badge-secondary">' + moduleTypeLabel(row.type) + '</span></td>';

        // Registered module info
        if (row.reg) {
            var regOwnerBadge = '';
            if (row.reg.owner === 'vendor') {
                var vName = row.reg.owner_vendor_name || '업체';
                regOwnerBadge = '<span class="badge badge-warning" style="font-size:10px;">' + escapeHtml(vName) + '</span>';
            } else {
                regOwnerBadge = '<span class="badge badge-success" style="font-size:10px;">자사</span>';
            }
            html += '<td style="border-right:2px solid var(--border); line-height:1.5;">' + formatRegisteredModuleInfo(row.reg) + ' ' + regOwnerBadge + '</td>';
            html += '<td style="text-align:center;">' + (row.reg.count || 1) + '</td>';
            var ib = row.reg.is_onboard ? '<span class="badge badge-secondary" style="font-size:10px;">온보드</span>' : '<span class="badge badge-info" style="font-size:10px;">애드온</span>';
            html += '<td style="text-align:center;">' + ib + '</td>';
        } else {
            html += '<td style="border-right:2px solid var(--border); color:var(--text-secondary);">-</td>';
            html += '<td style="text-align:center; color:var(--text-secondary);">-</td>';
            html += '<td style="text-align:center;">-</td>';
        }

        // Discovered module info
        if (row.disc) {
            html += '<td style="border-right:2px solid var(--border); line-height:1.5;">' + formatModuleInfo(row.disc.model, row.disc.capacity, row.disc.specification, row.disc.manufacturer, row.type) + cardInfoLine(row.disc) + '</td>';
            html += '<td style="text-align:center;" id="disc-count-' + assetId + '-' + row.discIdx + '">' + (row.disc.count || 1) + '</td>';
            var ownerVal = row.disc.owner === 'vendor' && row.disc.owner_vendor_id ? 'vendor_' + row.disc.owner_vendor_id : 'company';
            html += '<td><select class="form-control" style="font-size:11px; padding:1px 3px; min-width:70px;" ';
            html += 'onchange="changeModuleOwner(' + assetId + ',' + row.discIdx + ',this.value)">';
            html += buildVendorOptions(vendors, row.disc.owner, row.disc.owner_vendor_id);
            html += '</select></td>';
        } else {
            html += '<td style="border-right:2px solid var(--border); color:var(--text-secondary);">-</td>';
            html += '<td style="text-align:center; color:var(--text-secondary);">-</td>';
            html += '<td style="color:var(--text-secondary);">-</td>';
        }

        html += '<td style="text-align:center;">' + statusIcon + '</td>';
        html += '</tr>';
    });

    html += '</tbody></table>';

    // Summary
    var summary = [];
    if (matchCount > 0) summary.push('<span class="badge badge-success">&#x2705; 일치 ' + matchCount + '</span>');
    if (mismatchCount > 0) summary.push('<span class="badge badge-warning">&#x26A0;&#xFE0F; 불일치 ' + mismatchCount + '</span>');
    if (missingCount > 0) summary.push('<span class="badge badge-danger">&#x274C; 누락 ' + missingCount + '</span>');
    if (extraCount > 0) summary.push('<span class="badge badge-info">&#x1F195; 미등록 ' + extraCount + '</span>');
    if (summary.length > 0) {
        html += '<div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">' + summary.join('') + '</div>';
    }

    // Sync status badge with client-side comparison result (B-5b: consumer 리졸버로 스코프, 팝업=null→no-op)
    var statusCell = consumer.statusCell(assetId);
    if (statusCell) {
        if (mismatchCount === 0 && missingCount === 0 && extraCount === 0) {
            statusCell.innerHTML = '<span class="badge badge-success" title="일치">&#x2705; 일치</span>';
        } else {
            var parts = [];
            if (mismatchCount > 0) parts.push('불일치 ' + mismatchCount);
            if (missingCount > 0) parts.push('누락 ' + missingCount);
            if (extraCount > 0) parts.push('미등록 ' + extraCount);
            statusCell.innerHTML = '<span class="badge badge-warning" title="' + parts.join(', ') + '">&#x26A0;&#xFE0F; 불일치</span>';
        }
    }

    return html;
}

function renderDiscoveredModuleTable(data, assetId) {
    var modules = data.discovered_modules;
    var vendors = data.vendors || [];
    var defaultOwner = (data.asset_ownership === 'vendor') ? 'vendor' : 'company';
    var defaultVendorId = (data.asset_ownership === 'vendor') ? data.asset_vendor_id : null;

    if (!modules || modules.length === 0) return '<p class="text-muted">수집된 모듈이 없습니다.</p>';

    // Assign default owner to discovered modules that don't have one
    modules.forEach(function(m, idx) {
        if (!m.owner) {
            m.owner = defaultOwner;
            m.owner_vendor_id = defaultVendorId;
        }
        m._idx = idx;
    });

    var html = '<table style="width:100%; font-size:13px;" id="disc-table-' + assetId + '">';
    html += '<thead><tr><th>유형</th><th>모델</th><th>용량</th><th>사양</th><th>수량</th><th>소유자</th><th></th></tr></thead><tbody>';

    modules.forEach(function(m, idx) {
        var ownerVal = m.owner === 'vendor' && m.owner_vendor_id ? 'vendor_' + m.owner_vendor_id : 'company';
        html += '<tr id="disc-row-' + assetId + '-' + idx + '">';
        html += '<td><span class="badge badge-secondary">' + moduleTypeLabel(m.module_type) + '</span></td>';
        html += '<td>' + escapeHtml(m.model || '-') + '</td>';
        html += '<td>' + escapeHtml(m.capacity || '-') + '</td>';
        html += '<td>' + escapeHtml(m.specification || '-') + '</td>';
        html += '<td style="text-align:center;" id="disc-count-' + assetId + '-' + idx + '">' + (m.count || 1) + '</td>';
        html += '<td>';
        html += '<select class="form-control" style="font-size:12px; padding:2px 4px; min-width:90px;" ';
        html += 'onchange="changeModuleOwner(' + assetId + ',' + idx + ',this.value)">';
        html += buildVendorOptions(vendors, m.owner, m.owner_vendor_id);
        html += '</select>';
        html += '</td>';
        html += '<td style="text-align:center;">';
        if ((m.count || 1) > 1) {
            html += '<button class="btn btn-sm btn-outline" style="font-size:11px; padding:1px 6px;" onclick="splitModule(' + assetId + ',' + idx + ')" title="수량 분리">분리</button>';
        }
        html += '</td>';
        html += '</tr>';
    });

    html += '</tbody></table>';
    return html;
}

function changeModuleOwner(assetId, idx, val) {
    var data = scanResults[assetId];
    if (!data || !data.discovered_modules) return;
    var mod = data.discovered_modules[idx];
    if (!mod) return;

    if (val === 'company') {
        mod.owner = 'company';
        mod.owner_vendor_id = null;
    } else if (val.indexOf('vendor_') === 0) {
        mod.owner = 'vendor';
        mod.owner_vendor_id = parseInt(val.replace('vendor_', ''), 10);
    }
}

function splitModule(assetId, idx) {
    var data = scanResults[assetId];
    if (!data || !data.discovered_modules) return;
    var mod = data.discovered_modules[idx];
    if (!mod || (mod.count || 1) <= 1) return;

    var total = mod.count || 1;
    var splitCount = prompt('분리할 수량을 입력하세요 (1~' + (total - 1) + '):', '1');
    if (!splitCount) return;
    splitCount = parseInt(splitCount, 10);
    if (isNaN(splitCount) || splitCount < 1 || splitCount >= total) {
        alert('유효하지 않은 수량입니다. 1~' + (total - 1) + ' 사이 값을 입력하세요.');
        return;
    }

    // Create new module row with the split count
    var newMod = JSON.parse(JSON.stringify(mod));
    newMod.count = splitCount;
    newMod._idx = data.discovered_modules.length;

    // Reduce original count
    mod.count = total - splitCount;

    // Insert new module after the current one
    data.discovered_modules.splice(idx + 1, 0, newMod);

    // Re-render the detail panel (force refresh)
    showDetail(assetId, true);
}

function renderModuleTable(modules) {
    if (!modules || modules.length === 0) return '<p class="text-muted">수집된 모듈이 없습니다.</p>';
    var html = '<table style="font-size:13px;"><thead><tr><th>유형</th><th>모델</th><th>용량</th><th>수량</th><th>사양</th></tr></thead><tbody>';
    modules.forEach(function(m) {
        html += '<tr>';
        html += '<td><span class="badge badge-secondary">' + moduleTypeLabel(m.module_type) + '</span></td>';
        html += '<td>' + escapeHtml(m.model || '-') + '</td>';
        html += '<td>' + escapeHtml(m.capacity || '-') + '</td>';
        html += '<td>' + (m.count || 1) + '</td>';
        html += '<td>' + escapeHtml(m.specification || '-') + '</td>';
        html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
}

// ── Toggle Raw Output ──
function toggleRawOutput(assetId) {
    var container = document.getElementById('raw-output-' + assetId);
    if (!container) return;
    container.style.display = container.style.display === 'none' ? '' : 'none';
}

// ── Transfer Logs ──
function showTransferLogs(assetId) {
    var container = document.getElementById('transfer-logs-' + assetId);
    if (!container) return;

    // Toggle visibility
    if (container.style.display !== 'none') {
        container.style.display = 'none';
        return;
    }

    container.innerHTML = '<p class="text-muted">이력 로드중...</p>';
    container.style.display = '';

    fetch('/discovery/transfer-logs/' + assetId)
    .then(function(r) { return r.json(); })
    .then(function(result) {
        if (!result.logs || result.logs.length === 0) {
            container.innerHTML = '<p class="text-muted" style="font-size:13px;">이동 이력이 없습니다.</p>';
            return;
        }

        var html = '<h4 style="margin-bottom:8px; font-size:14px;">모듈 이동 이력</h4>';
        html += '<table style="width:100%; font-size:12px;">';
        html += '<thead><tr><th>날짜</th><th>모듈</th><th>수량</th><th>소유자</th><th>이전</th><th></th><th>이후</th><th>사유</th></tr></thead><tbody>';

        result.logs.forEach(function(log) {
            var fromLabel = log.from_asset_label || '-';
            var toLabel = log.to_asset_label || '-';
            var ownerLabel = log.owner === 'vendor' ? (log.owner_vendor_name || '업체') : 'TTA';
            var moduleLabel = moduleTypeLabel(log.module_type) + (log.model ? ' ' + log.model : '');

            html += '<tr>';
            html += '<td style="white-space:nowrap;">' + escapeHtml(log.transfer_date || log.created_at || '-') + '</td>';
            html += '<td>' + escapeHtml(moduleLabel) + '</td>';
            html += '<td style="text-align:center;">' + (log.count || 1) + '</td>';
            html += '<td>' + escapeHtml(ownerLabel) + '</td>';
            html += '<td>' + escapeHtml(fromLabel) + '</td>';
            html += '<td style="text-align:center;">&rarr;</td>';
            html += '<td>' + escapeHtml(toLabel) + '</td>';
            html += '<td>' + escapeHtml(log.reason || '-') + '</td>';
            html += '</tr>';
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    })
    .catch(function(err) {
        container.innerHTML = '<p class="text-muted" style="color:red;">이력 로드 오류: ' + escapeHtml(err.message) + '</p>';
    });
}

// ── Apply Asset ──
function applyAsset(assetId) {
    var data = scanResults[assetId];
    if (!data || !data.discovered_modules) return;

    if (!confirm('실제 수집된 모듈로 등록된 모듈을 갱신하시겠습니까?\n(소유자 정보가 함께 반영됩니다)')) return;

    // Prepare modules with owner info
    var modulesToSend = data.discovered_modules.map(function(m) {
        return {
            module_type: m.module_type,
            model: m.model,
            manufacturer: m.manufacturer,
            capacity: m.capacity,
            count: m.count || 1,
            specification: m.specification,
            slot_info: m.slot_info,
            notes: m.notes,
            owner: m.owner || 'company',
            owner_vendor_id: m.owner_vendor_id || null
        };
    });

    fetch('/discovery/apply-asset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            asset_id: assetId,
            modules: modulesToSend,
            expected_fingerprint: data.modules_fingerprint   // B-5b: 동시 적용 보호(스캔 시점 지문). undefined면 JSON에서 생략→기존 동작
        })
    })
    .then(function(r) { var st = r.status; return r.json().then(function(j) { j.__httpStatus = st; return j; }); })
    .then(function(result) {
        if (result.__httpStatus === 409) {
            // B-5b: 다른 곳에서 먼저 적용됨 → 재고·모듈 변화 0. 소비자가 onConflict를 주면 그쪽만(중복 알림 방지).
            if (consumer.onConflict) consumer.onConflict(assetId, result);
            else alert('다른 곳에서 먼저 적용되어 모듈 구성이 변경되었습니다. 다시 스캔하세요.');
            return;
        }
        if (result.success) {
            // B-5a: 목록 셀 갱신을 consumer.onApplied로 위임(기본값=기존 동작과 동일)
            consumer.onApplied(assetId, result, data);

            // Check for unmatched modules
            if (result.unmatched_modules && result.unmatched_modules.length > 0) {
                showUnmatchedModulesModal(result.unmatched_modules, assetId, (scanResults[assetId] || {}).asset_number || '');
            } else if (!consumer.silentSuccess) {
                alert('모듈이 갱신되었습니다. (소유자 정보 및 이력 포함)');
            }
        } else {
            alert('오류: ' + (result.error || '알 수 없는 오류'));
        }
    })
    .catch(function(err) { alert('오류: ' + err.message); });
}

// ── Unmatched Modules Modal (with link / register / skip options) ──
function showUnmatchedModulesModal(unmatchedModules, assetId, assetCode) {
    // Remove existing modal if any
    var old = document.getElementById('unmatchedModal');
    if (old) old.remove();

    var overlay = document.createElement('div');
    overlay.id = 'unmatchedModal';
    overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center;';

    var modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-primary, #fff); border-radius:8px; padding:24px; max-width:750px; width:95%; max-height:80vh; overflow-y:auto; box-shadow:0 8px 32px rgba(0,0,0,0.3);';

    var html = '<h3 style="margin:0 0 8px;">모듈 인벤토리 미매칭 항목' + (assetCode ? ' — ' + escapeHtml(assetCode) : '') + '</h3>';
    html += '<p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">';
    html += '아래 모듈은 인벤토리에 정확히 일치하는 항목이 없습니다.<br>';
    html += '각 항목별로 처리 방법을 선택해주세요.</p>';

    // Store modules globally for modal use
    window._unmatchedItems = unmatchedModules;
    window._unmatchedAssetId = assetId;

    // Fetch next code info for each unique module_type
    var typeSet = {};
    unmatchedModules.forEach(function(m) { typeSet[m.module_type] = true; });

    unmatchedModules.forEach(function(m, idx) {
        var hasCandidates = m.candidates && m.candidates.length > 0;

        html += '<div style="border:1px solid var(--border); border-radius:6px; padding:12px; margin-bottom:12px;">';
        // Header: type badge + model info
        html += '<div style="margin-bottom:8px; font-weight:600; font-size:13px;">';
        html += '<span class="badge badge-secondary">' + moduleTypeLabel(m.module_type) + '</span> ';
        html += escapeHtml(m.manufacturer || '') + (m.manufacturer ? ' / ' : '') + escapeHtml(m.model || '-');
        if (m.capacity) html += ' <span class="text-muted">(' + escapeHtml(m.capacity) + ')</span>';
        html += ' <span class="text-muted" style="font-size:12px;">' + (m.count || 1) + '개</span>';
        html += '</div>';

        // Option 1: Link to existing inventory item
        var linkDisabled = hasCandidates ? '' : ' disabled';
        var linkChecked = '';
        var candidateCount = hasCandidates ? m.candidates.length : 0;
        var listSize = Math.min(Math.max(candidateCount, 2), 6);
        html += '<label style="display:flex; align-items:flex-start; gap:8px; margin-bottom:6px; font-size:13px; cursor:pointer;">';
        html += '<input type="radio" name="unmatched-action-' + idx + '" value="link" ' + linkChecked + linkDisabled + ' onchange="onUnmatchedActionChange(' + idx + ')" style="margin-top:3px;">';
        html += '<span style="white-space:nowrap; margin-top:2px;">기존 코드에 연결:</span>';
        html += '</label>';
        html += '<div id="unmatched-link-wrap-' + idx + '" style="margin-left:28px; margin-bottom:6px; display:none;">';
        html += '<select id="unmatched-link-' + idx + '" class="form-control" size="' + listSize + '" style="font-size:12px; padding:2px 6px; width:100%; border:1px solid var(--border); border-radius:4px;"' + (hasCandidates ? '' : ' disabled') + '>';
        if (hasCandidates) {
            m.candidates.forEach(function(c) {
                var optLabel = c.item_code + ' \u2014 ' + (c.model || c.label || '?');
                if (c.manufacturer) optLabel += ' (' + c.manufacturer + ')';
                if (c.capacity) optLabel += ' [' + c.capacity + ']';
                html += '<option value="' + escapeHtml(c.item_code) + '">' + escapeHtml(optLabel) + '</option>';
            });
        } else {
            html += '<option value="">후보 없음</option>';
        }
        html += '</select>';
        html += '</div>';

        // Option 2: Register new
        html += '<label style="display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:13px; cursor:pointer;">';
        html += '<input type="radio" name="unmatched-action-' + idx + '" value="register" onchange="onUnmatchedActionChange(' + idx + ')">';
        html += '<span>새로 등록:</span>';
        html += '<input type="text" id="unmatched-code-' + idx + '" class="form-control" style="font-size:12px; padding:2px 6px; width:140px;" placeholder="로딩중..." disabled>';
        html += '</label>';

        // 수동 입력 필드(제조사·용량·사양·라벨) — 등록 선택 시 표시 (BUG-17: AI 자동채움 제거)
        html += '<div id="unmatched-spec-wrap-' + idx + '" style="margin-left:28px; margin-bottom:6px; display:none;">';
        html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 12px; font-size:12px;">';
        html += '<div><label style="color:var(--text-secondary);">제조사:</label>';
        html += '<input type="text" id="unmatched-manufacturer-' + idx + '" class="form-control" style="font-size:12px; padding:2px 6px; width:100%;" placeholder="제조사" value="' + escapeHtml(m.manufacturer || '') + '"></div>';
        html += '<div><label style="color:var(--text-secondary);">용량:</label>';
        html += '<input type="text" id="unmatched-capacity-' + idx + '" class="form-control" style="font-size:12px; padding:2px 6px; width:100%;" placeholder="용량" value="' + escapeHtml(m.capacity || '') + '"></div>';
        html += '<div><label style="color:var(--text-secondary);">사양:</label>';
        html += '<input type="text" id="unmatched-specification-' + idx + '" class="form-control" style="font-size:12px; padding:2px 6px; width:100%;" placeholder="사양"></div>';
        html += '<div><label style="color:var(--text-secondary);">라벨:</label>';
        html += '<input type="text" id="unmatched-label-' + idx + '" class="form-control" style="font-size:12px; padding:2px 6px; width:100%;" placeholder="관리용 라벨"></div>';
        html += '</div>';
        html += '</div>';

        // Option 3: Skip (default)
        html += '<label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">';
        html += '<input type="radio" name="unmatched-action-' + idx + '" value="skip" checked onchange="onUnmatchedActionChange(' + idx + ')">';
        html += '<span>건너뛰기</span>';
        html += '</label>';

        html += '</div>';
    });

    html += '<div style="margin-top:16px; display:flex; justify-content:flex-end; gap:8px;">';
    html += '<button class="btn btn-outline" onclick="closeUnmatchedModal()">취소</button>';
    html += '<button class="btn btn-primary" onclick="submitUnmatchedModules()">적용</button>';
    html += '</div>';

    modal.innerHTML = html;
    overlay.appendChild(modal);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeUnmatchedModal(); });
    document.body.appendChild(overlay);

    // Fetch suggested item codes for each module type
    var typeKeys = Object.keys(typeSet);
    var codeInfoMap = {};
    var fetchPromises = typeKeys.map(function(t) {
        return fetch('/discovery/next-item-code/' + t)
            .then(function(r) { return r.json(); })
            .then(function(info) { codeInfoMap[t] = info; })
            .catch(function() { codeInfoMap[t] = { prefix: '', nextSuffix: 'A' }; });
    });

    Promise.all(fetchPromises).then(function() {
        var suffixCounters = {};
        unmatchedModules.forEach(function(m, idx) {
            var info = codeInfoMap[m.module_type];
            if (!info) return;
            var input = document.getElementById('unmatched-code-' + idx);
            if (!input) return;

            if (!suffixCounters[m.module_type]) {
                suffixCounters[m.module_type] = info.nextSuffix ? info.nextSuffix.charCodeAt(0) : 65;
            }
            var suffix = String.fromCharCode(suffixCounters[m.module_type]);
            suffixCounters[m.module_type]++;

            var suggestedCode;
            if (m.module_type === 'cpu' || m.module_type === 'raid') {
                suggestedCode = info.prefix + suffix;
            } else {
                var mid = (m.capacity || '').replace(/\s+/g, '').replace(/[^0-9A-Za-z.GgTtMm]/g, '');
                if (!mid) mid = '?';
                suggestedCode = info.prefix + mid + '-' + suffix;
            }
            input.value = suggestedCode;
            input.placeholder = info.format || '';
            input.title = '형식: ' + (info.format || '') + ' (예: ' + (info.example || '') + ')';
        });
    });
}

function onUnmatchedActionChange(idx) {
    var radios = document.querySelectorAll('input[name="unmatched-action-' + idx + '"]');
    var selectedValue = '';
    for (var i = 0; i < radios.length; i++) {
        if (radios[i].checked) { selectedValue = radios[i].value; break; }
    }
    var codeInput = document.getElementById('unmatched-code-' + idx);
    var linkSelect = document.getElementById('unmatched-link-' + idx);
    var linkWrap = document.getElementById('unmatched-link-wrap-' + idx);
    var specWrap = document.getElementById('unmatched-spec-wrap-' + idx);
    if (codeInput) codeInput.disabled = (selectedValue !== 'register');
    if (linkSelect) linkSelect.disabled = (selectedValue !== 'link');
    if (linkWrap) linkWrap.style.display = (selectedValue === 'link') ? '' : 'none';
    if (specWrap) specWrap.style.display = (selectedValue === 'register') ? '' : 'none';
}

function closeUnmatchedModal() {
    var modal = document.getElementById('unmatchedModal');
    if (modal) modal.remove();
    window._unmatchedItems = null;
    window._unmatchedAssetId = null;
}


function submitUnmatchedModules() {
    var items = window._unmatchedItems;
    if (!items) return;

    var toLink = [];
    var toRegister = [];

    for (var idx = 0; idx < items.length; idx++) {
        var radios = document.querySelectorAll('input[name="unmatched-action-' + idx + '"]');
        var action = 'skip';
        for (var r = 0; r < radios.length; r++) {
            if (radios[r].checked) { action = radios[r].value; break; }
        }

        if (action === 'link') {
            var linkSelect = document.getElementById('unmatched-link-' + idx);
            var selectedCode = linkSelect ? linkSelect.value : '';
            if (!selectedCode) {
                alert('연결할 항목을 선택해주세요: ' + (items[idx].model || items[idx].module_type));
                return;
            }
            toLink.push({
                item_code: selectedCode,
                computing_module_id: items[idx].id
            });
        } else if (action === 'register') {
            var codeInput = document.getElementById('unmatched-code-' + idx);
            var itemCode = codeInput ? codeInput.value.trim() : '';
            if (!itemCode) {
                alert('품목코드를 입력해주세요: ' + (items[idx].model || items[idx].module_type));
                if (codeInput) codeInput.focus();
                return;
            }
            var mfgInput = document.getElementById('unmatched-manufacturer-' + idx);
            var capInput = document.getElementById('unmatched-capacity-' + idx);
            var specInput = document.getElementById('unmatched-specification-' + idx);
            var labelInput = document.getElementById('unmatched-label-' + idx);
            toRegister.push({
                item_code: itemCode,
                module_type: items[idx].module_type,
                model: items[idx].model,
                manufacturer: (mfgInput ? mfgInput.value.trim() : '') || items[idx].manufacturer,
                capacity: (capInput ? capInput.value.trim() : '') || items[idx].capacity,
                specification: specInput ? specInput.value.trim() : '',
                label: labelInput ? labelInput.value.trim() : '',
                count: items[idx].count || 1,
                computing_module_id: items[idx].id
            });
        }
        // skip → do nothing
    }

    if (toLink.length === 0 && toRegister.length === 0) {
        closeUnmatchedModal();
        return;
    }

    // Check for duplicate item codes in register list
    if (toRegister.length > 0) {
        var codes = toRegister.map(function(r) { return r.item_code; });
        var uniqueCodes = {};
        for (var c = 0; c < codes.length; c++) {
            if (uniqueCodes[codes[c]]) {
                alert('중복된 품목코드가 있습니다: ' + codes[c]);
                return;
            }
            uniqueCodes[codes[c]] = true;
        }
    }

    // Execute link and register requests
    var promises = [];
    if (toLink.length > 0) {
        promises.push(
            fetch('/discovery/link-inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: toLink })
            }).then(function(r) { return r.json(); })
        );
    }
    if (toRegister.length > 0) {
        promises.push(
            fetch('/discovery/register-inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: toRegister })
            }).then(function(r) { return r.json(); })
        );
    }

    Promise.all(promises).then(function(results) {
        var msgs = [];
        results.forEach(function(res) {
            if (res.linked && res.linked.length > 0) {
                msgs.push('기존 연결: ' + res.linked.length + '개 (' + res.linked.join(', ') + ')');
            }
            if (res.registered && res.registered.length > 0) {
                msgs.push('새로 등록: ' + res.registered.length + '개 (' + res.registered.join(', ') + ')');
            }
            if (res.error) {
                msgs.push('오류: ' + res.error);
            }
        });
        alert(msgs.length > 0 ? msgs.join('\n') : '처리 완료');
        closeUnmatchedModal();
    }).catch(function(err) {
        alert('오류: ' + err.message);
    });
}

  // ── 공개 API ──
  var DiscoveryCore = {
    results: scanResults,
    // 소비자 결선 교체(부분 병합). /discovery는 호출 안 함(기본값 사용).
    configure: function (opts) { if (!opts) return; for (var k in opts) { if (Object.prototype.hasOwnProperty.call(opts, k)) consumer[k] = opts[k]; } },
    // 단일 스캔 primitive(POST /discovery/scan-asset). 본문·저장 동작은 scanAsset과 동일.
    scan: function (assetId) {
      return fetch('/discovery/scan-asset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: assetId })
      }).then(function (r) { return r.json(); }).then(function (data) { scanResults[assetId] = data; return data; });
    },
    scanAsset: scanAsset,
    showDetail: showDetail,
    applyAsset: applyAsset,
    buildUnifiedRows: buildUnifiedRows,
    renderComparison: renderComparison,
    renderDiscoveredModuleTable: renderDiscoveredModuleTable,
    // B-5b 진입점(서버실 팝업): rootEl/콜백을 consumer로 주입. 목록 셀이 없으므로 detailRow는 더미,
    //   statusCell은 null(no-op)로 스코프. onApplied/onConflict는 팝업이 제공.
    mount: function (rootEl, assetId, opts) {
      opts = opts || {};
      var dummyRow = { style: {} };
      DiscoveryCore.configure({
        contentEl: function () { return rootEl; },
        detailRow: function () { return opts.detailRow ? opts.detailRow : dummyRow; },
        statusCell: function () { return null; },
        silentSuccess: true,
        onApplied: function (id, result, data) { if (opts.onApplied) opts.onApplied(id, result, data); },
        onConflict: function (id, result) { if (opts.onConflict) opts.onConflict(id, result); }
      });
      return { scan: function () { return DiscoveryCore.scan(assetId); }, showDetail: function (f) { return showDetail(assetId, f); } };
    }
  };
  window.DiscoveryCore = DiscoveryCore;

  // onclick/페이지 호환용 전역 노출 — 렌더 HTML(onclick 문자열)·페이지 참조를 바이트 그대로 유지.
  window.scanResults = scanResults;
  window.escapeHtml = escapeHtml;
  window.scanDiagnosticsHtml = scanDiagnosticsHtml;
  window.cardInfoLine = cardInfoLine;
  window.moduleTypeBadge = moduleTypeBadge;
  window.moduleSummaryHtml = moduleSummaryHtml;
  window.moduleTypeLabel = moduleTypeLabel;
  window.ownerDisplayName = ownerDisplayName;
  window.buildVendorOptions = buildVendorOptions;
  window.scanAsset = scanAsset;
  window.showDetail = showDetail;
  window.normalizeModelClient = normalizeModelClient;
  window.modelsMatchClient = modelsMatchClient;
  window.buildUnifiedRows = buildUnifiedRows;
  window.formatModuleInfo = formatModuleInfo;
  window.formatRegisteredModuleInfo = formatRegisteredModuleInfo;
  window.showInventoryDetail = showInventoryDetail;
  window.renderComparison = renderComparison;
  window.renderDiscoveredModuleTable = renderDiscoveredModuleTable;
  window.changeModuleOwner = changeModuleOwner;
  window.splitModule = splitModule;
  window.renderModuleTable = renderModuleTable;
  window.toggleRawOutput = toggleRawOutput;
  window.showTransferLogs = showTransferLogs;
  window.applyAsset = applyAsset;
  window.showUnmatchedModulesModal = showUnmatchedModulesModal;
  window.onUnmatchedActionChange = onUnmatchedActionChange;
  window.closeUnmatchedModal = closeUnmatchedModal;
  window.submitUnmatchedModules = submitUnmatchedModules;
})();
