'use strict';

// Screenshot seam for the toHaveScreenshot drop-in — the AUTOMATE-project dispatch target.
//
// This is a thin wrapper around the repo's own `percyScreenshot()` (index.js): the drop-in hands
// off to the EXACT Percy-on-Automate entry point a hand-written `percyScreenshot(page, name)`
// test would use, so it inherits the session-details lookup, the CLI `/percy/automateScreenshot`
// handoff and the remote capture — nothing is reimplemented here and the two entry points can
// never drift apart.
//
// SEMANTICS (vs the web/app flows): the capture happens on the REMOTE BrowserStack browser via
// the Automate session — no local pixels or DOM ever leave the test process, and the comparison
// tag identity (browser/os/width/device) comes from the real session, not from the Playwright
// config. That has two consequences surfaced here:
//   • The suite MUST be running on BrowserStack Automate (e.g. via browserstack-node-sdk). A
//     local browser has no session to capture through — that is a configuration error, reported
//     with a clear message instead of percyScreenshot's raw JSON-parse noise.
//   • Locator subjects and raw-pixel options (mask/clip/…) cannot apply to a remote capture;
//     they degrade to a full-page capture and are surfaced once at warn level.
const utils = require('@percy/sdk-utils');
const { Utils } = require('../utils');

const log = utils.logger('playwright-dropin');

// Lazy-required at capture time: the root module may itself be mid-load when the drop-in entry is
// evaluated (specs import both as ESM), and a top-level require here trips Node's CJS↔ESM
// interop on a partially-initialized module.
function rootPercyScreenshot(...args) {
  return require('../index.js').percyScreenshot(...args);
}

// toHaveScreenshot options that only make sense for a LOCAL capture — the remote Automate
// capture cannot apply them. `fullPage` is the one local capture option with a POA equivalent
// and is mapped through instead.
const LOCAL_ONLY_OPTS = Object.freeze([
  'clip', 'mask', 'maskColor', 'omitBackground', 'scale', 'animations', 'caret', 'style', 'stylePath'
]);

// One-per-run notices — every assertion in a suite hits the same degradations, so warn once.
let _localOptsWarned = false;
let _locatorWarned = false;
function _resetNotices() { _localOptsWarned = false; _locatorWarned = false; }

// A Locator exposes `.page()`; a Page does not.
function resolvePage(pageOrLocator) {
  return pageOrLocator && typeof pageOrLocator.page === 'function'
    ? pageOrLocator.page()
    : pageOrLocator;
}

// Take a Percy-on-Automate screenshot for a Page or Locator subject by delegating to the SDK's
// own `percyScreenshot`. Returns percyScreenshot's return value (the comparison detail when
// `sync` is set, undefined otherwise or on a swallowed error; the sync classifier owns the
// undefined case). Throws ONLY the configuration error below — percyScreenshot catches its own
// runtime errors. `deps` is injectable for tests.
async function screenshotViaAutomate(pageOrLocator, name, { sync } = {}, options = {}, deps = {}) {
  const percyScreenshot = deps.percyScreenshot || rootPercyScreenshot;
  const sessionDetails = deps.sessionDetails || (page => Utils.sessionDetails(page));
  const page = resolvePage(pageOrLocator);

  if (page !== pageOrLocator && !_locatorWarned) {
    _locatorWarned = true;
    log.warn('Percy: element screenshots are not supported on Automate projects — capturing the ' +
      'full page for Locator subjects (the snapshot name is unchanged, so baselines stay stable)');
  }

  const ignored = LOCAL_ONLY_OPTS.filter(k => options && options[k] !== undefined);
  if (ignored.length && !_localOptsWarned) {
    _localOptsWarned = true;
    log.warn(`Percy: ignoring toHaveScreenshot option(s) on an Automate project: ${ignored.join(', ')} — ` +
      'the capture happens on the remote BrowserStack browser, not from local pixels');
  }

  // Session preflight. `getSessionDetails` only answers on a BrowserStack Automate browser — on a
  // local browser the executor script evaluates to nothing and percyScreenshot would surface an
  // opaque JSON-parse error. Detect that here and raise a CONFIGURATION error (same class as a
  // wrong token: the user must fix their setup, so it is allowed to fail the assertion) with the
  // actual fix in the message. Detection is per-assertion, not latched — hybrid suites that run
  // some Playwright projects locally and some on BrowserStack keep working for the remote ones.
  let session = null;
  try {
    session = await sessionDetails(page);
  } catch { /* handled below — an unreachable/undecodable session is the same config error */ }
  if (!session || !session.hashed_id) {
    const err = new Error('Percy: the configured token is for a Percy on Automate project, but ' +
      'this browser is not a BrowserStack Automate session — run the suite on BrowserStack ' +
      '(e.g. via browserstack-node-sdk), or use a web/app project token for local runs.');
    err.isConfigurationError = true;
    throw err;
  }

  const poaOptions = {};
  if (options && options.fullPage !== undefined) poaOptions.fullPage = options.fullPage;
  if (sync) poaOptions.sync = true;

  return percyScreenshot(page, name, poaOptions);
}

module.exports = { screenshotViaAutomate, resolvePage, LOCAL_ONLY_OPTS, _resetNotices };
