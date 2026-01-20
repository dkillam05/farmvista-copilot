import { getDb } from './sqlite.js';

export function getFieldFullByKey(key) {
  const db = getDb();

  const row = db.prepare(`
    SELECT *
    FROM v_field_full
    WHERE field_name LIKE ? OR field_id = ?
    LIMIT 1
  `).get(`%${key}%`, key);

  if (!row) {
    throw new Error(`Field not found: ${key}`);
  }

  return row;
}

export function getGrainBagSummary() {
  const db = getDb();

  return db.prepare(`
    SELECT crop, bushels
    FROM v_grain_bags_down
  `).all();
}
