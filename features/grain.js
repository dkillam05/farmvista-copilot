// /features/grain.js  (FULL FILE)
// Rev: 2025-12-30-human-grain (Human phrasing tolerant; no CLI "Try:" menus; keep data logic intact)

const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson){
  const d = snapshotJson || {};
  // Firefoo export format:
  // { data: { __collections__: { ... } } }
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  // Some snapshots may already store just __collections__
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  return null;
}

function colAsArray(colsRoot, name){
  if (!colsRoot || !colsRoot[name] || typeof colsRoot[name] !== "object") return [];
  const objMap = colsRoot[name];
  const out = [];
  for (const [id, v] of Object.entries(objMap)) {
    if (v && typeof v === "object") out.push({ id, ...v });
  }
  return out;
}

function toNum(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtInt(n){
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function fmtBu(n){
  const v = Number(n) || 0;
  const digits = v >= 1000 ? 0 : 1;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function guessBagsOnHand(d){
  // Matches your dashboard KPI behavior: onHand wins, else qty, else 0
  if (d.onHand != null) return toNum(d.onHand);
  if (d.qty != null) return toNum(d.qty);
  return 0;
}

function guessCornBuPerBag(d){
  const keys = ["cornBuPerBag", "bagCornBu", "bushelsPerBag", "capacityCornBu", "ratedCornBu"];
  for (const k of keys) {
    if (d[k] != null && Number.isFinite(Number(d[k]))) return Number(d[k]);
  }
  return 0;
}

function guessSkuLabel(d){
  return (
    (d.sku || d.productSku || d.bagSku || "").toString().trim() ||
    (d.name || d.productName || d.bagName || "").toString().trim() ||
    (d.id || "").toString().trim() ||
    "Unknown SKU"
  );
}

// Human-ish intent detection helpers
function wantsSummary(qn){
  if (!qn) return false;
  if (qn === "grain" || qn === "grain summary" || qn === "summary grain") return true;
  if (qn === "show grain" || qn === "show me grain" || qn === "grain overview") return true;
  return false;
}

function wantsBags(qn){
  if (!qn) return false;
  return (
    qn.includes("grain bag") ||
    qn.includes("grain bags") ||
    qn.includes("bag inventory") ||
    qn.includes("bags on hand") ||
    qn === "bags" ||
    qn === "bag" ||
    qn === "show bags"
  );
}

function wantsBins(qn){
  if (!qn) return false;
  return (
    qn.includes("grain bin") ||
    qn.includes("grain bins") ||
    qn === "bins" ||
    qn === "bin" ||
    qn === "show bins"
  );
}

export function canHandleGrain(question){
  const q = norm(question);
  if (!q) return false;

  if (wantsSummary(q)) return true;
  if (wantsBags(q)) return true;
  if (wantsBins(q)) return true;

  // quick commands
  if (q.startsWith("sku ")) return true;
  if (q.startsWith("grain sku ")) return true;
  if (q.startsWith("bags sku ")) return true;

  return false;
}

export function answerGrain({ question, snapshot, intent }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";

  if (!json) {
    return {
      answer: "Snapshot is not available right now.",
      meta: { snapshotId, snapshotError: snapshot?.lastError || null }
    };
  }

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) {
    return {
      answer: "I can’t find grain collections in this snapshot right now.",
      meta: { snapshotId }
    };
  }

  const bagMoves = colAsArray(colsRoot, "inventoryGrainBagMovements"); // SKU-ish docs w/ onHand
  const bagEvents = colAsArray(colsRoot, "grain_bag_events");          // event log
  const binSites = colAsArray(colsRoot, "binSites");                   // bins metadata
  const binMoves = colAsArray(colsRoot, "binMovements");               // bin movement log

  // ---------
  // SKU filter: "grain sku x" or "sku x" or "bags sku x"
  // ---------
  let skuNeedle = null;
  let m = /^grain\s+sku\s+(.+)$/i.exec(q) || /^sku\s+(.+)$/i.exec(q) || /^bags\s+sku\s+(.+)$/i.exec(q);
  if (m) skuNeedle = (m[1] || "").trim();

  // ---------
  // BAGS SUMMARY (default)
  // ---------
  function summarizeBags(list){
    let totalBags = 0;
    let totalCornBu = 0;

    const perSku = [];
    for (const d of list) {
      const onHand = guessBagsOnHand(d);
      if (!(onHand > 0)) continue;

      const sku = guessSkuLabel(d);
      const cornBuPerBag = guessCornBuPerBag(d);
      const cornBuTotal = cornBuPerBag > 0 ? (onHand * cornBuPerBag) : 0;

      totalBags += onHand;
      totalCornBu += cornBuTotal;

      perSku.push({
        sku,
        onHand,
        cornBuPerBag,
        cornBuTotal
      });
    }

    // sort by bags desc
    perSku.sort((a, b) => (b.onHand - a.onHand));

    return { totalBags, totalCornBu, perSku };
  }

  // apply sku filter if requested
  const bagMovesFiltered = skuNeedle
    ? bagMoves.filter(d => guessSkuLabel(d).toLowerCase().includes(skuNeedle.toLowerCase()))
    : bagMoves;

  const bagSum = summarizeBags(bagMovesFiltered);

  // ---------
  // BINS SUMMARY (simple)
  // ---------
  const binsCount = binSites.length;
  const binMovesCount = binMoves.length;

  // ---------
  // Decide response type
  // ---------
  const mode = intent && intent.mode ? String(intent.mode) : null;

  if (wantsSummary(qn) || mode === "summary") {
    const parts = [];
    parts.push(`Grain summary:`);

    parts.push(`• Grain bag SKUs: ${fmtInt(bagMoves.length)}`);
    parts.push(`• Bags on hand: ${fmtInt(bagSum.totalBags)}`);
    if (bagSum.totalCornBu > 0) parts.push(`• Corn-rated bushels on hand: ${fmtBu(bagSum.totalCornBu)} bu`);

    parts.push(`• Bin sites: ${fmtInt(binsCount)}`);
    parts.push(`• Bin movement records: ${fmtInt(binMovesCount)}`);
    parts.push(`• Grain bag event records: ${fmtInt(bagEvents.length)}`);

    return { answer: parts.join("\n"), meta: { snapshotId } };
  }

  if (wantsBags(qn) || skuNeedle || mode === "bags") {
    if (!bagMoves.length) {
      return { answer: "No grain bag inventory records were found in the snapshot.", meta: { snapshotId } };
    }

    const title = skuNeedle ? `Grain bags on hand (filtered by “${skuNeedle}”)` : "Grain bags on hand";
    const lines = [];

    const show = bagSum.perSku.slice(0, 40); // keep it readable
    for (const row of show) {
      const bits = [];
      bits.push(`${fmtInt(row.onHand)} bags`);
      if (row.cornBuPerBag > 0) bits.push(`${fmtBu(row.cornBuPerBag)} corn bu/bag`);
      if (row.cornBuTotal > 0) bits.push(`${fmtBu(row.cornBuTotal)} corn bu total`);
      lines.push(`• ${row.sku} — ${bits.join(" • ")}`);
    }

    let footer = "";
    if (bagSum.perSku.length > 40) footer = `\n(Showing first 40 of ${bagSum.perSku.length} SKUs)`;

    const totals = [];
    totals.push(`Totals: ${fmtInt(bagSum.totalBags)} bags`);
    if (bagSum.totalCornBu > 0) totals.push(`${fmtBu(bagSum.totalCornBu)} corn-rated bu`);

    // If SKU filter produced nothing, say it plainly
    if (skuNeedle && bagSum.perSku.length === 0) {
      return {
        answer: `I didn’t find any grain bag SKUs on hand that match “${skuNeedle}”.`,
        meta: { snapshotId, skuFilter: skuNeedle, skuCount: bagMovesFiltered.length }
      };
    }

    return {
      answer: `${title}:\n\n${lines.join("\n")}\n\n${totals.join(" • ")}${footer}`,
      meta: {
        snapshotId,
        skuFilter: skuNeedle || null,
        skuCount: bagMovesFiltered.length
      }
    };
  }

  if (wantsBins(qn) || mode === "bins") {
    if (!binSites.length) {
      return { answer: "No bin sites were found in the snapshot.", meta: { snapshotId } };
    }

    const names = binSites.slice(0, 30).map((b, i) => {
      const label =
        (b.name || b.siteName || b.label || "").toString().trim() ||
        (b.id || "").toString().trim() ||
        `Bin Site ${i + 1}`;
      const loc = (b.location || b.town || b.city || "").toString().trim();
      return `• ${label}${loc ? ` — ${loc}` : ""}`;
    });

    return {
      answer:
        `Bin sites (${binSites.length}):\n\n` +
        names.join("\n") +
        (binSites.length > 30 ? `\n\n(Showing first 30)` : "") +
        `\n\nBin movement records: ${fmtInt(binMoves.length)}`,
      meta: { snapshotId, binSites: binSites.length, binMoves: binMoves.length }
    };
  }

  // Default (human, not a command menu)
  return {
    answer:
      `I can summarize grain, show grain bags on hand, or list bin sites.\n` +
      `For example: “grain summary”, “grain bags”, or “grain bins”.`,
    meta: { snapshotId }
  };
}
