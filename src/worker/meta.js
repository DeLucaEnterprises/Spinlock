/**
 * meta.js — Meta Model API client for SPINLOCK (Cloudflare Worker).
 *
 * Models (pinned):
 *   sam-3.1        — promptable segmentation, returns box grammar + mask.
 *   muse-spark-1.3 — vision verification of trick name / direction / total.
 *
 * Auth: Bearer META_API_KEY, Worker secret only. The key never leaves the
 * Worker — no browser code, log line, or error payload may contain it.
 *
 * Resiliency: every call is time-boxed, retried exactly once on 5xx / network
 * failure, and surfaces a structured MetaError (status + short body snippet)
 * so the UI can tell "model service down" apart from "no board found".
 * Nothing here invents a box, an angle, or a trick call.
 */

export const META_BASE_DEFAULT = "https://api.meta.ai/v1";
export const SAM_MODEL = "sam-3.1";
export const SPARK_MODEL = "muse-spark-1.3";

export class MetaError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = "MetaError";
    this.status = status;
    this.retryable = retryable;
  }
}

function snippet(text, max = 300) {
  if (!text) return "";
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/** Fetch with a hard timeout. Throws MetaError on abort/network failure. */
async function fetchTimeout(url, options, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const msg = err && err.name === "TimeoutError"
      ? `Meta API request timed out after ${timeoutMs}ms`
      : `Meta API request failed: ${err && err.message ? err.message : String(err)}`;
    throw new MetaError(msg, { status: 0, retryable: true });
  }
  return response;
}

/**
 * POST /v1/responses. `input` is a Responses-API input array.
 * Retries exactly once on HTTP >= 500 or network/timeout failure.
 * Returns the parsed JSON body (or { _rawText } if the body is not JSON).
 */
export async function callResponses({ apiKey, base, model, input, metadata, timeoutMs = 30000 }) {
  const url = `${base.replace(/\/$/, "")}/responses`;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchTimeout(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(metadata ? { model, input, metadata } : { model, input }),
      redirect: "manual",
    }, timeoutMs).catch((err) => {
      lastError = err;
      return null;
    });
    if (!res) {
      // Network/timeout error: retry once, then throw.
      if (attempt === 0 && lastError && lastError.retryable) continue;
      throw lastError;
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const err = new MetaError(
        `Meta API ${model} returned HTTP ${res.status}: ${snippet(text) || "(empty body)"}`,
        { status: res.status, retryable: res.status >= 500 },
      );
      if (attempt === 0 && err.retryable) continue;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      return { _rawText: text };
    }
  }
  throw lastError || new MetaError("Meta API request failed", { status: 0, retryable: false });
}

/** Recursively collect every string in a Responses-API payload, in order. */
function collectStrings(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") {
    // Prefer the fields the Responses API uses for model text, then the rest.
    for (const key of ["text", "output_text", "content", "output", "message"]) {
      if (key in value) collectStrings(value[key], out);
    }
    for (const key of Object.keys(value)) {
      if (!["text", "output_text", "content", "output", "message"].includes(key)) {
        collectStrings(value[key], out);
      }
    }
  }
  return out;
}

export function responseText(body) {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body._rawText === "string") return body._rawText;
  return collectStrings(body, []).join("\n");
}

/**
 * Parse SAM box grammar: <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>
 * Returns normalized boxes [{x1,y1,x2,y2,cx,cy,w,h}] in 0..1 coordinates,
 * or [] when no box is present (model honestly found nothing).
 * The mask payload is intentionally ignored — geometry uses the box.
 */
const BOX_RE = /<\|box;([^|]*)\|>/g;

export function parseBoxes(text) {
  const boxes = [];
  if (!text) return boxes;
  for (const match of String(text).matchAll(BOX_RE)) {
    const parts = {};
    for (const pair of match[1].split(";")) {
      const [k, v] = pair.split("=");
      if (k && v !== undefined) parts[k.trim()] = Number(v);
    }
    const { x1, y1, x2, y2, w, h } = parts;
    if (![x1, y1, x2, y2, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const nx1 = Math.min(x1, x2) / w, ny1 = Math.min(y1, y2) / h;
    const nx2 = Math.max(x1, x2) / w, ny2 = Math.max(y1, y2) / h;
    if (nx2 - nx1 <= 0 || ny2 - ny1 <= 0) continue;
    boxes.push({
      x1: nx1, y1: ny1, x2: nx2, y2: ny2,
      cx: (nx1 + nx2) / 2, cy: (ny1 + ny2) / 2,
      w: nx2 - nx1, h: ny2 - ny1,
    });
  }
  return boxes;
}

/** Largest box wins — the rider's board, not a distant artifact. */
function largestBox(boxes) {
  if (!boxes.length) return null;
  return boxes.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
}

function imagePart(dataUrl) {
  return { type: "input_image", image_url: dataUrl };
}

function textPart(text) {
  return { type: "input_text", text };
}

/**
 * Segment the snowboard in one frame.
 * Returns { found, box|null, boxesChecked, raw_snippet }.
 * Throws MetaError on model/transport failure (caller counts it, never
 * confuses it with "no board").
 *
 * SAM 3.1 takes ONE SHORT CONCEPT PHRASE per request (verified shape:
 * ARGUS step-5 smoke test used "person"; the Nov 9 Model API check used
 * "red circle"). A long instruction sentence is not a concept and
 * returns no boxes — that was the 0/30 failure on the first real clip.
 * The metadata block matches the verified ARGUS shape. raw_snippet
 * carries the first 200 chars of SAM's reply text so a no-box result
 * can show what the model actually said; it never contains the key.
 */
export async function segmentFrame({ apiKey, base, image, timeoutMs = 30000 }) {
  const input = [{
    type: "message",
    role: "user",
    content: [
      textPart("snowboard"),
      imagePart(image),
    ],
  }];
  const body = await callResponses({
    apiKey, base, model: SAM_MODEL, input, timeoutMs,
    metadata: { mask_encoding: "one_bit", include_confidence: "true" },
  });
  // Search the full payload text: box grammar may sit in any output field.
  const haystack = responseText(body) + "\n" + JSON.stringify(body);
  const boxes = parseBoxes(haystack);
  const box = largestBox(boxes);
  return {
    found: Boolean(box), box, boxesChecked: boxes.length,
    raw_snippet: snippet(responseText(body), 200),
  };
}

/**
 * Verify a trick with Muse Spark 1.3 from 3 keyframes + measured summary.
 * Returns the parsed verification object, or throws MetaError.
 * Never synthesizes a trick call: unparseable output is an error.
 */
export async function verifyTrick({ apiKey, base, images, measured, timeoutMs = 45000 }) {
  const prompt = [
    "You are verifying a snowboard aerial trick from 3 frames: takeoff, mid-air, landing.",
    `Measured from board tracking (estimate, single camera): total rotation ${measured.total_degrees} degrees, airtime ${measured.airtime_s} seconds, spin direction ${measured.direction || "unknown"}.`,
    "Look at the frames and estimate the trick independently. Reply with JSON ONLY, no other text:",
    '{"trick":"e.g. Backside 720","direction":"frontside|backside|unknown","total_degrees":720,"confidence":0.0-1.0,"reason":"one sentence citing what you see"}',
    "If you cannot tell from the frames, use total_degrees 0, confidence 0, and say so in reason. Do not guess a trick name.",
  ].join("\n");
  const content = [textPart(prompt)];
  for (const img of images.slice(0, 3)) content.push(imagePart(img));
  const body = await callResponses({
    apiKey, base, model: SPARK_MODEL, input: [{ role: "user", content }], timeoutMs,
  });
  const text = responseText(body);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new MetaError(
      `Spark verification returned no JSON: ${snippet(text, 200) || "(empty response)"}`,
      { status: 200, retryable: false },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new MetaError(
      `Spark verification returned unparseable JSON: ${snippet(jsonMatch[0], 200)}`,
      { status: 200, retryable: false },
    );
  }
  const total = Number(parsed.total_degrees);
  return {
    trick: typeof parsed.trick === "string" ? parsed.trick : "Unknown",
    direction: typeof parsed.direction === "string" ? parsed.direction : "unknown",
    total_degrees: Number.isFinite(total) ? total : 0,
    confidence: Number.isFinite(Number(parsed.confidence))
      ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

/** Agreement between measured geometry and Spark verification. */
export function agreementFor(measuredTotal, verifiedTotal) {
  if (!Number.isFinite(measuredTotal) || !Number.isFinite(verifiedTotal)) return "UNVERIFIED";
  const diff = Math.abs(measuredTotal - verifiedTotal);
  if (diff <= 45) return "LOCKED";
  if (diff <= 120) return "CLOSE";
  return "DISPUTED";
}

/** GET /v1/models — the health gate. Never throws; always returns a report. */
export async function checkHealth({ apiKey, base, timeoutMs = 12000 }) {
  if (!apiKey) {
    return {
      ok: false, status: 0, models: [], sam: false, spark: false, wonder: false,
      missing_secret: true,
      error: "META_API_KEY is not configured as a Worker secret. Run: npx wrangler secret put META_API_KEY",
    };
  }
  let res;
  try {
    res = await fetchTimeout(`${base.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "manual",
    }, timeoutMs);
  } catch (err) {
    return {
      ok: false, status: 0, models: [], sam: false, spark: false, wonder: false,
      error: err.message || "Could not reach the Meta Model API.",
    };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return {
      ok: false, status: res.status, models: [], sam: false, spark: false, wonder: false,
      error: `Meta API returned HTTP ${res.status}: ${snippet(text) || "(empty body)"}`,
    };
  }
  let names = [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed.data) ? parsed.data : [];
    names = list.map((m) => m.id || m.name || String(m)).filter(Boolean);
  } catch {
    names = [];
  }
  return {
    ok: true, status: res.status, models: names,
    sam: names.includes(SAM_MODEL),
    spark: names.includes(SPARK_MODEL),
    wonder: names.includes("muse-wonder-1.0"),
    error: "",
  };
}
