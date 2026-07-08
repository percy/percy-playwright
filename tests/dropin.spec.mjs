// toHaveScreenshot drop-in — dispatch + unit coverage.
//
// The dispatch tests import the drop-in entry (which registers the override on the shared
// Playwright `expect`) and then call the REAL `expect(page).toHaveScreenshot()` — hard-asserting
// that a capture reached the CLI testing server. A silent registration no-op (the failure mode
// Playwright's extend() guard makes possible) leaves the suite green with zero Percy traffic, so
// these tests must fail loudly if nothing was posted.
//
// Dispatch is automatic by project type (utils.percy.type from the healthcheck): the testing
// server reports 'web' (token-less default), so the default path is the percySnapshot flow;
// the app and automate paths are exercised by overriding the cached utils.percy.type in-process.
import sinon from 'sinon';
import helpers from '@percy/sdk-utils/test/helpers';
import utils from '@percy/sdk-utils';
import { test, expect } from '@playwright/test';
import '../dropin/index.js';
import dropinDom from '../dropin/dom.js';
import firstBuild from '../dropin/baseline/first-build.js';
import identity from '../dropin/identity.js';
import paths from '../dropin/paths.js';
import { Utils } from '../utils.js';

const { snapshotViaPercy, SCOPE_ATTR } = dropinDom;
const { firstBuildBaseline, OUTCOME, BASELINE_SOURCE } = firstBuild;
const { deriveName, _resetCounters } = identity;

async function recorded(endpoint) {
  const res = await utils.request('/test/requests');
  return (res.body.requests || []).filter(r => r.url.startsWith(endpoint));
}

// Pin the project type the dispatch reads. The matcher's isPercyEnabled() re-fetches the
// healthcheck only while percy.enabled is unset, so prime it first, then override the cached type.
async function withProjectType(type) {
  await utils.isPercyEnabled();
  utils.percy.type = type;
}

test.describe('toHaveScreenshot drop-in (dispatch)', () => {
  test.beforeEach(async ({ page }) => {
    await helpers.setupTest();
    await page.goto(helpers.testSnapshotURL);
  });

  test.afterEach(() => {
    sinon.restore();
    // setupTest deletes percy.enabled, so the next healthcheck restores the server's real type —
    // but reset here too so no in-process override leaks into non-dispatch tests.
    utils.percy.type = 'web';
  });

  test('web project routes toHaveScreenshot through percySnapshot and always passes', async ({ page }) => {
    await withProjectType('web');
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

  test('app project routes toHaveScreenshot through the raw-PNG comparison ingest', async ({ page }) => {
    await withProjectType('app');
    await expect(async () => {
      await expect(page).toHaveScreenshot('dropin-app.png');

      const comparisons = await recorded('/percy/comparison');
      const named = comparisons.find(c => /^dropin-app(-\d+)?$/.test(c.body.name));
      expect(named, 'app project did not post a comparison').toBeTruthy();
      expect(named.body.tag.width).toBe(page.viewportSize().width);
      // percy-api requires a tag height; the drop-in parses it from the PNG bytes.
      expect(named.body.tag.height).toBeGreaterThan(0);
      expect(named.body.tiles.length).toBe(1);
      expect(named.body.tiles[0].content.length).toBeGreaterThan(0);
    }).toPass({ timeout: 15000 });
  });

  test('automate project routes toHaveScreenshot through percyScreenshot', async ({ page }) => {
    await withProjectType('automate');
    // percyScreenshot needs a live Automate session; stub the session boundary and assert the
    // dispatch handed our derived snapshot name to the SDK's Automate flow.
    sinon.stub(Utils, 'sessionDetails').resolves({ hashed_id: 'session-123' });
    const captured = [];
    sinon.stub(Utils, 'captureAutomateScreenshot').callsFake(async data => {
      captured.push(data);
      return { body: { data: {} } };
    });

    await expect(page).toHaveScreenshot('dropin-automate.png');

    expect(captured.length).toBe(1);
    expect(captured[0].snapshotName).toMatch(/^dropin-automate(-\d+)?$/);
    expect(captured[0].sessionId).toBe('session-123');
    expect(captured[0].framework).toBe('playwright');
  });

  test('a Percy upload error never fails the assertion (warn-and-continue)', async ({ page }) => {
    await withProjectType('app');
    await helpers.test('error', '/percy/comparison');
    // Must still pass — a Percy problem can never red the functional suite.
    await expect(page).toHaveScreenshot('dropin-error-path.png');
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

  test('firstBuildBaseline seeds committed PNGs only when the server marked the build as baseline', async () => {
    // Server said normal head → nothing seeded, discovery never runs.
    const notFirst = await firstBuildBaseline({}, {
      build: { id: '1', source: 'playwright-dropin' },
      discoverBaselines: () => { throw new Error('must not discover'); }
    });
    expect(notFirst.outcome).toBe(OUTCOME.NOT_FIRST_BUILD);

    // Server said baseline → committed PNGs are posted with PNG-derived tag dims.
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x49484452, 12);
    png.writeUInt32BE(1280, 16);
    png.writeUInt32BE(720, 20);
    const posted = [];
    const seeded = await firstBuildBaseline({ clientInfo: 'c', environmentInfo: 'e' }, {
      build: { id: '9', source: BASELINE_SOURCE },
      discoverBaselines: () => ({
        baselines: [{ filepath: '/repo/a.png', name: 'home', browserFamily: 'chromium', width: 1280 }]
      }),
      readFile: async () => png,
      postComparison: async options => posted.push(options)
    });
    expect(seeded.outcome).toBe(OUTCOME.SEEDED);
    expect(posted[0].tag).toEqual({ name: 'chromium', browserName: 'chromium', width: 1280, height: 720 });
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
