#!/bin/bash
# ============================================================
# 장비실 재고 점검표 HTML 생성 스크립트
# 사용법: ./scripts/generate-inventory-checklist.sh [출력파일명]
# 기본값: INVENTORY_CHECKLIST_YYYY-MM-DD.html (프로젝트 루트)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="$PROJECT_ROOT/app/data/it_assets.db"
GEN_DATE=$(date +%Y-%m-%d)
GEN_TIME=$(date +%H:%M:%S)

if [ -n "${1:-}" ]; then
    OUTPUT="$PROJECT_ROOT/$1"
else
    OUTPUT="$PROJECT_ROOT/INVENTORY_CHECKLIST_${GEN_DATE}.html"
fi

if [ ! -f "$DB_PATH" ]; then
    echo "오류: DB 파일을 찾을 수 없습니다: $DB_PATH"
    exit 1
fi

escape_html() {
    sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

get_type_name() {
    case "$1" in
        memory)  echo "메모리" ;;
        cpu)     echo "CPU" ;;
        gpu)     echo "GPU" ;;
        disk)    echo "디스크(스토리지)" ;;
        network) echo "네트워크" ;;
        raid)    echo "RAID 컨트롤러" ;;
        psu)     echo "PSU(전원공급장치)" ;;
        npu)     echo "NPU" ;;
        cable)   echo "케이블" ;;
        *)       echo "$1" ;;
    esac
}

# ── HTML 시작 ──
cat > "$OUTPUT" << 'HTMLEOF'
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>장비실 재고 점검표</title>
<style>
/* ── 기본 스타일 ── */
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: 'Pretendard', 'Noto Sans KR', 'Malgun Gothic', '맑은 고딕', sans-serif;
    font-size: 11px;
    line-height: 1.4;
    color: #1a1a1a;
    padding: 20px;
}

/* ── 헤더 ── */
.header {
    border: 2px solid #333;
    padding: 16px 20px;
    margin-bottom: 16px;
}
.header h1 {
    font-size: 20px;
    text-align: center;
    margin-bottom: 12px;
    letter-spacing: 4px;
}
.header-info {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    font-size: 12px;
    margin-bottom: 10px;
}
.header-info .field {
    display: flex;
    align-items: baseline;
    gap: 4px;
}
.header-info .field label {
    font-weight: 700;
    white-space: nowrap;
}
.header-info .field .blank {
    display: inline-block;
    border-bottom: 1px solid #333;
    min-width: 80px;
    height: 18px;
}
.header-info .field .blank.wide { min-width: 140px; }
.header-info .field .blank.narrow { min-width: 50px; }
.header-notice {
    font-size: 10.5px;
    color: #444;
    border-top: 1px solid #ccc;
    padding-top: 8px;
    margin-top: 8px;
}
.gen-info {
    font-size: 9px;
    color: #999;
    text-align: right;
    margin-top: 4px;
}

/* ── 그룹 ── */
.group {
    margin-bottom: 14px;
    break-inside: avoid;
}
.group-header {
    font-size: 13px;
    font-weight: 700;
    background: #2c3e50;
    color: #fff;
    padding: 6px 12px;
    margin-bottom: 0;
    border-radius: 3px 3px 0 0;
}
.group-header .item-count {
    font-weight: 400;
    font-size: 11px;
    opacity: 0.8;
}

/* ── 테이블 ── */
table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10.5px;
    table-layout: fixed;
}
thead { display: table-header-group; }
thead tr {
    background: #ecf0f1;
}
th {
    font-weight: 700;
    text-align: center;
    padding: 5px 4px;
    border: 1px solid #999;
    font-size: 10px;
    vertical-align: middle;
    word-break: keep-all;
}
td {
    padding: 4px 6px;
    border: 1px solid #999;
    vertical-align: middle;
}

/* ── 컬럼 너비 ── */
.col-code  { width: 14%; }
.col-model { width: 22%; }
.col-num   { width: 7%; text-align: center; }
.col-input { width: 9%; }
.col-diff  { width: 7%; }
.col-note  { width: 26%; }
.col-check { width: 6%; text-align: center; }

td.code { font-family: 'Consolas', 'D2Coding', monospace; font-size: 10px; word-break: break-all; }
td.model { font-size: 9.5px; word-break: break-all; }
td.num  { text-align: center; font-weight: 600; }
td.input-cell { min-height: 28px; height: 28px; background: #fafafa; }
td.note-cell  { }
td.check-cell { text-align: center; font-size: 14px; }

tr:nth-child(even) { background: #f9f9f9; }
tr:hover { background: #eef5fc; }

/* ── 하단 ── */
.footer-section {
    margin-top: 20px;
    border: 1px solid #999;
    padding: 14px 16px;
    break-inside: avoid;
}
.footer-section h3 {
    font-size: 12px;
    margin-bottom: 10px;
    border-bottom: 1px solid #ccc;
    padding-bottom: 4px;
}
.memo-area {
    border: 1px solid #ccc;
    min-height: 80px;
    margin-bottom: 14px;
    padding: 6px;
}
.sig-row {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    margin-top: 12px;
    font-size: 12px;
}
.sig-row .sig-field {
    display: flex;
    align-items: baseline;
    gap: 4px;
}
.sig-row .sig-field .sig-line {
    display: inline-block;
    border-bottom: 1px solid #333;
    min-width: 120px;
    height: 18px;
}

/* ── 인쇄 최적화 ── */
@media print {
    @page {
        size: A4 portrait;
        margin: 15mm 10mm;
        @bottom-center {
            content: counter(page) " / " counter(pages);
            font-size: 9px;
            color: #666;
        }
    }
    body { padding: 0; font-size: 10px; }
    .header { border-width: 1.5px; }
    .group { break-inside: avoid; }
    table { font-size: 9.5px; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    td.input-cell { background: #fff !important; }
    tr:nth-child(even) { background: #f5f5f5 !important; }
    tr:hover { background: none !important; }
    .no-print { display: none !important; }
}
</style>
</head>
<body>

<div class="header">
    <h1>장비실 재고 점검표</h1>
    <div class="header-info">
        <div class="field">
            <label>점검 날짜:</label>
            <span class="blank narrow"></span>년
            <span class="blank narrow"></span>월
            <span class="blank narrow"></span>일
        </div>
        <div class="field">
            <label>점검자:</label>
            <span class="blank wide"></span>
        </div>
        <div class="field">
            <label>시작 시각:</label>
            <span class="blank"></span>
        </div>
        <div class="field">
            <label>종료 시각:</label>
            <span class="blank"></span>
        </div>
    </div>
    <div class="header-notice">
        안내: 시스템 기록과 실물을 비교하여 차이가 있으면 비고란에 사유를 기록하세요.
        "실물 보관"란에는 창고에 보관 중인 실물 수량만 기입합니다 (서버에 장착된 것은 제외).
    </div>
HTMLEOF

# 생성 정보 삽입 (변수 치환 필요)
cat >> "$OUTPUT" << EOF
    <div class="gen-info">생성: ${GEN_DATE} ${GEN_TIME} | DB: it_assets.db</div>
</div>
EOF

# ── 모듈 타입별 그룹 테이블 생성 ──
TYPES=(memory cpu gpu disk network raid psu npu cable)
TOTAL_ITEMS=0
GROUP_COUNT=0

for type in "${TYPES[@]}"; do
    DATA=$(sqlite3 -readonly -separator $'\t' "$DB_PATH" \
        "SELECT item_code,
                CASE
                  WHEN manufacturer IS NOT NULL AND manufacturer != '' AND model IS NOT NULL AND model != ''
                    THEN manufacturer || ' ' || model
                  WHEN model IS NOT NULL AND model != '' THEN model
                  ELSE '-'
                END,
                storage_quantity, in_use_quantity
         FROM module_inventory
         WHERE module_type = '${type}'
           AND (storage_quantity > 0 OR in_use_quantity > 0)
         ORDER BY item_code;" 2>/dev/null || true)

    [ -z "$DATA" ] && continue

    TYPE_NAME=$(get_type_name "$type")
    ROW_COUNT=$(echo "$DATA" | wc -l)
    TOTAL_ITEMS=$((TOTAL_ITEMS + ROW_COUNT))
    GROUP_COUNT=$((GROUP_COUNT + 1))

    cat >> "$OUTPUT" << EOF

<div class="group">
<h2 class="group-header">${TYPE_NAME} <span class="item-count">(${ROW_COUNT}건)</span></h2>
<table>
<thead>
<tr>
<th class="col-code">item_code</th>
<th class="col-model">모델</th>
<th class="col-num">시스템<br>보관</th>
<th class="col-num">시스템<br>사용 중</th>
<th class="col-input">실물 보관</th>
<th class="col-diff">차이</th>
<th class="col-note">사유/비고</th>
<th class="col-check">점검<br>OK</th>
</tr>
</thead>
<tbody>
EOF

    while IFS=$'\t' read -r code model_info stor inuse; do
        esc_code=$(printf '%s' "$code" | escape_html)
        esc_model=$(printf '%s' "$model_info" | escape_html)
        cat >> "$OUTPUT" << EOF
<tr>
<td class="code">${esc_code}</td>
<td class="model">${esc_model}</td>
<td class="num">${stor}</td>
<td class="num">${inuse}</td>
<td class="input-cell"></td>
<td class="input-cell"></td>
<td class="input-cell note-cell"></td>
<td class="check-cell">&#9744;</td>
</tr>
EOF
    done <<< "$DATA"

    cat >> "$OUTPUT" << 'EOF'
</tbody>
</table>
</div>
EOF

done

# ── 하단 섹션 ──
cat >> "$OUTPUT" << 'HTMLEOF'

<div class="footer-section">
    <h3>종합 메모</h3>
    <div class="memo-area"></div>

    <div class="header-info">
        <div class="field">
            <label>다음 점검 예정일:</label>
            <span class="blank narrow"></span>년
            <span class="blank narrow"></span>월
            <span class="blank narrow"></span>일
        </div>
    </div>

    <div class="sig-row">
        <div class="sig-field">
            <label>점검자 서명:</label>
            <span class="sig-line"></span>
        </div>
        <div class="sig-field">
            <label>확인자 서명:</label>
            <span class="sig-line"></span>
        </div>
    </div>
</div>

</body>
</html>
HTMLEOF

# ── 결과 출력 ──
echo "=================================================="
echo "  장비실 재고 점검표 생성 완료"
echo "=================================================="
echo "  파일: $(basename "$OUTPUT")"
echo "  경로: $OUTPUT"
echo "  생성일: ${GEN_DATE} ${GEN_TIME}"
echo "  그룹: ${GROUP_COUNT}개 | 항목: ${TOTAL_ITEMS}건"
echo ""
echo "  브라우저에서 열어 Ctrl+P 로 인쇄하세요."
echo "  (A4 세로 / 여백: 위아래 15mm, 좌우 10mm 권장)"
echo "=================================================="
