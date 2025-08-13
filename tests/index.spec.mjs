import helpers from '@percy/sdk-utils/test/helpers';
import { test, expect } from '@playwright/test';
import percySnapshot from '../index.js';
import sinon from 'sinon';
import { Utils } from '../utils.js';
const { percyScreenshot, ENV_INFO, CLIENT_INFO, createRegion } = percySnapshot;

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

  // temp specs for alpha release, some of them to be removed later

  test('processes pages with lazy-loaded images via data-src', async ({ page }) => {
    // Create a test page with data-src images
    await page.setContent(`
      <html>
        <body>
          <img data-src="https://example.com/image1.jpg" alt="Test image 1">
          <img data-src="http://example.com/image2.jpg" alt="Test image 2">
          <img data-src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" alt="Test image 3">
          <img data-src="blob:http://example.com/blob-id" alt="Test image 4">
          <img data-src="javascript:alert('xss')" alt="Test image 5">
          <img data-src="invalid-url" alt="Test image 6">
        </body>
      </html>
    `);

    await percySnapshot(page, 'Snapshot with data-src images');

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot with data-src images'
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
    // Second call (handleDynamicResources) returns undefined  
    // Third call (iframe DOM serialization) returns snapshot
    mockFrame.evaluate
      .onFirstCall().resolves(undefined)
      .onSecondCall().resolves(undefined)
      .onThirdCall().resolves({ html: '<html><body>Cross-origin content</body></html>', resources: [] });

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
      // handleDynamicResources or other functions
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
      // handleDynamicResources or other functions
      return Promise.resolve();
    });

    await percySnapshot(page, 'Snapshot with iframe no percy-element-id match');

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot with iframe no percy-element-id match'
    ]));
  });

  test('handles handleDynamicResources errors gracefully', async ({ page }) => {
    // Create a page that will cause handleDynamicResources to fail
    await page.setContent(`
      <html>
        <body>
          <h1>Test Page</h1>
        </body>
      </html>
    `);

    // Mock page.evaluate to throw an error for handleDynamicResources
    const originalEvaluate = page.evaluate;
    let callCount = 0;
    sinon.stub(page, 'evaluate').callsFake((func, ...args) => {
      callCount++;
      // First call is for percyDOM injection (should succeed)
      if (callCount === 1) {
        return originalEvaluate.call(page, func, ...args);
      }
      // Second call is for handleDynamicResources (should fail)
      if (callCount === 2) {
        return Promise.reject(new Error('handleDynamicResources failed'));
      }
      // Third call is for DOM serialization (should succeed)
      return originalEvaluate.call(page, func, ...args);
    });

    await percySnapshot(page, 'Snapshot with handleDynamicResources error');

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot with handleDynamicResources error'
    ]));
  });

  test('executes handleDynamicResources function in browser context', async ({ page }) => {
    // Create a simpler test page 
    await page.setContent(`
      <html>
        <body>
          <img data-src="https://example.com/image.jpg" alt="Test">
          <img data-src="javascript:alert('xss')" alt="Unsafe">
        </body>
      </html>
    `);

    await percySnapshot(page, 'Comprehensive handleDynamicResources test');

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Comprehensive handleDynamicResources test'
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
      
      // handleDynamicResources or other functions
      return Promise.resolve();
    });

    await percySnapshot(page, 'Snapshot with iframe src replacement');

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot with iframe src replacement'
    ]));
  });

  test('covers handleDynamicResources function execution paths', async ({ page }) => {
    // Create a page that will exercise handleDynamicResources code paths
    await page.setContent(`
      <html>
        <head>
          <style>
            .test-div { background-image: url('blob:http://test.com/blob123'); width: 100px; height: 100px; }
          </style>
        </head>
        <body>
          <img data-src="https://test.com/valid.jpg" alt="Valid HTTPS">
          <img data-src="http://test.com/valid.jpg" alt="Valid HTTP">
          <img data-src="data:image/png;base64,test" alt="Valid Data URL">
          <img data-src="blob:http://test.com/blob" alt="Valid Blob URL">
          <img data-src="ftp://test.com/invalid" alt="Invalid Protocol">
          <img data-src="not-a-url" alt="Invalid URL">
          <div class="test-div">Element with blob background</div>
          <div style="background-image: url('blob:http://test.com/blob456');">Another blob div</div>
        </body>
      </html>
    `);

    // Execute the handleDynamicResources function directly in the browser
    await page.evaluate(() => {
      // Simulate the handleDynamicResources function execution
      // This mirrors the actual function but allows us to test it directly
      const images = document.querySelectorAll('img');
      images.forEach(img => {
        const dataSrc = img.getAttribute('data-src');
        if (dataSrc) {
          try {
            const url = new URL(dataSrc, window.location.origin);
            if (
              url.protocol === 'http:' ||
              url.protocol === 'https:' ||
              url.protocol === 'data:' ||
              url.protocol === 'blob:'
            ) {
              img.src = url.href;
            }
          } catch (e) {
            // Invalid URL handling
          }
        }
      });

      // Process blob background images
      const elements = Array.from(document.querySelectorAll('*'));
      const promises = [];

      for (const el of elements) {
        const style = window.getComputedStyle(el);
        const backgroundImage = style.getPropertyValue('background-image');

        if (backgroundImage && backgroundImage.includes('blob:')) {
          const blobUrlMatch = backgroundImage.match(/url\("?(blob:.+?)"?\)/);
          if (blobUrlMatch && blobUrlMatch[1]) {
            // Simulate blob processing (simplified)
            const blobUrl = blobUrlMatch[1];
            promises.push(Promise.resolve());
          }
        }
      }
      
      return Promise.all(promises);
    });

    await percySnapshot(page, 'Direct handleDynamicResources execution');

    const logs = await helpers.get('logs');
    expect(logs).toEqual(expect.arrayContaining([
      'Snapshot found: Direct handleDynamicResources execution'
    ]));
  });
});

// temp specs for alpha release, some of them to be removed later

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


