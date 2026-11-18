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
 *   POST /api/airtime     — Spark per-frame airborne/ground classification (<=16 frames)
 *   POST /api/sequence    — Spark per-frame yaw estimation over one trick (<=12 frames)
 *   POST /api/pose        — Spark coarse-facing judgement on rider crops (<=12 frames) + completed-cycle total
 *   POST /api/verify      — Muse Spark independent verification from 3 keyframes
 *
 * Batching is deliberate: each Worker request stays short, the client gets
 * real progress ("SAM frame X of N"), Cancel aborts between batches, and a
 * failing model path fails fast instead of hanging a 30-frame scan.
 */

import {
  META_BASE_DEFAULT,
  MetaError,
  agreementFor,
  bucketCycleTotal,
  checkHealth,
  classifyAirtime,
  cycleAgreement,
  estimateYawSequence,
  poseFromCrops,
  segmentFrame,
  snapCycleTotal,
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
async function runSamBatch({ apiKey, base, frames, concept = "snowboard" }) {
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
      const seg = await segmentFrame({ apiKey, base, image: frame.image, concept, timeoutMs: SAM_TIMEOUT_MS });
      consecutiveErrors = 0;
      succeeded += 1;
      results.push({
        index: frame.index, time: frame.time,
        found: seg.found, box: seg.box,
        cx: seg.box ? seg.box.cx : null, cy: seg.box ? seg.box.cy : null,
        sam_note: seg.found ? null : (seg.raw_snippet || null),
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
  // SAM concept is allowlisted: the client may ask for the board or the rider, nothing else.
  const concept = body && typeof body.concept === "string" ? body.concept : "snowboard";
  if (concept !== "snowboard" && concept !== "snowboarder") {
    return json({ ok: false, error: `Unknown SAM concept: ${concept}.` }, 400);
  }
  const out = await runSamBatch({ apiKey: env.META_API_KEY, base: baseUrl(env), frames, concept });
  // HTTP 200 with model_ok:false when the model path failed but the API itself worked.
  // The client must check model_ok — it must never treat this as "no board".
  return json({ ok: true, kind, concept, ...out });
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
      sam_note: seg.found ? null : (seg.raw_snippet || null),
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
    // Verification is independent: no measured numbers reach the prompt.
    const verification = await verifyTrick({
      apiKey: env.META_API_KEY,
      base: baseUrl(env),
      images,
    });
    return json({
      ok: true,
      verification,
      agreement: agreementFor(measuredTotal, verification),
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

function validFrameList(body, maxFrames) {
  const frames = body && Array.isArray(body.frames) ? body.frames : null;
  if (!frames || frames.length === 0) return { error: "Request body must include a non-empty frames array." };
  if (frames.length > maxFrames) return { error: `Send at most ${maxFrames} frames per call. Got ${frames.length}.` };
  for (const f of frames) {
    if (!f || !isDataUrl(f.image) || !Number.isFinite(Number(f.time))) {
      return { error: "Every frame must include an image data URL and a numeric time." };
    }
  }
  return {
    frames: frames.map((f) => ({ index: f.index, time: Number(f.time), image: f.image })),
  };
}

async function handleAirtime(request, env) {
  if (!env.META_API_KEY) return missingKeyResponse();
  const body = await readJson(request);
  const checked = validFrameList(body, 16);
  if (checked.error) return json({ ok: false, error: checked.error }, 400);
  try {
    const classifications = await classifyAirtime({
      apiKey: env.META_API_KEY, base: baseUrl(env), frames: checked.frames,
    });
    return json({ ok: true, classifications, model_error: false, error: "" });
  } catch (err) {
    const isMeta = err instanceof MetaError;
    return json({
      ok: true, classifications: null, model_error: true,
      error: err instanceof Error ? err.message : String(err),
      status: isMeta ? err.status : 0,
    });
  }
}

async function handleSequence(request, env) {
  if (!env.META_API_KEY) return missingKeyResponse();
  const body = await readJson(request);
  const checked = validFrameList(body, 12);
  if (checked.error) return json({ ok: false, error: checked.error }, 400);
  try {
    const sequence = await estimateYawSequence({
      apiKey: env.META_API_KEY, base: baseUrl(env), frames: checked.frames,
    });
    return json({ ok: true, sequence, model_error: false, error: "" });
  } catch (err) {
    const isMeta = err instanceof MetaError;
    return json({
      ok: true, sequence: null, model_error: true,
      error: err instanceof Error ? err.message : String(err),
      status: isMeta ? err.status : 0,
    });
  }
}

async function handlePose(request, env) {
  if (!env.META_API_KEY) return missingKeyResponse();
  const body = await readJson(request);
  const checked = validFrameList(body, 12);
  if (checked.error) return json({ ok: false, error: checked.error }, 400);
  try {
    const pose = await poseFromCrops({
      apiKey: env.META_API_KEY, base: baseUrl(env), frames: checked.frames,
    });
    // The cross-check total comes from code (bucket-cycle unwrap of the
    // coarse facings), not from the model's own total_degrees. When the
    // progression shows a completed turn, the completed-cycle rule snaps
    // to the trick total (spins land in multiples of 180°).
    const bucket = bucketCycleTotal(pose.frames);
    const snap = snapCycleTotal(bucket);
    const measured = body && body.measured && typeof body.measured === "object" ? body.measured : {};
    const measuredTotal = Number(measured.total_degrees);
    const measuredDirection = typeof measured.direction === "string" ? measured.direction : "";
    let agreement;
    if (snap) {
      agreement = cycleAgreement(measuredTotal, measuredDirection, snap.total_degrees, bucket.direction);
    } else if (!bucket.error) {
      agreement = agreementFor(measuredTotal, {
        trick: pose.trick,
        direction: pose.direction,
        total_degrees: Math.abs(bucket.total_degrees),
        confidence: pose.confidence,
      });
    } else {
      agreement = "UNVERIFIED";
    }
    return json({
      ok: true, pose, bucket, snap, agreement,
      model_error: false, error: "",
    });
  } catch (err) {
    const isMeta = err instanceof MetaError;
    return json({
      ok: true, pose: null, bucket: null, snap: null, agreement: "UNVERIFIED", model_error: true,
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
      if (path === "/api/airtime" && request.method === "POST") return handleAirtime(request, env);
      if (path === "/api/sequence" && request.method === "POST") return handleSequence(request, env);
      if (path === "/api/pose" && request.method === "POST") return handlePose(request, env);
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
