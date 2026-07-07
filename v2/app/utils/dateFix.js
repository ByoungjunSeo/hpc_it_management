/**
 * Fix pg Date objects in a row.
 * - DATE columns (dateOnlyCols): YYYY-MM-DD string without UTC shift
 * - TIMESTAMP columns (all other Date instances in cols): 서버 로컬시간 문자열
 *   (toISOString은 UTC라 화면이 v1(KST) 대비 9시간 밀림 — B-4d-6d에서 발견·수정)
 *
 * @param {object} row - DB row object
 * @param {string[]} dateOnlyCols - column names that are pg DATE type
 * @param {string[]} cols - all column names to check
 * @returns {object} row with dates converted to strings
 */
function formatTimestamp(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0');
}

function fixRowDates(row, dateOnlyCols, cols) {
  if (!row) return row;
  for (const k of cols) {
    if (row[k] instanceof Date) {
      if (dateOnlyCols.includes(k)) {
        const d = row[k];
        row[k] = d.getFullYear() + '-' +
          String(d.getMonth() + 1).padStart(2, '0') + '-' +
          String(d.getDate()).padStart(2, '0');
      } else {
        row[k] = formatTimestamp(row[k]);
      }
    }
  }
  return row;
}

module.exports = { fixRowDates, formatTimestamp };
