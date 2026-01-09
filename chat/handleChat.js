'use strict';

import crypto from "crypto";
import OpenAI from "openai";
import { ensureDbFromSnapshot, getDb } from "../context/snapshot-db.js";
import { TOOLS } from "./tools.js";
import { executeTool } from "./toolExecutor.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleChat({ question, snapshot, threadId }) {
  if (!snapshot?.ok) return { ok: false, answer: "Snapshot not loaded." };

  ensureDbFromSnapshot(snapshot);
  const db = getDb();

  const response = await client.responses.create({
    model: "gpt-4.1",
    input: question,
    tools: TOOLS,
    tool_choice: "auto"
  });

  const msg = response.output[0];
  const toolCall = msg?.content?.find(c => c.type === "tool_call");

  if (!toolCall) {
    return { ok: true, answer: msg.content[0]?.text || "(no response)" };
  }

  const result = executeTool(db, toolCall.name, toolCall.arguments);
  if (!result.ok) return { ok: false, answer: "Query failed." };

  return {
    ok: true,
    answer: result.rows.map(r => `• ${r.field || r.tower || ""}`).join("\n")
  };
}
