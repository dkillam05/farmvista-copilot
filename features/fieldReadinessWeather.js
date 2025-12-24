const norm = (s) => (s || "").toString().trim().toLowerCase();

function getCollectionsRoot(snapshotJson){
  const d = snapshotJson || {};
  if (d.data && d.data.__collections__ && typeof d.data.__collections__ === "object") return d.data.__collections__;
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

function mmToIn(mm){
  const n = Number(mm) || 0;
  return n / 25.4;
}

function fmtIn(inches){
  const v = Number(inches) || 0;
  // 2 decimals for rain is usually right
  return v.toFixed(2);
}

function fmtF(f){
  const v = Number(f);
  if (!Number.isFinite(v)) return null;
  return Math.round(v);
}

function cToF(c){
  const v = Number(c);
  if (!Number.isFinite(v)) return null;
  return (v * 9) / 5 + 32;
}

// YYYY-MM-DD in a timezone (America/Chicago)
function dateYMDInTZ(dateObj, timeZone){
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(dateObj); // "2025-12-24"
}

function hourKeyInTZ(dateObj, timeZone){
  // produce "YYYY-MM-DDTHH:00"
  const date = dateYMDInTZ(dateObj, timeZone);
  const hFmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false });
  const hh = hFmt.format(dateObj); // "00".."23"
  return `${date}T${hh}:00`;
}

function extractFieldNeedle(question){
  const q = (question || "").toString().trim();

  // Require "field ..." so we don’t guess wrong
  const m =
    /^field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^show\s+field\s*[:#]?\s*(.+)$/i.exec(q) ||
    /^open\s+field\s*[:#]?\s*(.+)$/i.exec(q);

  if (!m) return null;

  // If they wrote: "field X rain yesterday", strip trailing weather words
  let tail = (m[1] || "").trim();

  // Remove common weather phrases from the end
  tail = tail
    .replace(/\b(rain|rainfall|precip|precipitation|temp|temperature|weather)\b.*$/i, "")
    .trim();

  return tail || null;
}

function wantsRain(qn){
  return qn.includes("rain") || qn.includes("rainfall") || qn.includes("precip");
}

function wantsTemp(qn){
  return qn.includes("temp") || qn.includes("temperature");
}

function windowType(qn){
  if (qn.includes("yesterday")) return "yesterday";
  if (qn.includes("last 3") || qn.includes("past 3") || qn.includes("3 days")) return "last3days";
  if (qn.includes("today")) return "today";
  if (qn.includes("now") || qn.includes("current")) return "now";
  // default if they asked rain but no window
  return "last3days";
}

function pickWeatherDocByNeedle(weatherDocs, needleRaw){
  const needle = norm(needleRaw);
  if (!needle) return null;

  // Exact id match
  let found = weatherDocs.find(d => norm(d.fieldId) === needle || norm(d.id) === needle) || null;
  if (found) return found;

  // Exact fieldName match
  found = weatherDocs.find(d => norm(d.fieldName) === needle) || null;
  if (found) return found;

  // Contains match
  found = weatherDocs.find(d => norm(d.fieldName).includes(needle)) || null;
  if (found) return found;

  // If numeric, try matching fieldNumber-like in fieldName
  if (/^[0-9]+$/.test(needleRaw.trim())) {
    found = weatherDocs.find(d => norm(d.fieldName).includes(` ${needleRaw.trim()} `) || norm(d.fieldName).includes(`${needleRaw.trim()}-`)) || null;
  }

  return found;
}

function sumRainForDates(hourly, datesSet){
  let mm = 0;
  for (const h of hourly) {
    const t = (h && h.time) ? String(h.time) : "";
    const date = t.slice(0, 10); // "YYYY-MM-DD"
    if (!datesSet.has(date)) continue;
    mm += Number(h.rain_mm) || 0;
  }
  return mm;
}

function sumRainForDate(hourly, dateYMD){
  return sumRainForDates(hourly, new Set([dateYMD]));
}

function sumRainLastNDays(hourly, timeZone, n){
  const now = new Date();
  const dates = [];
  for (let i = 0; i < n; i++){
    const d = new Date(now.getTime() - i * 86400000);
    dates.push(dateYMDInTZ(d, timeZone));
  }
  return { mm: sumRainForDates(hourly, new Set(dates)), dates };
}

function findTempNow(hourly, timeZone){
  if (!Array.isArray(hourly) || !hourly.length) return null;

  const now = new Date();
  const key = hourKeyInTZ(now, timeZone); // "YYYY-MM-DDTHH:00"

  // times are "YYYY-MM-DDTHH:MM" and are in local time of that timezone.
  // We can lexicographically compare because format is sortable.
  let best = null;

  for (const h of hourly) {
    const t = (h && h.time) ? String(h.time) : "";
    if (!t) continue;
    if (t <= key) best = h; // keep latest <= key
    else break;             // hourly is usually sorted
  }

  // If none <= key (rare), just use first
  if (!best) best = hourly[0];

  return {
    time: best.time,
    tempF: fmtF(cToF(best.temp_c)),
    rhPct: (best.rh_pct != null ? Number(best.rh_pct) : null),
    windMph: (best.wind_mph != null ? Number(best.wind_mph) : null)
  };
}

export function canHandleFieldReadinessWeather(question){
  const qn = norm(question);
  if (!qn) return false;

  // require "field ..." to avoid accidental triggers
  const hasFieldPrefix = /^(field|show field|open field)\b/i.test((question || "").toString().trim());
  if (!hasFieldPrefix) return false;

  return wantsRain(qn) || wantsTemp(qn) || qn.includes("weather");
}

export function answerFieldReadinessWeather({ question, snapshot }){
  const q = (question || "").toString().trim();
  const qn = norm(q);

  const json = snapshot?.json || null;
  const snapshotId = snapshot?.activeSnapshotId || "unknown";

  if (!json) {
    return { answer: "Snapshot is not available right now.", meta: { snapshotId } };
  }

  const colsRoot = getCollectionsRoot(json);
  if (!colsRoot) {
    return { answer: "I can’t find Firefoo collections in this snapshot.", meta: { snapshotId } };
  }

  const weatherDocs = colAsArray(colsRoot, "field_weather_cache");
  if (!weatherDocs.length) {
    return { answer: "No field_weather_cache data found in this snapshot.", meta: { snapshotId } };
  }

  const needle = extractFieldNeedle(q);
  if (!needle) {
    return {
      answer: `Tell me which field. Example:\n• "field North 80 rain yesterday"\n• "field 12 temp now"`,
      meta: { snapshotId }
    };
  }

  const wdoc = pickWeatherDocByNeedle(weatherDocs, needle);
  if (!wdoc) {
    return {
      answer: `I can’t find weather cache for field “${needle}”. Try using the exact field name shown in the app.`,
      meta: { snapshotId }
    };
  }

  const tz = (wdoc.timezone || "America/Chicago").toString();
  const hourly = wdoc?.normalized?.hourly;
  if (!Array.isArray(hourly) || !hourly.length) {
    return {
      answer: `Weather cache exists for “${wdoc.fieldName || wdoc.fieldId}” but hourly data is missing.`,
      meta: { snapshotId }
    };
  }

  const kind = windowType(qn);
  const wantsR = wantsRain(qn);
  const wantsT = wantsTemp(qn) || qn.includes("weather");

  const lines = [];
  const fieldLabel = (wdoc.fieldName || wdoc.fieldId || wdoc.id || needle);

  lines.push(`Field: ${fieldLabel}`);

  if (wantsR) {
    if (kind === "yesterday") {
      const y = dateYMDInTZ(new Date(Date.now() - 86400000), tz);
      const mm = sumRainForDate(hourly, y);
      lines.push(`Rain yesterday (${y}): ${fmtIn(mmToIn(mm))} in`);
    } else if (kind === "today") {
      const t = dateYMDInTZ(new Date(), tz);
      const mm = sumRainForDate(hourly, t);
      lines.push(`Rain today (${t}): ${fmtIn(mmToIn(mm))} in`);
    } else {
      const { mm, dates } = sumRainLastNDays(hourly, tz, 3);
      lines.push(`Rain last 3 days (${dates[2]} → ${dates[0]}): ${fmtIn(mmToIn(mm))} in`);
    }
  }

  if (wantsT) {
    const nowT = findTempNow(hourly, tz);
    if (nowT && nowT.tempF != null) {
      lines.push(`Temp now (${nowT.time}): ${nowT.tempF}°F`);
    } else {
      lines.push(`Temp now: unavailable`);
    }
  }

  return {
    answer: lines.join("\n"),
    meta: {
      snapshotId,
      fieldId: wdoc.fieldId || wdoc.id || null,
      timezone: tz,
      source: wdoc.source || null,
      fetchedAt: wdoc.fetchedAt || null
    }
  };
}
