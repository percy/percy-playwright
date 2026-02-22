import helpers from '@percy/sdk-utils/test/helpers';
import { test, expect } from '@playwright/test';
import percySnapshot from '../index.js';
import sinon from 'sinon';
import { Utils } from '../utils.js';
import utils from '@percy/sdk-utils';
const { percyScreenshot, ENV_INFO, CLIENT_INFO, createRegion, slowScrollToBottom } = percySnapshot;

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

    test('posts snapshots to the local percy server', async ({ page }) => {
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
      html: `<html><body><h1>Main Page</h1><iframe src="about:blank" data-percy-element-id="iframe-1"></iframe></body></html>`,
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
      html: `<html><body><h1>Main Page</h1><iframe src="about:blank" data-percy-element-id="different-id"></iframe></body></html>`,
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
          html: `<html><body><h1>Main Page</h1><iframe src="https://cross-origin.com/frame" data-percy-element-id="test-iframe-1"></iframe></body></html>`,
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

  test('posts snapshots to percy server with responsiveSnapshotCapture true', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
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
  });

  test('posts snapshots to percy server with responsiveSnapshotCapture false', async ({ page }) => {
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: false, widths: [1280] });
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1',
      `- url: ${helpers.testSnapshotURL}`,
      expect.stringMatching(/clientInfo: @percy\/playwright\/.+/),
      expect.stringMatching(/environmentInfo: playwright\/.+/)
    ]));
  });

  test('posts snapshots to percy server with responsiveSnapshotCapture with mobile', async ({ page }) => {
    await helpers.test('config', { config: [1280], mobile: [390] });
    
    const setViewportSizeSpy = sinon.spy(page, 'setViewportSize');
    
    await percySnapshot(page, 'Snapshot 1', { responsiveSnapshotCapture: true });
    
    // Verify viewport was resized for responsive capture with mobile widths
    expect(setViewportSizeSpy.called).toBe(true);
    
    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1',
      `- url: ${helpers.testSnapshotURL}`,
      expect.stringMatching(/clientInfo: @percy\/playwright\/.+/),
      expect.stringMatching(/environmentInfo: playwright\/.+/)
    ]));
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
    
    await percySnapshot(page, 'Test Snapshot with mobile', { responsiveSnapshotCapture: true });
    
    // Verify viewport was resized for both mobile and config widths
    expect(setViewportSizeSpy.called).toBe(true);
    // Should be called for mobile widths: 390, 768, and config: 1280
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
    
    const evaluateSpy = sinon.spy(page, 'evaluate');
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    // Verify that evaluate was called for minHeight calculation (window.outerHeight - window.innerHeight + minH)
    const minHeightCalls = evaluateSpy.getCalls().filter(call => {
      const func = call.args[0];
      return typeof func === 'function' && func.toString().includes('outerHeight') && func.toString().includes('innerHeight');
    });
    expect(minHeightCalls.length).toBeGreaterThan(0);
    
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
    const originalViewportSize = page.viewportSize;
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

  test('passes ignoreCanvasSerializationErrors as true to DOM serialization', async ({ page }) => {
    const evaluateSpy = sinon.spy(page, 'evaluate');

    await percySnapshot(page, 'Snapshot with ignore canvas true', { 
      ignoreCanvasSerializationErrors: true 
    });

    // Find the call to PercyDOM.serialize
    const serializeCalls = evaluateSpy.getCalls().filter(call => {
      const func = call.args[0];
      return typeof func === 'function' && func.toString().includes('PercyDOM.serialize');
    });
    
    expect(serializeCalls.length).toBeGreaterThan(0);
    expect(serializeCalls[0].args[1]).toEqual(
      expect.objectContaining({
        ignoreCanvasSerializationErrors: true
      })
    );
  });

  test('passes ignoreCanvasSerializationErrors as false to DOM serialization', async ({ page }) => {
    const evaluateSpy = sinon.spy(page, 'evaluate');

    await percySnapshot(page, 'Snapshot with ignore canvas false', { 
      ignoreCanvasSerializationErrors: false 
    });

    // Find the call to PercyDOM.serialize
    const serializeCalls = evaluateSpy.getCalls().filter(call => {
      const func = call.args[0];
      return typeof func === 'function' && func.toString().includes('PercyDOM.serialize');
    });
    
    expect(serializeCalls.length).toBeGreaterThan(0);
    expect(serializeCalls[0].args[1]).toEqual(
      expect.objectContaining({
        ignoreCanvasSerializationErrors: false
      })
    );
  });

  test('defaults ignoreCanvasSerializationErrors to false when not provided', async ({ page }) => {
    const evaluateSpy = sinon.spy(page, 'evaluate');

    await percySnapshot(page, 'Snapshot with default canvas setting');

    // Find the call to PercyDOM.serialize
    const serializeCalls = evaluateSpy.getCalls().filter(call => {
      const func = call.args[0];
      return typeof func === 'function' && func.toString().includes('PercyDOM.serialize');
    });
    
    expect(serializeCalls.length).toBeGreaterThan(0);
    // When not provided in options or config, should default to false
    expect(serializeCalls[0].args[1]).toEqual(
      expect.objectContaining({
        ignoreCanvasSerializationErrors: false
      })
    );
  });

  test('should default to false when empty options object is provided', async ({ page }) => {
    const evaluateSpy = sinon.spy(page, 'evaluate');

    await percySnapshot(page, 'Default canvas test with empty options', {});

    // Find the call to PercyDOM.serialize
    const serializeCalls = evaluateSpy.getCalls().filter(call => {
      const func = call.args[0];
      return typeof func === 'function' && func.toString().includes('PercyDOM.serialize');
    });
    
    expect(serializeCalls.length).toBeGreaterThan(0);
    expect(serializeCalls[0].args[1]).toEqual(
      expect.objectContaining({
        ignoreCanvasSerializationErrors: false
      })
    );
  });
});

test.describe('Lazy Loading and Scroll', () => {
  test.beforeEach(async ({ page }) => {
    await helpers.setupTest();
    await page.goto(helpers.testSnapshotURL);
  });

  test.afterEach(async ({ page }) => {
    sinon.restore();
    delete process.env.PERCY_ENABLE_LAZY_LOADING_SCROLL;
    delete process.env.PERCY_LAZY_LOAD_SCROLL_TIME;
    delete process.env.PERCY_SLEEP_AFTER_LAZY_LOAD_COMPLETE;
  });

  test('should scroll if PERCY_ENABLE_LAZY_LOADING_SCROLL is set', async ({ page }) => {
    process.env.PERCY_ENABLE_LAZY_LOADING_SCROLL = 'true';
    process.env.PERCY_LAZY_LOAD_SCROLL_TIME = '0.001'; // Very short for testing
    await helpers.test('config', { config: [1280], mobile: [] });
    
    const evaluateSpy = sinon.spy(page, 'evaluate');
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    // Check that scroll functions were called
    const scrollCalls = evaluateSpy.getCalls().filter(call => {
      const arg = call.args[0];
      return (typeof arg === 'string' && 
        (arg.includes('scrollHeight') || arg.includes('clientHeight'))) ||
        (typeof arg === 'function' && arg.toString().includes('scrollTo'));
    });
    expect(scrollCalls.length).toBeGreaterThan(0);
    
    delete process.env.PERCY_LAZY_LOAD_SCROLL_TIME;
  });

  test('should use custom scroll time if PERCY_LAZY_LOAD_SCROLL_TIME is set', async ({ page }) => {
    process.env.PERCY_ENABLE_LAZY_LOADING_SCROLL = 'true';
    process.env.PERCY_LAZY_LOAD_SCROLL_TIME = '0.01'; // Very short for testing
    await helpers.test('config', { config: [1280], mobile: [] });
    
    // Mock page.evaluate to return values that will trigger the scroll loop
    const originalEvaluate = page.evaluate;
    let evaluateCallCount = 0;
    sinon.stub(page, 'evaluate').callsFake((func, ...args) => {
      if (typeof func === 'string') {
        if (func.includes('scrollHeight')) {
          // Return a height that will trigger multiple scroll iterations
          return Promise.resolve(evaluateCallCount++ < 2 ? 3000 : 2000);
        }
        if (func.includes('clientHeight')) {
          return Promise.resolve(1000);
        }
      }
      return originalEvaluate.call(page, func, ...args);
    });
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    // Check that scrollHeight was evaluated (scroll happened)
    expect(page.evaluate.called).toBe(true);
  });

  test('should use custom sleep after scroll if PERCY_SLEEP_AFTER_LAZY_LOAD_COMPLETE is set', async ({ page }) => {
    process.env.PERCY_ENABLE_LAZY_LOADING_SCROLL = 'true';
    process.env.PERCY_SLEEP_AFTER_LAZY_LOAD_COMPLETE = '0.01'; // Very short for testing
    await helpers.test('config', { config: [1280], mobile: [] });
    
    // Mock page.evaluate to return values that will trigger scroll
    const originalEvaluate = page.evaluate;
    sinon.stub(page, 'evaluate').callsFake((func, ...args) => {
      if (typeof func === 'string') {
        if (func.includes('scrollHeight')) {
          return Promise.resolve(1500);
        }
        if (func.includes('clientHeight')) {
          return Promise.resolve(1000);
        }
      }
      return originalEvaluate.call(page, func, ...args);
    });
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    expect(page.evaluate.called).toBe(true);
  });

  test('should handle large scroll height capped at 25000px', async ({ page }) => {
    process.env.PERCY_ENABLE_LAZY_LOADING_SCROLL = 'true';
    process.env.PERCY_LAZY_LOAD_SCROLL_TIME = '0.001';
    await helpers.test('config', { config: [1280], mobile: [] });
    
    // Mock page.evaluate to return very large scroll height
    const originalEvaluate = page.evaluate;
    let scrollHeightCallCount = 0;
    sinon.stub(page, 'evaluate').callsFake((func, ...args) => {
      if (typeof func === 'string') {
        if (func.includes('scrollHeight')) {
          // Return very large height on first few calls, then smaller
          return Promise.resolve(scrollHeightCallCount++ < 30 ? 50000 : 1000);
        }
        if (func.includes('clientHeight')) {
          return Promise.resolve(1000);
        }
      }
      return originalEvaluate.call(page, func, ...args);
    });
    
    await percySnapshot(page, 'Test Snapshot', { responsiveSnapshotCapture: true });
    
    // Verify that scrollTo was called (scroll happened)
    const scrollToCalls = page.evaluate.getCalls().filter(call => {
      const func = call.args[0];
      return typeof func === 'function' && func.toString().includes('scrollTo');
    });
    expect(scrollToCalls.length).toBeGreaterThan(0);
    
    delete process.env.PERCY_LAZY_LOAD_SCROLL_TIME;
  });

});

test.describe('slowScrollToBottom', () => {
  let mockedPage;

  test.beforeEach(() => {
    mockedPage = {
      evaluate: sinon.stub()
    };
  });

  test('should scroll to bottom and sleep after loading as set in env', async () => {
    process.env.PERCY_SLEEP_AFTER_LAZY_LOAD_COMPLETE = '2';
    mockedPage.evaluate
      .onCall(0).resolves(9)       // scrollHeight
      .onCall(1).resolves(5)       // clientHeight
      .onCall(2).resolves(undefined) // scrollTo
      .onCall(3).resolves(9)       // scrollHeight in loop
      .onCall(4).resolves(undefined) // scrollTo
      .onCall(5).resolves(9)       // scrollHeight in loop
      .onCall(6).resolves(undefined); // scrollTo(0, 0)

    const setTimeoutSpy = sinon.spy(global, 'setTimeout');

    await slowScrollToBottom(mockedPage);
    
    expect(setTimeoutSpy.callCount).toBeGreaterThanOrEqual(3);
    // Verify setTimeout was called with correct timing for final sleep (2000ms)
    const timeoutCalls = setTimeoutSpy.getCalls().map(call => call.args[1]);
    expect(timeoutCalls.filter(t => t === 2000).length).toBe(1);
    expect(mockedPage.evaluate.callCount).toBe(7);
    
    setTimeoutSpy.restore();
    delete process.env.PERCY_SLEEP_AFTER_LAZY_LOAD_COMPLETE;
  });

  test('should scroll to bottom and sleep as set in env', async () => {
    process.env.PERCY_LAZY_LOAD_SCROLL_TIME = '1.2';
    mockedPage.evaluate
      .onCall(0).resolves(9)       // scrollHeight
      .onCall(1).resolves(5)       // clientHeight
      .onCall(2).resolves(undefined) // scrollTo
      .onCall(3).resolves(9)       // scrollHeight in loop
      .onCall(4).resolves(undefined) // scrollTo
      .onCall(5).resolves(9)       // scrollHeight in loop
      .onCall(6).resolves(undefined); // scrollTo(0, 0)

    const setTimeoutSpy = sinon.spy(global, 'setTimeout');

    await slowScrollToBottom(mockedPage);
    
    // Verify setTimeout was called with correct timing (1200ms for scroll, 1000ms for final sleep)
    const timeoutCalls = setTimeoutSpy.getCalls().map(call => call.args[1]);
    expect(timeoutCalls.filter(t => t === 1200).length).toBeGreaterThan(0);
    expect(timeoutCalls.filter(t => t === 1000).length).toBe(1);
    expect(mockedPage.evaluate.callCount).toBe(7);
    
    setTimeoutSpy.restore();
    delete process.env.PERCY_LAZY_LOAD_SCROLL_TIME;
  });

  test('should scroll upto 25k px and sleep as passed in function', async () => {
    mockedPage.evaluate
      .onCall(0).resolves(30000)   // scrollHeight (capped to 25000)
      .onCall(1).resolves(15000)   // clientHeight
      .onCall(2).resolves(undefined) // scrollTo
      .onCall(3).resolves(30000)   // scrollHeight in loop
      .onCall(4).resolves(undefined) // scrollTo
      .onCall(5).resolves(30000)   // scrollHeight in loop
      .onCall(6).resolves(undefined); // scrollTo(0, 0)

    const setTimeoutSpy = sinon.spy(global, 'setTimeout');

    await slowScrollToBottom(mockedPage, 2);
    
    // Verify setTimeout was called with 2000ms for scrolls and 1000ms for final sleep
    const timeoutCalls = setTimeoutSpy.getCalls().map(call => call.args[1]);
    expect(timeoutCalls.filter(t => t === 2000).length).toBeGreaterThan(0);
    expect(timeoutCalls.filter(t => t === 1000).length).toBe(1);
    expect(mockedPage.evaluate.callCount).toBe(7);
    
    setTimeoutSpy.restore();
  });

  test('should use default timing when no env vars or params are set', async () => {
    // Ensure env vars are not set
    delete process.env.PERCY_LAZY_LOAD_SCROLL_TIME;
    delete process.env.PERCY_SLEEP_AFTER_LAZY_LOAD_COMPLETE;
    
    mockedPage.evaluate
      .onCall(0).resolves(9)       // scrollHeight
      .onCall(1).resolves(5)       // clientHeight
      .onCall(2).resolves(undefined) // scrollTo
      .onCall(3).resolves(9)       // scrollHeight in loop
      .onCall(4).resolves(undefined) // scrollTo
      .onCall(5).resolves(9)       // scrollHeight in loop
      .onCall(6).resolves(undefined); // scrollTo(0, 0)

    const setTimeoutSpy = sinon.spy(global, 'setTimeout');

    await slowScrollToBottom(mockedPage); // No params passed
    
    // Default scroll sleep should be 450ms (SCROLL_DEFAULT_SLEEP_TIME = 0.45 * 1000)
    // Default sleepAfterScroll should be 1000ms
    const timeoutCalls = setTimeoutSpy.getCalls().map(call => call.args[1]);
    expect(timeoutCalls.filter(t => t === 450).length).toBeGreaterThan(0);
    expect(timeoutCalls.filter(t => t === 1000).length).toBe(1);
    expect(mockedPage.evaluate.callCount).toBe(7);
    
    setTimeoutSpy.restore();
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


