/**
 * SPINLOCK — Cloudflare Worker.
 *
 * Serves the static frontend (./public via ASSETS) and a small JSON API.
 * The Meta API key lives ONLY in env.META_API_KEY (Worker secret).
 * It is never sent to the browser, never logged, and never echoed in errors.
 *
 * API:
 *   GET  /api/health      — live model check (health gate)
 *   POST /api/detect      — batched SAM segmentation for coarse scan (<=8 frames/call)
 *   POST /api/analyze     — batched SAM segmentation for a trick window (<=8 frames/call)
 *   POST /api/live-frame  — single-frame SAM segmentation (live camera)
 *   POST /api/verify      — Muse Spark verification from 3 keyframes + measured summary
 *
 * Batching is deliberate: each Worker request stays short, the client gets
 * real progress ("SAM frame X of N"), Cancel aborts between batches, and a
 * failing model path fails fast instead of hanging a 30-frame scan.
 */

import {
  META_BASE_DEFAULT,
  MetaError,
  agreementFor,
  checkHealth,
  segmentFrame,
  verifyTrick,
} from "./meta.js";

const MAX_FRAMES_PER_CALL = 8;
const MAX_CONSECUTIVE_SAM_ERRORS = 3;
const SAM_TIMEOUT_MS = 30000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function baseUrl(env) {
  return (env.META_API_BASE || META_BASE_DEFAULT).replace(/\/$/, "");
}

function missingKeyResponse() {
  return json({
    ok: false,
    model_error: true,
    missing_secret: true,
    error: "META_API_KEY is not configured as a Worker secret. Run: npx wrangler secret put META_API_KEY",
  }, 503);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:image/");
}

/**
 * Run SAM over a small batch of frames, sequentially, failing fast.
 * Returns { results, sam_errors, model_ok, error }.
 * A transport/model failure is NEVER reported as "no board found".
 */
async function runSamBatch({ apiKey, base, frames }) {
  const results = [];
  let samErrors = 0;
  let succeeded = 0;
  let consecutiveErrors = 0;
  let firstError = "";
  for (const frame of frames) {
    if (!isDataUrl(frame.image)) {
      results.push({ index: frame.index, time: frame.time, found: false, box: null, skipped: "not an image data URL" });
      continue;
    }
    try {
      const seg = await segmentFrame({ apiKey, base, image: frame.image, timeoutMs: SAM_TIMEOUT_MS });
      consecutiveErrors = 0;
      succeeded += 1;
      results.push({
        index: frame.index, time: frame.time,
        found: seg.found, box: seg.box,
        cx: seg.box ? seg.box.cx : null, cy: seg.box ? seg.box.cy : null,
      });
    } catch (err) {
      samErrors += 1;
      consecutiveErrors += 1;
      if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      results.push({ index: frame.index, time: frame.time, found: false, box: null, cx: null, cy: null, sam_error: true });
      if (consecutiveErrors >= MAX_CONSECUTIVE_SAM_ERRORS) {
        return {
          results, sam_errors: samErrors, model_ok: false,
          error: `Model service failing (${consecutiveErrors} consecutive SAM errors): ${firstError}`,
          aborted_early: true,
        };
      }
    }
  }
  // model_ok means the model path answered at least once. If every SAM call
  // in the batch failed, that is a model outage — never "no board found".
  const modelOk = succeeded > 0;
  return {
    results,
    sam_errors: samErrors,
    model_ok: modelOk,
    error: samErrors > 0 ? `SAM failed on ${samErrors} of ${frames.length} frames: ${firstError}` : "",
    aborted_early: false,
  };
}

async function handleHealth(request, env) {
  const report = await checkHealth({ apiKey: env.META_API_KEY, base: baseUrl(env) });
  return json({ ...report, checked_at: new Date().toISOString() });
}

async function handleSamBatch(request, env, kind) {
  if (!env.META_API_KEY) return missingKeyResponse();
  const body = await readJson(request);
  const frames = body && Array.isArray(body.frames) ? body.frames : null;
  if (!frames || frames.length === 0) {
    return json({ ok: false, error: "Request body must include a non-empty frames array." }, 400);
  }
  if (frames.length > MAX_FRAMES_PER_CALL) {
    return json({ ok: false, error: `Send at most ${MAX_FRAMES_PER_CALL} frames per call (batched design). Got ${frames.length}.` }, 400);
  }
  const out = await runSamBatch({ apiKey: env.META_API_KEY, base: baseUrl(env), frames });
  // HTTP 200 with model_ok:false when the model path failed but the API itself worked.
  // The client must check model_ok — it must never treat this as "no board".
  return json({ ok: true, kind, ...out });
}

async function handleLiveFrame(request, env) {
  if (!env.META_API_KEY) return missingKeyResponse();
  const body = await readJson(request);
  if (!body || !isDataUrl(body.image)) {
    return json({ ok: false, error: "Request body must include an image data URL." }, 400);
  }
  try {
    const seg = await segmentFrame({ apiKey: env.META_API_KEY, base: baseUrl(env), image: body.image, timeoutMs: 20000 });
    return json({
      ok: true, found: seg.found, box: seg.box,
      cx: seg.box ? seg.box.cx : null, cy: seg.box ? seg.box.cy : null,
      model_error: false, error: "",
    });
  } catch (err) {
    return json({
      ok: true, found: false, box: null, cx: null, cy: null,
      model_error: true,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleVerify(request, env) {
  if (!env.META_API_KEY) return missingKeyResponse();
  const body = await readJson(request);
  const images = body && Array.isArray(body.images) ? body.images.filter(isDataUrl) : [];
  const measured = body && body.measured && typeof body.measured === "object" ? body.measured : {};
  if (images.length === 0) {
    return json({ ok: false, error: "Request body must include at least one keyframe image data URL." }, 400);
  }
  const measuredTotal = Number(measured.total_degrees);
  try {
    const verification = await verifyTrick({
      apiKey: env.META_API_KEY,
      base: baseUrl(env),
      images,
      measured: {
        total_degrees: Number.isFinite(measuredTotal) ? Math.round(measuredTotal) : 0,
        airtime_s: Number(measured.airtime_s) || 0,
        direction: typeof measured.direction === "string" ? measured.direction : "unknown",
      },
    });
    return json({
      ok: true,
      verification,
      agreement: agreementFor(measuredTotal, verification.total_degrees),
      model_error: false, error: "",
    });
  } catch (err) {
    const isMeta = err instanceof MetaError;
    return json({
      ok: true,
      verification: null,
      agreement: "UNVERIFIED",
      model_error: true,
      error: err instanceof Error ? err.message : String(err),
      status: isMeta ? err.status : 0,
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/health" && request.method === "GET") return handleHealth(request, env);
      if (path === "/api/detect" && request.method === "POST") return handleSamBatch(request, env, "detect");
      if (path === "/api/analyze" && request.method === "POST") return handleSamBatch(request, env, "analyze");
      if (path === "/api/live-frame" && request.method === "POST") return handleLiveFrame(request, env);
      if (path === "/api/verify" && request.method === "POST") return handleVerify(request, env);
      if (path.startsWith("/api/")) {
        return json({ ok: false, error: `Unknown API route: ${path}` }, 404);
      }
      // Everything else: static frontend.
      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        const assetRes = await env.ASSETS.fetch(request);
        // SPA fallback: unknown non-API paths serve the single page.
        if (assetRes.status === 404 && request.method === "GET") {
          const indexReq = new Request(new URL("/", request.url), request);
          return env.ASSETS.fetch(indexReq);
        }
        return assetRes;
      }
      return new Response("Static assets are not configured (ASSETS binding missing). Check wrangler.toml.", { status: 500 });
    } catch (err) {
      // Last-resort guard: never hang, never leak env values.
      return json({ ok: false, error: `Worker error: ${err instanceof Error ? err.message : "unknown error"}` }, 500);
    }
  },
};
