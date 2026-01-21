// /src/data/getters/rtkTowers.js  (FULL FILE)
// Rev: 2026-01-20-v2-getters-rtk-count
//
// Counts RTK towers from snapshot table rtkTowers

import { db } from '../sqlite.js';

export function getRtkTowerCount() {
  const sqlite = db();
  const row = sqlite.prepare(`SELECT COUNT(1) AS n FROM rtkTowers`).get();
  return { count: Number(row?.n || 0) };
}