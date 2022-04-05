import { helpers } from '@percy/sdk-utils/test/helpers';
import { test, expect } from '@playwright/test';
import percySnapshot from '../index.js';

test.describe('percySnapshot', () => {
  test.beforeAll(async function() {
    await helpers.mockSite();
  });

  test.afterAll(async () => {
    await helpers.closeSite();
  });

  test.beforeEach(async ({ page }) => {
    await helpers.setup();
    await page.goto('http://localhost:8000');
  });

  test.afterEach(async () => {
    await helpers.teardown();
  });

  test('throws an error when a page is not provided', async () => {
    await expect(percySnapshot()).rejects.toThrow('A Playwright `page` object is required.');
  });

  test('throws an error when a name is not provided', async ({ page }) => {
    await expect(percySnapshot(page)).rejects.toThrow('The `name` argument is required.');
  });

  test('disables snapshots when the healthcheck fails', async ({ page }) => {
    await helpers.testFailure('/percy/healthcheck');

    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    await expect(helpers.getRequests()).resolves.toEqual([['/percy/healthcheck']]);

    expect(helpers.logger.stderr).toEqual([]);
    expect(helpers.logger.stdout).toEqual(['[percy] Percy is not running, disabling snapshots']);
  });

  test('posts snapshots to the local percy server', async ({ page }) => {
    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    await expect(helpers.getRequests()).resolves.toEqual([
      ['/percy/healthcheck'],
      ['/percy/dom.js'],
      [
        '/percy/snapshot',
        {
          name: 'Snapshot 1',
          url: 'http://localhost:8000/',
          domSnapshot: '<html><head></head><body>Snapshot Me</body></html>',
          clientInfo: expect.stringMatching(/@percy\/playwright\/.+/),
          environmentInfo: expect.stringMatching(/playwright\/.+/)
        }
      ],
      [
        '/percy/snapshot',
        expect.objectContaining({
          name: 'Snapshot 2'
        })
      ]
    ]);

    expect(helpers.logger.stdout).toEqual([]);
    expect(helpers.logger.stderr).toEqual([]);
  });

  test('handles snapshot failures', async ({ page }) => {
    await helpers.testFailure('/percy/snapshot', 'failure');

    await percySnapshot(page, 'Snapshot 1');

    expect(helpers.logger.stdout).toEqual([]);
    expect(helpers.logger.stderr).toEqual([
      '[percy] Could not take DOM snapshot "Snapshot 1"',
      '[percy] Error: failure'
    ]);
  });
});
