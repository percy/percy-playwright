'use strict';

// Unit 5b — sync-assertion mode (Option C / D10 / KD14).
//
// Sync is read from the GLOBAL `.percy.yml snapshot.sync` (via the healthcheck `percy.config`,
// surfaced by config.js) — it is NOT a drop-in field. When on, the override posts the comparison
// with `sync: true`, awaits the per-comparison verdict, and applies the KD14 3-WAY CLASSIFIER here
// (above the capture seam — the strategy returns data; index.js decides the throw):
//
//   1. verdict + diff           → throw inline (this test fails; message has the dashboard URL).
//   2. verdict + no diff        → pass.
//   3. {error} (timeout/comparison-error/CLI-exit/403) → do NOT throw; count locally + emit
//      `playwright_dropin_sync_no_verdict`. The mandatory Gate-A backstop (reporter.js) is the ONLY
//      signal that catches this population (their diffs still land in build-level
//      total-comparisons-diff), so a no-verdict is NEVER a false-green.
//
// FIRST-BUILD-REVIEW-ONLY (KD7) is checked INSIDE the classifier, BEFORE the diff branch — first
// build diffs are baseline-establishment noise, so we never throw on them.
//
// `handleSyncJob` (cli core) returns the comparison detail on success and `{ error }` on
// timeout/exception/403 — indistinguishable from a clean pass UNLESS we inspect `.error`. The
// classifier makes that distinction explicit.
const utils = require('@percy/sdk-utils');

const log = utils.logger('playwright-dropin');

// Per-assertion wait cap (KD14). The CLI's WaitForJob also caps at ~90s; we surface the same bound.
const SYNC_TIMEOUT = 90_000;

const NO_VERDICT_EVENT = 'playwright_dropin_sync_no_verdict';

// Local no-verdict counter (observable for the run; the telemetry event is emitted per occurrence).
let _noVerdictCount = 0;
function noVerdictCount() { return _noVerdictCount; }
function _resetNoVerdict() { _noVerdictCount = 0; }

// One-time latch for the token-capability message (FIX #3). When the authoritative read (the
// CLI-side getComparisonDetails) 403s for a write-only token, EVERY assertion would otherwise spam
// the same warning. We emit the distinct capability message exactly ONCE per run, then quietly route
// subsequent auth-failure errors into the no-verdict bucket.
let _tokenCapabilityNotified = false;
function _resetTokenCapabilityNotice() { _tokenCapabilityNotified = false; }

// The distinct, one-time message surfaced when the sync read is refused for lack of read scope.
const TOKEN_CAPABILITY_MESSAGE =
  'Percy sync: token cannot read comparison results — sync needs a read-capable (full) token. ' +
  'Inline verdicts are disabled; the gate backstop still protects CI.';

// Detect an auth/permission failure from a sync result's `{error}`. This is the AUTHORITATIVE
// write-only signal (FIX #3): the CLI's handleSyncJob surfaces the percy-api 403/401 here. The error
// may be a string, an Error, or an object carrying a statusCode/status — match HTTP 403/401 or the
// words "forbidden"/"unauthorized" case-insensitively.
function isAuthFailure(error) {
  if (error == null) return false;
  const status = (typeof error === 'object' &&
    (error.statusCode ?? error.status ?? error.code)) || null;
  if (status === 403 || status === 401 || status === '403' || status === '401') return true;
  const text = typeof error === 'string'
    ? error
    : (error.message || String(error));
  return /\b(403|401|forbidden|unauthorized|unauthorised)\b/i.test(text);
}

// Extract the diff-ratio from a sync-cli comparison detail. The result nests the diff under
// screenshots[].diff-info['diff-ratio'] (percy-api ComparisonSerializerService). Returns a number
// (0 when none) or null when the structure is absent (treated as no-verdict upstream).
function extractDiffRatio(detail) {
  const screenshots = detail && detail.screenshots;
  if (!Array.isArray(screenshots) || !screenshots.length) return null;
  let max = 0;
  let sawDiffInfo = false;
  for (const s of screenshots) {
    const info = s && s['diff-info'];
    if (info && info['diff-ratio'] != null) {
      sawDiffInfo = true;
      max = Math.max(max, Number(info['diff-ratio']) || 0);
    }
  }
  return sawDiffInfo ? max : null;
}

// Pull the best dashboard URL for the failing assertion message.
function dashboardUrl(detail) {
  const urls = detail && detail['dashboard-urls'];
  if (!urls) return null;
  return urls['current-snapshot'] || urls['current-build'] || null;
}

// Emit the no-verdict telemetry event (best-effort; never throws — learnings: instrumentation must
// not crash the caller). Records to the build-event endpoint when available.
function emitNoVerdict(identity, reason) {
  _noVerdictCount += 1;
  try {
    if (typeof utils.postBuildEvents === 'function') {
      // Fire-and-forget; do not await — the assertion path must not block on telemetry.
      Promise.resolve(utils.postBuildEvents({
        event: NO_VERDICT_EVENT,
        name: identity && identity.name,
        browserFamily: identity && identity.browserFamily,
        width: identity && identity.width,
        reason
      })).catch(() => {});
    }
  } catch { /* swallow — telemetry must never fail the suite */ }
}

// The 3-way classifier. Returns { throw: boolean, message: string, outcome: string }.
// `identity` = { name, browserFamily, width }; `opts.isFirstBuild` applies KD7 suppression.
function classifySyncResult(result, identity = {}, opts = {}) {
  const idStr = [identity.name, identity.browserFamily, identity.width && `${identity.width}px`]
    .filter(Boolean).join(' · ');

  // (3) No-verdict bucket FIRST — {error} is indistinguishable from a clean pass otherwise.
  if (!result || result.error) {
    const reason = (result && result.error) || 'no result returned';

    // (3a) AUTH/PERMISSION failure (FIX #3) — the AUTHORITATIVE write-only signal. The sync read
    // (getComparisonDetails) 403s for a write-only token; percy-api gates reads to master||read_only
    // (build_policy.rb). Emit the distinct token-capability message ONCE, then route this (and every
    // subsequent assertion) into the no-verdict bucket — NEVER throw inline, NEVER false-green. The
    // mandatory Gate-A backstop (reporter.js) is the signal that reds CI.
    if (isAuthFailure(result && result.error)) {
      emitNoVerdict(identity, 'token cannot read comparison results (auth failure)');
      if (!_tokenCapabilityNotified) {
        _tokenCapabilityNotified = true;
        log.warn(TOKEN_CAPABILITY_MESSAGE);
      }
      return { throw: false, message: TOKEN_CAPABILITY_MESSAGE, outcome: 'no_verdict_auth' };
    }

    emitNoVerdict(identity, reason);
    log.warn(`Percy: no verdict for "${identity.name || idStr}" within ${SYNC_TIMEOUT / 1000}s — ` +
      'not failing inline; the post-run gate decides');
    return { throw: false, message: `Percy: no verdict (${reason}) — gate will decide`, outcome: 'no_verdict' };
  }

  // KD7 — first build is review-only. Checked BEFORE the diff branch: build #1 diffs are
  // baseline-establishment noise, never a regression → never throw.
  if (opts.isFirstBuild) {
    return { throw: false, message: 'Percy: first build — review-only (diffs are baseline noise)', outcome: 'first_build' };
  }

  const diffRatio = extractDiffRatio(result);
  if (diffRatio == null) {
    // Verdict-shaped but no diff-info (e.g. still-initialising) → treat as no-verdict, not a pass.
    emitNoVerdict(identity, 'comparison not finished');
    return { throw: false, message: 'Percy: no verdict (comparison not finished) — gate will decide', outcome: 'no_verdict' };
  }

  // (1) verdict + diff → throw inline.
  if (diffRatio > 0) {
    const url = dashboardUrl(result);
    const msg = `Percy: visual change detected for "${identity.name || idStr}"` +
      (url ? ` — review at ${url}` : '');
    return { throw: true, message: msg, outcome: 'diff' };
  }

  // (2) verdict + no diff → pass.
  return { throw: false, message: 'Percy: no visual change', outcome: 'no_diff' };
}

// Best-effort pre-flight token-scope check (FIX #3). We NO LONGER refuse based on the brittle prefix
// heuristic (false negatives on `ss_…` write-only tokens, false positives on read-capable `web_`
// tokens). Refusal is only ever returned from an AUTHORITATIVE read:
//   • an injected `probe` that actually asks the API whether reads are allowed, or
//   • a real resource-backed read via @percy/client.getBuild when a build id is already known.
// When NO resource is available we SKIP the pre-flight refusal (return ok) rather than guess — the
// runtime 403 in the classifier is the real backstop, so we never block sync on a guess.
// Resolves { ok, reason }.
async function preflightTokenScope({ token = process.env.PERCY_TOKEN, probe, buildId, client } = {}) {
  if (probe) {
    try {
      const readable = await probe(token);
      return readable
        ? { ok: true }
        : { ok: false, reason: 'token cannot read comparison results' };
    } catch (err) {
      return { ok: false, reason: `token scope check failed — ${err.message}` };
    }
  }

  // Resource-backed pre-flight: only when a build id is already known. getBuild reads through the
  // same percy-api read gate, so a 403/401 here is the authoritative write-only signal.
  if (buildId && client && typeof client.getBuild === 'function') {
    try {
      await client.getBuild(buildId);
      return { ok: true };
    } catch (err) {
      if (isAuthFailure(err)) {
        return { ok: false, reason: 'token cannot read comparison results' };
      }
      // Non-auth error (network, 404, …) is NOT a scope verdict — do not refuse on a guess.
      return { ok: true };
    }
  }

  // No resource to read against → cannot authoritatively decide pre-flight. Allow; the classifier's
  // 403 handling backstops at runtime.
  return { ok: true };
}

module.exports = {
  classifySyncResult,
  extractDiffRatio,
  dashboardUrl,
  preflightTokenScope,
  isAuthFailure,
  noVerdictCount,
  emitNoVerdict,
  _resetNoVerdict,
  _resetTokenCapabilityNotice,
  SYNC_TIMEOUT,
  NO_VERDICT_EVENT,
  TOKEN_CAPABILITY_MESSAGE
};
