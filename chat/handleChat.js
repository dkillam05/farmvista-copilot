// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-12-handleChat-sqlFirst27-auto-first-empty-retry-dbquery-only
//
// Fix:
// ✅ Keep OpenAI-led flow (tool_choice:"auto" first)
// ✅ If Responses API returns an empty reply (no tool calls + no text),
//    retry ONCE with tool_choice:"required" but ONLY db_query tool available.
//    This prevents "No answer." and avoids resolver rabbit holes.
//
// Keeps:
// ✅ Minimal guardrails in system prompt
// ✅ Pending did-you-mean support
// ✅ Resolvers available in normal flow, but NOT in the retry fallback

'use strict';

import { ensureDbReady, getDbStatus } from "../context/snapshot-db.js";
import { runSql } from "./sqlRunner.js";

import { resolveFieldTool, resolveField } from "./resolve-fields.js";
import { resolveFarmTool, resolveFarm } from "./resolve-farms.js";
import { resolveRtkTowerTool, resolveRtkTower } from "./resolve-rtkTowers.js";
import { resolveBinSiteTool, resolveBinSite } from "./resolve-binSites.js";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").toString().trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").toString().trim();
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").toString().trim();

// -------- Minimal memory (in this file only) --------
const TTL_MS = 12 * 60 * 60 * 1000;     // 12 hours
const MAX_TURNS = 24;                   // keep small (app likes clean chat)
const THREADS = new Map();              // threadId -> { messages:[{role,content}], pending, updatedAt }

function nowMs() { return Date.now(); }

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

function pruneThreads() {
  const now = nowMs();
  for (const [k, v] of THREADS.entries()) {
    if (!v?.updatedAt || (now - v.updatedAt) > TTL_MS) THREADS.delete(k);
  }
}

function getThread(threadId) {
  if (!threadId) return null;
  const cur = THREADS.get(threadId);
  if (cur && (nowMs() - (cur.updatedAt || 0)) <= TTL_MS) return cur;

  const fresh = { messages: [], pending: null, updatedAt: nowMs() };
  THREADS.set(threadId, fresh);
  return fresh;
}

function pushMsg(thread, role, content) {
  if (!thread) return;
  thread.messages.push({ role, content: safeStr(content) });
  if (thread.messages.length > (MAX_TURNS * 2)) {
    thread.messages = thread.messages.slice(-MAX_TURNS * 2);
  }
  thread.updatedAt = nowMs();
}

function setPending(thread, pending) {
  if (!thread) return;
  thread.pending = pending || null; // { kind, query, candidates:[{id,name,score}], originalText }
  thread.updatedAt = nowMs();
}

// -------- OpenAI wrapper --------
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

  const raw = await rsp.text();
  const data = jsonTryParse(raw);
  if (!rsp.ok) {
    const msg = data?.error?.message || raw || `OpenAI error (${rsp.status})`;
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
    if (!it) continue;
    if (it.type === "message") {
      const content = Array.isArray(it.content) ? it.content : [];
      for (const c of content) {
        if (c?.type === "output_text" && typeof c.text === "string") {
          const t = c.text.trim();
          if (t) parts.push(t);
        }
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

function buildSystemPrompt(dbStatus) {
  const counts = dbStatus?.counts || {};
  const snapshotId = dbStatus?.snapshot?.id || "unknown";

  return `
You are FarmVista Copilot.

You decide what to query and how to answer. Keep it natural.
But for any database facts, you MUST use tools (no guessing).

SMALL GUARDRAILS:
1) Never guess DB facts. Use tools.
2) Never show internal IDs to the user (you may use ids internally in SQL).
3) If the user asks "how many bushels ... in storage" and they did NOT specify bins vs bags vs total,
   ask ONE clarifying question first:
   "Do you mean bin storage, field bag storage, or total (bins + bags)?"
4) CropYear (bags only): if answering a field-bag question and user didn't specify crop year,
   check distinct crop years first; only ask if 2+ years exist.

IMPORTANT: Do NOT treat crop words like "corn" or "soybeans" as a field/farm name.
Only resolve a field/farm/tower/site when the user clearly refers to one.

GRAIN LOGIC (matches the app):
- Bin bushels: SUM(binSiteBins.onHandBushels) filtered by lower(lastCropType)=lower(crop).
- Field bag bushels:
  - ratedCornBu per open putDown row =
      countFull * productsGrainBags.bushelsCorn
    + sum(partialFeet) * (productsGrainBags.bushelsCorn / productsGrainBags.lengthFt)
  - convert to crop using factors:
      corn 1.00, soybeans 0.93, wheat 1.07, milo 1.02, oats 0.78
    cropBu = ratedCornBu * factor

TOOLS AVAILABLE:
- db_query(sql, params?, limit?)
- resolve_field / resolve_farm / resolve_rtk_tower / resolve_binSite
(use resolvers only when needed)

DB snapshot: ${snapshotId}
Counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}

Key tables:
- binSiteBins(...)
- grainBagEvents(...)
- productsGrainBags(...)
`.trim();
}

function dbQueryToolDef() {
  return {
    type: "function",
    name: "db_query",
    description: "Run a read-only SQL SELECT query against the FarmVista SQLite snapshot database.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string" },
        params: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
        limit: { type: "number" }
      },
      required: ["sql"]
    }
  };
}

export async function handleChatHttp(req, res) {
  try {
    pruneThreads();

    await ensureDbReady({ force: false });
    const dbStatus = await getDbStatus();

    const body = req.body || {};
    let userText = safeStr(body.text || body.message || body.q || "").trim();
    const debugAI = !!body.debugAI;
    const threadId = safeStr(body.threadId || "").trim();

    if (!userText) return res.status(400).json({ ok: false, error: "missing_text" });

    const thread = getThread(threadId);

    // ---- pending did-you-mean yes/no ----
    if (thread && thread.pending) {
      const pend = thread.pending;

      if (isYesLike(userText)) {
        const top = pend?.candidates?.[0] || null;
        if (top?.id && top?.name) {
          userText = `${pend.originalText}\n\nUser confirmed: ${top.name} (id=${top.id}). Use that.`;
          thread.pending = null;
          thread.updatedAt = nowMs();
        }
      } else if (isNoLike(userText)) {
        thread.pending = null;
        thread.updatedAt = nowMs();
        return res.json({
          ok: true,
          text: "Okay — tell me the exact name you meant.",
          meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
        });
      }
    }

    const system = buildSystemPrompt(dbStatus);

    const input_list = [
      { role: "system", content: system },
      ...(thread?.messages || []),
      { role: "user", content: userText }
    ];

    const tools = [
      dbQueryToolDef(),
      resolveFieldTool,
      resolveFarmTool,
      resolveRtkTowerTool,
      resolveBinSiteTool
    ];

    // FIRST CALL: allow model to ask a clarifying question OR call tools
    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "auto",
      input: input_list,
      temperature: 0.2
    });

    if (Array.isArray(rsp.output)) input_list.push(...rsp.output);

    // ---- EMPTY RESPONSE SAFETY RETRY ----
    // If no tool calls and no assistant text, retry once forcing db_query only.
    // This avoids "No answer." and avoids resolver traps.
    const firstCalls = extractFunctionCalls(rsp);
    const firstText = extractAssistantText(rsp);
    if (!firstCalls.length && !firstText) {
      rsp = await openaiResponsesCreate({
        model: OPENAI_MODEL,
        tools: [dbQueryToolDef()],
        tool_choice: "required",
        input: input_list,
        temperature: 0.2
      });
      if (Array.isArray(rsp.output)) input_list.push(...rsp.output);
    }

    // Tool loop
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

        } else if (name === "resolve_field") {
          didAny = true;
          result = resolveField(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, { kind: "field", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
            return res.json({ ok: true, text: formatDidYouMean("field", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
          }

        } else if (name === "resolve_farm") {
          didAny = true;
          result = resolveFarm(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, { kind: "farm", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
            return res.json({ ok: true, text: formatDidYouMean("farm", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
          }

        } else if (name === "resolve_rtk_tower") {
          didAny = true;
          result = resolveRtkTower(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, { kind: "rtk tower", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
            return res.json({ ok: true, text: formatDidYouMean("rtk tower", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
          }

        } else if (name === "resolve_binSite") {
          didAny = true;
          result = resolveBinSite(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) setPending(thread, { kind: "bin site", query: safeStr(args.query || ""), candidates: result.candidates, originalText: safeStr(body.text || body.message || body.q || "") });
            return res.json({ ok: true, text: formatDidYouMean("bin site", result.candidates), meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined });
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

    if (thread) {
      pushMsg(thread, "user", userText);
      pushMsg(thread, "assistant", text);
    }

    const meta = { usedOpenAI: true, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null };
    return res.json({ ok: true, text, meta: debugAI ? meta : undefined });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}