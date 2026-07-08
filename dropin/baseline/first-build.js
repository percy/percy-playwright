'use strict';

// First-build-as-baseline (flag-passing model — supersedes the two-build parallel-nonce seed).
//
// Chain: the `percy-playwright` wrapper (or the customer) sets PERCY_DROPIN_BASELINE_CANDIDATE=true
// → @percy/client sends `dropin-baseline-candidate` on createBuild → percy-api rewrites the build's
// source to 'playwright-dropin-baseline' IFF this is the project's FIRST visible build (server
// decides first-ness; the flag can never rebaseline an established project) → the CLI exposes the
// decided source through /percy/healthcheck (`percy.build.source`).
//
// When the server says "this build IS the baseline":
//   • globalSetup fills the run's ONE build with the repo's COMMITTED snapshot PNGs — the baselines
//     the user has already blessed (TB) — via the normal CLI comparison path (they belong to this
//     very build, so no client-direct ingest, no nonce, no poll, no defer-uploads dance).
//   • The toHaveScreenshot override SKIPS posting live captures (PERCY_DROPIN_SEEDED_BASELINE=1) so
//     the baseline contains exactly the blessed PNGs; assertions still pass (always-pass).
//   • percy-api auto-approves the build at finish (KD13: source-keyed + first-baseline bound +
//     the `playwright-dropin-baseline-ingest` rollout kill-switch). Diffs start on the next run.
//
// With no committed snapshots the live captures become the first build's content instead (the
// override posts normally) — still auto-approved server-side, matching native Playwright's own
// "first run writes the baselines" behavior.
const fs = require('fs');
const utils = require('@percy/sdk-utils');
const { discoverBaselines } = require('./discover');
const { pngDimensions } = require('../png');

const log = utils.logger('playwright-dropin');

const BASELINE_SOURCE = 'playwright-dropin-baseline';

// Parallel seed-upload cap: high enough to keep globalSetup fast on large baseline sets, low
// enough not to stampede the local CLI server's request queue.
const SEED_CONCURRENCY = 8;

const OUTCOME = Object.freeze({
  NOT_FIRST_BUILD: 'not_first_build',
  SEEDED: 'seeded',
  NO_BASELINES: 'no_baselines',
  UNMAPPABLE: 'unmappable'
});

// Runs inside globalSetup, after isPercyEnabled() has populated `utils.percy`. Returns
// { firstBuild, seeded, outcome } and never throws (a Percy problem must not abort the suite).
async function firstBuildBaseline(
  { rootDir, snapshotDir, playwrightConfig, clientInfo, environmentInfo } = {},
  deps = {}
) {
  const discover = deps.discoverBaselines || discoverBaselines;
  const post = deps.postComparison || (options => utils.postComparison(options));
  const readFile = deps.readFile || fs.promises.readFile;
  const build = deps.build !== undefined ? deps.build : (utils.percy && utils.percy.build);

  // The server decided this is NOT the project's first build (or the CLI predates the candidate
  // flag and never sent it) — the run's build is a normal head; nothing to seed.
  if (!build || build.source !== BASELINE_SOURCE) {
    return { firstBuild: false, seeded: 0, outcome: OUTCOME.NOT_FIRST_BUILD };
  }

  const { baselines, degraded, reason } = discover({
    rootDir, snapshotDir, config: playwrightConfig
  });

  if (degraded) {
    return { firstBuild: true, seeded: 0, outcome: OUTCOME.UNMAPPABLE, degradeReason: reason };
  }
  if (!baselines || !baselines.length) {
    return { firstBuild: true, seeded: 0, outcome: OUTCOME.NO_BASELINES };
  }

  // Bounded-concurrency ingest (TB §11 scale): a repo can carry hundreds of committed baselines
  // and globalSetup blocks the suite start — post in parallel, but capped so we never stampede
  // the local CLI server. Per-file failures are skipped (partial baseline beats none).
  const concurrency = deps.concurrency || SEED_CONCURRENCY;
  let seeded = 0;
  const queue = [...baselines];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      try {
        // The buffer is both the tile content and the source of truth for tag height (percy-api
        // validates height presence on screenshot records — see src/png.js).
        const buf = await readFile(b.filepath);
        const dims = pngDimensions(buf);
        await post({
          name: b.name,
          clientInfo,
          environmentInfo,
          tag: {
            name: b.browserFamily,
            browserName: b.browserFamily,
            width: b.width || (dims && dims.width) || undefined,
            height: (dims && dims.height) || undefined
          },
          tiles: [{ content: buf.toString('base64') }]
        });
        seeded += 1;
      } catch (err) {
        log.debug(`Percy: skipped committed baseline "${b.name}" — ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, baselines.length) }, worker));

  return { firstBuild: true, seeded, outcome: seeded > 0 ? OUTCOME.SEEDED : OUTCOME.NO_BASELINES };
}

module.exports = { firstBuildBaseline, BASELINE_SOURCE, OUTCOME };
