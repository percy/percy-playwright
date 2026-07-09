'use strict';

// Playwright reporter used ONLY to capture the RESOLVED config outside a test run.
//
// Baseline discovery (discover.js) reconstructs snapshot identity from the resolved config
// (projects' browserName/viewport, snapshot path templates). Inside a test run that config came
// from globalSetup's FullConfig; the CLI-driven seeding flow runs BEFORE any test run, so
// resolve-config.js spawns `npx playwright test --list --reporter=<this file>` — Playwright
// resolves its own config (including TS configs) and hands it to `onBegin`, which serializes the
// minimal shape discovery needs to the file named by PERCY_PW_CONFIG_OUT. `--list` performs test
// discovery only; no test executes.
const fs = require('fs');

const screenshotTpl = obj =>
  obj && obj.expect && obj.expect.toHaveScreenshot && obj.expect.toHaveScreenshot.pathTemplate;

class PercyConfigReporter {
  onBegin(config) {
    const out = process.env.PERCY_PW_CONFIG_OUT;
    if (!out) return;

    const shape = {
      rootDir: config.rootDir,
      snapshotPathTemplate: config.snapshotPathTemplate,
      expect: screenshotTpl(config)
        ? { toHaveScreenshot: { pathTemplate: screenshotTpl(config) } }
        : undefined,
      projects: (config.projects || []).map(p => ({
        name: p.name || '',
        use: {
          browserName: p.use && p.use.browserName,
          viewport: p.use && p.use.viewport
        },
        snapshotPathTemplate: p.snapshotPathTemplate,
        expect: screenshotTpl(p)
          ? { toHaveScreenshot: { pathTemplate: screenshotTpl(p) } }
          : undefined
      }))
    };

    fs.writeFileSync(out, JSON.stringify(shape));
  }

  // Keep `--list` output clean; this reporter only writes the config file.
  printsToStdio() {
    return false;
  }
}

module.exports = PercyConfigReporter;
