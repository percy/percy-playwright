const utils = require('@percy/sdk-utils');
const { Utils } = require('./utils');

// Collect client and environment information
const sdkPkg = require('./package.json');
const playwrightPkg = require('playwright/package.json');
const CLIENT_INFO = `${sdkPkg.name}/${sdkPkg.version}`;
const ENV_INFO = `${playwrightPkg.name}/${playwrightPkg.version}`;
const log = utils.logger('playwright');

// Take a DOM snapshot and post it to the snapshot endpoint
const percySnapshot = async function(page, name, options) {
  if (!page) throw new Error('A Playwright `page` object is required.');
  if (!name) throw new Error('The `name` argument is required.');
  if (!(await utils.isPercyEnabled())) return;

  try {
    // Inject the DOM serialization script
    await page.evaluate(await utils.fetchPercyDOM());

    // Serialize and capture the DOM
    /* istanbul ignore next: no instrumenting injected code */
    let domSnapshot = await page.evaluate((options) => {
      /* eslint-disable-next-line no-undef */
      return PercyDOM.serialize(options);
    }, options);

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
