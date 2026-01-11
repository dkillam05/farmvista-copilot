// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-11-handleChat-sqlFirst13-registry-tools-context
//
// This is the reset.
// ✅ No brittle FAST routes
// ✅ OpenAI interprets every question
// ✅ Deterministic DB via db_query
// ✅ Generic resolver: resolve_entity(type, query)
// ✅ Generic memory for human follow-ups (list selection, yes/no)
//
// You are NOT programming questions.
// You are providing tools + schema + a small generic context layer.

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { resolveEntityTool, resolveEntityGeneric } from "./resolve-entity.js";
import { getEntity, listEntityTypes, detectRefinement } from "./entityRegistry.js";
import {
  pruneContextStore,
  setLastList,
  getLastList,
  setLastSelection,
  getLastSelection,
  setPending,
  getPending,
  clearPending
} from "./contextStore.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString().trim();
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString().trim();

function safeStr(v) { return (v == null ? "" : String(v)); }
function norm(s) { return safeStr(s).trim().toLowerCase(); }
function jsonTryParse(s) { try { return JSON.parse(s); } catch { return null; } }

function isYesLike(s) {
  const v = norm(s);
  return ["yes", "y", "yep", "yeah", "correct", "right", "ok", "okay", "sure"].includes(v);
}
function isNoLike(s) {
  const v = norm(s);
  return ["no", "n", "nope", "nah"].includes(v);
}

async function openaiResponsesCreate(payload) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const rsp = await fetch(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const text = await rsp.text();
  const data = jsonTryParse(text);
  if (!rsp.ok) {
    const msg = data?.error?.message || text || `OpenAI error (${rsp.status})`;
    throw new Error(msg);
  }
  return data;
}

function extractFunctionCalls(responseJson) {
  const items = Array.isArray(responseJson?.output) ? responseJson.output : [];
  return items.filter(it => it && it.type === "function_call");
}

function extractAssistantText(responseJson) {
  const direct = safeStr(responseJson?.output_text || "").trim();
  if (direct) return direct;

  const items = Array.isArray(responseJson?.output) ? responseJson.output : [];
  const parts = [];
  for (const it of items) {
    if (it?.type === "message") {
      for (const c of (it.content || [])) {
        if (c?.type === "output_text" && typeof c.text === "string" && c.text.trim()) parts.push(c.text.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function formatDidYouMean(kind, candidates) {
  const lines = [];
  lines.push(`Did you mean (${kind}):`);
  for (const c of (candidates || []).slice(0, 8)) lines.push(`- ${c.name}`);
  lines.push(``);
  lines.push(`Reply with the exact name, or say "yes" to pick the first one.`);
  return lines.join("\n");
}

function parseNumberSelection(text) {
  // "number 5", "farm number 5", "#5"
  const t = norm(text);
  let m = t.match(/\b(farm\s*)?(number|#)\s*(\d{1,3})\b/);
  if (m) return Number(m[3]);
  m = t.match(/\b(\d{1,3})\b/);
  // only accept pure numeric message
  if (m && t === m[1]) return Number(m[1]);
  return null;
}

function buildSystemPrompt(dbStatus, threadId) {
  const counts = dbStatus?.counts || {};
  const snapshotId = dbStatus?.snapshot?.id || "unknown";

  const lastList = threadId ? getLastList(threadId) : null;
  const lastSel = threadId ? getLastSelection(threadId) : null;

  return `
You are FarmVista Copilot.

YOU do 100% of language understanding and deciding which tools to call.
But you MUST use tools for database facts.

HARD RULES:
- Never guess DB facts. Use tools.
- Do NOT show IDs. Use IDs internally.
- Active-by-default: unless user explicitly asks archived/inactive, apply active filter:
  (archived IS NULL OR archived = 0)

TOOLS:
- resolve_entity(type, query) -> match or candidates
- db_query(sql, params?, limit?) -> SELECT-only

ENTITY TYPES:
${listEntityTypes().join(", ")}

GENERIC FOLLOW-UP BEHAVIOR:
- If user says "number 5" and there is a last list, interpret it as selecting item #5 from that list.
- If user asks to "include/add/with" after a list, treat it as a refinement of that same list.

CONTEXT (server memory, not shown to user):
- lastList: ${lastList ? `${lastList.type} (${lastList.items.length} items)` : "none"}
- lastSelection: ${lastSel ? `${lastSel.type} (${lastSel.item?.name || ""})` : "none"}

Snapshot: ${snapshotId}
Counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}
`.trim();
}

// Detect list queries so we can store lastList deterministically
function maybeCaptureLastList(threadId, sql, rows) {
  if (!threadId || !sql || !Array.isArray(rows) || !rows.length) return;

  const low = sql.toLowerCase();
  const cap = (type) => {
    const ent = getEntity(type);
    if (!ent) return;
    // If rows contain id+name, store as lastList
    if (rows[0]?.id != null && rows[0]?.name != null) {
      setLastList(threadId, type, rows.map(r => ({ id: String(r.id), name: String(r.name) })));
    }
  };

  if (low.includes(" from farms")) cap("farms");
  else if (low.includes(" from fields")) cap("fields");
  else if (low.includes(" from rtktowers")) cap("rtkTowers");
}

export async function handleChatHttp(req, res) {
  try {
    pruneContextStore();

    await ensureDbReady({ force: false });
    const dbStatus = await getDbStatus();

    const body = req.body || {};
    let userText = safeStr(body.text || body.message || body.q || "").trim();
    const debugAI = !!body.debugAI;
    const threadId = safeStr(body.threadId || "").trim();

    if (!userText) return res.status(400).json({ ok: false, error: "missing_text" });

    // 1) Handle pending "did you mean" with yes/no generically
    const pend = threadId ? getPending(threadId) : null;
    if (threadId && pend) {
      if (isYesLike(userText)) {
        const top = pend?.candidates?.[0] || null;
        if (top?.id && top?.name) {
          clearPending(threadId);
          // rewrite userText to include confirmed entity name and type
          userText = `${pend.originalText}\n\nUser confirmed ${pend.kind}: ${top.name}.`;
          setLastSelection(threadId, pend.kind, { id: top.id, name: top.name });
        }
      } else if (isNoLike(userText)) {
        clearPending(threadId);
        return res.json({
          ok: true,
          text: "Okay — tell me the exact name you meant.",
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
        });
      }
    }

    // 2) Handle "number N" selection from last list generically
    const n = parseNumberSelection(userText);
    if (threadId && n != null) {
      const ll = getLastList(threadId);
      if (ll && Array.isArray(ll.items) && ll.items.length >= n && n > 0) {
        const pick = ll.items[n - 1];
        setLastSelection(threadId, ll.type, { id: pick.id, name: pick.name });
        return res.json({
          ok: true,
          text: `Got it — #${n} is ${pick.name}. What would you like to know about it?`,
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
        });
      }
    }

    // 3) Handle generic list refinement: "include acres" after a farms list
    if (threadId) {
      const ll = getLastList(threadId);
      if (ll && ll.type) {
        const refKey = detectRefinement(ll.type, userText);
        if (refKey) {
          const ent = getEntity(ll.type);
          const ref = ent?.refinements?.[refKey];
          if (ref?.sql) {
            const r = runSql({ sql: ref.sql, limit: 500 });
            const rows = r.rows || [];
            // refresh last list with id+name
            if (rows.length && rows[0]?.id != null && rows[0]?.name != null) {
              setLastList(threadId, ll.type, rows.map(x => ({ id: String(x.id), name: String(x.name) })));
            }
            const lines = rows.map(ref.formatRow).filter(Boolean);
            return res.json({
              ok: true,
              text: lines.join("\n") || "No results.",
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }
        }
      }
    }

    // 4) Normal OpenAI tool calling (OpenAI does 100% interpretation)
    const tools = [
      {
        type: "function",
        name: "db_query",
        description: "Run a read-only SQL SELECT query against the FarmVista SQLite snapshot database.",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string" },
            params: { type: "array", items: { type: ["string","number","boolean","null"] } },
            limit: { type: "number" }
          },
          required: ["sql"]
        }
      },
      resolveEntityTool
    ];

    const system = buildSystemPrompt(dbStatus, threadId);

    const input_list = [
      { role: "system", content: system },
      { role: "user", content: userText }
    ];

    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "required",
      input: input_list,
      temperature: 0.2
    });

    if (Array.isArray(rsp.output)) input_list.push(...rsp.output);

    for (let i = 0; i < 10; i++) {
      const calls = extractFunctionCalls(rsp);
      if (!calls.length) break;

      let didAny = false;

      for (const call of calls) {
        const name = safeStr(call?.name);
        const args = jsonTryParse(call.arguments) || {};
        let result = null;

        if (name === "db_query") {
          didAny = true;
          try {
            result = runSql({
              sql: safeStr(args.sql || ""),
              params: Array.isArray(args.params) ? args.params : [],
              limit: Number.isFinite(args.limit) ? args.limit : 200
            });
          } catch (e) {
            result = { ok: false, error: e?.message || String(e) };
          }

          // capture lastList opportunistically
          if (threadId && result?.rows && typeof args.sql === "string") {
            maybeCaptureLastList(threadId, args.sql, result.rows);
          }

        } else if (name === "resolve_entity") {
          didAny = true;
          const type = safeStr(args.type || "");
          const query = safeStr(args.query || "");
          result = resolveEntityGeneric(type, query);

          // if candidates, store pending for yes/no
          if (threadId && result?.ok !== false && !result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            setPending(threadId, {
              kind: type,
              query,
              candidates: result.candidates,
              originalText: userText,
              createdAt: Date.now()
            });

            return res.json({
              ok: true,
              text: formatDidYouMean(type, result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }

          // if match, store last selection
          if (threadId && result?.match?.id) {
            setLastSelection(threadId, type, { id: result.match.id, name: result.match.name });
          }
        }

        input_list.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result ?? { ok: false, error: "no_result" })
        });
      }

      if (!didAny) break;

      rsp = await openaiResponsesCreate({
        model: OPENAI_MODEL,
        tools,
        tool_choice: "auto",
        input: input_list,
        temperature: 0.2
      });

      if (Array.isArray(rsp.output)) input_list.push(...rsp.output);
    }

    const text = extractAssistantText(rsp) || "No answer.";

    const meta = {
      usedOpenAI: true,
      model: OPENAI_MODEL,
      snapshot: dbStatus?.snapshot || null
    };

    return res.json({ ok: true, text, meta: debugAI ? meta : undefined });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}