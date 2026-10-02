export const LAYOUT_DEFAULTS = Object.freeze({ Width: 72, Height: 66, X: 14, Y: 17, FontSize: 13, ButtonFontSize: 12, MetaWidth: 108, ActionWidth: 76, RowPadding: 1, Gap: 2, SourceWeight: 1, TranslationWeight: 1, PageSize: 16 });
const limits = { Width: [45, 95], Height: [40, 90], X: [0, 55], Y: [0, 60], FontSize: [10, 22], ButtonFontSize: [10, 20], MetaWidth: [70, 200], ActionWidth: [60, 130], RowPadding: [0, 8], Gap: [0, 8], SourceWeight: [.5, 3], TranslationWeight: [.5, 3], PageSize: [8, 32] };
export function normalizeLayout(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const result = { ...LAYOUT_DEFAULTS };
  for (const key of Object.keys(result)) {
    const number = Number(value[key]);
    if (value[key] != null && Number.isFinite(number)) result[key] = Math.min(limits[key][1], Math.max(limits[key][0], number));
  }
  result.PageSize = Math.round(result.PageSize);
  result.X = Math.min(result.X, 100 - result.Width); result.Y = Math.min(result.Y, 100 - result.Height);
  return result;
}
export function exportTranscript(rows) {
  return '\uFEFF' + rows.map(row => '[' + new Date(row.time).toLocaleString() + '] ' + row.sender + '\r\n原文：' + row.source + (row.translation ? '\r\n译文：' + row.translation : '')).join('\r\n\r\n') + '\r\n';
}
