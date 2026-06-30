/**
 * Fix pg Date objects in a row.
 * - DATE columns (dateOnlyCols): YYYY-MM-DD string without UTC shift
 * - TIMESTAMP columns (all other Date instances in cols): toISOString()
 *
 * @param {object} row - DB row object
 * @param {string[]} dateOnlyCols - column names that are pg DATE type
 * @param {string[]} cols - all column names to check
 * @returns {object} row with dates converted to strings
 */
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
        row[k] = row[k].toISOString();
      }
    }
  }
  return row;
}

module.exports = { fixRowDates };
