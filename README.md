# SPINLOCK — Lock onto every degree of airtime

Snowboard rotation analysis for the **Cloudflare × U.S. Ski & Snowboard Challenge 1: Snowboard Rotation Analysis**.

Upload a clip, paste a direct video-file link, or point a live camera at the jump — SPINLOCK finds the trick itself, measures the rotation, and verifies the call. Built as a standalone **Cloudflare Worker** (API + static frontend, no other backend), so it deploys with one command and calls the Meta Model API directly from Cloudflare.

> **Submission due:** November 30, 2026 — GitHub repo + deployed Cloudflare link + short explanation.
> See [Submission explanation draft](#submission-explanation-draft) below.

---

## What it does

1. **Find the trick automatically.** Paste a direct video link (MP4/WebM/MOV) or upload a clip and tap **Find the trick & analyze**. SPINLOCK samples frames across the whole video and judges board-to-snow contact frame by frame to find the airborne stretch — takeoff, airtime, landing — with no scrubbing. Contact judgement (not board height in the frame) is what works on follow-cam footage, where the camera tilts with the rider. A manual window override stays available, and a board-height fallback runs only if the vision check fails.
2. **Measure the rotation.** In the trick window, SAM segments the board in every frame to confirm the lock, and Muse Spark estimates the rider's facing (yaw) in each airborne frame. The yaw estimates unwrap into a rotation curve and fit to a steady spin: total rotation, airtime, peak/average spin rate, a dial synced to frame replay, a frame strip with per-frame degrees, and a rotation-over-time chart.
3. **Verify independently.** A separate Muse Spark call looks at takeoff / mid-air / landing frames and estimates the trick on its own, with no measured numbers fed in. Curve fit vs. verified totals are shown side by side with a **LOCKED** (agree within 45°, confident named trick), **CLOSE** (within 120°), or **DISPUTED** call. If verification cannot confirm a trick — including when both totals are 0° — the result honestly says **UNVERIFIED**. The trick is never guessed.
4. **Live camera mode.** Start tracking before drop-in; SAM re-locks the board about once a second, the dial and curve build live, and auto takeoff/landing detection (on by default) calls both moments itself and verifies after touchdown. Manual Mark buttons stay as backup.
5. **Run sheet.** Every run saves in the browser (local storage) with its measured frames, curve, and verification. Runs can be reopened, replayed, or deleted.

**No demo data.** The app starts empty. No rotation, takeoff, or landing value is ever invented, filled in, or presented from placeholder data. Gaps in a curve mean SAM did not lock the board in that frame — and the board-found rate is always shown next to the result.

---

## How Meta models are used

All Meta calls happen **server-side in the Worker** (`src/worker/`). The browser never sees the API key.

| Model | Used for | Call |
|---|---|---|
| `sam-3.1` | Segment the snowboard in each frame (box grammar + mask; geometry uses the box) to confirm the board lock | `POST /v1/responses`, image as base64 data URL, text prompt "snowboard" |
| `muse-spark-1.3` | Judge airborne vs. on-snow per frame (airtime window); estimate rider facing (yaw) per airborne frame (rotation curve); independently verify trick name, direction, and total from 3 keyframes (strict JSON replies, no measured numbers fed to the verify call) | `POST /v1/responses`, images + task prompt |
| `muse-wonder-1.0` | Listed in the health check only (available on the key); not used in this pipeline | `GET /v1/models` |

Base URL: `https://api.meta.ai/v1`, Bearer auth with the `META_API_KEY` Worker secret. No file upload is needed for images — base64 data URLs work. The health gate (`GET /v1/models`) runs before any scan.

### Why SAM + Spark, in that order

SAM gives a **measurable** first pass: a box per frame confirming the board is actually locked. Spark gives the **judgement** a single camera requires: whether the board is off the snow, and which way the rider is facing as the spin progresses. The verify call is a **separate, unanchored** second opinion — it receives no measured numbers, so it cannot parrot the curve it is meant to check. When the two disagree, SPINLOCK says DISPUTED instead of picking the prettier number. A human (coach, judge, athlete) always makes the final call — SPINLOCK never calls a find on its own.

> **Why not board-axis geometry?** An earlier version measured the board's image-plane axis angle and unwrapped it. On the first real clip (Nov 18) that produced 0° total on a real 360: a spin is rotation about the rider's vertical axis, and the board's image-plane axis only oscillates as the board foreshortens — it cannot see yaw. The same clip exposed the old snow-line window detection (9.12s "airtime" on a ~1.2s jump, because the follow-cam tilts with the rider) and a vacuous LOCKED (0° vs 0° at 0% confidence). All three were replaced with the vision-first pipeline above; the board-axis code survives only as the provisional live dial.

---

## Architecture

```
public/index.html          Single-page X Games broadcast UI (no build step, no CDN deps)
public/spinlock-logo.png   Brand mark (exact approved file)
src/worker/index.js        Worker entry: routing, batched SAM endpoints, static fallback
src/worker/meta.js         Meta Model API client: SAM parsing, Spark verify, health check
wrangler.toml              Worker + static assets config
```

```
Browser ── frames (JPEG data URLs, ≤8/batch) ──► Worker ──► Meta Model API
  ▲  boxes + verification                           (Bearer secret, server-side only)
  └── rotation curve, dial, chart, run sheet (localStorage)
```

**API** (all JSON, all same-origin):

| Route | Purpose |
|---|---|
| `GET /api/health` | Live model check. Returns `{ok, models, sam, spark, wonder, error}`. Never throws. |
| `POST /api/detect` | Batched SAM segmentation for the coarse whole-clip scan (≤8 frames/call). |
| `POST /api/analyze` | Batched SAM segmentation for trick-window frames (≤8 frames/call). |
| `POST /api/live-frame` | Single-frame SAM segmentation for live camera mode. |
| `POST /api/airtime` | Spark per-frame airborne/ground classification for the coarse scan (≤16 frames/call). |
| `POST /api/sequence` | Spark per-frame yaw estimation over one trick window (≤12 frames/call). |
| `POST /api/verify` | Spark independent verification from 3 keyframes (no measured numbers in the prompt). Returns verification + LOCKED/CLOSE/DISPUTED/UNVERIFIED. |

**Batching is a resiliency choice, not an accident.** Each Worker request stays short, the client shows real progress (`SAM frame X of N`), Cancel aborts between batches, and a failing model path fails fast instead of hanging a 30-frame scan. Runs persist in browser local storage in this standalone version — no database setup is needed for the judge test. (A venue deployment would add R2/Durable Objects for shared run history; see [What this version deliberately leaves out](#what-this-version-deliberately-leaves-out).)

---

## Resiliency (built in, not bolted on)

These behaviors come from a real failure found on Nov 17, when uploads sat in "Scanning…" forever:

- **Health gate.** The header badge checks the models live. If SAM is unreachable it shows **MODELS UNREACHABLE** with Retry + auto-recheck every 30s, and scan buttons stay disabled. A scan that cannot succeed never starts.
- **Fail-fast, honest errors.** After ~3 consecutive SAM errors the scan aborts with the real model error ("model service failing…"), clearly distinct from "no board found." Model errors are counted separately from missed boards in every run note. A batch where *every* SAM call fails reports `model_ok: false` — never a fake empty result.
- **Timeouts everywhere.** ~5s per video seek, 30s per SAM call (20s live), 12s health check, one retry on 5xx/network failure only. A stalled seek or hung call cannot hang the UI.
- **Progress + Cancel.** Every scan shows stage, `SAM frame X of N`, and elapsed seconds, with a Cancel button that aborts cleanly. Cancelled runs are saved as cancelled — never as results.
- **No stuck runs.** Pipelines fail cleanly on unexpected errors, re-runs reset cleanly, and any run left in "processing" for over 12 minutes is auto-closed as failed-and-rerunnable on the next load.
- **Live mode survives.** Hung live calls time out, repeated failures raise a visible warning while tracking keeps retrying, and camera permission / no-camera states are explicit.
- **Link failures are honest.** YouTube/Vimeo/social watch pages are refused with a plain explanation (they cannot be frame-sampled in a browser) and a download-and-upload path. Direct links that lack CORS permission produce a CORS error, not a hang.

---

## Fresh-clone judge test

Prerequisites: **Node.js 18+** and **npm**. No other setup. No build step for the frontend.

```bash
git clone <this-repo>
cd spinlock
npm install
```

### 1. Run it locally (no key — health gate demo)

```bash
npm run dev
# → http://localhost:8787
```

With no key configured, the page loads and the header honestly shows **MODELS UNREACHABLE** with the missing-secret error. Scanning stays disabled. This is the intended behavior, not a broken build.

### 2. Add the Meta key (local dev only)

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars and paste your Meta Model API key from dev.meta.ai/api-keys.
# .dev.vars is gitignored — never commit it.
npm run dev
```

The header should now show **SAM 3.1 + SPARK LIVE** (assuming the key is valid and the network can reach `api.meta.ai`). Upload a snowboard clip and tap **Find the trick & analyze**.

### 3. Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler secret put META_API_KEY   # paste the key when prompted; it is never stored in the repo
npm run deploy
# → https://spinlock.<your-subdomain>.workers.dev
```

Open the deployed URL, confirm the health badge is live, and run one starter-pack clip end to end (see [First test](#first-test)). That deployed URL is the submission link.

### Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server on port 8787 |
| `npm run deploy` | Deploy Worker + static frontend to Cloudflare |
| `npm run check` | Syntax-check the Worker source |
| `npx wrangler secret put META_API_KEY` | Set/rotate the production secret |
| `npx wrangler secret delete META_API_KEY` | Remove the production secret |

---

## First test

Use the **official starter-pack footage** first — it is what the judging criteria are written against, and it avoids any rights question from random competition clips:

- Starter pack Drive folder: <https://drive.google.com/drive/folders/1T1FYZR_ZG8WX0C5-9G6ygX8itEffVa5X> → folder `01 - Snowboard Rotation Analysis` (real slopestyle / halfpipe footage) + `START HERE - Challenge Guide`.

1. Upload one slopestyle clip, tap **Find the trick & analyze**, and check the LOCKED/CLOSE/DISPUTED call against the known trick.
2. Note the **board-found rate** and any frame where SAM loses the board (snow spray, upside-down, edge-on).
3. Live test: point a camera at a board — or at a second screen playing a trick clip — start tracking, and check the live dial, airtime, and delayed verification call.

Report the two numbers that matter: **board-found rate on a real clip**, and **whether Spark's verified total matches the known trick**. Those decide whether the pipeline is submission-ready or needs tuning (frame rate, sample count, snow-line threshold).

> **Proven so far (Nov 18, 2026):** the deployed Worker reaches Meta from Cloudflare (`/api/health` ok, all 10 models), and the first real clip (a 9.77s follow-cam 360) locked the board in 23 of 30 frames — the SAM success path works. That same run exposed three accuracy bugs (whole-clip window, 0° rotation, vacuous LOCKED), fixed the same day with the vision-first pipeline described above. The fixed pipeline's numbers (window, fitted total vs. the known trick) still await the first retest on the deployed Worker. Do not present any result as verified until that retest lands.

---

## Honest limits

- **One camera = a 2D view.** Facing (yaw) is estimated from the visible rider. A rider hidden by spray, shot from directly behind the jump, or too small in frame produces low-confidence estimates — and the fit refuses to invent a total from fewer than 3 confident frames. That is why board-found rate, per-frame confidence, and the independent Spark check are always visible — and why SPINLOCK reports DISPUTED instead of hiding disagreement.
- **Direct links need CORS.** A direct video-file link only works if its host allows cross-origin frame reads. Otherwise the browser blocks the canvas read and SPINLOCK reports a CORS error.
- **Platform watch pages are refused.** YouTube, Vimeo, Instagram, TikTok, Facebook, and X links cannot be sampled frame-by-frame in any browser app. Download the clip (where you have the right to) and upload the file.
- **Live mode is near-real-time, not zero-latency.** SAM re-locks about once a second; Spark verifies after touchdown (1–3s). That delay is the broadcast replay moment, not a defect.
- **Runs live in the browser.** The run sheet uses local storage in this standalone version. Clearing browser data clears runs. Shared/venue history needs the R2/Durable Objects step below.

---

## What this version deliberately leaves out

For a clean, one-command submission build, this repo does **not** include:

- R2 footage archive, D1/KV run storage, or Durable Objects per-run state
- Cloudflare Stream RTMP/SRT venue ingest or WebSocket broadcast overlays
- An edge tracker between SAM keyframes (the live design calls for one at venue scale)

Those are the documented next steps for a venue deployment — see the Cloudflare deployment checklist in the project notes. Nothing in this repo pretends they are already configured.

---

## Submission explanation draft

*For the challenge submission form (repo link + deployed link + short explanation). Edit freely — figures below are the design, not measured results, until the first deployed clip test lands.*

> **SPINLOCK — Lock onto every degree of airtime.**
>
> SPINLOCK is a snowboard rotation analysis tool for coaches and athletes, built as a Cloudflare Worker. Upload a slopestyle or halfpipe clip, paste a direct video link, or use the live camera — SPINLOCK finds the trick itself (takeoff, airtime, landing) instead of asking the user to scrub, measures the rotation curve frame by frame, and verifies the call independently.
>
> How it works: frames are extracted in the browser; Meta's SAM 3.1 segments the snowboard in each frame to confirm the board lock; airtime is found by judging board-to-snow contact frame by frame (which works on follow-cam footage, where frame height cannot); Muse Spark 1.3 estimates the rider's facing in each airborne frame, and those estimates unwrap and fit to a spin curve with total rotation, airtime, and peak/average spin rate; a separate, independent Spark call then verifies trick name, direction, and total from takeoff/mid-air/landing frames, and the two are shown side by side with a LOCKED / CLOSE / DISPUTED call. Results include a rotation dial synced to replay, a per-frame strip, a rotation-over-time chart, and a persistent run sheet. Live mode tracks from a camera feed with auto takeoff/landing detection and a delayed verification call after touchdown.
>
> The app is built for failure as much as for success: a live health gate refuses to start scans the models cannot serve, SAM failures fail fast with honest model errors (never disguised as "no board found"), every scan shows real progress with Cancel, and no run can sit in "processing" forever. The Meta API key lives only as a Cloudflare Worker secret — never in the browser, repo, or logs.

---

## File map

```
wrangler.toml              Worker + static assets config (no secrets)
package.json               Scripts + wrangler devDependency (no runtime deps)
.dev.vars.example          Local-dev secret template (copy to .dev.vars; gitignored)
.gitignore                 node_modules, .wrangler, .dev.vars
public/index.html          Whole frontend: X Games UI, frame extraction, geometry, live mode, run sheet
public/spinlock-logo.png   Brand mark (exact approved file, 1600×1600)
src/worker/index.js        Routing + batched API endpoints + assets fallback
src/worker/meta.js         Meta API client, SAM box parsing, Spark verify, health check
```

## Security

- `META_API_KEY` is a Worker secret only. It never appears in the repo, in chat, in logs, or in any browser bundle. Error messages carry HTTP statuses and short body snippets only — never credentials.
- Uploaded clips are processed in the browser and sent to the Worker only as sampled JPEG frames for segmentation. No clip is stored server-side in this version.
- `npm audit` / dependency review: the only dependency is `wrangler` (dev-only). The deployed Worker and frontend have zero runtime dependencies.

---

*SPINLOCK — built for the Cloudflare × U.S. Ski & Snowboard Challenge 1. Detection and measurement only; a human always makes the final call.*
