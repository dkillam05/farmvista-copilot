// /chat/handleChat.js  (FULL FILE)
// Rev: 2026-01-12-handleChat-sqlFirst22-grainCapacity-match-app
//
// Change (PROMPT ONLY):
// ✅ Grain bag bushels estimation now matches the app:
//    - ratedCornBu from productsGrainBags.bushels (per full bag)
//    - partialFeet bushels = feet * (bushels / lengthFt)
//    - convert to crop using FVGrainCapacity factors (soybeans=0.93, wheat=1.07, milo=1.02, oats=0.78)
//
// Keeps:
// ✅ cropYear clarification (bags only)
// ✅ bin inventory rule (binSiteBins)
// ✅ total bins + bags rule
// ✅ no hardcoded question handlers / no new files

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

YOU interpret the user's question 100%.
But you MUST use tools for any database facts.

HARD RULES:
1) Never guess DB facts. Use tools.
2) Do NOT show IDs to the user. You MAY select ids internally in SQL to support joins and follow-ups.
3) Active-by-default: unless the user explicitly requests archived/inactive, filter using:
   (archived IS NULL OR archived = 0)
4) Follow-ups are normal. Use conversation context.

CROP NAME MATCHING (HARD):
- Always match crops case-insensitively (lower()).
- Treat these as equivalent:
  - "soybean", "soybeans", "beans", "sb" => soybeans
  - "corn", "maize" => corn
  - "wheat", "hrw", "srw" => wheat
  - "milo", "sorghum" => milo
  - "oats" => oats

CROP YEAR RULE (HARD) — BAGS ONLY:
- Only trigger crop-year clarification when the question involves grain bags / grainBagEvents.
- If user asks anything about grain bags and does NOT specify cropYear, ask:
  "Which crop year? (ex: 2025) — or do you want combined years (ex: 2025 + 2026) / all years?"
- Do NOT ask crop year for bin inventory questions.

BIN INVENTORY RULE (HARD):
- If the user asks about bushels "in bins", "bin storage", "on hand", "grain bins":
  you MUST use binSiteBins ONLY (optionally join binSites).
- Bushels in bins = SUM(binSiteBins.onHandBushels).
- Crop in bin = binSiteBins.lastCropType.
- Filters must be case-insensitive: lower(lastCropType)=lower(?).

GRAIN BAGS BUSHELS (HARD — MATCHES APP):
- Grain bag bushels are estimated using:
  1) productsGrainBags.bushels = rated CORN bushels per FULL bag
  2) productsGrainBags.lengthFt = physical length in feet
  3) For each open grainBagEvents putDown row:
     - fullCornBu = counts.full * bushels
     - partialCornBu = SUM(partialFeet) * (bushels / lengthFt)
     - ratedCornBu = fullCornBu + partialCornBu
  4) Convert ratedCornBu to the event crop using the SAME factors as /Farm-vista/js/grain-capacity.js:
     - soybeans factor = 0.93
     - wheat factor = 1.07
     - milo factor = 1.02
     - oats factor = 0.78
     - corn factor = 1.00
     Use: cropBu = ratedCornBu * factor(crop)
- Do NOT invent factors; use exactly the above.

NOTE ABOUT JOINING (HARD):
- To map a grainBagEvents row to a product:
  - Use bagSkuId if it matches productsGrainBags.id.
  - Otherwise, join by (bagDiameterFt + bagSizeFeet) matching (productsGrainBags.diameterFt + productsGrainBags.lengthFt).
- partialFeet are stored in grainBagEvents.partialFeetJson (JSON array). Use json_each to sum feet.

TOTAL STORAGE RULE (HARD):
- If user asks for TOTAL / OVERALL / "bins + bags":
  return:
  - bins bushels (binSiteBins)
  - bag bushels (grainBagEvents + productsGrainBags + factors)
  - combined total
  - show breakdown.

TOOLS:
- resolve_field(query)
- resolve_farm(query)
- resolve_rtk_tower(query)
- resolve_binSite(query)
- db_query(sql, params?, limit?)

DB snapshot: ${snapshotId}
Counts: farms=${counts.farms ?? "?"}, fields=${counts.fields ?? "?"}, rtkTowers=${counts.rtkTowers ?? "?"}

Tables:
- grainBagEvents(id, type, datePlaced, cropType, cropYear, bagSkuId, bagDiameterFt, bagSizeFeet, countFull, countPartial, partialFeetJson, status, data)
- productsGrainBags(id, brand, diameterFt, lengthFt, bushelsCorn, status, data)
- binSites(id, name, status)
- binSiteBins(siteId, siteName, binNum, onHandBushels, lastCropType)
`.trim();
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

    // ---- Handle pending "Did you mean" with yes/no (server-side) ----
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

    // ---- Build input with minimal thread context ----
    const system = buildSystemPrompt(dbStatus);

    const input_list = [
      { role: "system", content: system },
      ...(thread?.messages || []),
      { role: "user", content: userText }
    ];

    // ---- Tools ----
    const tools = [
      {
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
      },
      resolveFieldTool,
      resolveFarmTool,
      resolveRtkTowerTool,
      resolveBinSiteTool
    ];

    // ---- OpenAI first call (must call at least one tool) ----
    let rsp = await openaiResponsesCreate({
      model: OPENAI_MODEL,
      tools,
      tool_choice: "required",
      input: input_list,
      temperature: 0.2
    });

    if (Array.isArray(rsp.output)) input_list.push(...rsp.output);

    // ---- Tool loop ----
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

        } else if (name === "resolve_binSite") {
          didAny = true;
          result = resolveBinSite(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) {
              setPending(thread, {
                kind: "bin site",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                originalText: safeStr(body.text || body.message || body.q || "")
              });
            }
            return res.json({
              ok: true,
              text: formatDidYouMean("bin site", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }

        } else if (name === "resolve_field") {
          didAny = true;
          result = resolveField(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) {
              setPending(thread, {
                kind: "field",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                originalText: safeStr(body.text || body.message || body.q || "")
              });
            }
            return res.json({
              ok: true,
              text: formatDidYouMean("field", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }

        } else if (name === "resolve_farm") {
          didAny = true;
          result = resolveFarm(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) {
              setPending(thread, {
                kind: "farm",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                originalText: safeStr(body.text || body.message || body.q || "")
              });
            }
            return res.json({
              ok: true,
              text: formatDidYouMean("farm", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
          }

        } else if (name === "resolve_rtk_tower") {
          didAny = true;
          result = resolveRtkTower(safeStr(args.query || ""));
          if (!result?.match && Array.isArray(result?.candidates) && result.candidates.length) {
            if (thread) {
              setPending(thread, {
                kind: "rtk tower",
                query: safeStr(args.query || ""),
                candidates: result.candidates,
                originalText: safeStr(body.text || body.message || body.q || "")
              });
            }
            return res.json({
              ok: true,
              text: formatDidYouMean("rtk tower", result.candidates),
              meta: debugAI ? { usedOpenAI: false, model: OPENAI_MODEL, snapshot: dbStatus?.snapshot || null } : undefined
            });
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