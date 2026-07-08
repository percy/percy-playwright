'use strict';

// Unit 3 / R6 — the SINGLE source of snapshot-identity truth, shared by the head-capture override
// (index.js) and the committed-baseline discovery (baseline/discover.js).
//
// Percy pairs a comparison by its identity tuple `(name, browser_family, width)`. For a committed
// Playwright baseline PNG and its head capture to land on the SAME comparison (a real diff, not two
// "new" snapshots), both sides MUST derive that tuple the same way.
//
// `browser_family` and `width` are NOT recoverable from a PNG filename — `browser_family` comes from
// `projectName → use.browserName` and `width` from `use.viewport.width` (config-only; the width
// never appears in the path). So discovery reconstructs them FORWARD from the resolved config and we
// only ever derive `name` from a Playwright artifact. The `name` derivation below mirrors
// Playwright's own snapshot-path logic (workerProcessEntry `_resolveSnapshotPaths`) byte-for-byte so
// the capture-time name equals the on-disk `{arg}` stem.

// Playwright's filename sanitizer (playwright-core `sanitizeForFilePath`): collapse every run of
// "special" chars into a single `-`. Letters, digits, `-` and `_` survive. Kept in lock-step with
// Playwright; if upstream changes this regex, baseline↔head pairing would silently break.
// eslint-disable-next-line no-control-regex
const SANITIZE_RE = /[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g;

function sanitizeForFilePath(s) {
  return String(s).replace(SANITIZE_RE, '-');
}

// Per-test anonymous/named snapshot counters, mirroring Playwright's `lastAnonymousSnapshotIndex` /
// `lastNamedSnapshotIndex`. Playwright increments these per test; we key by the live testInfo object
// so repeated `toHaveScreenshot()` calls in one test get `-1`, `-2`, … exactly as the committed
// filenames would. A WeakMap lets finished tests be GC'd. When no testInfo is available (shouldn't
// happen inside a Playwright test) we fall back to a per-process counter map keyed by stem.
const COUNTERS = new WeakMap();
const FALLBACK_COUNTERS = { anon: 0, named: new Map() };

function countersFor(testInfo) {
  if (!testInfo) return FALLBACK_COUNTERS;
  let c = COUNTERS.get(testInfo);
  if (!c) {
    c = { anon: 0, named: new Map() };
    COUNTERS.set(testInfo, c);
  }
  return c;
}

// Build the sanitized stem Playwright would write for an ANONYMOUS (no name arg) screenshot:
//   sanitize([...titlePath.slice(1), index].join(' '))
// where `index` is the 1-based per-test anonymous counter (1 produces no numeric suffix only in the
// sense that the stem is `… 1`; Playwright always appends the index for anonymous snapshots).
function anonymousStem(titlePath, index) {
  const parts = (Array.isArray(titlePath) ? titlePath.slice(1) : []).filter(Boolean);
  return sanitizeForFilePath([...parts, index].join(' '));
}

// Build the sanitized stem for a NAMED screenshot. Playwright sanitizes the name (sans `.png`) and,
// for the 2nd+ call with the SAME name in one test, appends `-{index-1}` (so `shot`, `shot-1`, …).
// A path-array name (nested subdirs) is joined with `/` then sanitized per-segment by Playwright;
// we join with `/` and sanitize the whole thing, which collapses `/` to `-` — see `degrade` note in
// discover.js (a path-array baseline is treated as unmappable there, so capture-side parity for the
// array case is best-effort only).
function namedStem(rawName, testInfo) {
  const joined = Array.isArray(rawName) ? rawName.join('/') : String(rawName);
  const withoutExt = joined.replace(/\.png$/i, '');
  const sanitized = sanitizeForFilePath(withoutExt);

  const counters = countersFor(testInfo);
  const index = (counters.named.get(sanitized) || 0) + 1;
  counters.named.set(sanitized, index);
  return index > 1 ? `${sanitized}-${index - 1}` : sanitized;
}

// Reconstruct the snapshot `name` for a head capture exactly as Playwright would name the committed
// baseline file. `nameArg` is the explicit `toHaveScreenshot(name)` argument (string or path-array)
// or undefined for an anonymous call.
function deriveName(nameArg, testInfo) {
  if (nameArg !== undefined && nameArg !== null && nameArg !== '') {
    return namedStem(nameArg, testInfo);
  }
  const titlePath = testInfo && Array.isArray(testInfo.titlePath) ? testInfo.titlePath : [];
  const counters = countersFor(testInfo);
  counters.anon += 1;
  return anonymousStem(titlePath, counters.anon);
}

// D2 — map a toHaveScreenshot call onto Percy's (name, browser_family, width).
// - name: the sanitized stem Playwright would write on disk (so it pairs with the committed PNG).
// - browserFamily: the Playwright project name (chromium/firefox/webkit) — the comparison-tag identity.
// - width: the page viewport width.
function deriveIdentity(pageOrLocator, nameArg, testInfo) {
  const page = pageOrLocator && typeof pageOrLocator.page === 'function'
    ? pageOrLocator.page()
    : pageOrLocator;
  const viewport = (page && typeof page.viewportSize === 'function' && page.viewportSize()) || { width: 1280 };

  const name = deriveName(nameArg, testInfo);
  const browserFamily = (testInfo && testInfo.project && testInfo.project.name) || 'chromium';
  return { name, browserFamily, width: viewport.width };
}

// Test-only: reset the fallback counters (the per-testInfo WeakMap clears itself as tests are GC'd,
// but the process-wide fallback map persists across in-process unit cases).
function _resetCounters() {
  FALLBACK_COUNTERS.anon = 0;
  FALLBACK_COUNTERS.named.clear();
}

module.exports = {
  deriveIdentity,
  deriveName,
  sanitizeForFilePath,
  anonymousStem,
  _resetCounters
};
