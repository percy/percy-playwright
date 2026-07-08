'use strict';

// @percy/playwright/dropin — overrides Playwright's toHaveScreenshot() so existing visual tests
// route through Percy, with one config line and no test rewrites. Requiring this module registers
// the override globally (Q3-proven: applies to tests importing `expect` straight from
// @playwright/test).
//
// Capture dispatch is AUTOMATIC, by the Percy PROJECT TYPE (config.js captureFlowFor — the CLI
// healthcheck's `percy.type`), delegating to the SDK flows that already exist in ../index.js:
//   • web      → percySnapshot's serialized-DOM flow (dom.js seam adds Locator scoping).
//   • automate → percyScreenshot (Percy on Automate).
//   • app/generic → raw-PNG upload through the EXISTING postComparison ingest (KD3 — web-shaped
//     tag + base64 content tile; capture.js owns the pixel capture, the only piece the root SDK
//     doesn't already have).
//
// Behaviour (per plan):
//   • Throw policy is CENTRALIZED HERE, ABOVE the capture seams (KD4): the flows return data;
//     index.js decides whether to pass/throw based on the active mode:
//       - async always-pass (D6, default): never throw; verdict deferred to Percy review.
//       - compat (D6/KD5): run the NATIVE matcher's throw semantics (missing-baseline suppressed).
//       - sync (D10/KD14): await the per-comparison verdict; throw inline ONLY on verdict+diff.
//   • D3: a Percy *error* NEVER fails the suite (try/catch + log.debug) — in every mode.
//   • Native fallback (D7/Unit 6): if Percy is disabled at the START of the run, the WHOLE run goes
//     native (latched once) so the suite behaves exactly as pre-install.
//
// The three modes are MUTUALLY EXCLUSIVE and resolved at config-load (Unit 7 / src/config.js).
const { expect: baseExpect, test } = require('@playwright/test');
const utils = require('@percy/sdk-utils');
const { captureFullOverride } = require('./capture');
const { snapshotViaPercy, resolvePageAndLocator } = require('./dom');
const { deriveIdentity } = require('./identity');
const fallback = require('./fallback');
const { classifySyncResult } = require('./sync');
const { loadConfig, validateConfig, assertSyncEngaged, modeStatusLine, captureFlowFor } = require('./config');

const { CLIENT_INFO, ENV_INFO } = require('./version-info');
const { pngDimensions } = require('./png');
const log = utils.logger('playwright-dropin');

// Capture Playwright's ORIGINAL toHaveScreenshot BEFORE we override the slot — the native-fallback
// (D7) and compat-mode (D6) paths invoke it. Must happen prior to the override registration below.
const nativeMatcher = fallback.captureNativeMatcher(baseExpect);

// Pristine expect snapshot for native delegation. `extend()` COPIES userMatchers at call time, so a
// chain created from this instance keeps dispatching to the BUILT-IN toHaveScreenshot even after we
// inject our override into the shared instance below. Subject binding, matcher state and step
// reporting all come from Playwright itself. (`captureNativeMatcher`'s raw-slot grab returns a
// closure with the subject already bound to `undefined` on Playwright >=1.49's expect, so it cannot
// be applied to a real page — kept only as a shape probe / legacy export.)
const nativeExpect = baseExpect.extend({});

function currentTestInfo() {
  try { return test.info(); } catch { return null; }
}

// First-build detection for the sync classifier (KD7). The globalSetup seed (Unit 4b) sets
// PERCY_DROPIN_FIRST_BUILD when it establishes the project's first baseline → the head this run is
// build #1, whose diffs are baseline-establishment noise. The reporter (Gate A) does the
// authoritative post-finish detection via the build's base-build relationship.
function isFirstBuildRun() {
  return process.env.PERCY_DROPIN_FIRST_BUILD === '1';
}

// Run-level native-fallback latch (D7/KD6). isPercyEnabled() is checked once at the FIRST assertion;
// its verdict is latched for the whole run so we never go partial-native mid-run (mid-run blips are
// retried instead). null = not yet decided. We also run the one-time config validation + footgun
// rejections (Unit 7) + the mode status line here.
let _runMode = null; // 'percy' | 'native'
let _validated = false;
async function resolveRunMode(config) {
  if (_runMode) return _runMode;

  // Fallback can be disabled by config (then we stay in Percy mode and simply no-op when disabled).
  const enabled = await utils.isPercyEnabled().catch(() => false);

  // One-time footgun validation + pre-flight checks (mutual exclusion, sync+deferred, token scope).
  // A rejected combination is a CONFIGURATION error the user must fix — it is allowed to throw out
  // of the matcher (unlike a Percy *runtime* error, which D3 swallows). We only validate when Percy
  // is live (native fallback means none of the modes are in play).
  if (enabled && !_validated) {
    _validated = true;
    await validateConfig(config);
    log.info(modeStatusLine(config));
  }

  if (enabled) {
    _runMode = 'percy';
  } else if (config.fallback) {
    fallback.noteNativeFallback('Percy not enabled at run start');
    _runMode = 'native';
  } else {
    // Fallback disabled → behave as the old skip-silently path (D6 always-pass, no native compare).
    _runMode = 'percy';
  }
  return _runMode;
}

// Test-only reset of the latch + native-notice (the harness re-requires a fresh process in CI, but
// unit tests in-process need to flip run state between cases).
function _resetRunState() { _runMode = null; _validated = false; fallback._resetNotice(); }

// Build the postComparison options for a captured tile. `sync` is added only in sync mode so the
// CLI awaits the per-comparison verdict (it also honours percy.config.snapshot.sync server-side).
function comparisonOptions({ name, browserFamily, width, pngBuffer, sync }) {
  // percy-api requires tag height (screenshot records validate presence); width stays the
  // IDENTITY width (viewport) so baseline↔head pairing is stable, height comes from the actual
  // PNG bytes (accurate for both page and element captures).
  const dims = pngDimensions(pngBuffer);
  const options = {
    name,
    clientInfo: CLIENT_INFO,
    environmentInfo: ENV_INFO,
    tag: { name: browserFamily, browserName: browserFamily, width, height: dims && dims.height },
    tiles: [{ content: pngBuffer.toString('base64') }]
  };
  if (sync) options.sync = true;
  return options;
}

// Lazy-required at dispatch time for the same CJS↔ESM interop reason as dom.js: the root module
// may be mid-load when the drop-in entry is evaluated (specs import both as ESM).
function rootPercyScreenshot(...args) {
  return require('../index.js').percyScreenshot(...args);
}

const percyMatchers = {
  async toHaveScreenshot(pageOrLocator, nameOrOptions, maybeOptions) {
    const config = loadConfig();
    const matcherState = this;
    const nativeArgs = [pageOrLocator, nameOrOptions, maybeOptions];

    // (1) Run-level native fallback (D7): Percy disabled at run start → native compare for the
    // WHOLE run. Native throws on real diffs (pre-install behaviour) but we suppress the
    // missing-baseline first-run throw so installing the drop-in can't red a fresh repo.
    const mode = await resolveRunMode(config);
    if (mode === 'native') {
      return fallback.runNativeViaExpect(nativeExpect, matcherState, nativeArgs, { suppressMissingBaseline: true });
    }

    // (2) Percy is live. Capture + post. D3: a Percy *error* must never fail the suite.
    let syncResult;
    try {
      if (!(await utils.isPercyEnabled())) {
        return { pass: true, message: () => 'Percy is disabled — snapshot skipped' };
      }

      // First-build-as-baseline: globalSetup seeded the committed snapshot PNGs as this build's
      // content, so live captures must NOT be posted on top — the auto-approved baseline is
      // exactly the blessed repo PNGs. The assertion still passes (always-pass posture).
      if (process.env.PERCY_DROPIN_SEEDED_BASELINE === '1') {
        return {
          pass: true,
          message: () => 'Percy: first build — baseline established from committed snapshots; live capture skipped'
        };
      }

      const nameArg = typeof nameOrOptions === 'string' || Array.isArray(nameOrOptions) ? nameOrOptions : undefined;
      const options = (typeof nameOrOptions === 'object' && !Array.isArray(nameOrOptions) ? nameOrOptions : maybeOptions) || {};

      const { name, browserFamily, width } = deriveIdentity(pageOrLocator, nameArg, currentTestInfo());

      // Automatic dispatch by Percy project type (utils.percy.type, cached by the
      // isPercyEnabled() above) — delegate to the SDK flow the project actually accepts.
      const flow = captureFlowFor();

      if (flow === 'snapshot') {
        // WEB project — the SDK's own percySnapshot (serialized DOM, server-side render), via the
        // dom.js seam that adds Locator scoping + viewport identity pinning. percySnapshot
        // swallows its own errors and returns the postSnapshot data; an undefined result in sync
        // mode lands in the classifier's no-verdict bucket (never a false-green — the gate
        // backstops).
        const response = await snapshotViaPercy(pageOrLocator, name, { width, sync: config.sync }, options);
        if (config.sync) {
          assertSyncEngaged(config);
          syncResult = response;
        }
      } else if (flow === 'automate') {
        // AUTOMATE project — the SDK's own percyScreenshot (Percy on Automate). The remote session
        // captures the full screen; Locator scoping has no equivalent there.
        const { page, locator } = resolvePageAndLocator(pageOrLocator);
        if (locator) {
          log.debug('Percy: Automate screenshots capture the session screen — Locator scoping is ignored');
        }
        const data = await rootPercyScreenshot(page, name, config.sync ? { sync: true } : undefined);
        if (config.sync) {
          assertSyncEngaged(config);
          syncResult = data;
        }
      } else {
        // APP/GENERIC project — screenshot/BYOS (capture.js seam): upload the pre-rendered PNG.
        const pngBuffer = await captureFullOverride(pageOrLocator, options);
        const postOptions = comparisonOptions({ name, browserFamily, width, pngBuffer, sync: config.sync });

        // KD3 reuse: the existing /percy/comparison ingest accepts a web-shaped tag + inline content
        // tile. In sync mode postComparison returns the per-comparison verdict; otherwise we
        // retry-on-blip (D7 mid-run) and never go native inside a live run.
        if (config.sync) {
          // Sync mode: a missing verdict must still red CI via the Gate-A backstop, so the post here
          // is NOT wrapped in retryablePost's swallow — the classifier owns the {error} bucket.
          syncResult = await utils.postComparison(postOptions);
          // Runtime guard: assert sync actually engaged (a deferred-upload that slipped in at runtime
          // would silently turn sync into a no-op). Surfaces loudly; the gate still backstops.
          assertSyncEngaged(config);
        } else {
          await fallback.retryablePost(() => utils.postComparison(postOptions));
        }
      }

      // (3) Sync mode (D10/KD14): apply the 3-way classifier ABOVE the capture seam. First-build
      // review-only (KD7) and the {error} no-verdict bucket are handled inside the classifier.
      if (config.sync) {
        const verdict = classifySyncResult(syncResult, { name, browserFamily, width }, { isFirstBuild: isFirstBuildRun() });
        if (verdict.throw) {
          // Real regression on a non-first build → fail THIS assertion inline (dashboard URL in msg).
          return { pass: false, message: () => verdict.message };
        }
        return { pass: true, message: () => verdict.message || '' };
      }
    } catch (err) {
      // D3: any Percy error (capture, post, classify) is swallowed — never fail the functional
      // suite on a Percy problem. The async/always-pass and sync paths both land here on error.
      log.debug(`Percy: skipped toHaveScreenshot — ${err.message}`);
    }

    // (4) Compat mode (D6/KD5): preserve native THROW semantics even with Percy on, but suppress
    // the missing-baseline first-run throw. Runs AFTER the Percy post so the snapshot still uploads.
    if (config.compat) {
      return fallback.runNativeViaExpect(nativeExpect, matcherState, nativeArgs, { suppressMissingBaseline: true });
    }

    // (5) Default async always-pass (D6): verdict deferred to Percy's async review.
    return { pass: true, message: () => '' };
  }
};

// Register the override on the SHARED expect instance tests import. Playwright's public
// `expect.extend()` SILENTLY SKIPS matcher names that collide with built-ins on the shared instance
// (1.60: `if (name in allBuiltinMatchers) continue`; 1.49: qualified-name shadowing) — the override
// only takes effect on the NEW instance extend() returns, which tests never import. To keep the
// zero-test-change promise we inject the matcher into the shared instance's userMatchers via its
// META_INFO symbol: call-time dispatch spreads `{...allBuiltinMatchers, ...userMatchers}`, so
// userMatchers win. Falls back to plain extend() (custom-name semantics) if the internal shape ever
// changes, and warns — a silent no-op here means NO snapshot ever reaches Percy while CI stays
// green, the worst failure mode this package has.
const metaSym = Object.getOwnPropertySymbols(baseExpect)
  .find(s => baseExpect[s] && typeof baseExpect[s] === 'object' && baseExpect[s].userMatchers);
if (metaSym) {
  baseExpect[metaSym].userMatchers.toHaveScreenshot = percyMatchers.toHaveScreenshot;
} else {
  baseExpect.extend(percyMatchers);
  log.warn('Percy: could not inject the toHaveScreenshot override into this Playwright version — ' +
    'falling back to expect.extend(), which may be ignored for built-in matcher names. ' +
    'If snapshots do not appear in Percy, this Playwright version is unsupported.');
}

// Unit 4b — the first-build baseline seed (the bet). Exposed so a consumer can either point
// `globalSetup` at the package's `/global-setup` entry, or call this from their own globalSetup.
const baselineGlobalSetup = require('./global-setup');

// Unit 5 — the opt-in gate reporter, exposed for one-line wiring in playwright.config `reporter`.
const PercyGateReporter = require('./reporter');

module.exports = {
  CLIENT_INFO,
  ENV_INFO,
  baselineGlobalSetup,
  PercyGateReporter,
  _resetRunState,
  nativeMatcher
};
