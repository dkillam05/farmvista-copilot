'use strict';

import { ensureDbFromSnapshot, getDb } from '../context/snapshot-db.js';
import { runSql } from '../chat/sqlRunner.js';
import { getThreadContext, applyContextDelta } from '../chat/conversationStore.js';

/**
 * FarmVista Copilot Chat Handler (FULL FILE)
 * Rev: 2026-01-09-handleChat-global-lists1
 *
 * GLOBAL RULES (apply to ANY list output):
 * ✅ Sort: numeric-prefix first if items start with numbers, else A–Z
 * ✅ Page size: 100 items
 * ✅ If more exist: append "…plus N more. (say \"show more\")"
 * ✅ Followups operate on the LAST list shown:
 *    - "show more" / "show all"
 *    - "sort a-z" / "sort z-a"
 *    - "sort high to low" / "sort low to high"
 *    - "total" / "average"
 *
 * OpenAI:
 * ✅ tool_choice = "required" (never free-chat answers)
 * ✅ OpenAI must call fv_query every request
 */

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const PAGE_SIZE = 100;

function safeStr(v) { return (v == null ? '' : String(v)).trim(); }
function norm(s) { return safeStr(s).toLowerCase(); }
function escSql(s) { return safeStr(s).replace(/'/g, "''"); }

function fmtA(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function activeOnlyWhere() {
  return `(fields.status IS NULL OR fields.status='' OR LOWER(fields.status) NOT IN ('archived','inactive'))`;
}

function countyKey(s) {
  return norm(s).replace(/\s+/g, '');
}

function buildCountyWhere(countyText) {
  const c = safeStr(countyText);
  if (!c) return '1=1';
  const tok = escSql(norm(c));
  const key = escSql(countyKey(c));
  return `(
    fields.county_norm LIKE '%${tok}%'
    OR REPLACE(fields.county_norm,' ','') LIKE '%${key}%'
  )`;
}

function metricCol(metric) {
  const m = norm(metric);
  if (m === 'hel') return 'helAcres';
  if (m === 'crp') return 'crpAcres';
  return 'tillable';
}

/* =========================================================
   GLOBAL LIST ENGINE
========================================================= */

function stripBullet(line) {
  const s = safeStr(line);
  return s.startsWith('• ') ? s.slice(2).trim() : s;
}

function startsWithNumber(s) {
  const t = stripBullet(s);
  return /^\d+/.test(t);
}

function numPrefix(s) {
  const t = stripBullet(s);
  const m = t.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

function alphaSort(a, b) {
  return stripBullet(a).localeCompare(stripBullet(b), undefined, { sensitivity: 'base' });
}

function numericThenAlphaSort(a, b) {
  const na = numPrefix(a);
  const nb = numPrefix(b);
  if (na != null && nb != null) return (na - nb) || alphaSort(a, b);
  if (na != null) return -1;
  if (nb != null) return 1;
  return alphaSort(a, b);
}

function decideDefaultSort(items) {
  if (!items || !items.length) return { mode: 'az', sorted: [] };
  const n = Math.min(items.length, 25);
  let numHits = 0;
  for (let i = 0; i < n; i++) if (startsWithNumber(items[i])) numHits++;
  const useNumeric = numHits >= Math.ceil(n * 0.6);
  const sorted = items.slice().sort(useNumeric ? numericThenAlphaSort : alphaSort);
  return { mode: useNumeric ? 'num' : 'az', sorted };
}

function parseNumericValueFromLine(line) {
  const s = stripBullet(line);

  // prefer number before "ac" or "acres"
  let m = s.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:acres?\b|ac\b)/i);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  // next: number after "—" (common "Thing — 123")
  m = s.match(/—\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  // fallback: last number in the string
  const all = s.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g);
  if (all && all.length) {
    const n = Number(String(all[all.length - 1]).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function paginate(items, offset) {
  const off = Math.max(0, Number(offset) || 0);
  const slice = items.slice(off, off + PAGE_SIZE);
  const remaining = Math.max(0, items.length - (off + slice.length));
  return { slice, remaining, nextOffset: off + slice.length };
}

function storeLastList(threadId, items, offset, sortMode) {
  applyContextDelta(threadId, {
    lastList: {
      items: items.slice(),
      offset: Number(offset) || 0,
      sortMode: safeStr(sortMode || 'az'),
      pageSize: PAGE_SIZE
    }
  });
}

function getLastList(threadId) {
  const ctx = getThreadContext(threadId) || {};
  const ll = ctx.lastList;
  if (!ll || !Array.isArray(ll.items)) return null;
  return {
    items: ll.items.slice(),
    offset: Number(ll.offset) || 0,
    sortMode: safeStr(ll.sortMode || 'az')
  };
}

function renderPage(items, offset, sortMode) {
  const { slice, remaining, nextOffset } = paginate(items, offset);
  const lines = slice.map(x => x.startsWith('• ') ? x : `• ${x}`);
  let text = lines.join('\n');
  if (remaining > 0) text += `\n…plus ${remaining} more. (say "show more")`;
  return { text: text || '(no matches)', nextOffset, remaining, sortMode };
}

function applySort(items, mode) {
  const m = norm(mode);
  if (m === 'z-a') return items.slice().sort((a, b) => alphaSort(b, a));
  if (m === 'a-z') return items.slice().sort(alphaSort);
  if (m === 'num') return items.slice().sort(numericThenAlphaSort);
  // default
  return items.slice().sort(alphaSort);
}

function sortByValue(items, dir) {
  const d = norm(dir);
  const rows = items.map(x => ({ raw: x, val: parseNumericValueFromLine(x) }));
  rows.sort((a, b) => {
    const av = (a.val == null ? -Infinity : a.val);
    const bv = (b.val == null ? -Infinity : b.val);
    if (d === 'desc') return (bv - av) || alphaSort(a.raw, b.raw);
    return (av - bv) || alphaSort(a.raw, b.raw);
  });
  return rows.map(r => r.raw);
}

function computeTotal(items) {
  const nums = items.map(parseNumericValueFromLine).filter(v => v != null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0);
}

function computeAverage(items) {
  const nums = items.map(parseNumericValueFromLine).filter(v => v != null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/* =========================================================
   TOOLING: fv_query
========================================================= */

const TOOLS = [
  {
    type: 'function',
    name: 'fv_query',
    description:
      'Query FarmVista snapshot SQLite for data. MUST be used for EVERY request. ' +
      'Return lists and results from DB. Do NOT ask user what a "field" means.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list_fields',
            'list_counties',
            'group_metric',
            'drilldown_metric',
            'field_info',
            'rtk_info',
            'list_rtk_towers'
          ]
        },
        county: { type: 'string' },
        farm: { type: 'string' },
        rtkTower: { type: 'string' },
        field: { type: 'string' },
        metric: { type: 'string', enum: ['hel', 'crp', 'tillable'] },
        metricGt: { type: 'number' },
        groupBy: { type: 'string', enum: ['county', 'farm'] },
        limit: { type: 'number' }
      },
      required: ['action'],
      additionalProperties: false
    }
  }
];

function extractToolCall(respJson) {
  const out = respJson?.output;
  if (!Array.isArray(out)) return null;
  for (const item of out) {
    if (item && item.type === 'function_call' && item.name === 'fv_query') return item;
  }
  // fallback shape (some responses variants)
  for (const item of out || []) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && c.type === 'tool_call' && c.name === 'fv_query') return c;
    }
  }
  return null;
}

function formatFieldInfoRow(r) {
  const lines = [];
  const field = safeStr(r.field || r.name);
  if (field) lines.push(`Field: ${field}`);
  if (r.field_num != null && safeStr(r.field_num) !== '') lines.push(`Field # : ${safeStr(r.field_num)}`);
  if (r.field_id) lines.push(`Field ID: ${safeStr(r.field_id)}`);
  if (r.farm) lines.push(`Farm: ${safeStr(r.farm)}`);
  const loc = [safeStr(r.county), safeStr(r.state)].filter(Boolean).join(', ');
  if (loc) lines.push(`Location: ${loc}`);
  lines.push(`Tillable: ${fmtA(r.tillable)} ac`);
  lines.push(`HEL: ${fmtA(r.helAcres)} ac`);
  lines.push(`CRP: ${fmtA(r.crpAcres)} ac`);
  lines.push(`RTK tower: ${safeStr(r.rtkTower) || '(none)'}`);
  lines.push(`Frequency: ${safeStr(r.frequencyMHz) ? `${safeStr(r.frequencyMHz)} MHz` : '(unknown)'}`);
  lines.push(`Network ID: ${safeStr(r.networkId) || '(unknown)'}`);
  return lines.join('\n');
}

function runTool(db, args) {
  const action = norm(args.action);
  const limit = Math.max(1, Math.min(5000, Number(args.limit) || 5000));

  // LIST COUNTIES
  if (action === 'list_counties') {
    const sql = `
      SELECT
        MIN(TRIM(fields.county)) AS county,
        MIN(TRIM(fields.state)) AS state
      FROM fields
      WHERE TRIM(COALESCE(fields.county,'')) <> ''
        AND ${activeOnlyWhere()}
      GROUP BY REPLACE(fields.county_norm,' ',''), fields.state_norm
      ORDER BY LOWER(county) ASC, LOWER(state) ASC
      LIMIT ${limit}
    `.trim();
    const ex = runSql({ db, sql, limitDefault: limit });
    return { kind: 'list', ex, items: ex.ok ? ex.rows.map(r => `${safeStr(r.county)}, ${safeStr(r.state)}`.replace(/,\s*$/, '').trim()) : [] };
  }

  // LIST FIELDS (optionally filtered by county)
  if (action === 'list_fields') {
    const county = safeStr(args.county);
    const where = [activeOnlyWhere()];
    if (county) where.push(buildCountyWhere(county));

    const sql = `
      SELECT fields.name AS field
      FROM fields
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(fields.field_num, 999999) ASC, fields.name_norm ASC
      LIMIT ${limit}
    `.trim();

    const ex = runSql({ db, sql, limitDefault: limit });
    return { kind: 'list', ex, items: ex.ok ? ex.rows.map(r => safeStr(r.field)).filter(Boolean) : [] };
  }

  // GROUP METRIC BY COUNTY OR FARM
  if (action === 'group_metric') {
    const metric = norm(args.metric) || 'tillable';
    const col = metricCol(metric);
    const groupBy = norm(args.groupBy) === 'farm' ? 'farm' : 'county';

    let sql = '';
    if (groupBy === 'farm') {
      sql = `
        SELECT
          MIN(farms.name) AS groupName,
          SUM(COALESCE(fields.${col},0)) AS value
        FROM fields
        LEFT JOIN farms ON fields.farmId = farms.id
        WHERE ${activeOnlyWhere()}
        GROUP BY farms.name_norm
        ORDER BY LOWER(groupName) ASC
        LIMIT ${limit}
      `.trim();
    } else {
      sql = `
        SELECT
          CASE
            WHEN TRIM(COALESCE(MIN(fields.state),'')) <> '' THEN MIN(TRIM(fields.county)) || ', ' || MIN(TRIM(fields.state))
            ELSE MIN(TRIM(fields.county))
          END AS groupName,
          SUM(COALESCE(fields.${col},0)) AS value
        FROM fields
        WHERE TRIM(COALESCE(fields.county,'')) <> ''
          AND ${activeOnlyWhere()}
        GROUP BY REPLACE(fields.county_norm,' ',''), fields.state_norm
        ORDER BY LOWER(groupName) ASC
        LIMIT ${limit}
      `.trim();
    }

    const ex = runSql({ db, sql, limitDefault: limit });
    const items = ex.ok
      ? ex.rows.map(r => `${safeStr(r.groupName)} — ${fmtA(r.value)} ac`)
      : [];
    return { kind: 'list', ex, items };
  }

  // DRILLDOWN: FIELDS IN COUNTY WITH METRIC > X
  if (action === 'drilldown_metric') {
    const metric = norm(args.metric) || 'tillable';
    const col = metricCol(metric);
    const gt = (args.metricGt != null) ? Number(args.metricGt) : 0;
    const county = safeStr(args.county);

    const where = [
      activeOnlyWhere(),
      `COALESCE(fields.${col},0) > ${Number.isFinite(gt) ? gt : 0}`
    ];
    if (county) where.push(buildCountyWhere(county));

    const sql = `
      SELECT fields.name AS field, COALESCE(fields.${col},0) AS value
      FROM fields
      WHERE ${where.join(' AND ')}
      ORDER BY value DESC, fields.name_norm ASC
      LIMIT ${limit}
    `.trim();

    const ex = runSql({ db, sql, limitDefault: limit });
    const items = ex.ok
      ? ex.rows.map(r => `${safeStr(r.field)} — ${fmtA(r.value)} ac`)
      : [];
    return { kind: 'list', ex, items };
  }

  // FIELD INFO (full card)
  if (action === 'field_info') {
    const f = safeStr(args.field);
    if (!f) return { kind: 'text', text: '(no matches)' };

    const tok = escSql(norm(f));
    const sql = `
      SELECT
        fields.id AS field_id,
        fields.name AS field,
        fields.field_num AS field_num,
        farms.name AS farm,
        fields.county AS county,
        fields.state AS state,
        COALESCE(fields.tillable,0) AS tillable,
        COALESCE(fields.helAcres,0) AS helAcres,
        COALESCE(fields.crpAcres,0) AS crpAcres,
        rtkTowers.name AS rtkTower,
        rtkTowers.frequencyMHz AS frequencyMHz,
        rtkTowers.networkId AS networkId
      FROM fields
      LEFT JOIN farms ON fields.farmId = farms.id
      LEFT JOIN rtkTowers ON fields.rtkTowerId = rtkTowers.id
      WHERE ${activeOnlyWhere()}
        AND (fields.name_norm LIKE '%${tok}%' OR fields.name_sq LIKE '%${tok.replace(/\s+/g,'')}%')
      ORDER BY fields.name_norm ASC
      LIMIT 5
    `.trim();

    const ex = runSql({ db, sql, limitDefault: 5 });
    if (!ex.ok || !(ex.rows || []).length) return { kind: 'text', text: '(no matches)' };
    const rows = ex.rows || [];
    if (rows.length === 1) return { kind: 'text', text: formatFieldInfoRow(rows[0]) };
    return { kind: 'list', ex, items: rows.map(r => safeStr(r.field)).filter(Boolean) };
  }

  // LIST RTK TOWERS
  if (action === 'list_rtk_towers') {
    const sql = `
      SELECT rtkTowers.name AS tower
      FROM rtkTowers
      WHERE rtkTowers.name IS NOT NULL AND rtkTowers.name <> ''
      ORDER BY rtkTowers.name_norm ASC
      LIMIT ${limit}
    `.trim();
    const ex = runSql({ db, sql, limitDefault: limit });
    return { kind: 'list', ex, items: ex.ok ? ex.rows.map(r => safeStr(r.tower)).filter(Boolean) : [] };
  }

  // RTK INFO
  if (action === 'rtk_info') {
    const t = safeStr(args.rtkTower || args.tower);
    if (!t) return { kind: 'text', text: '(no matches)' };

    const tok = escSql(norm(t));
    const sql = `
      SELECT
        rtkTowers.name AS tower,
        rtkTowers.frequencyMHz AS frequencyMHz,
        rtkTowers.networkId AS networkId
      FROM rtkTowers
      WHERE rtkTowers.name_norm LIKE '%${tok}%'
      ORDER BY rtkTowers.name_norm ASC
      LIMIT 5
    `.trim();

    const ex = runSql({ db, sql, limitDefault: 5 });
    if (!ex.ok || !(ex.rows || []).length) return { kind: 'text', text: '(no matches)' };
    const r0 = ex.rows[0];
    return {
      kind: 'text',
      text: `RTK tower: ${safeStr(r0.tower)}\nFrequency: ${safeStr(r0.frequencyMHz)} MHz\nNetwork ID: ${safeStr(r0.networkId)}`
    };
  }

  return { kind: 'text', text: '(no matches)' };
}

/* =========================================================
   MAIN
========================================================= */

export async function handleChat({
  question,
  snapshot,
  threadId = '',
  debugAI = false
}) {
  if (!question || !question.trim()) {
    return { ok: false, answer: 'Missing question.', meta: { aiUsed: false } };
  }

  if (!snapshot?.ok) {
    return { ok: false, answer: 'Snapshot not loaded.', meta: { aiUsed: false } };
  }

  // Build DB
  try {
    ensureDbFromSnapshot(snapshot);
  } catch (e) {
    return { ok: false, answer: 'Database build failed.', meta: { aiUsed: false } };
  }

  const db = getDb();
  if (!db) {
    return { ok: false, answer: 'DB not ready.', meta: { aiUsed: false } };
  }

  // GLOBAL FOLLOWUPS ON LAST LIST
  const last = threadId ? getThreadContext(threadId) : null;
  const lastList = (last && last.lastList && Array.isArray(last.lastList.items)) ? last.lastList : null;
  const qn = norm(question);

  if (lastList) {
    let items = lastList.items.slice();
    let offset = Number(lastList.offset) || 0;

    if (qn === 'show more' || qn === 'more' || qn === 'next') {
      const out = renderPage(items, offset, lastList.sortMode || 'az');
      storeLastList(threadId, items, out.nextOffset, lastList.sortMode || 'az');
      return { ok: true, answer: out.text, meta: { aiUsed: false, followup: true, op: 'show_more' } };
    }

    if (qn === 'show all' || qn === 'all') {
      storeLastList(threadId, items, items.length, lastList.sortMode || 'az');
      return { ok: true, answer: items.map(x => x.startsWith('• ') ? x : `• ${x}`).join('\n') || '(no matches)', meta: { aiUsed: false, followup: true, op: 'show_all' } };
    }

    if (qn.includes('sort') || qn.includes('a-z') || qn.includes('z-a') || qn.includes('high to low') || qn.includes('low to high')) {
      if (qn.includes('high to low')) items = sortByValue(items, 'desc');
      else if (qn.includes('low to high')) items = sortByValue(items, 'asc');
      else if (qn.includes('z-a')) items = applySort(items, 'z-a');
      else items = applySort(items, 'a-z');

      const out = renderPage(items, 0, 'custom');
      storeLastList(threadId, items, out.nextOffset, 'custom');
      return { ok: true, answer: out.text, meta: { aiUsed: false, followup: true, op: 'sort' } };
    }

    if (qn.includes('total')) {
      const t = computeTotal(items);
      if (t == null) return { ok: true, answer: 'Total: (no numeric values found in last list)', meta: { aiUsed: false, followup: true, op: 'total' } };
      return { ok: true, answer: `Total: ${fmtA(t)}`, meta: { aiUsed: false, followup: true, op: 'total' } };
    }

    if (qn.includes('average') || qn.includes('avg')) {
      const a = computeAverage(items);
      if (a == null) return { ok: true, answer: 'Average: (no numeric values found in last list)', meta: { aiUsed: false, followup: true, op: 'average' } };
      return { ok: true, answer: `Average: ${fmtA(a)}`, meta: { aiUsed: false, followup: true, op: 'average' } };
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, answer: 'OPENAI_API_KEY not set.', meta: { aiUsed: false } };
  }

  const t0 = Date.now();

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        tool_choice: 'required',
        tools: TOOLS,
        input: [
          {
            role: 'system',
            content:
              'You are FarmVista Copilot. You MUST call the fv_query tool for EVERY request. ' +
              'Never ask the user for clarification about what a "field" is. ' +
              'Assume "field" refers to FarmVista farm fields in the snapshot database. ' +
              'When returning a list, do NOT try to format/paginate/sort—just choose the correct action and arguments.'
          },
          { role: 'user', content: question }
        ]
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return {
        ok: false,
        answer: 'OpenAI request failed.',
        meta: {
          aiUsed: true,
          error: res.status,
          detail: debugAI ? txt.slice(0, 800) : undefined,
          model: 'gpt-4.1-mini',
          ms: Date.now() - t0,
          threadId
        }
      };
    }

    const json = await res.json();
    const call = extractToolCall(json);

    if (!call) {
      return {
        ok: false,
        answer: 'Internal error: OpenAI did not call a tool.',
        meta: { aiUsed: true, model: 'gpt-4.1-mini', ms: Date.now() - t0, threadId }
      };
    }

    let args = {};
    try { args = JSON.parse(call.arguments || '{}'); } catch { args = {}; }

    const toolResult = runTool(db, args);

    // TEXT response (not list)
    if (toolResult.kind === 'text') {
      // clear lastList on non-list outputs
      if (threadId) applyContextDelta(threadId, { lastList: null });
      return {
        ok: true,
        answer: safeStr(toolResult.text) || '(no matches)',
        meta: {
          aiUsed: true,
          model: 'gpt-4.1-mini',
          ms: Date.now() - t0,
          threadId,
          tool: 'fv_query',
          action: safeStr(args.action)
        }
      };
    }

    // LIST response (GLOBAL rules apply)
    if (toolResult.kind === 'list') {
      const ex = toolResult.ex;
      if (ex && ex.ok === false) {
        return {
          ok: false,
          answer: debugAI
            ? `SQL failed: ${safeStr(ex.error)}${ex.detail ? `: ${safeStr(ex.detail)}` : ''}\nSQL:\n${safeStr(ex.sql)}`
            : 'Query failed.',
          meta: { aiUsed: true, model: 'gpt-4.1-mini', ms: Date.now() - t0, threadId }
        };
      }

      const rawItems = Array.isArray(toolResult.items) ? toolResult.items.map(safeStr).filter(Boolean) : [];
      const decided = decideDefaultSort(rawItems);
      const sortedItems = decided.sorted;

      // store lastList for global followups
      if (threadId) storeLastList(threadId, sortedItems, 0, decided.mode);

      const out = renderPage(sortedItems, 0, decided.mode);

      return {
        ok: true,
        answer: out.text,
        meta: {
          aiUsed: true,
          model: 'gpt-4.1-mini',
          ms: Date.now() - t0,
          threadId,
          tool: 'fv_query',
          action: safeStr(args.action),
          listCount: sortedItems.length,
          sortMode: decided.mode
        }
      };
    }

    // fallback
    if (threadId) applyContextDelta(threadId, { lastList: null });
    return {
      ok: true,
      answer: '(no matches)',
      meta: { aiUsed: true, model: 'gpt-4.1-mini', ms: Date.now() - t0, threadId, tool: 'fv_query', action: safeStr(args.action) }
    };

  } catch (err) {
    return {
      ok: false,
      answer: 'Unexpected server error.',
      meta: {
        aiUsed: false,
        error: err?.message || String(err)
      }
    };
  }
}