'use strict';

import { ensureDbFromSnapshot, getDb } from '../context/snapshot-db.js';
import { runSql } from '../chat/sqlRunner.js';

/**
 * FarmVista Copilot Chat Handler (FULL FILE)
 * Rev: 2026-01-09-handleChat-tools-required1
 *
 * Fixes your current problem:
 * ✅ Forces OpenAI to ALWAYS call a tool (no more generic ChatGPT answers)
 * ✅ Tool executes deterministic SQL against the snapshot-built SQLite DB
 * ✅ Returns DB-backed answers (never asks “what do you mean by fields”)
 *
 * Notes:
 * - No OpenAI SDK (fetch only, Node 20)
 * - Always returns meta.aiUsed for UI debug
 */

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

/**
 * Single canonical tool:
 * The model must call fv_query for EVERY message.
 * Your code executes and formats results.
 */
const TOOLS = [
  {
    type: 'function',
    name: 'fv_query',
    description:
      'Query FarmVista snapshot SQLite for fields/farms/counties/rtk information. ' +
      'Use this for ALL user questions. Prefer exact DB-backed answers. ' +
      'If user asks "list all fields" set action="list_fields". ' +
      'If user asks "fields in <county>" set action="list_fields" + county. ' +
      'If user asks "<metric> by county" set action="group_metric" + groupBy="county" + metric. ' +
      'If user asks "which fields in <county> have <metric>" set action="drilldown_metric" + county + metric + metricGt=0.',
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
  const limit = Math.max(1, Math.min(5000, Number(args.limit) || 200));

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
    return { kind: 'lines', sql, exec: runSql({ db, sql, limitDefault: limit }),
      toLines: (rows) => rows.map(r => `• ${[safeStr(r.county), safeStr(r.state)].filter(Boolean).join(', ')}`) };
  }

  // LIST ALL FIELDS (optionally filtered by county)
  if (action === 'list_fields') {
    const county = safeStr(args.county);
    const where = [
      activeOnlyWhere()
    ];
    if (county) where.push(buildCountyWhere(county));

    const sql = `
      SELECT fields.id AS field_id, fields.name AS field
      FROM fields
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(fields.field_num, 999999) ASC, fields.name_norm ASC
      LIMIT ${limit}
    `.trim();

    return { kind: 'lines', sql, exec: runSql({ db, sql, limitDefault: limit }),
      toLines: (rows) => rows.map(r => `• ${safeStr(r.field)}`) };
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

    return { kind: 'lines', sql, exec: runSql({ db, sql, limitDefault: limit }),
      toLines: (rows) => rows.map(r => `• ${safeStr(r.groupName)} — ${fmtA(r.value)} ac`) };
  }

  // DRILLDOWN: FIELDS IN COUNTY WITH METRIC > X
  if (action === 'drilldown_metric') {
    const metric = norm(args.metric) || 'tillable';
    const col = metricCol(metric);
    const gt = (args.metricGt != null) ? Number(args.metricGt) : 0;
    const county = safeStr(args.county);
    const where = [activeOnlyWhere(), `COALESCE(fields.${col},0) > ${Number.isFinite(gt) ? gt : 0}`];
    if (county) where.push(buildCountyWhere(county));

    const sql = `
      SELECT fields.id AS field_id, fields.name AS field, COALESCE(fields.${col},0) AS value
      FROM fields
      WHERE ${where.join(' AND ')}
      ORDER BY value DESC, fields.name_norm ASC
      LIMIT ${limit}
    `.trim();

    return { kind: 'lines', sql, exec: runSql({ db, sql, limitDefault: limit }),
      toLines: (rows) => rows.map(r => `• ${safeStr(r.field)} — ${fmtA(r.value)} ac`) };
  }

  // FIELD INFO (full card, includes RTK)
  if (action === 'field_info') {
    const f = safeStr(args.field);
    if (!f) {
      return { kind: 'text', text: '(no matches)' };
    }
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
    if (!ex.ok) return { kind: 'text', text: '(no matches)', sql, error: ex.error, detail: ex.detail };
    const rows = ex.rows || [];
    if (!rows.length) return { kind: 'text', text: '(no matches)', sql };
    if (rows.length === 1) return { kind: 'text', text: formatFieldInfoRow(rows[0]), sql };
    return { kind: 'lines', sql, lines: rows.map(r => `• ${safeStr(r.field)}`) };
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
    return { kind: 'lines', sql, exec: runSql({ db, sql, limitDefault: limit }),
      toLines: (rows) => rows.map(r => `• ${safeStr(r.tower)}`) };
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
    if (!ex.ok) return { kind: 'text', text: '(no matches)', sql, error: ex.error, detail: ex.detail };
    const rows = ex.rows || [];
    if (!rows.length) return { kind: 'text', text: '(no matches)', sql };
    const r0 = rows[0];
    return {
      kind: 'text',
      sql,
      text: `RTK tower: ${safeStr(r0.tower)}\nFrequency: ${safeStr(r0.frequencyMHz)} MHz\nNetwork ID: ${safeStr(r0.networkId)}`
    };
  }

  return { kind: 'text', text: '(no matches)' };
}

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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, answer: 'OPENAI_API_KEY not set.', meta: { aiUsed: false } };
  }

  const t0 = Date.now();

  try {
    // FORCE TOOL USE
    const res = await fetch('https://api.openai.com/v1/responses', {
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
              'Assume "field" refers to farm fields in the snapshot database. ' +
              'If user asks for a list, choose list_fields. If user mentions a county, set county. ' +
              'If user asks for HEL/CRP/tillable per county, use group_metric. ' +
              'If user asks which fields have HEL in a county, use drilldown_metric with metricGt=0.'
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
      // With tool_choice=required this should not happen
      return {
        ok: false,
        answer: 'Internal error: OpenAI did not call a tool.',
        meta: { aiUsed: true, model: 'gpt-4.1-mini', ms: Date.now() - t0, threadId }
      };
    }

    let args = {};
    try { args = JSON.parse(call.arguments || '{}'); } catch { args = {}; }

    const toolResult = runTool(db, args);

    // Execute if needed
    if (toolResult.kind === 'lines' && toolResult.exec) {
      const ex = toolResult.exec;
      if (!ex.ok) {
        return {
          ok: false,
          answer: debugAI
            ? `SQL failed: ${safeStr(ex.error)}${ex.detail ? `: ${safeStr(ex.detail)}` : ''}\nSQL:\n${safeStr(ex.sql)}`
            : 'Query failed.',
          meta: { aiUsed: true, model: 'gpt-4.1-mini', ms: Date.now() - t0, threadId }
        };
      }

      const rows = ex.rows || [];
      const lines = toolResult.toLines ? toolResult.toLines(rows) : rows.map(r => `• ${JSON.stringify(r)}`);
      const text = (lines && lines.length) ? lines.join('\n') : '(no matches)';

      return {
        ok: true,
        answer: text,
        meta: {
          aiUsed: true,
          model: 'gpt-4.1-mini',
          ms: Date.now() - t0,
          threadId,
          tool: 'fv_query',
          action: safeStr(args.action),
          debugSql: debugAI ? safeStr(ex.sql) : undefined
        }
      };
    }

    if (toolResult.kind === 'lines' && Array.isArray(toolResult.lines)) {
      const text = toolResult.lines.length ? toolResult.lines.join('\n') : '(no matches)';
      return {
        ok: true,
        answer: text,
        meta: { aiUsed: true, model: 'gpt-4.1-mini', ms: Date.now() - t0, threadId, tool: 'fv_query', action: safeStr(args.action) }
      };
    }

    if (toolResult.kind === 'text') {
      return {
        ok: true,
        answer: safeStr(toolResult.text) || '(no matches)',
        meta: {
          aiUsed: true,
          model: 'gpt-4.1-mini',
          ms: Date.now() - t0,
          threadId,
          tool: 'fv_query',
          action: safeStr(args.action),
          debugSql: debugAI ? safeStr(toolResult.sql || '') : undefined
        }
      };
    }

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