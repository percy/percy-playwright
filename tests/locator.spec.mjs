import helpers from '@percy/sdk-utils/test/helpers';
import utils from '@percy/sdk-utils';
import { test, expect } from '@playwright/test';
import sinon from 'sinon';
import percySnapshot from '../index.js';
import { createRequire } from 'module';

// Required (not imported) to avoid a sibling ESM import of a CJS module index.js also requires.
const { Utils } = createRequire(import.meta.url)('../utils.js');
const { percyTest } = percySnapshot;
const MARKER = 'data-percy-scope';

// Runs the `mount` override percyTest() registers, against a stand-in base `mount`.
async function withPercyMount(baseMount, body) {
  let override;
  const fakeTest = { extend: fixtures => { override = fixtures.mount; return 'extended'; } };
  expect(percyTest(fakeTest)).toBe('extended');
  await override({ mount: baseMount }, body);
}

async function postedSnapshots() {
  const res = await utils.request('/test/requests');
  return (res.body.requests || []).filter(r => r.url.startsWith('/percy/snapshot')).map(r => r.body);
}

test.describe('percySnapshot with a Locator', () => {
  test.beforeEach(async ({ page }) => {
    await helpers.setupTest();
    await page.goto(helpers.testSnapshotURL);
    await page.evaluate(() => {
      document.body.innerHTML = '<header>Gallery chrome</header><div id="root"><button>Primary</button></div>';
    });
  });

  test.afterEach(() => {
    sinon.restore();
  });

  test('scopes the snapshot to the element and removes the marker afterwards', async ({ page }) => {
    await percySnapshot(page.locator('#root'), 'story');

    const posted = await postedSnapshots();
    expect(posted).toHaveLength(1);
    expect(posted[0].name).toBe('story');
    expect(posted[0].scope).toBe(`[${MARKER}]`);
    expect(posted[0].url).toBe(page.url());
    expect(posted[0].domSnapshot.html).toContain(`id="root" ${MARKER}=""`);
    await expect(page.locator(`[${MARKER}]`)).toHaveCount(0);
  });

  test('an explicit scope wins over the locator marker', async ({ page }) => {
    await percySnapshot(page.locator('#root'), 'story', { scope: 'button' });

    const posted = await postedSnapshots();
    expect(posted[0].scope).toBe('button');
    expect(posted[0].domSnapshot.html).not.toContain(MARKER);
  });

  test('an empty locator logs an error and posts nothing', async ({ page }) => {
    await percySnapshot(page.locator('#missing'), 'empty');

    expect(await postedSnapshots()).toHaveLength(0);
    expect(helpers.logger.stderr).toEqual(expect.arrayContaining([
      '[percy] Could not take DOM snapshot "empty": the locator matched no elements'
    ]));
  });

  test('cleans up the marker when posting fails', async ({ page }) => {
    await helpers.test('error', '/percy/snapshot');

    await percySnapshot(page.locator('#root'), 'failing');

    await expect(page.locator(`[${MARKER}]`)).toHaveCount(0);
    expect(helpers.logger.stderr).toEqual(expect.arrayContaining([
      '[percy] Could not take DOM snapshot "failing"'
    ]));
  });

  test('requires a name for a locator that was not mounted through percyTest', async ({ page }) => {
    await expect(percySnapshot(page.locator('#root'))).rejects.toThrow('The `name` argument is required.');
  });

  test('names unmounted-story snapshots by story id with a per-test counter', async ({ page }) => {
    await withPercyMount(async () => page.locator('#root'), async mount => {
      const primary = await mount('Button/Primary', { label: 'x' });
      await percySnapshot(primary);
      await percySnapshot(primary, 'explicit');
      await percySnapshot(primary);
      const again = await mount('Button/Primary');
      await percySnapshot(again);
      await percySnapshot(await mount('Button/Secondary'));
    });
    // A fresh fixture instance (next test) starts counting again.
    await withPercyMount(async () => page.locator('#root'), async mount => {
      await percySnapshot(await mount('Button/Primary'));
    });

    expect((await postedSnapshots()).map(p => p.name)).toEqual([
      'Button/Primary', 'explicit', 'Button/Primary-2', 'Button/Primary-3', 'Button/Secondary', 'Button/Primary'
    ]);
  });

  test('does not record non-string mount arguments', async ({ page }) => {
    await withPercyMount(async () => page.locator('#root'), async mount => {
      const component = await mount({ type: 'jsx' });
      await expect(percySnapshot(component)).rejects.toThrow('The `name` argument is required.');
    });
  });

  test('skips everything when Percy is disabled', async ({ page }) => {
    await helpers.test('error', '/percy/healthcheck');
    await percySnapshot(page.locator('#root'), 'disabled');
    expect(helpers.logger.stdout).toEqual(expect.arrayContaining([
      '[percy] Percy is not running, disabling snapshots'
    ]));
  });
});

test.describe('percyTest', () => {
  test('rejects anything that is not a Playwright test object', () => {
    expect(() => percyTest()).toThrow('percyTest() expects the `test` object from @playwright/test.');
    expect(() => percyTest({})).toThrow('percyTest() expects the `test` object from @playwright/test.');
  });

  test('throws a clear error when the mount fixture is unavailable', () => {
    const testType = Symbol('testType');
    const oldTest = { extend: () => {}, [testType]: { fixtures: [{ fixtures: { page: () => {} } }, {}] } };
    expect(() => percyTest(oldTest)).toThrow(/requires the built-in `mount` fixture from @playwright\/test 1.62/);
  });

  test('extends a test whose internals cannot be inspected', () => {
    expect(percyTest({ extend: () => 'extended' })).toBe('extended');
  });

  test('extends the real @playwright/test test object', () => {
    expect(typeof percyTest(test)).toBe('function');
  });
});

test.describe('Utils locator helpers', () => {
  test('isLocator tells a Locator from a Page', async ({ page }) => {
    expect(Utils.isLocator(page.locator('body'))).toBe(true);
    expect(Utils.isLocator(page)).toBe(false);
    expect(Utils.isLocator(null)).toBe(false);
  });

  test('withScopedLocator swallows a failing marker cleanup', async () => {
    const locator = { evaluate: sinon.stub() };
    locator.evaluate.onFirstCall().resolves();
    locator.evaluate.onSecondCall().rejects(new Error('detached'));

    const result = await Utils.withScopedLocator(locator, 'data-x', async scope => scope);

    expect(result).toBe('[data-x]');
    expect(locator.evaluate.callCount).toBe(2);
  });
});
