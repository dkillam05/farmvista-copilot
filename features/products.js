// /features/products.js  (FULL FILE)

const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson) {
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
  if (d.__collections__ && typeof d.__collections__ === "object") return d.__collections__;
  return null;
}

function colAsArray(colsRoot, name) {
  if (!colsRoot || !colsRoot[name] || typeof colsRoot[name] !== "object") return [];
  const objMap = colsRoot[name];
  const out = [];
  for (const [id, v] of Object.entries(objMap)) {
    if (v && typeof v === "object") out.push({ id, ...v });
  }
  return out;
}

function parseTime(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof v === "object" && typeof v.__time__ === "string") {
    const ms = Date.parse(v.__time__);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function fmtDateTime(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return null;
  }
}

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function safeStr(v) {
  return v == null ? "" : String(v);
}

function stripQuotes(s) {
  let t = (s || "").toString().trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  return t;
}

function pickNeedle(q) {
  // supports:
  //   seed <needle>
  //   chemical <needle>
  //   fertilizer <needle>
  //   products <needle>
  let m =
    /^(seed|seeds)\s+(.+)$/i.exec(q) ||
    /^(chemical|chemicals)\s+(.+)$/i.exec(q) ||
    /^(fertilizer|fert)\s+(.+)$/i.exec(q) ||
    /^(product|products)\s+(.+)$/i.exec(q);
  if (!m) return { kind: "", needle: "" };
  const kind = norm(m[1]);
  const needle = stripQuotes(m[2]);
  return { kind, needle };
}

function isListQuery(qn) {
  return qn.includes("list") || qn.includes("show") || qn.includes("summary") || qn === "products";
}

function includesAny(qn, arr) {
  return arr.some((s) => qn.includes(s));
}

/* ---------------- Seed helpers ---------------- */

function seedLabel(s) {
  const brand = safeStr(s.brand).trim();
  const variety = safeStr(s.variety).trim();
  const mat = safeStr(s.maturity).trim();
  const trait = safeStr(s.traitLabel || s.trait).trim();
  const crop = safeStr(s.crop).trim();
  const bits = [];
  if (brand) bits.push(brand);
  if (variety) bits.push(variety);
  const tail = [];
  if (crop) tail.push(crop);
  if (mat) tail.push(mat);
  if (trait) tail.push(trait);
  return `${bits.join(" ")}${tail.length ? ` — ${tail.join(" • ")}` : ""}`.trim() || s.id || "Seed";
}

function matchSeed(s, nn) {
  const hay = [
    s.id,
    s.brand,
    s.variety,
    s.crop,
    s.maturity,
    s.trait,
    s.traitLabel,
    s.notes
  ]
    .map((x) => norm(x))
    .join(" ");
  return hay.includes(nn);
}

/* -------------- Chemical helpers -------------- */

function chemLabel(c) {
  const prod = safeStr(c.product).trim();
  const comp = safeStr(c.company).trim();
  const cat = safeStr(c.category).trim();
  const rate = safeStr(c.rate).trim();
  const ru = safeStr(c.rateUnit).trim();
  const carrier = safeStr(c.carrier).trim();
  const cu = safeStr(c.carrierUnit).trim();

  const bits = [];
  if (comp) bits.push(comp);
  if (cat) bits.push(cat);
  const tail = [];
  if (rate) tail.push(`${rate}${ru ? ` ${ru}` : ""}`.trim());
  if (carrier) tail.push(`${carrier}${cu ? ` ${cu}` : ""}`.trim());

  return `${prod || c.id || "Chemical"}${bits.length ? ` — ${bits.join(" • ")}` : ""}${tail.length ? ` • ${tail.join(" • ")}` : ""}`;
}

function matchChem(c, nn) {
  const hay = [
    c.id,
    c.product,
    c.company,
    c.category,
    c.moa,
    c.form,
    c.cropfit,
    c.notes
  ]
    .map((x) => norm(x))
    .join(" ");
  return hay.includes(nn);
}

/* ------------ Fertilizer helpers -------------- */

function fertLabel(f) {
  const src = safeStr(f.source).trim();
  const form = safeStr(f.form).trim();
  const n = safeStr(f.n).trim();
  const p = safeStr(f.p).trim();
  const k = safeStr(f.k).trim();
  const appliedUnit = safeStr(f.appliedUnit).trim();
  const purchaseUnit = safeStr(f.purchaseUnit).trim();
  const vendor = safeStr(f.vendor).trim();

  const bits = [];
  if (form) bits.push(form);
  if (vendor) bits.push(vendor);

  const npk = [n, p, k].every((x) => x !== "") ? `${n}-${p}-${k}` : "";

  const tail = [];
  if (npk) tail.push(`NPK ${npk}`);
  if (appliedUnit) tail.push(`appliedUnit ${appliedUnit}`);
  if (purchaseUnit) tail.push(`purchaseUnit ${purchaseUnit}`);

  return `${src || f.id || "Fertilizer"}${bits.length ? ` — ${bits.join(" • ")}` : ""}${tail.length ? ` • ${tail.join(" • ")}` : ""}`;
}

function matchFert(f, nn) {
  const hay = [
    f.id,
    f.source,
    f.form,
    f.vendor,
    f.notes,
    f.n,
    f.p,
    f.k
  ]
    .map((x) => norm(x))
    .join(" ");
  return hay.includes(nn);
}

/* ------------ Grain bag products -------------- */

function gbLabel(g) {
  const brand = safeStr(g.brand).trim();
  const dia = g.diameterFt != null ? `${g.diameterFt}` : "";
  const len = g.lengthFt != null ? `${g.lengthFt}` : "";
  const thick = g.thicknessMil != null ? `${g.thicknessMil} mil` : "";
  const bu = g.bushels != null ? `${fmtInt(g.bushels)} bu` : "";
  const bits = [];
  if (dia && len) bits.push(`${dia}x${len}`);
  if (thick) bits.push(thick);
  if (bu) bits.push(bu);
  return `${brand || g.id || "Grain Bag"}${bits.length ? ` — ${bits.join(" • ")}` : ""}`;
}

function matchGB(g, nn) {
  const hay = [
    g.id,
    g.brand,
    g.diameterFt,
    g.lengthFt,
    g.thicknessMil,
    g.bushels,
    g.notes
  ]
    .map((x) => norm(x))
    .join(" ");
  return hay.includes(nn);
}

/* ---------------- Main feature ---------------- */

export function canHandleProducts(question) {
  const q = norm(question);
  if (!q) return false;

  // broad triggers
  if (q === "products" || q.startsWith("products")) return true;
  if (q === "seed" || q === "seeds" || q.startsWith("seed ") || q.startsWith("seeds ")) return true;
  if (q === "chemical" || q === "chemicals" || q.startsWith("chemical ") || q.startsWith("chemicals ")) return true;
  if (q === "fertilizer" || q === "fert" || q.startsWith("fertilizer ") || q.startsWith("fert ")) return true;

  // allow "roundup" etc without prefix if they say "product roundup"
  if (q.startsWith("product ")) return true;

  // grain bag products
  if (q.includes("grain bag") && (q.includes("product") || q.includes("products"))) return true;

  // "dap" commonly asked
  if (q.includes("dap") && (q.includes("fert") || q.includes("fertilizer") || q.includes("products"))) return true;

  return false;
}

export function answerProducts({ question, snapshot }) {
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";
  if (!json) return { answer: "Snapshot is not available right now.", meta: { snapshotId } };

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };

  const chemicals = colAsArray(colsRoot, "productsChemical").map((c) => ({
    ...c,
    __createdMs: parseTime(c.createdAt) || null,
    __updatedMs: parseTime(c.updatedAt) || null
  }));

  const fertilizers = colAsArray(colsRoot, "productsFertilizer").map((f) => ({
    ...f,
    __createdMs: parseTime(f.createdAt) || null,
    __updatedMs: parseTime(f.updatedAt) || null
  }));

  const grainBags = colAsArray(colsRoot, "productsGrainBags").map((g) => ({
    ...g,
    __createdMs: parseTime(g.createdAt) || null,
    __updatedMs: parseTime(g.updatedAt) || null
  }));

  const seeds = colAsArray(colsRoot, "productsSeed").map((s) => ({
    ...s,
    __createdMs: parseTime(s.createdAt) || null,
    __updatedMs: parseTime(s.updatedAt) || null
  }));

  const hasAny = chemicals.length || fertilizers.length || grainBags.length || seeds.length;
  if (!hasAny) return { answer: "No products collections found in the snapshot.", meta: { snapshotId } };

  const { kind, needle } = pickNeedle(q);
  const nn = norm(needle);

  // quick direct modes from plain text
  const wantsSeed = kind === "seed" || kind === "seeds" || qn.startsWith("seed") || qn.startsWith("seeds");
  const wantsChem = kind === "chemical" || kind === "chemicals" || qn.startsWith("chemical") || qn.startsWith("chemicals");
  const wantsFert = kind === "fertilizer" || kind === "fert" || qn.startsWith("fertilizer") || qn.startsWith("fert");
  const wantsGB = qn.includes("grain bag") && (qn.includes("product") || qn.includes("products"));

  // summary
  if (qn === "products" || qn === "products summary" || (isListQuery(qn) && !needle && !wantsSeed && !wantsChem && !wantsFert && !wantsGB)) {
    const usedSeeds = seeds.filter((s) => s.used === true).length;
    const unusedSeeds = seeds.filter((s) => s.used === false).length;

    return {
      answer:
        `Products summary (snapshot ${snapshotId}):\n` +
        `• Chemicals: ${chemicals.length}\n` +
        `• Fertilizers: ${fertilizers.length}\n` +
        `• Grain bag products: ${grainBags.length}\n` +
        `• Seed varieties: ${seeds.length} (used: ${usedSeeds} • unused: ${unusedSeeds})\n\n` +
        `Try:\n` +
        `• seed list\n` +
        `• seed search 114\n` +
        `• chemical roundup\n` +
        `• fertilizer dap\n` +
        `• grain bag products`,
      meta: { snapshotId, chemicals: chemicals.length, fertilizers: fertilizers.length, grainBags: grainBags.length, seeds: seeds.length }
    };
  }

  // ---- SEED ----
  if (wantsSeed) {
    if (!needle || includesAny(qn, ["list", "show", "summary"])) {
      // list compact
      const byCrop = (crop) => seeds.filter((s) => norm(s.crop) === crop);
      const corn = byCrop("corn");
      const soy = byCrop("soybean");
      const other = seeds.filter((s) => !["corn", "soybean"].includes(norm(s.crop)));

      const pick = (arr) => arr
        .slice()
        .sort((a, b) => safeStr(a.brand).localeCompare(safeStr(b.brand)) || safeStr(a.variety).localeCompare(safeStr(b.variety)))
        .slice(0, 20);

      const lines = [];
      const addGroup = (title, arr) => {
        if (!arr.length) return;
        lines.push(`${title} (${arr.length}):`);
        for (const s of pick(arr)) lines.push(`• ${seedLabel(s)} (${s.id})${typeof s.used === "boolean" ? ` • ${s.used ? "used" : "unused"}` : ""}`);
        if (arr.length > 20) lines.push(`• …and ${arr.length - 20} more`);
        lines.push("");
      };

      addGroup("Corn", corn);
      addGroup("Soybean", soy);
      addGroup("Other", other);

      return {
        answer:
          `Seed products (snapshot ${snapshotId}): total ${seeds.length}\n\n` +
          (lines.join("\n").trim() || "No seed records.") +
          `\n\nTry:\n• seed search 114\n• seed Asgrow\n• seed Enlist\n• seed variety 14830W`,
        meta: { snapshotId, seeds: seeds.length }
      };
    }

    // search seeds
    const hits = seeds.filter((s) => matchSeed(s, nn));
    if (!hits.length) return { answer: `No seed match for "${needle}". Try "seed list".`, meta: { snapshotId } };

    const lines = hits
      .slice()
      .sort((a, b) => safeStr(a.brand).localeCompare(safeStr(b.brand)) || safeStr(a.variety).localeCompare(safeStr(b.variety)))
      .slice(0, 25)
      .map((s) => {
        const used = typeof s.used === "boolean" ? (s.used ? "used" : "unused") : "";
        const upd = fmtDateTime(s.__updatedMs) || "";
        const bits = [];
        if (used) bits.push(used);
        if (upd) bits.push(`updated ${upd}`);
        return `• ${seedLabel(s)} (${s.id})${bits.length ? ` • ${bits.join(" • ")}` : ""}`;
      });

    return {
      answer:
        `Seed search "${needle}" (snapshot ${snapshotId}) — matches: ${hits.length}\n` +
        lines.join("\n") +
        (hits.length > 25 ? `\n\n(Showing first 25)` : ""),
      meta: { snapshotId, matches: hits.length }
    };
  }

  // ---- CHEMICAL ----
  if (wantsChem || qn.startsWith("chemical") || qn.startsWith("chemicals")) {
    if (!needle || includesAny(qn, ["list", "show", "summary"])) {
      const lines = chemicals
        .slice()
        .sort((a, b) => safeStr(a.product).localeCompare(safeStr(b.product)))
        .slice(0, 25)
        .map((c) => `• ${chemLabel(c)} (${c.id})`);

      return {
        answer:
          `Chemical products (snapshot ${snapshotId}): ${chemicals.length}\n\n` +
          (lines.length ? lines.join("\n") : "No chemicals.") +
          (chemicals.length > 25 ? `\n\n(Showing first 25)` : "") +
          `\n\nTry:\n• chemical roundup\n• chemical Bayer\n• chemical herbicide`,
        meta: { snapshotId, chemicals: chemicals.length }
      };
    }

    const hits = chemicals.filter((c) => matchChem(c, nn));
    if (!hits.length) return { answer: `No chemical match for "${needle}". Try "chemicals list".`, meta: { snapshotId } };

    const lines = hits
      .slice()
      .sort((a, b) => safeStr(a.product).localeCompare(safeStr(b.product)))
      .slice(0, 25)
      .map((c) => {
        const upd = fmtDateTime(c.__updatedMs) || "";
        const bits = [];
        if (c.status) bits.push(c.status);
        if (upd) bits.push(`updated ${upd}`);
        return `• ${chemLabel(c)} (${c.id})${bits.length ? ` • ${bits.join(" • ")}` : ""}`;
      });

    return {
      answer:
        `Chemical search "${needle}" (snapshot ${snapshotId}) — matches: ${hits.length}\n` +
        lines.join("\n") +
        (hits.length > 25 ? `\n\n(Showing first 25)` : ""),
      meta: { snapshotId, matches: hits.length }
    };
  }

  // ---- FERTILIZER ----
  if (wantsFert || qn.startsWith("fertilizer") || qn.startsWith("fert ")) {
    if (!needle || includesAny(qn, ["list", "show", "summary"])) {
      const lines = fertilizers
        .slice()
        .sort((a, b) => safeStr(a.source).localeCompare(safeStr(b.source)))
        .slice(0, 25)
        .map((f) => `• ${fertLabel(f)} (${f.id})`);

      return {
        answer:
          `Fertilizer products (snapshot ${snapshotId}): ${fertilizers.length}\n\n` +
          (lines.length ? lines.join("\n") : "No fertilizers.") +
          (fertilizers.length > 25 ? `\n\n(Showing first 25)` : "") +
          `\n\nTry:\n• fertilizer dap\n• fertilizer 18-46-0\n• fertilizer dry`,
        meta: { snapshotId, fertilizers: fertilizers.length }
      };
    }

    const hits = fertilizers.filter((f) => matchFert(f, nn));
    if (!hits.length) return { answer: `No fertilizer match for "${needle}". Try "fertilizer list".`, meta: { snapshotId } };

    const lines = hits
      .slice()
      .sort((a, b) => safeStr(a.source).localeCompare(safeStr(b.source)))
      .slice(0, 25)
      .map((f) => {
        const upd = fmtDateTime(f.__updatedMs) || "";
        const bits = [];
        if (f.status) bits.push(f.status);
        if (upd) bits.push(`updated ${upd}`);
        return `• ${fertLabel(f)} (${f.id})${bits.length ? ` • ${bits.join(" • ")}` : ""}`;
      });

    return {
      answer:
        `Fertilizer search "${needle}" (snapshot ${snapshotId}) — matches: ${hits.length}\n` +
        lines.join("\n") +
        (hits.length > 25 ? `\n\n(Showing first 25)` : ""),
      meta: { snapshotId, matches: hits.length }
    };
  }

  // ---- GRAIN BAG PRODUCTS ----
  if (wantsGB || qn.includes("grain bag products")) {
    const lines = grainBags
      .slice()
      .sort((a, b) => safeStr(a.brand).localeCompare(safeStr(b.brand)) || (Number(a.diameterFt) || 0) - (Number(b.diameterFt) || 0))
      .slice(0, 25)
      .map((g) => `• ${gbLabel(g)} (${g.id})`);

    return {
      answer:
        `Grain bag products (snapshot ${snapshotId}): ${grainBags.length}\n\n` +
        (lines.length ? lines.join("\n") : "No grain bag products.") +
        (grainBags.length > 25 ? `\n\n(Showing first 25)` : "") +
        `\n\nTry:\n• grain bag products\n• products grain bags`,
      meta: { snapshotId, grainBags: grainBags.length }
    };
  }

  // fallback: if user typed "products <needle>" => search across all
  if (qn.startsWith("products ") || qn.startsWith("product ")) {
    const needle2 = stripQuotes(q.replace(/^products?\s+/i, ""));
    const nn2 = norm(needle2);

    const seedHits = seeds.filter((s) => matchSeed(s, nn2)).slice(0, 10);
    const chemHits = chemicals.filter((c) => matchChem(c, nn2)).slice(0, 10);
    const fertHits = fertilizers.filter((f) => matchFert(f, nn2)).slice(0, 10);
    const gbHits = grainBags.filter((g) => matchGB(g, nn2)).slice(0, 10);

    const lines = [];
    if (seedHits.length) {
      lines.push(`Seeds (${seedHits.length} shown):`);
      seedHits.forEach((s) => lines.push(`• ${seedLabel(s)} (${s.id})`));
      lines.push("");
    }
    if (chemHits.length) {
      lines.push(`Chemicals (${chemHits.length} shown):`);
      chemHits.forEach((c) => lines.push(`• ${chemLabel(c)} (${c.id})`));
      lines.push("");
    }
    if (fertHits.length) {
      lines.push(`Fertilizers (${fertHits.length} shown):`);
      fertHits.forEach((f) => lines.push(`• ${fertLabel(f)} (${f.id})`));
      lines.push("");
    }
    if (gbHits.length) {
      lines.push(`Grain bag products (${gbHits.length} shown):`);
      gbHits.forEach((g) => lines.push(`• ${gbLabel(g)} (${g.id})`));
      lines.push("");
    }

    if (!lines.length) return { answer: `No product matches for "${needle2}". Try "products summary".`, meta: { snapshotId } };

    return {
      answer:
        `Product search "${needle2}" (snapshot ${snapshotId}):\n\n` +
        lines.join("\n").trim() +
        `\n\nTry:\n• seed ${needle2}\n• chemical ${needle2}\n• fertilizer ${needle2}`,
      meta: { snapshotId }
    };
  }

  return {
    answer:
      `Try:\n` +
      `• products summary\n` +
      `• seed list\n` +
      `• seed search 114\n` +
      `• chemical roundup\n` +
      `• fertilizer dap\n` +
      `• grain bag products`,
    meta: { snapshotId }
  };
}
