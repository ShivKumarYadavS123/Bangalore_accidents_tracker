/**
 * Local JSON copy of the public accident map (Frontend/accident_data.json).
 * Every visitor can download that file, so it only ever holds verified public
 * records: user reports stay in the database, and readers skip anything whose
 * status is not 'active'.
 */
import fs from 'fs';

export const isPublicRecord = (r) => !!r && r.status === 'active' && !r.reporter_id;

/** Records the JSON fallback may show: status === 'active' only. */
export function readActiveAccidents(jsonPath) {
  if (!jsonPath || !fs.existsSync(jsonPath)) return [];
  const list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return Array.isArray(list) ? list.filter(r => r && r.status === 'active') : [];
}

/** Adds an admin-verified record to the top of the file; refuses anything that is not public. */
export function appendPublicAccident(jsonPath, record) {
  if (!isPublicRecord(record)) return false;
  try {
    if (!jsonPath || !fs.existsSync(jsonPath)) return false;
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    data.unshift(record);
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('JSON sync new error:', e.message);
    return false;
  }
}
