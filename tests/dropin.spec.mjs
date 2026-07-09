// toHaveScreenshot drop-in — dispatch + unit coverage.
//
// The dispatch tests import the drop-in entry (which registers the override on the shared
// Playwright `expect`) and then call the REAL `expect(page).toHaveScreenshot()` — hard-asserting
// that a capture reached the CLI testing server. A silent registration no-op (the failure mode
// Playwright's extend() guard makes possible) leaves the suite green with zero Percy traffic, so
// these tests must fail loudly if nothing was posted.
//
// The drop-in is WEB-ONLY: every assertion is a percySnapshot web snapshot (the testing server
// reports type 'web' — the token-less default). A non-web token is a configuration error.
import fs from 'fs';
import path from 'path';
import os from 'os';
import helpers from '@percy/sdk-utils/test/helpers';
import utils from '@percy/sdk-utils';
import { test, expect } from '@playwright/test';
import dropin from '../dropin/index.js';
import dropinDom from '../dropin/dom.js';
import identity from '../dropin/identity.js';
import paths from '../dropin/paths.js';
import provider from '../dropin/baseline/provider.js';
import resolveConfig from '../dropin/baseline/resolve-config.js';
import ConfigReporter from '../dropin/baseline/config-reporter.js';

const { snapshotViaPercy, SCOPE_ATTR } = dropinDom;
const { deriveName, _resetCounters } = identity;
const { _resetRunState } = dropin;
const { resolvePlaywrightConfig } = resolveConfig;

async function recorded(endpoint) {
  const res = await utils.request('/test/requests');
  return (res.body.requests || []).filter(r => r.url.startsWith(endpoint));
}

test.describe('toHaveScreenshot drop-in (dispatch)', () => {
  test.beforeEach(async ({ page }) => {
    await helpers.setupTest();
    await page.goto(helpers.testSnapshotURL);
  });

  test.afterEach(() => {
    // setupTest deletes percy.enabled, so the next healthcheck restores the server's real type —
    // but reset here too so no in-process override leaks into other tests.
    utils.percy.type = 'web';
  });

  test('routes toHaveScreenshot (named + anonymous) through percySnapshot and always passes', async ({ page }) => {
    // The CLI testing server is shared across parallel workers and reset by every test's
    // setupTest — a read-back can race a concurrent reset. Retry the whole post+read block as a
    // unit; snapshot-name counters increment across retries, so match name families, not indices.
    await expect(async () => {
      await expect(page).toHaveScreenshot('dropin-named.png');
      await expect(page).toHaveScreenshot();
      await expect(page).toHaveScreenshot();

      const snapshots = await recorded('/percy/snapshot');

      const named = snapshots.find(s => /^dropin-named(-\d+)?$/.test(s.body.name));
      expect(named, 'override did not post a snapshot — the toHaveScreenshot override is NOT registered').toBeTruthy();
      // Identity pinning: the render width is the test's viewport width.
      expect(named.body.widths).toEqual([page.viewportSize().width]);
      expect(named.body.minHeight).toBe(page.viewportSize().height);
      expect(named.body.domSnapshot).toBeTruthy();

      // Anonymous calls get Playwright's on-disk stem naming (title + per-test counter); the
      // exact derivation contract is pinned in the unit tests below.
      const anonymous = snapshots.filter(s => /-\d+$/.test(s.body.name) && !/^dropin-named/.test(s.body.name));
      expect(anonymous.length).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 15000 });
  });

  test('a non-web project token is a configuration error (like other SDKs)', async ({ page }) => {
    // Pin the cached project type, then reset the run latch so validation re-runs.
    await utils.isPercyEnabled();
    utils.percy.type = 'automate';
    _resetRunState();

    try {
      await expect(expect(page).toHaveScreenshot('dropin-wrong-token.png'))
        .rejects.toThrow(/requires a web project token/);
    } finally {
      utils.percy.type = 'web';
      _resetRunState();
    }
  });

  test('a Percy upload error never fails the assertion (warn-and-continue)', async ({ page }) => {
    await helpers.test('error', '/percy/snapshot');
    try {
      // Must still pass — a Percy problem can never red the functional suite.
      await expect(page).toHaveScreenshot('dropin-error-path.png');
    } finally {
      // The error flag lives on the SHARED testing server — clear it immediately so parallel
      // workers posting real snapshots aren't starved for the rest of this test's slot.
      await helpers.test('reset');
    }
  });
});

test.describe('drop-in units', () => {
  test('deriveName mirrors Playwright anonymous/named stem rules', () => {
    _resetCounters();
    const ti = { titlePath: ['spec.ts', 'suite', 'case'] };
    expect(deriveName(undefined, ti)).toBe('suite-case-1');
    expect(deriveName(undefined, ti)).toBe('suite-case-2');
    expect(deriveName('banner.png', ti)).toBe('banner');
    expect(deriveName('banner.png', ti)).toBe('banner-1');
  });

  test('path hygiene strips NUL bytes and rejects multi-component dirent names', () => {
    expect(paths.sanitizePath('/repo\0/x')).toBe('/repo/x');
    expect(paths.sanitizeDirentName('home-snapshots')).toBe('home-snapshots');
    expect(paths.sanitizeDirentName('..')).toBe(null);
    expect(paths.sanitizeDirentName('a/b')).toBe(null);
    expect(paths.sanitizeDirentName('a\\b')).toBe(null);
    expect(paths.sanitizeDirentName('')).toBe(null);
  });

  test('snapshotViaPercy delegates to the repo percySnapshot and scopes Locator subjects', async ({ page }) => {
    await page.setContent('<div><section id="card">A card</section></div>');
    let sawMarkerDuringCapture = false;
    let receivedArgs = null;

    await snapshotViaPercy(page.locator('#card'), 'card-snap', { width: 900, sync: true }, {}, {
      percySnapshot: async (p, name, options) => {
        sawMarkerDuringCapture = await p.locator(`[${SCOPE_ATTR}]`).count() === 1;
        receivedArgs = { name, options };
        return { verdict: 'ok' };
      }
    });

    expect(sawMarkerDuringCapture, 'scope marker must be present during capture').toBe(true);
    // …and removed from the live page afterwards.
    await expect(page.locator(`[${SCOPE_ATTR}]`)).toHaveCount(0);
    expect(receivedArgs.name).toBe('card-snap');
    expect(receivedArgs.options.scope).toBe(`[${SCOPE_ATTR}]`);
    expect(receivedArgs.options.widths).toEqual([900]);
    expect(receivedArgs.options.minHeight).toBe(page.viewportSize().height);
    expect(receivedArgs.options.sync).toBe(true);
  });
});

test.describe('baseline provider (CLI seeding contract)', () => {
  let tmpDir;

  // A minimal committed-baseline repo: one `*-snapshots` dir with a valid 1280x720 PNG header.
  function makePng(width = 1280, height = 720) {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(0x49484452, 12); // IHDR
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
  }

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'percy-dropin-provider-'));
    const snapsDir = path.join(tmpDir, 'example.spec.ts-snapshots');
    fs.mkdirSync(snapsDir, { recursive: true });
    fs.writeFileSync(path.join(snapsDir, 'home-chromium-darwin.png'), makePng());
  });

  test.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const RESOLVED_CONFIG = {
    rootDir: null, // set per test
    projects: [{ name: 'chromium', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 } } }]
  };

  test('discovers committed baselines with identity + PNG-derived height', async () => {
    const result = await provider.discoverBaselines({ cwd: tmpDir }, {
      resolveConfig: () => ({ ...RESOLVED_CONFIG, rootDir: tmpDir })
    });

    expect(result.degraded).toBeFalsy();
    expect(result.baselines.length).toBe(1);
    expect(result.baselines[0]).toEqual(expect.objectContaining({
      name: 'home',
      browserFamily: 'chromium',
      width: 1280,
      height: 720
    }));
    expect(result.baselines[0].filepath.endsWith('home-chromium-darwin.png')).toBe(true);
  });

  test('degrades when the Playwright config cannot be resolved', async () => {
    const result = await provider.discoverBaselines({ cwd: tmpDir }, {
      resolveConfig: () => null
    });

    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('playwright_config_unresolvable');
    expect(result.baselines).toEqual([]);
  });

  test('exposes the head-build source tag', () => {
    expect(provider.buildSource).toBe('playwright-dropin');
  });

  test('resolvePlaywrightConfig round-trips the reporter-written file and cleans up', () => {
    let writtenTo = null;
    const config = resolvePlaywrightConfig({
      cwd: tmpDir,
      spawn: (cmd, args, opts) => {
        // Stand-in for `npx playwright test --list`: write the file like the reporter would.
        writtenTo = opts.env.PERCY_PW_CONFIG_OUT;
        fs.writeFileSync(writtenTo, JSON.stringify({ rootDir: tmpDir, projects: [] }));
        return { status: 0 };
      }
    });

    expect(config).toEqual({ rootDir: tmpDir, projects: [] });
    expect(fs.existsSync(writtenTo), 'temp config file must be cleaned up').toBe(false);
  });

  test('resolvePlaywrightConfig returns null when playwright never writes the file', () => {
    const config = resolvePlaywrightConfig({
      cwd: tmpDir,
      spawn: () => ({ status: 1, stderr: 'no playwright here' })
    });
    expect(config).toBe(null);
  });

  test('the config reporter serializes the minimal resolved shape', () => {
    const out = path.join(tmpDir, 'reporter-out.json');
    process.env.PERCY_PW_CONFIG_OUT = out;
    try {
      new ConfigReporter().onBegin({
        rootDir: tmpDir,
        projects: [{
          name: 'chromium',
          use: { browserName: 'chromium', viewport: { width: 1280, height: 720 }, headless: true },
          snapshotPathTemplate: undefined
        }]
      });
    } finally {
      delete process.env.PERCY_PW_CONFIG_OUT;
    }

    const shape = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(shape.rootDir).toBe(tmpDir);
    expect(shape.projects[0].use).toEqual({
      browserName: 'chromium',
      viewport: { width: 1280, height: 720 }
    });
    // Only the fields identity reconstruction needs — nothing else leaks through (undefined
    // template/expect fields are dropped by JSON serialization).
    expect(Object.keys(shape.projects[0]).sort()).toEqual(['name', 'use']);
  });
});
