'use strict';

// Unit 6 — Native fallback (D7) + compat-mode native throw (D6/KD5).
//
// Two distinct jobs, both centred on Playwright's ORIGINAL `toHaveScreenshot`:
//
//   1. Native fallback (D7/KD6): if Percy is NOT enabled at the START of the run (no token,
//      CLI down, healthcheck fail), the WHOLE run routes through the native matcher so the suite
//      behaves EXACTLY as it did pre-install (pixel diff against committed baselines, native
//      throw). This is a run-level decision, latched once — never partial-native inside a live
//      Percy run (mid-run blips are retried/queued instead, see retryablePost).
//
//   2. Compat mode (D6/KD5): the user opts in to keep native THROW semantics even with Percy on,
//      but we SUPPRESS the missing-baseline first-run throw so installing the drop-in (which means
//      a repo may have no committed baseline yet) never reds a first run just because no baseline
//      exists.
//
// To invoke the native matcher we MUST hold the original `toHaveScreenshot` captured BEFORE
// `baseExpect.extend({ toHaveScreenshot })` replaced it (index.js does the capture at module load
// and hands it here). Playwright keeps the default matchers on a prototype in the matcher object's
// chain; `captureNativeMatcher` walks that chain and grabs the slot's value.
const utils = require('@percy/sdk-utils');

const log = utils.logger('playwright-dropin');

// Playwright signals "no committed baseline yet" with a matcher error whose message mentions a
// missing snapshot / "writing actual". We match conservatively so a genuine pixel diff still throws.
const MISSING_BASELINE_RE = /(snapshot|screenshot).*(doesn't exist|does not exist|is missing|not found)|writing actual|to update snapshots/i;

// Capture the native `toHaveScreenshot` from the live matcher prototype chain. MUST be called
// before `baseExpect.extend` overrides the slot. Returns null if it can't be found (older/newer
// Playwright) — callers then degrade gracefully (treat as no-native-available).
function captureNativeMatcher(baseExpect) {
  try {
    let obj = baseExpect(undefined);
    while (obj) {
      if (Object.prototype.hasOwnProperty.call(obj, 'toHaveScreenshot')) {
        const desc = Object.getOwnPropertyDescriptor(obj, 'toHaveScreenshot');
        return (desc && typeof desc.value === 'function') ? desc.value : null;
      }
      obj = Object.getPrototypeOf(obj);
    }
  } catch (err) {
    log.debug(`Percy: could not capture native toHaveScreenshot — ${err.message}`);
  }
  return null;
}

// Detect whether a thrown native error / failing matcher result is the "no committed baseline"
// first-run case (which compat mode must NOT surface as a failure).
function isMissingBaselineFailure(errOrResult) {
  if (!errOrResult) return false;
  let msg = errOrResult.message;
  // Matcher results carry message as a FUNCTION — call it (String(fn) would test the source code).
  if (typeof msg === 'function') { try { msg = msg(); } catch { msg = ''; } }
  return Boolean(msg && MISSING_BASELINE_RE.test(String(msg)));
}

// Invoke the captured native matcher with the same `this` (matcher state) and args Playwright would
// have used. Playwright's matchers may either THROW (hard assertions) or RETURN `{ pass:false }`
// (soft path) on a diff; we normalise both. When `suppressMissingBaseline` is set (compat mode),
// a missing-baseline outcome is converted to a PASS so a first run never reds on an absent baseline.
async function runNativeMatcher(nativeMatcher, matcherState, args, { suppressMissingBaseline = false } = {}) {
  if (typeof nativeMatcher !== 'function') {
    // No native matcher available → we cannot do a native compare. Pass so we never fail worse
    // than pre-install would on an unsupported Playwright (D3 spirit).
    return { pass: true, message: () => 'Percy: native screenshot matcher unavailable — skipped' };
  }

  try {
    const result = await nativeMatcher.apply(matcherState, args);
    if (result && result.pass === false && suppressMissingBaseline && isMissingBaselineFailure(result)) {
      return { pass: true, message: () => 'Percy: first run — no committed baseline yet (compat-mode suppressed)' };
    }
    return result;
  } catch (err) {
    if (suppressMissingBaseline && isMissingBaselineFailure(err)) {
      return { pass: true, message: () => 'Percy: first run — no committed baseline yet (compat-mode suppressed)' };
    }
    throw err;
  }
}

// One-time native-fallback notice (plan §User-Facing States): printed once on entering native so a
// green CI isn't mistaken for "Percy passed".
let noticeShown = false;
function noteNativeFallback(reason) {
  if (noticeShown) return;
  noticeShown = true;
  log.warn(`Percy unavailable (${reason}) — running native screenshot comparison; no Percy build created`);
}

// Reset hook for tests (the one-time notice latch).
function _resetNotice() { noticeShown = false; }

// Mid-run upload resilience (D7/KD6): a transient post failure inside a LIVE Percy run must NOT
// drop to native (that would mix native + Percy in one build). Instead retry the post a few times
// with backoff; if it still fails, swallow (D3 — never fail the suite on a Percy error) at
// debug-level (plan: mid-run blip is debug-only, no user-facing alarm).
async function retryablePost(postFn, { retries = 3, backoff = 200, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await postFn();
    } catch (err) {
      lastErr = err;
      log.debug(`Percy: upload blip (attempt ${attempt + 1}/${retries + 1}) — ${err.message}`);
      if (attempt < retries) await sleep(backoff * (attempt + 1));
    }
  }
  // Exhausted retries: swallow per D3 — the run stays green; the post-matrix gate (Unit 5) is the
  // backstop for anything that genuinely didn't land.
  log.debug(`Percy: upload failed after retries — ${lastErr && lastErr.message}`);
  return undefined;
}

// With --update-snapshots=missing (Playwright's default), the built-in records the "snapshot
// doesn't exist, writing actual" failure as a SOFT ERROR: `handleMissing` returns `pass: true` plus
// a `softError` the step machinery feeds to `testInfo._failWithError` — pushing to testInfo.errors
// AND flipping testInfo.status to 'failed', entirely OUTSIDE the matcher's return value. Converting
// our result can't suppress it, so we remove the recorded error and restore status — but only when
// ours was the only failure on the test.
function scrubMissingBaselineSoftError() {
  try {
    const testInfo = require('@playwright/test').test.info();
    const errors = testInfo && testInfo.errors;
    if (!Array.isArray(errors)) return;
    let removed = false;
    for (let i = errors.length - 1; i >= 0; i--) {
      if (isMissingBaselineFailure(errors[i])) { errors.splice(i, 1); removed = true; }
    }
    if (removed && errors.length === 0 && testInfo.status === 'failed') {
      testInfo.status = testInfo.expectedStatus;
    }
  } catch { /* no live test — nothing to scrub */ }
}

// Delegate to the BUILT-IN toHaveScreenshot through a pristine expect chain (snapshotted in
// index.js BEFORE the override was injected). Playwright handles subject binding, matcher state and
// step reporting; a failing native compare THROWS out of the chain, so missing-baseline detection
// sees a real Error message (not a message-function).
async function runNativeViaExpect(nativeExpect, matcherState, args, { suppressMissingBaseline = false } = {}) {
  if (typeof nativeExpect !== 'function') {
    // No pristine chain available → we cannot do a native compare. Pass so we never fail worse
    // than pre-install would on an unsupported Playwright (D3 spirit).
    return { pass: true, message: () => 'Percy: native screenshot matcher unavailable — skipped' };
  }
  const [subject, ...rest] = args;
  while (rest.length && rest[rest.length - 1] === undefined) rest.pop();
  try {
    let chain = nativeExpect(subject);
    if (matcherState && matcherState.isNot) chain = chain.not;
    await chain.toHaveScreenshot(...rest);
    // A first run with no committed baseline "passes" the chain but soft-fails the test (see above).
    if (suppressMissingBaseline) scrubMissingBaselineSoftError();
    return { pass: !(matcherState && matcherState.isNot), message: () => '' };
  } catch (err) {
    if (suppressMissingBaseline && isMissingBaselineFailure(err)) {
      return { pass: true, message: () => 'Percy: first run — no committed baseline yet (suppressed)' };
    }
    throw err;
  }
}

module.exports = {
  captureNativeMatcher,
  runNativeMatcher,
  runNativeViaExpect,
  scrubMissingBaselineSoftError,
  isMissingBaselineFailure,
  noteNativeFallback,
  retryablePost,
  MISSING_BASELINE_RE,
  _resetNotice
};
