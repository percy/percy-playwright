'use strict';

// The @percy/cli baseline provider for the Playwright toHaveScreenshot drop-in.
//
// `percy exec` discovers this module through the package.json entry
//   "@percy/cli": { "baselineProvider": "dropin/baseline/provider.js" }
// and, on an EMPTY Percy project, uploads the discovered baselines as an auto-approved build #1
// before the user's test command runs (the suite never executes for the baseline). The explicit
// `percy playwright:setup-baseline` command uses the same discovery for established projects.
//
// All Playwright knowledge lives here (where committed screenshots are, how their filenames map
// onto Percy snapshot identity); the CLI only orchestrates builds and uploads.
const fs = require('fs');
const { discoverBaselines } = require('./discover');
const { resolvePlaywrightConfig } = require('./resolve-config');
const { pngDimensions } = require('../png');

// Source tag `percy exec` stamps on head builds while the drop-in SDK is installed.
const BUILD_SOURCE = 'playwright-dropin';

// Read just the PNG header for the tag height — baseline sets can be large; the CLI streams the
// full file at upload time from `filepath`.
function pngHeaderDimensions(filepath) {
  const buf = Buffer.alloc(24);
  const fd = fs.openSync(filepath, 'r');
  try {
    fs.readSync(fd, buf, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  return pngDimensions(buf);
}

// Provider contract: -> { baselines: [{ filepath, name, browserFamily, width, height }],
// degraded?, reason? }. Identity width stays the project viewport width (stable baseline↔head
// pairing); height comes from the PNG bytes (percy-api validates tag height presence). `deps` is
// injectable for tests.
async function providerDiscoverBaselines({ cwd = process.cwd(), log } = {}, deps = {}) {
  const resolveConfig = deps.resolveConfig || resolvePlaywrightConfig;
  const readDimensions = deps.readDimensions || pngHeaderDimensions;

  const config = resolveConfig({ cwd, log });
  if (!config) {
    return { baselines: [], degraded: true, reason: 'playwright_config_unresolvable' };
  }

  const result = discoverBaselines({ rootDir: config.rootDir || cwd, snapshotDir: config.snapshotDir, config });
  if (result.degraded || !result.baselines.length) return result;

  const baselines = [];
  for (const b of result.baselines) {
    try {
      const dims = readDimensions(b.filepath);
      baselines.push({ ...b, height: dims && dims.height });
    } catch (err) {
      if (log) log.debug(`Percy: skipped unreadable baseline "${b.name}" — ${err.message}`);
    }
  }

  return { ...result, baselines };
}

module.exports = {
  buildSource: BUILD_SOURCE,
  discoverBaselines: providerDiscoverBaselines
};
