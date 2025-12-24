const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson){
  const d = snapshotJson || {};
  // Firefoo export format:
  // { data: { __collections__: { ... } } }
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  // Some snapshots may already store just __collections__
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  // Or may be flattened
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
  // show 0 decimals if big, 1 if small-ish
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
  // Common fields we’ve seen in your KPI logic + likely variants
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

export function canHandleGrain(question){
  const q = norm(question);
  if (!q) return false;

  if (q === "grain" || q === "grain summary") return true;
  if (q.includes("grain bag") || q.includes("grain bags")) return true;
  if (q.includes("bag inventory") || q.includes("bags on hand")) return true;
  if (q.includes("bin") || q.includes("bins")) return true;

  // quick commands
  if (q.startsWith("sku ")) return true;
  if (q.startsWith("grain sku ")) return true;

  return false;
}

export function answerGrain({ question, snapshot }){
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
      answer: "I can’t find Firefoo collections in this snapshot (expected data.__collections__).",
      meta: { snapshotId }
    };
  }

  const bagMoves = colAsArray(colsRoot, "inventoryGrainBagMovements"); // SKU-ish docs w/ onHand
  const bagEvents = colAsArray(colsRoot, "grain_bag_events");          // event log
  const binSites = colAsArray(colsRoot, "binSites");                   // bins metadata
  const binMoves = colAsArray(colsRoot, "binMovements");               // bin movement log

  // ---------
  // SKU filter: "grain sku x" or "sku x"
  // ---------
  let skuNeedle = null;
  let m = /^grain\s+sku\s+(.+)$/i.exec(q) || /^sku\s+(.+)$/i.exec(q);
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
  if (qn === "grain" || qn === "grain summary") {
    const parts = [];
    parts.push(`Grain summary (snapshot ${snapshotId}):`);
    parts.push(`• Grain bag SKUs: ${fmtInt(bagMoves.length)}`);
    parts.push(`• Bags on hand: ${fmtInt(bagSum.totalBags)}`);

    // corn-rated bu only (we’ll add crop conversion later if you want)
    if (bagSum.totalCornBu > 0) parts.push(`• Corn-rated bushels on hand: ${fmtBu(bagSum.totalCornBu)} bu`);

    parts.push(`• Bin sites: ${fmtInt(binsCount)}`);
    parts.push(`• Bin movement records: ${fmtInt(binMovesCount)}`);
    parts.push(`• Grain bag event records: ${fmtInt(bagEvents.length)}`);

    parts.push(`\nTry:`);
    parts.push(`• "grain bags"`);
    parts.push(`• "grain sku <text>"`);
    parts.push(`• "grain bins"`);

    return { answer: parts.join("\n"), meta: { snapshotId } };
  }

  if (qn.includes("grain bag") || qn.includes("grain bags") || qn.includes("bag inventory") || qn.includes("bags on hand") || skuNeedle) {
    if (!bagMoves.length) {
      return { answer: "No inventoryGrainBagMovements records found in the snapshot.", meta: { snapshotId } };
    }

    const title = skuNeedle ? `Grain bags (filtered by “${skuNeedle}”)` : "Grain bags on hand";
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

    return {
      answer: `${title}:\n\n${lines.join("\n")}\n\n${totals.join(" • ")}${footer}`,
      meta: {
        snapshotId,
        skuFilter: skuNeedle || null,
        skuCount: bagMovesFiltered.length
      }
    };
  }

  if (qn.includes("grain bin") || qn.includes("grain bins") || qn === "bins") {
    if (!binSites.length) {
      return { answer: "No binSites records found in the snapshot.", meta: { snapshotId } };
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

  return {
    answer: `Try:\n• "grain summary"\n• "grain bags"\n• "grain sku <text>"\n• "grain bins"`,
    meta: { snapshotId }
  };
}
