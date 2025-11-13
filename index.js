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
  const iframeSnapshot = await frame.evaluate((opts) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(opts);
  }, { ...options, enableJavascript: true });

  // Create a new resource for the iframe's HTML
  const iframeResource = {
    url: frameUrl,
    content: iframeSnapshot.html,
    mimetype: 'text/html'
  };

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
    iframeResource,
    iframeSnapshot,
    frameUrl
  };
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

    // Serialize and capture the DOM
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
      crossOriginFrames.map(frame => processFrame(page, frame, options, percyDOM))
    );

    for (const { iframeData, iframeResource, iframeSnapshot, frameUrl } of processedFrames) {
      // Add the iframe's own resources to the main snapshot
      domSnapshot.resources.push(...iframeSnapshot.resources);
      // Add the iframe HTML resource itself
      domSnapshot.resources.push(iframeResource);

      if (iframeData && iframeData.percyElementId) {
        const regex = new RegExp(`(<iframe[^>]*data-percy-element-id=["']${iframeData.percyElementId}["'][^>]*>)`);
        const match = domSnapshot.html.match(regex);

        /* istanbul ignore next: iframe matching logic depends on DOM structure */
        if (match) {
          const iframeTag = match[1];
          // Replace the original iframe tag with one that points to the new resource.
          const newIframeTag = iframeTag.replace(/src="[^"]*"/i, `src="${frameUrl}"`);
          domSnapshot.html = domSnapshot.html.replace(iframeTag, newIframeTag);
        }
      }
    }

    domSnapshot.cookies = await page.context().cookies();

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
