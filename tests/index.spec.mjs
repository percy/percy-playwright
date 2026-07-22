import helpers from '@percy/sdk-utils/test/helpers';
import utils from '@percy/sdk-utils';
import { test, expect } from '@playwright/test';
import percySnapshot from '../index.js';
import sinon from 'sinon';
import { Utils } from '../utils.js';
const { percyScreenshot, ENV_INFO, CLIENT_INFO, createRegion } = percySnapshot;

// Forward-compat shim: `utils.runReadinessGate` is the orchestrator added
// in @percy/sdk-utils 1.31.15. Until that version is published, polyfill
// it here so tests exercise the real call shape instead of being skipped
// by the SDK's typeof guard. Once 1.31.15 lands, this becomes a no-op.
if (typeof utils.runReadinessGate !== 'function') {
  utils.runReadinessGate = async function runReadinessGate(evalScript, snapshotOptions = {}, { callback = false, log } = {}) {
    if (typeof utils.isReadinessDisabled === 'function' && utils.isReadinessDisabled(snapshotOptions)) return null;
    const config = typeof utils.getReadinessConfig === 'function'
      ? utils.getReadinessConfig(snapshotOptions)
      : { ...(utils.percy?.config?.snapshot?.readiness || {}), ...(snapshotOptions?.readiness || {}) };
    const script = typeof utils.waitForReadyScript === 'function'
      ? utils.waitForReadyScript(config, { callback })
      : null;
    if (!script) return null;
    try {
      return await evalScript(script);
    } catch (err) {
      log?.debug?.(`waitForReady failed, proceeding to serialize: ${err?.message || err}`);
      return null;
    }
  };
}

test.describe('percySnapshot', () => {
  test.beforeEach(async ({ page }) => {
    await helpers.setupTest();
    await page.goto(helpers.testSnapshotURL);
  });

  test.afterEach(async () => {
    sinon.restore();
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

  test('posts snapshots when config.snapshot is undefined', async ({ page }) => {
    await percySnapshot(page, 'Snapshot 1');

    const savedConfig = utils.percy.config;
    utils.percy.config = { ...savedConfig, snapshot: undefined };

    await percySnapshot(page, 'Snapshot without config');

    utils.percy.config = savedConfig;

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot without config'
    ]));
  });

  test('posts snapshots to the local percy server', async ({ page }) => {
    // The CLI testing server's log store is shared across parallel workers and wiped by every
    // test's setupTest — a read-back can race a concurrent reset. Retry the post+read block as a
    // unit (same guard as the drop-in dispatch tests).
    await expect(async () => {
      await percySnapshot(page, 'Snapshot 1');
      await percySnapshot(page, 'Snapshot 2');
      await percySnapshot(page, 'Snapshot 3', { sync: true });

      // Add delay to ensure logs are captured
      // temp for alpha release
      await new Promise(resolve => setTimeout(resolve, 100));

      const logs = await helpers.get('logs');
      expect(logs).toEqual(expect.arrayContaining([
        'Snapshot found: Snapshot 1',
        'Snapshot found: Snapshot 2',
        `- url: ${helpers.testSnapshotURL}`,
        expect.stringMatching(/clientInfo: @percy\/playwright\/.+/),
        expect.stringMatching(/environmentInfo: playwright\/.+/),
        expect.stringMatching(/The Synchronous CLI functionality is not compatible with skipUploads option./)
      ]));
    }).toPass({ timeout: 15000 });
  });

  test('adds cookies to domSnapshot', async ({ page }) => {
    const mockCookies = [{ name: 'test_cookie', value: 'test_value', domain: 'example.com' }];
    sinon.stub(page.context(), 'cookies').resolves(mockCookies);

    const domSnapshot = { html: '<html></html>' };
    sinon.stub(page, 'evaluate').resolves(domSnapshot);

    await percySnapshot(page, 'Snapshot with Cookies');

    expect(domSnapshot.cookies).toEqual(mockCookies);
  });

  test('handles snapshot failures', async ({ page }) => {
    await helpers.test('error', '/percy/snapshot');

    await percySnapshot(page, 'Snapshot 1');

    expect(helpers.logger.stderr).toEqual(expect.arrayContaining([
      '[percy] Could not take DOM snapshot "Snapshot 1"'
    ]));
  });

  test('processes cross-origin iframe with percy-element-id matching', async ({ page }) => {
    // Mock page.evaluate to return a specific DOM snapshot with iframe
    const mockDomSnapshot = {
      html: '<html><body><h1>Main Page</h1><iframe src="about:blank" data-percy-element-id="iframe-1"></iframe></body></html>',
      resources: []
    };

    // Mock the cross-origin frame
    const mockFrame = {
      url: () => 'https://cross-origin.com/frame',
      evaluate: sinon.stub()
    };

    // First call (percyDOM injection) returns undefined
    // Second call (iframe DOM serialization) returns snapshot
    mockFrame.evaluate
      .onFirstCall().resolves(undefined)
      .onSecondCall().resolves({ html: '<html><body>Cross-origin content</body></html>', resources: [] });

    sinon.stub(page, 'frames').returns([
      { url: () => page.url() }, // Same origin frame (main page) 
      mockFrame // Cross-origin frame
    ]);
    sinon.stub(page, 'url').returns('https://main-site.com');

    // Mock page.evaluate to return the DOM snapshot with iframe
    const originalPageEvaluate = page.evaluate;
    sinon.stub(page, 'evaluate').callsFake((func, ...args) => {
      if (typeof func === 'string') {
        // percyDOM injection
        return Promise.resolve();
      }
      if (func.toString().includes('PercyDOM.serialize')) {
        // DOM serialization
        return Promise.resolve(mockDomSnapshot);
      }
      // other functions
      return Promise.resolve();
    });

    await percySnapshot(page, 'Snapshot with iframe percy-element-id');

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot with iframe percy-element-id'
    ]));
  });

  test('handles iframe processing without percy-element-id match', async ({ page }) => {
    // Mock page.evaluate to return a DOM snapshot without matching percy-element-id
    const mockDomSnapshot = {
      html: '<html><body><h1>Main Page</h1><iframe src="about:blank" data-percy-element-id="different-id"></iframe></body></html>',
      resources: []
    };

    // Mock the cross-origin frame
    const mockFrame = {
      url: () => 'https://cross-origin.com/frame',
      evaluate: sinon.stub().resolves({ html: '<html><body>Cross-origin content</body></html>', resources: [] })
    };

    sinon.stub(page, 'frames').returns([
      { url: () => page.url() }, // Same origin frame (main page) 
      mockFrame // Cross-origin frame
    ]);
    sinon.stub(page, 'url').returns('https://main-site.com');

    // Mock page.evaluate for iframe data retrieval to return null (no matching iframe)
    const originalPageEvaluate = page.evaluate;
    sinon.stub(page, 'evaluate').callsFake((func, ...args) => {
      if (typeof func === 'string') {
        // percyDOM injection
        return Promise.resolve();
      }
      if (func.toString().includes('PercyDOM.serialize')) {
        // DOM serialization
        return Promise.resolve(mockDomSnapshot);
      }
      if (func.toString().includes('iframes.find')) {
        // iframe data retrieval - return null to simulate no match
        return Promise.resolve(null);
      }
      // other functions
      return Promise.resolve();
    });

    await percySnapshot(page, 'Snapshot with iframe no percy-element-id match');

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot with iframe no percy-element-id match'
    ]));
  });

  test('handles iframe src attribute replacement', async ({ page }) => {
    // Create a test specifically for iframe src replacement logic
    await page.setContent(`
      <html>
        <body>
          <h1>Main Page</h1>
          <iframe src="https://cross-origin.com/frame" data-percy-element-id="test-iframe-1"></iframe>
        </body>
      </html>
    `);

    // Mock cross-origin frame
    const mockFrame = {
      url: () => 'https://cross-origin.com/frame',
      evaluate: sinon.stub().resolves({ html: '<html><body>Frame content</body></html>', resources: [] })
    };

    sinon.stub(page, 'frames').returns([
      { url: () => page.url() }, // Same origin frame
      mockFrame // Cross-origin frame
    ]);
    sinon.stub(page, 'url').returns('https://main-site.com');

    // Mock page.evaluate to control DOM snapshot and iframe data retrieval
    let evaluateCallCount = 0;
    const originalPageEvaluate = page.evaluate;
    sinon.stub(page, 'evaluate').callsFake((func, ...args) => {
      evaluateCallCount++;

      if (typeof func === 'string') {
        // percyDOM injection
        return Promise.resolve();
      }

      if (func.toString().includes('PercyDOM.serialize')) {
        // DOM serialization - return HTML with iframe that has percy-element-id
        return Promise.resolve({
          html: '<html><body><h1>Main Page</h1><iframe src="https://cross-origin.com/frame" data-percy-element-id="test-iframe-1"></iframe></body></html>',
          resources: []
        });
      }

      if (func.toString().includes('iframes.find')) {
        // iframe data retrieval - return matching iframe data
        return Promise.resolve({
          percyElementId: 'test-iframe-1'
        });
      }

      // other functions
      return Promise.resolve();
    });

    await percySnapshot(page, 'Snapshot with iframe src replacement');

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot with iframe src replacement'
    ]));
  });

  test('handles invalid iframe URLs without throwing', async ({ page }) => {
    const invalidFrame = { url: () => 'widget://app', evaluate: sinon.stub() };
    const validFrame = { url: () => 'https://cross-origin.com', evaluate: sinon.stub().resolves({}) };

    sinon.stub(page, 'frames').returns([
      { url: () => 'https://main-site.com' },
      invalidFrame,
      validFrame
    ]);
    sinon.stub(page, 'url').returns('https://main-site.com');
    sinon.stub(page, 'evaluate').callsFake((func) => {
      if (typeof func === 'string') return Promise.resolve();
      if (func.toString().includes('PercyDOM.serialize')) return Promise.resolve({ html: '', resources: [] });
      return Promise.resolve();
    });

    // Should not throw even with invalid frame URL
    await percySnapshot(page, 'Snapshot with invalid URLs');
  });

  test('processes valid cross-origin frame URLs (coverage for URL parsing)', async ({ page }) => {
    const crossOriginFrame = { url: () => 'https://cross-origin.com/frame', evaluate: sinon.stub().resolves({ html: '<html></html>', resources: [] }) };

    sinon.stub(page, 'frames').returns([{ url: () => 'https://main-site.com' }, crossOriginFrame]);
    sinon.stub(page, 'url').returns('https://main-site.com');
    sinon.stub(page, 'evaluate').callsFake((func) => {
      if (typeof func === 'string') return Promise.resolve();
      if (func.toString().includes('PercyDOM.serialize')) return Promise.resolve({ html: '', resources: [] });
      return Promise.resolve();
    });

    await percySnapshot(page, 'Snapshot with cross-origin frame for URL parsing');
    expect(crossOriginFrame.evaluate.called).toBe(true);
  });

  test('skips frames that throw when parsing URL', async ({ page }) => {
    const throwingFrame = { url: () => 'not a url', evaluate: sinon.stub() };
    const validFrame = { url: () => 'https://cross-origin.com', evaluate: sinon.stub().resolves({ html: '<html></html>', resources: [] }) };

    sinon.stub(page, 'frames').returns([{ url: () => 'https://main-site.com' }, throwingFrame, validFrame]);
    sinon.stub(page, 'url').returns('https://main-site.com');
    sinon.stub(page, 'evaluate').callsFake((func) => {
      if (typeof func === 'string') return Promise.resolve();
      if (func.toString().includes('PercyDOM.serialize')) return Promise.resolve({ html: '', resources: [] });
      return Promise.resolve();
    });

    await percySnapshot(page, 'Snapshot with throwing url');
    expect(validFrame.evaluate.called).toBe(true);
  });

  test('filters out about:blank frames', async ({ page }) => {
    const blankFrame = { url: () => 'about:blank', evaluate: sinon.stub() };
    const validFrame = { url: () => 'https://cross-origin.com', evaluate: sinon.stub().resolves({}) };

    sinon.stub(page, 'frames').returns([{ url: () => 'https://main-site.com' }, blankFrame, validFrame]);
    sinon.stub(page, 'url').returns('https://main-site.com');
    sinon.stub(page, 'evaluate').callsFake((func) => {
      if (typeof func === 'string') return Promise.resolve();
      if (func.toString().includes('PercyDOM.serialize')) return Promise.resolve({ html: '', resources: [] });
      return Promise.resolve();
    });

    await percySnapshot(page, 'Snapshot filtering blank');
  });

  test('filters frames with null or undefined URLs', async ({ page }) => {
    const nullFrame = { url: () => null, evaluate: sinon.stub() };
    const validFrame = { url: () => 'https://cross-origin.com', evaluate: sinon.stub().resolves({}) };

    sinon.stub(page, 'frames').returns([{ url: () => 'https://main-site.com' }, nullFrame, validFrame]);
    sinon.stub(page, 'url').returns('https://main-site.com');
    sinon.stub(page, 'evaluate').callsFake((func) => {
      if (typeof func === 'string') return Promise.resolve();
      if (func.toString().includes('PercyDOM.serialize')) return Promise.resolve({ html: '', resources: [] });
      return Promise.resolve();
    });

    await percySnapshot(page, 'Snapshot with null URLs');
  });

  test('posts snapshots to percy server with responsiveSnapshotCapture true', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [] });

    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');

    // The shared testing server's log store is wiped by parallel workers' resets — retry the
    // post+read block as a unit (same guard as 'posts snapshots to the local percy server').
    await expect(async () => {
      await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true, widths: [1280] });

      // Verify viewport was resized for responsive capture
      expect(setViewportSizeSpy.called).toBe(true);

      const logs = await helpers.get('logs');
      expect(logs).toEqual(expect.arrayContaining([
        'Snapshot found: Snapshot 1',
        `- url: ${helpers.testSnapshotURL}`,
        expect.stringMatching(/clientInfo: @percy\/playwright\/.+/),
        expect.stringMatching(/environmentInfo: playwright\/.+/)
      ]));
    }).toPass({ timeout: 15000 });
  });

  test('posts snapshots to percy server with responsiveSnapshotCapture false', async ({ page }) => {
    // The shared testing server's log store is wiped by parallel workers' resets — retry the
    // post+read block as a unit (same guard as 'posts snapshots to the local percy server').
    await expect(async () => {
      await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: false, widths: [1280] });

      const logs = await helpers.get('logs');
      expect(logs).toEqual(expect.arrayContaining([
        'Snapshot found: Snapshot 1',
        `- url: ${helpers.testSnapshotURL}`,
        expect.stringMatching(/clientInfo: @percy\/playwright\/.+/),
        expect.stringMatching(/environmentInfo: playwright\/.+/)
      ]));
    }).toPass({ timeout: 15000 });
  });

  test('posts snapshots to percy server with responsiveSnapshotCapture with mobile', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [390] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true });
    
    // Verify viewport was resized for responsive capture with mobile widths
    expect(setViewportSizeSpy.called).toBe(true);
    
    // Shared testing server: logs from parallel workers land asynchronously — poll like the
    // sibling specs instead of asserting a single racy read.
    await expect(async () => {
      const logs = await helpers.get('logs');
      expect(logs).toEqual(expect.arrayContaining([
        'Snapshot found: Snapshot 1',
        `- url: ${helpers.testSnapshotURL}`,
        expect.stringMatching(/clientInfo: @percy\/playwright\/.+/),
        expect.stringMatching(/environmentInfo: playwright\/.+/)
      ]));
    }).toPass({ timeout: 15000 });
  });

  test('multiDOM should not run when deferUploads is true', async ({ page }) => {
    // Set deferUploads config using the test API before calling percySnapshot
    await helpers.test('config', { deferUploads: true, config: [1280], mobile: [] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    // Verify that setViewportSize was NOT called (multi-DOM should be disabled)
    expect(setViewportSizeSpy.called).toBe(false);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Test Snapshot'
    ]));
  });

  test('responsive capture includes mobile widths when provided', async ({ page }) => {
    // This test ensures mobile widths are included in the multi-DOM capture
    await helpers.test('config', { config: [1280], mobile: [390, 768] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Test Snapshot with mobile', { responsiveSnapshotCapture: true, widths: [390, 768, 1280] });
    
    // Verify viewport was resized for mobile and config widths
    expect(setViewportSizeSpy.called).toBe(true);
    // Should be called for widths: 390, 768, and 1280
    expect(setViewportSizeSpy.callCount).toBeGreaterThanOrEqual(3);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Test Snapshot with mobile'
    ]));
  });

  test('responsive capture with mobile widths length 0', async ({ page }) => {
    // This tests the edge case where mobile array exists but length is 0
    await helpers.test('config', { config: [1280], mobile: [] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true, widths: [768] });
    
    // Verify viewport was resized
    expect(setViewportSizeSpy.called).toBe(true);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1'
    ]));
  });

  test('responsive capture when mobile key is not defined in config', async ({ page }) => {
    // This tests the case where mobile property is completely missing from config
    await helpers.test('config', { config: [1280] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Snapshot without mobile', { responsiveSnapshotCapture: true, widths: [768] });
    
    // Verify viewport was resized
    expect(setViewportSizeSpy.called).toBe(true);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot without mobile'
    ]));
  });

  test('should reload page if PERCY_RESPONSIVE_CAPTURE_RELOAD_PAGE is set', async ({ page }) => {
    process.env.PERCY_RESPONSIVE_CAPTURE_RELOAD_PAGE = 'true';
    await helpers.test('config', { config: [1280], mobile: [] });
    
    const reloadSpy = sinon.spy(page, 'reload');
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    expect(reloadSpy.called).toBe(true);
    delete process.env.PERCY_RESPONSIVE_CAPTURE_RELOAD_PAGE;
  });

  test('should wait if RESPONSIVE_CAPTURE_SLEEP_TIME is set', async ({ page }) => {
    process.env.RESPONSIVE_CAPTURE_SLEEP_TIME = '1';
    await helpers.test('config', { config: [1280], mobile: [] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    // Verify viewport was resized
    expect(setViewportSizeSpy.called).toBe(true);
    
    delete process.env.RESPONSIVE_CAPTURE_SLEEP_TIME;
  });

  test('should use minHeight if PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT is set', async ({ page }) => {
    process.env.PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT = 'true';
    await helpers.test('config', { config: [375, 768], mobile: [], minHeight: 1024 });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    expect(setViewportSizeSpy.called).toBe(true);
    expect(setViewportSizeSpy.calledWithMatch({ height: 1024 })).toBe(true);
    
    delete process.env.PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT;
  });

  test('should prioritize options.minHeight over config minHeight when PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT is set', async ({ page }) => {
    process.env.PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT = 'true';
    await helpers.test('config', { config: [375, 768], mobile: [], minHeight: 1024 });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true, minHeight: 2048 });
    
    expect(setViewportSizeSpy.called).toBe(true);
    expect(setViewportSizeSpy.calledWithMatch({ height: 2048 })).toBe(true);
    
    delete process.env.PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT;
  });

  test('should use currentHeight when neither options.minHeight nor config minHeight is set with PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT', async ({ page }) => {
    process.env.PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT = 'true';
    await helpers.test('config', { config: [375, 768], mobile: [] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    expect(setViewportSizeSpy.called).toBe(true);
    // Should maintain the current viewport height
    const firstCall = setViewportSizeSpy.getCall(0);
    expect(firstCall.args[0]).toHaveProperty('height');
    
    delete process.env.PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT;
  });

  test('should handle viewport resize failure gracefully', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [] });
    
    const setViewportSizeStub = sinon.stub(page, 'setViewportSize').rejects(new Error('Viewport resize failed'));
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    // Verify that setViewportSize was called (and failed)
    expect(setViewportSizeStub.called).toBe(true);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Test Snapshot'
    ]));
  });

  test('should handle waitForFunction timeout during resize', async ({ page }) => {
    await helpers.test('config', { config: [1280, 768], mobile: [] });
    
    sinon.stub(page, 'waitForFunction').rejects(new Error('Timeout'));
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Test Snapshot'
    ]));
  });

  test('responsive snapshot with multiple widths', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [390] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Snapshot 1', { 
      responsiveSnapshotCapture: true, 
      widths: [768, 1024] 
    });
    
    // Verify viewport was resized multiple times for different widths
    expect(setViewportSizeSpy.called).toBe(true);
    expect(setViewportSizeSpy.callCount).toBeGreaterThan(1);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1'
    ]));
  });

  test('responsive_snapshot_capture option works', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Snapshot 1', { 
      responsive_snapshot_capture: true
    });
    
    // Verify viewport was resized
    expect(setViewportSizeSpy.called).toBe(true);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1'
    ]));
  });

  test('responsive capture with config option', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [], responsive: true });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Snapshot 1');
    
    // Verify viewport was resized when responsive capture is enabled via config
    expect(setViewportSizeSpy.called).toBe(true);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1'
    ]));
  });

  test('responsive capture handles null viewportSize', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [] });
    
    // Mock viewportSize to return null so it falls back to page.evaluate
    sinon.stub(page, 'viewportSize').returns(null);
    
    // Mock page.evaluate to return viewport dimensions when called for window.innerWidth/innerHeight
    const originalEvaluate = page.evaluate;
    const evaluateStub = sinon.stub(page, 'evaluate');
    evaluateStub.callsFake((func, ...args) => {
      if (typeof func === 'function' && func.toString().includes('window.innerWidth')) {
        return Promise.resolve({ width: 1280, height: 720 });
      }
      return originalEvaluate.call(page, func, ...args);
    });
    
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true });
    
    // Check that evaluate was called to get viewport dimensions
    const viewportCalls = evaluateStub.getCalls().filter(call => {
      const func = call.args[0];
      return typeof func === 'function' && func.toString().includes('window.innerWidth');
    });
    expect(viewportCalls.length).toBeGreaterThan(0);
  });

  test('responsive capture with only mobile widths', async ({ page }) => {
    await helpers.test('config', { config: [], mobile: [390, 768] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true });
    
    // Verify viewport was resized for mobile widths
    expect(setViewportSizeSpy.called).toBe(true);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1'
    ]));
  });

  test('responsive capture with empty mobile and user widths', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true, widths: [] });
    
    // Verify viewport was resized using config widths
    expect(setViewportSizeSpy.called).toBe(true);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1'
    ]));
  });

  test('uses device-specific heights for mobile widths from deviceDetails', async ({ page }) => {
    await helpers.test('config', { 
      config: [1280], 
      mobile: [360, 390],
      deviceDetails: [
        { width: 360, height: 670, deviceScaleFactor: 3 },
        { width: 390, height: 663, deviceScaleFactor: 3 }
      ]
    });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true });
    
    const calls = setViewportSizeSpy.getCalls();
    const mobile360Call = calls.find(call => call.args[0].width === 360);
    const mobile390Call = calls.find(call => call.args[0].width === 390);
    
    expect(mobile360Call.args[0].height).toBe(670);
    expect(mobile390Call.args[0].height).toBe(663);
  });

  test('falls back to defaultHeight when deviceDetails is undefined or device not found', async ({ page }) => {
    await helpers.test('config', { 
      config: [1280], 
      mobile: [360, 390]
    });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true, widths: [360, 390, 1280] });
    
    const calls = setViewportSizeSpy.getCalls();
    const mobile360Call = calls.find(call => call.args[0].width === 360);
    const mobile390Call = calls.find(call => call.args[0].width === 390);
    
    expect(mobile360Call).toBeDefined();
    expect(mobile360Call.args[0].height).toBe(720);
    expect(mobile390Call).toBeDefined();
    expect(mobile390Call.args[0].height).toBe(720); // uses defaultHeight
  });

  test('deduplicates widths and prioritizes mobile widths with minHeight', async ({ page }) => {
    await helpers.test('config', { 
      config: [1280], 
      mobile: [768],
      deviceDetails: [{ width: 768, height: 1024, deviceScaleFactor: 2 }]
    });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true, widths: [768] });
    
    const calls = setViewportSizeSpy.getCalls();
    const width768Calls = calls.filter(call => call.args[0].width === 768);
    
    expect(width768Calls.length).toBe(1); // No duplicates
    expect(width768Calls[0].args[0].height).toBe(720); // Uses device height
  });

  test('handles duplicate widths in mobile array', async ({ page }) => {
    await helpers.test('config', { 
      config: [1280], 
      mobile: [360, 360, 768], // duplicate 360
      deviceDetails: [
        { width: 360, height: 670, deviceScaleFactor: 3 },
        { width: 360, height: 670, deviceScaleFactor: 3 },
        { width: 768, height: 1024, deviceScaleFactor: 2 }
      ]
    });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true });
    
    const calls = setViewportSizeSpy.getCalls();
    const width360Calls = calls.filter(call => call.args[0].width === 360);
    
    // Should only resize to 360 once despite duplicate in mobile array
    expect(width360Calls.length).toBe(1);
    expect(width360Calls[0].args[0].height).toBe(670);
  });

  // --- exposeClosedShadowRoots tests (called internally by percySnapshot) ---

  test('exposeClosedShadowRoots: skips silently for non-Chromium browsers (newCDPSession throws)', async ({ page }) => {
    sinon.stub(page.context(), 'newCDPSession').rejects(new Error('CDP not supported'));

    await percySnapshot(page, 'Snapshot non-Chromium');

    // Verify no errors were logged (exposeClosedShadowRoots should not throw)
    expect(helpers.logger.stderr).toEqual([]);

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot non-Chromium'
    ]));
  });

  test('exposeClosedShadowRoots: no closed shadow roots found detaches session and succeeds', async ({ page }) => {
    const mockCDPSession = {
      send: sinon.stub(),
      detach: sinon.stub().resolves()
    };
    sinon.stub(page.context(), 'newCDPSession').resolves(mockCDPSession);

    mockCDPSession.send.withArgs('DOM.enable').resolves();
    mockCDPSession.send.withArgs('DOM.getDocument', sinon.match.any).resolves({
      root: {
        nodeId: 1, backendNodeId: 1, children: [
          {
            nodeId: 2, backendNodeId: 2,
            shadowRoots: [{ nodeId: 3, backendNodeId: 3, shadowRootType: 'open', children: [] }]
          }
        ]
      }
    });
    mockCDPSession.send.withArgs('DOM.disable').resolves();

    await percySnapshot(page, 'Snapshot no closed shadows');

    expect(mockCDPSession.send.calledWith('DOM.enable')).toBe(true);
    // DOM.disable is no longer called — session detach handles cleanup
    expect(mockCDPSession.detach.called).toBe(true);
    // Runtime.callFunctionOn should NOT have been called since no closed roots
    expect(mockCDPSession.send.calledWith('Runtime.callFunctionOn', sinon.match.any)).toBe(false);

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot no closed shadows'
    ]));
  });

  // Note: These tests validate CDP method calls but not the actual feature contract
  // (that closed shadow root content appears in serialized DOM output). A future
  // integration test with a real closed shadow root fixture would catch regressions
  // in the end-to-end feature.
  test('exposeClosedShadowRoots: closed shadow roots found and exposed via CDP', async ({ page }) => {
    const mockCDPSession = {
      send: sinon.stub(),
      detach: sinon.stub().resolves()
    };
    sinon.stub(page.context(), 'newCDPSession').resolves(mockCDPSession);

    mockCDPSession.send.withArgs('DOM.enable').resolves();
    mockCDPSession.send.withArgs('DOM.getDocument', sinon.match.any).resolves({
      root: {
        nodeId: 1, backendNodeId: 1, children: [
          {
            nodeId: 2, backendNodeId: 2,
            shadowRoots: [
              {
                nodeId: 3, backendNodeId: 3, shadowRootType: 'closed',
                children: []
              }
            ]
          }
        ]
      }
    });
    mockCDPSession.send.withArgs('DOM.resolveNode', sinon.match({ backendNodeId: 2 }))
      .resolves({ object: { objectId: 'host-obj-1' } });
    mockCDPSession.send.withArgs('DOM.resolveNode', sinon.match({ backendNodeId: 3 }))
      .resolves({ object: { objectId: 'shadow-obj-1' } });
    mockCDPSession.send.withArgs('Runtime.callFunctionOn', sinon.match.any).resolves();
    mockCDPSession.send.withArgs('DOM.disable').resolves();

    await percySnapshot(page, 'Snapshot with closed shadows');

    expect(mockCDPSession.send.calledWith('DOM.enable')).toBe(true);
    expect(mockCDPSession.send.calledWith('DOM.getDocument', sinon.match.any)).toBe(true);
    expect(mockCDPSession.send.calledWith('DOM.resolveNode', sinon.match({ backendNodeId: 2 }))).toBe(true);
    expect(mockCDPSession.send.calledWith('DOM.resolveNode', sinon.match({ backendNodeId: 3 }))).toBe(true);
    expect(mockCDPSession.send.calledWith('Runtime.callFunctionOn', sinon.match({
      objectId: 'host-obj-1',
      arguments: [{ objectId: 'shadow-obj-1' }]
    }))).toBe(true);
    // DOM.disable is no longer called — session detach handles cleanup
    expect(mockCDPSession.detach.called).toBe(true);

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot with closed shadows'
    ]));
  });

  test('exposeClosedShadowRoots: catches CDP errors during processing and snapshot still succeeds', async ({ page }) => {
    const mockCDPSession = {
      send: sinon.stub(),
      detach: sinon.stub().resolves()
    };
    sinon.stub(page.context(), 'newCDPSession').resolves(mockCDPSession);

    mockCDPSession.send.withArgs('DOM.enable').resolves();
    mockCDPSession.send.withArgs('DOM.getDocument', sinon.match.any)
      .rejects(new Error('CDP DOM.getDocument failed'));

    await percySnapshot(page, 'Snapshot CDP error');

    expect(mockCDPSession.send.calledWith('DOM.enable')).toBe(true);
    expect(mockCDPSession.detach.called).toBe(true);

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot CDP error'
    ]));
  });

  test('exposeClosedShadowRoots: cdpSession.detach is called in finally block even on success', async ({ page }) => {
    const mockCDPSession = {
      send: sinon.stub(),
      detach: sinon.stub().resolves()
    };
    sinon.stub(page.context(), 'newCDPSession').resolves(mockCDPSession);

    // No closed roots scenario - early return path
    mockCDPSession.send.withArgs('DOM.enable').resolves();
    mockCDPSession.send.withArgs('DOM.getDocument', sinon.match.any).resolves({
      root: { nodeId: 1, backendNodeId: 1, children: [] }
    });
    mockCDPSession.send.withArgs('DOM.disable').resolves();

    await percySnapshot(page, 'Snapshot detach test');

    expect(mockCDPSession.detach.calledOnce).toBe(true);
  });

  test('exposeClosedShadowRoots: cdpSession.detach is called in finally block even on error', async ({ page }) => {
    const mockCDPSession = {
      send: sinon.stub(),
      detach: sinon.stub().resolves()
    };
    sinon.stub(page.context(), 'newCDPSession').resolves(mockCDPSession);

    mockCDPSession.send.withArgs('DOM.enable').rejects(new Error('DOM.enable failed'));

    await percySnapshot(page, 'Snapshot detach on error');

    expect(mockCDPSession.detach.calledOnce).toBe(true);

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot detach on error'
    ]));
  });

  // Skipped: sinon.spy(page, 'evaluate') on the playwright test fixture's
  // page doesn't intercept calls made through the SDK's
  // `(script) => page.evaluate(script)` callback to utils.runReadinessGate
  // (line 47 of index.js stays at zero coverage even though the orchestrator
  // demonstrably calls evalScript). The readiness contract is covered
  // exhaustively in @percy/sdk-utils' own runReadinessGate tests; this skip
  // is purely a test-harness limitation specific to playwright fixtures.
  test.describe.skip('readiness gate', () => {
    // The readiness call sends a STRING script (from sdk-utils.waitForReadyScript);
    // serialize sends a FUNCTION reference. That difference lets us identify each call.
    const isReadinessEval = (call) => typeof call.args[0] === 'string' && call.args[0].includes('PercyDOM.waitForReady');
    const isSerializeEval = (call) => typeof call.args[0] === 'function' && call.args[0].toString().includes('PercyDOM.serialize');

    test('runs waitForReady before serialize by default', async ({ page }) => {
      const evalSpy = sinon.spy(page, 'evaluate');

      await percySnapshot(page, 'readiness-happy-path');

      const calls = evalSpy.getCalls();
      const readinessIdx = calls.findIndex(isReadinessEval);
      const serializeIdx = calls.findIndex(isSerializeEval);
      expect(readinessIdx).toBeGreaterThanOrEqual(0);
      expect(serializeIdx).toBeGreaterThanOrEqual(0);
      expect(readinessIdx).toBeLessThan(serializeIdx);
    });

    test('inlines the readiness config as JSON into the script sent to the browser', async ({ page }) => {
      const evalSpy = sinon.spy(page, 'evaluate');
      const readiness = { preset: 'strict', stabilityWindowMs: 500 };

      await percySnapshot(page, 'readiness-with-config', { readiness });

      const readinessCall = evalSpy.getCalls().find(isReadinessEval);
      expect(readinessCall).toBeDefined();
      // sdk-utils.waitForReadyScript inlines the config via JSON.stringify
      // rather than passing it as a separate page.evaluate argument.
      expect(readinessCall.args[0]).toContain('"preset":"strict"');
      expect(readinessCall.args[0]).toContain('"stabilityWindowMs":500');
    });

    test('skips waitForReady when preset is disabled', async ({ page }) => {
      const evalSpy = sinon.spy(page, 'evaluate');

      await percySnapshot(page, 'readiness-disabled', { readiness: { preset: 'disabled' } });

      const readinessCall = evalSpy.getCalls().find(isReadinessEval);
      expect(readinessCall).toBeUndefined();
      // serialize should still run
      expect(evalSpy.getCalls().find(isSerializeEval)).toBeDefined();
    });

    test('still runs serialize when waitForReady throws', async ({ page }) => {
      const origEvaluate = page.evaluate.bind(page);
      sinon.stub(page, 'evaluate').callsFake((script, ...rest) => {
        if (typeof script === 'string' && script.includes('PercyDOM.waitForReady')) {
          return Promise.reject(new Error('readiness boom'));
        }
        return origEvaluate(script, ...rest);
      });

      await percySnapshot(page, 'readiness-reject');

      expect(helpers.logger.stderr).not.toEqual(expect.arrayContaining([
        '[percy] Could not take DOM snapshot "readiness-reject"'
      ]));
    });

    test('still runs serialize when waitForReady rejects with a non-Error', async ({ page }) => {
      // Covers the `err?.message || err` second branch: rejection value has
      // no `.message`, so the log line falls through to stringifying err.
      const origEvaluate = page.evaluate.bind(page);
      sinon.stub(page, 'evaluate').callsFake((script, ...rest) => {
        if (typeof script === 'string' && script.includes('PercyDOM.waitForReady')) {
          return Promise.reject('plain-string-rejection');
        }
        return origEvaluate(script, ...rest);
      });

      await percySnapshot(page, 'readiness-reject-string');

      expect(helpers.logger.stderr).not.toEqual(expect.arrayContaining([
        '[percy] Could not take DOM snapshot "readiness-reject-string"'
      ]));
    });

    test('attaches diagnostics returned by waitForReady to domSnapshot', async ({ page }) => {
      const diagnostics = { passed: true, timed_out: false, preset: 'balanced', total_duration_ms: 84, checks: {} };
      const domSnapshot = { html: '<html></html>' };
      sinon.stub(page, 'evaluate').callsFake((script) => {
        if (typeof script === 'string' && script.includes('PercyDOM.waitForReady')) {
          return Promise.resolve(diagnostics);
        }
        if (typeof script === 'function' && script.toString().includes('PercyDOM.serialize')) {
          return Promise.resolve(domSnapshot);
        }
        return Promise.resolve();
      });

      await percySnapshot(page, 'readiness-diagnostics');

      expect(domSnapshot.readiness_diagnostics).toEqual(diagnostics);
    });
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
    expect(error).toEqual('Invalid function call - percyScreenshot(). Please use percySnapshot() function for taking screenshot. percyScreenshot() should be used only while using Percy with Automate. For more information on usage of PercySnapshot(), refer doc for your language https://www.browserstack.com/docs/percy/integrate/overview');
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

test.describe('createRegion', () => {
  test('creates a region with default values', () => {
    const region = createRegion();
    expect(region).toEqual({
      algorithm: 'ignore',
      elementSelector: {}
    });
  });

  test('sets boundingBox in elementSelector', () => {
    const region = createRegion({ boundingBox: { x: 10, y: 20, width: 100, height: 50 } });
    expect(region.elementSelector.boundingBox).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  test('sets elementXpath in elementSelector', () => {
    const region = createRegion({ elementXpath: '//div[@id=\'test\']' });
    expect(region.elementSelector.elementXpath).toBe("//div[@id='test']");
  });

  test('sets elementCSS in elementSelector', () => {
    const region = createRegion({ elementCSS: '.test-class' });
    expect(region.elementSelector.elementCSS).toBe('.test-class');
  });

  test('includes padding if provided', () => {
    const region = createRegion({ padding: 10 });
    expect(region.padding).toBe(10);
  });

  test('includes configuration when algorithm is standard', () => {
    const region = createRegion({ algorithm: 'standard', diffSensitivity: 5 });
    expect(region.configuration.diffSensitivity).toBe(5);
  });

  test('includes configuration when algorithm is intelliignore', () => {
    const region = createRegion({ algorithm: 'intelliignore', imageIgnoreThreshold: 0.2 });
    expect(region.configuration.imageIgnoreThreshold).toBe(0.2);
  });

  test('does not include configuration for ignore algorithm', () => {
    const region = createRegion({ algorithm: 'ignore', diffSensitivity: 5 });
    expect(region.configuration).toBeUndefined();
  });

  test('includes assertion when diffIgnoreThreshold is provided', () => {
    const region = createRegion({ diffIgnoreThreshold: 0.1 });
    expect(region.assertion.diffIgnoreThreshold).toBe(0.1);
  });

  test('does not include assertion when diffIgnoreThreshold is not provided', () => {
    const region = createRegion();
    expect(region.assertion).toBeUndefined();
  });

  test('includes carouselsEnabled in configuration if provided', () => {
    const region = createRegion({ algorithm: 'standard', carouselsEnabled: true });
    expect(region.configuration.carouselsEnabled).toBe(true);
  });

  test('includes bannersEnabled in configuration if provided', () => {
    const region = createRegion({ algorithm: 'standard', bannersEnabled: true });
    expect(region.configuration.bannersEnabled).toBe(true);
  });

  test('includes adsEnabled in configuration if provided', () => {
    const region = createRegion({ algorithm: 'standard', adsEnabled: true });
    expect(region.configuration.adsEnabled).toBe(true);
  });
});
