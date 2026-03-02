const utils = require('@percy/sdk-utils');
const { Utils } = require('./utils');

// Collect client and environment information
const sdkPkg = require('./package.json');
const playwrightPkg = require('playwright/package.json');
const CLIENT_INFO = `${sdkPkg.name}/${sdkPkg.version}`;
const ENV_INFO = `${playwrightPkg.name}/${playwrightPkg.version}`;
const log = utils.logger('playwright');

// Processes a single cross-origin frame to capture its snapshot and resources.
async function processFrame(page, frame, options, percyDOM) {
  const frameUrl = frame.url();

  /* istanbul ignore next: browser-executed iframe serialization */
  // enableJavaScript: true prevents the standard iframe serialization logic from running.
  // This is necessary because we're manually handling cross-origin iframe serialization here.
  const iframeSnapshot = await frame.evaluate((opts) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(opts);
  }, { ...options, enableJavascript: true });

  // Get the iframe's element data from the main page context
  /* istanbul ignore next: browser-executed evaluation function */
  const iframeData = await page.evaluate((fUrl) => {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    const matchingIframe = iframes.find(iframe => iframe.src.startsWith(fUrl));
    if (matchingIframe) {
      return {
        percyElementId: matchingIframe.getAttribute('data-percy-element-id')
      };
    }
  }, frameUrl);

  return {
    iframeData,
    iframeSnapshot,
    frameUrl
  };
}

async function captureSerializedDOM(page, options, percyDOM, captureWidth = null) {
  /* istanbul ignore next: no instrumenting injected code */
  let domSnapshot = await page.evaluate((options) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(options);
  }, options);

  // Process CORS IFrames
  // Note: Blob URL handling (data-src images, blob background images) is now handled
  // in the CLI via async DOM serialization. See: percy/cli packages/dom/src/serialize-blob-urls.js
  // This section only handles cross-origin iframe serialization and resource merging.
  const pageUrl = new URL(page.url());
  const crossOriginFrames = page.frames()
    .filter(frame => frame.url() !== 'about:blank' && new URL(frame.url()).origin !== pageUrl.origin);

  // Inject Percy DOM into all cross-origin frames before processing them in parallel
  await Promise.all(crossOriginFrames.map(frame => frame.evaluate(percyDOM)));

  const processedFrames = await Promise.all(
    crossOriginFrames.map(frame => processFrame(page, frame, options, percyDOM, captureWidth))
  );
  domSnapshot.corsIframes = processedFrames;
  domSnapshot.cookies = await page.context().cookies();
  return domSnapshot;
}

async function changeViewportAndWait(page, width, height, resizeCount) {
  try {
    await page.setViewportSize({ width, height });
  } catch (error) {
    log.debug(`Resizing using setViewportSize failed for width ${width}`, error);
    return false;
  }

  try {
    /* istanbul ignore next: no instrumenting injected code */
    await page.waitForFunction((count) => window.resizeCount === count, resizeCount, { timeout: 1000 });
  } catch (error) {
    log.debug(`Timed out waiting for window resize event for width ${width}`, error);
  }

  return true;
}

function isResponsiveDOMCaptureValid(options) {
  if (utils.percy?.config?.percy?.deferUploads) {
    return false;
  }
  return (
    options?.responsive_snapshot_capture ||
    options?.responsiveSnapshotCapture ||
    utils.percy?.config?.snapshot?.responsiveSnapshotCapture ||
    false
  );
}

async function captureResponsiveDOM(page, options, percyDOM) {
  const domSnapshots = [];
  /* istanbul ignore next: no instrumenting injected code */
  const currentViewport = page.viewportSize() || await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  let currentWidth = currentViewport.width;
  let currentHeight = currentViewport.height;
  let lastWindowWidth = currentWidth;
  let resizeCount = 0;

  /* istanbul ignore next: no instrumenting injected code */
  await page.evaluate(() => {
    /* eslint-disable-next-line no-undef */
    PercyDOM.waitForResize();
  });

  // Calculate default height for non-mobile widths
  let defaultHeight = currentHeight;
  if (process.env.PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT) {
    const minHeight = utils.percy?.config?.snapshot?.minHeight;
    /* istanbul ignore next: no instrumenting injected code */
    defaultHeight = await page.evaluate((minH) => window.outerHeight - window.innerHeight + minH, minHeight);
  }

  // Get width and height combinations
  /* istanbul ignore next: CLI version compatibility check */
  if (!utils.getResponsiveWidths) {
    throw new Error('Update Percy CLI to the latest version to use responsiveSnapshotCapture');
  }
  const widthHeights = await utils.getResponsiveWidths(options.widths || []);

  for (let { width, height } of widthHeights) {
    height = height || defaultHeight;
    if (lastWindowWidth !== width) {
      resizeCount++;
      await changeViewportAndWait(page, width, height, resizeCount);
      lastWindowWidth = width;
    }

    if (process.env.PERCY_RESPONSIVE_CAPTURE_RELOAD_PAGE) {
      await page.reload();
      await page.evaluate(percyDOM);
    }

    if (process.env.RESPONSIVE_CAPTURE_SLEEP_TIME) {
      await new Promise(resolve => setTimeout(resolve, parseInt(process.env.RESPONSIVE_CAPTURE_SLEEP_TIME) * 1000));
    }

    let domSnapshot = await captureSerializedDOM(page, options, percyDOM, width);
    domSnapshot.width = width;
    domSnapshots.push(domSnapshot);
  }

  await changeViewportAndWait(page, currentWidth, currentHeight, resizeCount + 1);
  return domSnapshots;
}

async function captureDOM(page, options, percyDOM) {
  const responsiveSnapshotCapture = isResponsiveDOMCaptureValid(options);
  if (responsiveSnapshotCapture) {
    return await captureResponsiveDOM(page, options, percyDOM);
  } else {
    return await captureSerializedDOM(page, options, percyDOM);
  }
}

// Take a DOM snapshot and post it to the snapshot endpoint
const percySnapshot = async function(page, name, options) {
  if (!page) throw new Error('A Playwright `page` object is required.');
  if (!name) throw new Error('The `name` argument is required.');
  if (!(await utils.isPercyEnabled())) return;

  try {
    // Inject the DOM serialization script
    const percyDOM = await utils.fetchPercyDOM();
    await page.evaluate(percyDOM);

    let domSnapshot = await captureDOM(page, options || {}, percyDOM);

    // Post the DOM to the snapshot endpoint with snapshot options and other info
    const response = await utils.postSnapshot({
      ...options,
      environmentInfo: ENV_INFO,
      clientInfo: CLIENT_INFO,
      url: page.url(),
      domSnapshot,
      name
    });
    return response?.body?.data;
  } catch (err) {
    log.error(`Could not take DOM snapshot "${name}"`);
    log.error(err);
  }
};

const createRegion = function({
  boundingBox = null,
  elementXpath = null,
  elementCSS = null,
  padding = null,
  algorithm = 'ignore',
  diffSensitivity = null,
  imageIgnoreThreshold = null,
  carouselsEnabled = null,
  bannersEnabled = null,
  adsEnabled = null,
  diffIgnoreThreshold = null
} = {}) {
  const elementSelector = {};
  if (boundingBox) elementSelector.boundingBox = boundingBox;
  if (elementXpath) elementSelector.elementXpath = elementXpath;
  if (elementCSS) elementSelector.elementCSS = elementCSS;

  const region = {
    algorithm,
    elementSelector
  };

  if (padding) {
    region.padding = padding;
  }

  const configuration = {};
  if (['standard', 'intelliignore'].includes(algorithm)) {
    if (diffSensitivity) configuration.diffSensitivity = diffSensitivity;
    if (imageIgnoreThreshold) configuration.imageIgnoreThreshold = imageIgnoreThreshold;
    if (carouselsEnabled) configuration.carouselsEnabled = carouselsEnabled;
    if (bannersEnabled) configuration.bannersEnabled = bannersEnabled;
    if (adsEnabled) configuration.adsEnabled = adsEnabled;
  }

  if (Object.keys(configuration).length > 0) {
    region.configuration = configuration;
  }

  const assertion = {};
  if (diffIgnoreThreshold) {
    assertion.diffIgnoreThreshold = diffIgnoreThreshold;
  }

  if (Object.keys(assertion).length > 0) {
    region.assertion = assertion;
  }

  return region;
};

// Takes Playwright screenshot with Automate
const percyScreenshot = async function(page, name, options) {
  if (!page) throw new Error('A Playwright `page` object is required.');
  if (!name) throw new Error('The `name` argument is required.');
  if (!(await utils.isPercyEnabled())) return;
  if (Utils.projectType() !== 'automate') {
    throw new Error('Invalid function call - percyScreenshot(). Please use percySnapshot() function for taking screenshot. percyScreenshot() should be used only while using Percy with Automate. For more information on usage of PercySnapshot(), refer doc for your language https://www.browserstack.com/docs/percy/integrate/overview');
  }

  try {
    const sessionDetails = await Utils.sessionDetails(page);
    const sessionId = sessionDetails.hashed_id;
    const pageGuid = page._guid;
    const frameGuid = page._mainFrame._guid;
    const data = {
      environmentInfo: ENV_INFO,
      clientInfo: CLIENT_INFO,
      sessionId: sessionId,
      pageGuid: pageGuid,
      frameGuid: frameGuid,
      framework: 'playwright',
      snapshotName: name,
      options
    };
    const response = await Utils.captureAutomateScreenshot(data);
    return response?.body?.data;
  } catch (err) {
    log.error(`Could not take percy screenshot "${name}"`);
    log.error(err);
  }
};

module.exports = percySnapshot;
module.exports.percySnapshot = percySnapshot;
module.exports.createRegion = createRegion;
module.exports.percyScreenshot = percyScreenshot;
module.exports.CLIENT_INFO = CLIENT_INFO;
module.exports.ENV_INFO = ENV_INFO;
