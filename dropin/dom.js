'use strict';

// Snapshot seam for the toHaveScreenshot drop-in — the WEB-project dispatch target.
//
// This is a thin wrapper around the repo's own `percySnapshot()` (index.js): the drop-in calls the
// EXACT entry point a hand-written `percySnapshot(page, name)` test would, so it inherits the DOM
// injection, closed-shadow-root piercing, readiness gate, responsive capture, cross-origin iframe
// serialization and the postSnapshot call — nothing is reimplemented here and the two entry points
// can never drift apart.
//
// What this seam adds on top:
//   • Locator subjects → SCOPED snapshots: the element is marked with a data attribute that
//     survives serialization and the snapshot is posted with `scope`, so Percy's server-side
//     render clips to the element (you cannot screenshot "part of a DOM" any other way).
//   • Identity pinning: the test's viewport width is sent as `widths: [width]` (and its height as
//     `minHeight`) so Percy renders at the same width the assertion ran at — the project-level
//     width config does not multiply drop-in snapshots.
//   • toHaveScreenshot-only options (clip/mask/animations/…) are surfaced at debug as ignored —
//     they apply to raw pixels, not a server-side render.
//
// SEMANTICS (vs screenshot flow): Percy renders web snapshots in ITS OWN browsers (project
// settings), not the Playwright browser the test ran in — `browser_family` identity is
// server-controlled here.
const utils = require('@percy/sdk-utils');

const log = utils.logger('playwright-dropin');

// Lazy-required at capture time: the root module may itself be mid-load when the drop-in entry is
// evaluated (specs import both as ESM), and a top-level require here trips Node's CJS↔ESM
// interop on a partially-initialized module.
function rootPercySnapshot(...args) {
  return require('../index.js').percySnapshot(...args);
}

const SCOPE_ATTR = 'data-percy-dropin-scope';

// toHaveScreenshot options that only make sense for the raw-pixel screenshot flow.
const SCREENSHOT_ONLY_OPTS = Object.freeze([
  'clip', 'fullPage', 'mask', 'maskColor', 'omitBackground', 'scale', 'animations', 'caret', 'style', 'stylePath'
]);

// A Locator exposes `.page()`; a Page does not.
function resolvePageAndLocator(pageOrLocator) {
  const isLocator = pageOrLocator && typeof pageOrLocator.page === 'function';
  return isLocator
    ? { page: pageOrLocator.page(), locator: pageOrLocator }
    : { page: pageOrLocator, locator: null };
}

// Take a Percy web snapshot for a Page or Locator subject by delegating to the SDK's own
// `percySnapshot`. Returns percySnapshot's return value (the postSnapshot response data — the
// sync verdict when `sync` is set, undefined otherwise or on a swallowed error; the sync
// classifier owns the undefined case). Never throws after the marker is set — percySnapshot
// catches its own errors (D3), and marker cleanup is `finally`-guarded. `deps` is injectable
// for tests.
async function snapshotViaPercy(pageOrLocator, name, { width, sync } = {}, options = {}, deps = {}) {
  const percySnapshot = deps.percySnapshot || rootPercySnapshot;
  const { page, locator } = resolvePageAndLocator(pageOrLocator);

  const ignored = SCREENSHOT_ONLY_OPTS.filter(k => options && options[k] !== undefined);
  if (ignored.length) {
    log.debug(`Percy: snapshot flow ignores screenshot-only option(s): ${ignored.join(', ')}`);
  }

  // Locator subject → mark the element so the server-side render can be scoped to it. The marker
  // attribute survives serialization (no fragile CSS-selector reconstruction) and is removed right
  // after capture so the live page is left untouched.
  let scope = null;
  if (locator) {
    // istanbul ignore next - browser-executed function (instrumentation counters don't exist there)
    await locator.evaluate((el, attr) => el.setAttribute(attr, ''), SCOPE_ATTR);
    scope = `[${SCOPE_ATTR}]`;
  }

  const viewport = (page && typeof page.viewportSize === 'function' && page.viewportSize()) || null;
  const snapshotOptions = {};
  if (width) snapshotOptions.widths = [width];
  if (viewport && viewport.height) snapshotOptions.minHeight = viewport.height;
  if (scope) snapshotOptions.scope = scope;
  if (sync) snapshotOptions.sync = true;

  try {
    return await percySnapshot(page, name, snapshotOptions);
  } finally {
    if (locator) {
      // istanbul ignore next - browser-executed function (instrumentation counters don't exist there)
      await locator.evaluate((el, attr) => el.removeAttribute(attr), SCOPE_ATTR).catch(() => {});
    }
  }
}

module.exports = { snapshotViaPercy, resolvePageAndLocator, SCOPE_ATTR, SCREENSHOT_ONLY_OPTS };
