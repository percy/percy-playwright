'use strict';

// Unit 4b — first-build baseline, wired as a Playwright `globalSetup`.
//
// Flag-passing model (supersedes the two-build parallel-nonce seed): the run's ONE build was
// already created by `percy exec` with the `dropin-baseline-candidate` flag (via the
// `percy-playwright` wrapper's PERCY_DROPIN_BASELINE_CANDIDATE env, mirroring PERCY_BUILD_SOURCE).
// percy-api decided first-ness at create time; the CLI healthcheck exposes the decision as
// `percy.build.source`. When this build IS the baseline, globalSetup fills it with the repo's
// committed snapshot PNGs (the baselines the user already blessed — TB) and the override skips
// live captures; percy-api auto-approves the build at finish (KD13).
//
// One-line wiring (consumer's playwright.config.js):
//   const { baselineGlobalSetup } = require('@percy/playwright-dropin');
//   module.exports = defineConfig({ globalSetup: require.resolve('@percy/playwright-dropin/global-setup'), ... });
// or, if the consumer already has a globalSetup, call `baselineGlobalSetup()` from inside it.
const utils = require('@percy/sdk-utils');
const { firstBuildBaseline, OUTCOME } = require('./baseline/first-build');
const { loadConfig } = require('./config');

const { CLIENT_INFO, ENV_INFO } = require('./version-info');
const log = utils.logger('playwright-dropin');

// D9 (Unit 8 drop-in part) — when a run SEEDS the project's first baseline, the acting user is
// establishing what "correct" looks like; warn them explicitly (CLI stderr once). The percy-api
// telemetry/flag side is handled separately — this is the drop-in console warning only.
function warnBaselineSeeding(result) {
  if (!result || !result.firstBuild) return;
  const who = process.env.PERCY_GIT_AUTHOR || process.env.GIT_AUTHOR_NAME || process.env.USER || 'you';
  log.warn('Percy: this run establishes the project\'s first baseline — ' +
    `${who} is establishing the baseline these snapshots will be reviewed against. ` +
    'Subsequent runs diff against it.');
}

// User-facing first-build copy (plan §User-Facing States). Distinguish outcomes.
function reportOutcome(result) {
  if (!result || !result.firstBuild) {
    log.info('Percy: using your project\'s existing baseline — this build diffs against it as usual');
    return;
  }
  switch (result.outcome) {
    case OUTCOME.SEEDED:
      log.info(`Percy: first build — seeded ${result.seeded} committed snapshot(s) as the baseline ` +
        '(auto-approved; diffs start on your next run)');
      break;
    case OUTCOME.UNMAPPABLE:
      log.info('Percy: your Playwright snapshot naming could not be mapped automatically — ' +
        'this run\'s captures become the baseline; diffs start on your next run');
      break;
    case OUTCOME.NO_BASELINES:
    default:
      log.info('Percy: first build — no committed snapshots found; this run\'s captures become ' +
        'the baseline (auto-approved; diffs start on your next run)');
  }
}

// Normalize a Playwright FullConfig (as passed to globalSetup) into the minimal shape discover.js
// reads. FullConfig exposes `.projects` (each a FullProject with `.name`, `.use`, and the resolved
// `.snapshotPathTemplate`) and may carry top-level template fields. We pass through only what
// forward identity reconstruction needs; missing fields make discovery degrade, not crash.
function normalizePlaywrightConfig(config) {
  if (!config || typeof config !== 'object') return {};
  const projects = Array.isArray(config.projects)
    ? config.projects.map(p => ({
      name: p.name || '',
      use: p.use || {},
      snapshotPathTemplate: p.snapshotPathTemplate,
      expect: p.expect
    }))
    : [];
  return {
    projects,
    use: config.use,
    snapshotPathTemplate: config.snapshotPathTemplate,
    expect: config.expect
  };
}

// The globalSetup entry. Never throws — a Percy seed failure must not block the test run (D3).
async function baselineGlobalSetup(config) {
  try {
    if (!(await utils.isPercyEnabled())) {
      log.debug('Percy is disabled — skipping first-build baseline seed');
      return;
    }

    // The committed-baseline seed uploads Playwright's PNGs through the raw-image (screenshot)
    // ingest — meaningless for a web project, whose baselines are server-side renders. In snapshot
    // mode the build diffs against the project's existing web baseline as usual.
    if (loadConfig().captureMode === 'snapshot') {
      log.info('Percy: the committed-baseline seed is screenshot-mode only — skipped ' +
        '(captureMode: snapshot; this build diffs against your project\'s existing baseline as usual)');
      return { firstBuild: false, seeded: 0, outcome: 'snapshot-mode' };
    }

    // Map Playwright config → discover inputs. `config.rootDir`/`configFile` are best-effort: the
    // discover module falls back to conventional `*-snapshots` locations when they're absent.
    const rootDir = (config && (config.rootDir || (config.configFile && require('path').dirname(config.configFile)))) || process.cwd();

    // Normalize the resolved Playwright FullConfig into the shape discover expects for forward
    // identity reconstruction (Unit 3 / R6): per-project { name, use, snapshotPathTemplate, expect }
    // plus the top-level template fields. Discovery degrades to live-capture baseline on anything
    // it can't map (custom template, missing browserName/viewport, ambiguous tail, path-array {arg}).
    const playwrightConfig = normalizePlaywrightConfig(config);

    const result = await firstBuildBaseline({
      rootDir,
      playwrightConfig,
      clientInfo: CLIENT_INFO,
      environmentInfo: ENV_INFO
    });

    if (result.firstBuild) {
      // KD7: this run IS build #1 — review-only for the gate/sync classifier. Workers read these
      // via the env (globalSetup runs in the main process; workers fork after it).
      process.env.PERCY_DROPIN_FIRST_BUILD = '1';

      // Committed snapshots were seeded as this build's content — the override must NOT post live
      // captures on top (the baseline is exactly the blessed PNGs). Without a seed, live captures
      // become the baseline instead and the override posts normally.
      if (result.outcome === OUTCOME.SEEDED) {
        process.env.PERCY_DROPIN_SEEDED_BASELINE = '1';
      }
    }

    warnBaselineSeeding(result);
    reportOutcome(result);
    return result;
  } catch (err) {
    // Belt-and-suspenders: firstBuildBaseline already swallows its own errors, but globalSetup must
    // be bulletproof — a throw here would abort the whole suite.
    log.debug(`Percy: first-build baseline seed skipped — ${err.message}`);
  }
}

module.exports = baselineGlobalSetup;
module.exports.baselineGlobalSetup = baselineGlobalSetup;
module.exports.reportOutcome = reportOutcome;
module.exports.warnBaselineSeeding = warnBaselineSeeding;
module.exports.CLIENT_INFO = CLIENT_INFO;
