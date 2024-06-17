import helpers from '@percy/sdk-utils/test/helpers';
import { test, expect } from '@playwright/test';
import percySnapshot from '../index.js';
import sinon from 'sinon';
import { Utils } from '../utils.js';
const { percyScreenshot, ENV_INFO, CLIENT_INFO } = percySnapshot;

test.describe('percySnapshot', () => {
  test.beforeEach(async ({ page }) => {
    await helpers.setupTest();
    await page.goto(helpers.testSnapshotURL);
  });

  test('throws an error when a page is not provided', async () => {
    await expect(percySnapshot()).rejects.toThrow('A Playwright `page` object is required.');
  });

  test('throws an error when a name is not provided', async ({ page }) => {
    await expect(percySnapshot(page)).rejects.toThrow('The `name` argument is required.');
  });

  test('disables snapshots when the healthcheck fails', async ({ page }) => {
    await helpers.test('error', '/percy/healthcheck');

    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    expect(helpers.logger.stdout).toEqual(expect.arrayContaining([
      '[percy] Percy is not running, disabling snapshots'
    ]));
  });

  test('posts snapshots to the local percy server', async ({ page }) => {
    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');
    await percySnapshot(page, 'Snapshot 3', { sync: true });

    expect(await helpers.get('logs')).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1',
      'Snapshot found: Snapshot 2',
      `- url: ${helpers.testSnapshotURL}`,
      expect.stringMatching(/clientInfo: @percy\/playwright\/.+/),
      expect.stringMatching(/environmentInfo: playwright\/.+/),
      expect.stringMatching(/The Synchronous CLI functionality is not compatible with skipUploads option./)
    ]));
  });

  test('handles snapshot failures', async ({ page }) => {
    await helpers.test('error', '/percy/snapshot');

    await percySnapshot(page, 'Snapshot 1');

    expect(helpers.logger.stderr).toEqual(expect.arrayContaining([
      '[percy] Could not take DOM snapshot "Snapshot 1"'
    ]));
  });
});

test.describe('percyScreenshot', () => {
  test.beforeEach(async ({ page }) => {
    await helpers.setupTest();
    await page.goto(helpers.testSnapshotURL);
  });

  test.afterEach(async ({ page }) => {
    sinon.restore();
  });

  test('throws an error when a page is not provided', async () => {
    await expect(percyScreenshot()).rejects.toThrow('A Playwright `page` object is required.');
  });

  test('throws an error when a name is not provided', async ({ page }) => {
    await expect(percyScreenshot(page)).rejects.toThrow('The `name` argument is required.');
  });

  test('disables snapshots when the healthcheck fails', async ({ page }) => {
    await helpers.test('error', '/percy/healthcheck');

    await percyScreenshot(page, 'Snapshot 1');
    await percyScreenshot(page, 'Snapshot 2');

    expect(helpers.logger.stdout).toEqual(expect.arrayContaining([
      '[percy] Percy is not running, disabling snapshots'
    ]));
  });

  test('throws error for web session', async ({ page }) => {
    let error = null;
    try {
      await percyScreenshot(page, 'Snapshot 2');
    } catch (e) {
      error = e.message;
    }
    expect(error).toEqual('Invalid function call - percyScreenshot(). Please use percySnapshot() function for taking screenshot. percyScreenshot() should be used only while using Percy with Automate. For more information on usage of PercySnapshot(), refer doc for your language https://docs.percy.io/docs/end-to-end-testing');
  });

  test('calls captureAutomateScreenshot with correct data', async ({ page }) => {
    sinon.stub(Utils, 'projectType').returns('automate');
    sinon.stub(Utils, 'sessionDetails').returns({ hashed_id: 'abc' });
    const captureAutomateScreenshotStub = sinon.stub(Utils, 'captureAutomateScreenshot').returns({ body: { data: 'response' } });
    const result = await percyScreenshot(page, 'Snapshot 1');
    expect(result).toBe('response');
    const expectedData = {
      environmentInfo: ENV_INFO,
      clientInfo: CLIENT_INFO,
      sessionId: 'abc',
      pageGuid: page._guid,
      frameGuid: page._mainFrame._guid,
      framework: 'playwright',
      snapshotName: 'Snapshot 1',
      options: undefined
    };
    expect(captureAutomateScreenshotStub.calledWith(expectedData)).toBe(true);
  });

  test('logs error if anything fails', async ({ page }) => {
    sinon.stub(Utils, 'projectType').returns('automate');
    sinon.stub(Utils, 'sessionDetails').returns({ hashed_id: 'abc' });
    sinon.stub(Utils, 'captureAutomateScreenshot').throws(new Error('Some error'));
    await percyScreenshot(page, 'Snapshot 1');
    expect(helpers.logger.stderr).toEqual(expect.arrayContaining([
      '[percy] Could not take percy screenshot "Snapshot 1"',
      '[percy] Error: Some error'
    ]));
  });
});
