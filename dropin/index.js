'use strict';

// @percy/playwright/dropin — overrides Playwright's toHaveScreenshot() so existing visual tests
// route through Percy, with one config line and no test rewrites. Requiring this module registers
// the override globally (Q3-proven: applies to tests importing `expect` straight from
// @playwright/test).
//
// Capture dispatch is AUTOMATIC, by the Percy PROJECT TYPE (the token):
//   • WEB project → the SDK's own `percySnapshot` serialized-DOM flow (dom.js seam adds Locator
//     scoping), rendered server-side by Percy's pipeline.
//   • APP project → the captured PNG uploads straight through the comparison ingest — no render
//     flow is triggered, exactly how App Percy ingests screenshots today (capture.js owns the
//     pixel capture).
//   • Any other token (automate, generic, ...) is a CONFIGURATION error (validateConfig throws,
//     like other SDKs' wrong-token errors).
//
// Baseline seeding is CLI-DRIVEN and never happens in-process here: `percy exec` uploads the
// committed Playwright PNGs as an auto-approved build #1 on an empty project (before any test
// runs), and `percy playwright:setup-baseline` does the same explicitly on established projects
// (see dropin/baseline/provider.js + commands/setup-baseline.mjs).
//
// Behaviour (per plan):
//   • Throw policy is CENTRALIZED HERE, ABOVE the capture seam (KD4): the flow returns data;
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
const { snapshotViaPercy } = require('./dom');
const { deriveIdentity } = require('./identity');
const fallback = require('./fallback');
const { classifySyncResult } = require('./sync');
const { loadConfig, validateConfig, assertSyncEngaged, modeStatusLine } = require('./config');

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

// First-build detection for the sync classifier (KD7). With no committed baselines the head run
// itself becomes the project's baseline: `percy exec` sends the baseline-candidate flag and the
// API rewrites the build's source iff it is the project's first build. The CLI exposes the decided
// source through the healthcheck build info — when this run's build IS the baseline, its diffs are
// baseline-establishment noise. The reporter (Gate A) does the authoritative post-finish detection.
function isFirstBuildRun() {
  return Boolean(utils.percy && utils.percy.build &&
    utils.percy.build.source === 'playwright-dropin-baseline');
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

// Build the postComparison options for a captured tile (APP projects). `sync` is added only in
// sync mode so the CLI awaits the per-comparison verdict.
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

      const nameArg = typeof nameOrOptions === 'string' || Array.isArray(nameOrOptions) ? nameOrOptions : undefined;
      const options = (typeof nameOrOptions === 'object' && !Array.isArray(nameOrOptions) ? nameOrOptions : maybeOptions) || {};

      const { name, browserFamily, width } = deriveIdentity(pageOrLocator, nameArg, currentTestInfo());

      // Automatic dispatch by project type (validateConfig has already rejected anything that is
      // neither web nor app, so this is a clean two-way switch).
      if (((utils.percy && utils.percy.type) || 'web') === 'app') {
        // APP project — upload the captured PNG straight through the comparison ingest; no render
        // flow is triggered server-side (exactly how App Percy ingests screenshots).
        const pngBuffer = await captureFullOverride(pageOrLocator, options);
        const postOptions = comparisonOptions({ name, browserFamily, width, pngBuffer, sync: config.sync });

        if (config.sync) {
          // Sync mode: a missing verdict must still red CI via the Gate-A backstop, so the post
          // here is NOT wrapped in retryablePost's swallow — the classifier owns the {error}
          // bucket. Runtime guard: assert sync actually engaged (a deferred-upload that slipped
          // in at runtime would silently turn sync into a no-op).
          syncResult = await utils.postComparison(postOptions);
          assertSyncEngaged(config);
        } else {
          await fallback.retryablePost(() => utils.postComparison(postOptions));
        }
      } else {
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

// Unit 5 — the opt-in gate reporter, exposed for one-line wiring in playwright.config `reporter`.
const PercyGateReporter = require('./reporter');

module.exports = {
  CLIENT_INFO,
  ENV_INFO,
  PercyGateReporter,
  _resetRunState,
  nativeMatcher
};
