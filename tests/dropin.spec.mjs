// toHaveScreenshot drop-in — dispatch + unit coverage.
//
// The dispatch tests import the drop-in entry (which registers the override on the shared
// Playwright `expect`) and then call the REAL `expect(page).toHaveScreenshot()` — hard-asserting
// that a comparison reached the CLI testing server. A silent registration no-op (the failure mode
// Playwright's extend() guard makes possible) leaves the suite green with zero Percy traffic, so
// these tests must fail loudly if nothing was posted.
import helpers from '@percy/sdk-utils/test/helpers';
import utils from '@percy/sdk-utils';
import { test, expect } from '@playwright/test';
import '../dropin/index.js';
import dropinDom from '../dropin/dom.js';
import firstBuild from '../dropin/baseline/first-build.js';
import identity from '../dropin/identity.js';

const { captureDomSnapshot, SCOPE_ATTR } = dropinDom;
const { firstBuildBaseline, OUTCOME, BASELINE_SOURCE } = firstBuild;
const { deriveName, _resetCounters } = identity;

async function recordedComparisons() {
  const res = await utils.request('/test/requests');
  return (res.body.requests || []).filter(r => r.url.startsWith('/percy/comparison'));
}

test.describe('toHaveScreenshot drop-in (dispatch)', () => {
  test.beforeEach(async ({ page }) => {
    await helpers.setupTest();
    await page.goto(helpers.testSnapshotURL);
  });

  test('routes toHaveScreenshot (named + anonymous) through Percy and always passes', async ({ page }) => {
    // The CLI testing server is shared across parallel workers and reset by every test's
    // setupTest — a read-back can race a concurrent reset. Retry the whole post+read block as a
    // unit; snapshot-name counters increment across retries, so match name families, not indices.
    await expect(async () => {
      await expect(page).toHaveScreenshot('dropin-named.png');
      await expect(page).toHaveScreenshot();
      await expect(page).toHaveScreenshot();

      const comparisons = await recordedComparisons();

      const named = comparisons.find(c => /^dropin-named(-\d+)?$/.test(c.body.name));
      expect(named, 'override did not post a comparison — the toHaveScreenshot override is NOT registered').toBeTruthy();
      expect(named.body.tag.width).toBe(page.viewportSize().width);
      // percy-api requires a tag height; the drop-in parses it from the PNG bytes.
      expect(named.body.tag.height).toBeGreaterThan(0);
      expect(named.body.tiles.length).toBe(1);
      expect(named.body.tiles[0].content.length).toBeGreaterThan(0);

      // Anonymous calls get Playwright's on-disk stem naming (title + per-test counter); the
      // exact derivation contract is pinned in the unit tests below.
      const anonymous = comparisons.filter(c => /-\d+$/.test(c.body.name) && !/^dropin-named/.test(c.body.name));
      expect(anonymous.length).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 15000 });
  });

  test('a Percy upload error never fails the assertion (warn-and-continue)', async ({ page }) => {
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

  test('captureDomSnapshot reuses the repo captureDOM and scopes Locator subjects', async ({ page }) => {
    await page.setContent('<div><section id="card">A card</section></div>');
    let sawMarkerDuringCapture = false;

    const result = await captureDomSnapshot(page.locator('#card'), {}, {
      fetchPercyDOM: async () => 'window.__percy_dom_injected = true;',
      captureDOM: async p => {
        sawMarkerDuringCapture = await p.locator(`[${SCOPE_ATTR}]`).count() === 1;
        return { html: '<html>captured</html>' };
      }
    });

    expect(result.scope).toBe(`[${SCOPE_ATTR}]`);
    expect(sawMarkerDuringCapture, 'scope marker must be present during capture').toBe(true);
    // …and removed from the live page afterwards.
    await expect(page.locator(`[${SCOPE_ATTR}]`)).toHaveCount(0);
    expect(result.domSnapshot.html).toBe('<html>captured</html>');
  });
});
