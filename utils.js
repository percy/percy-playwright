const utils = require('@percy/sdk-utils');
const { Cache } = require('./cache');

class Utils {
  static projectType() {
    return utils.percy?.type;
  }

  static async captureAutomateScreenshot(data) {
    return await utils.captureAutomateScreenshot(data);
  }

  static async sessionDetails(page) {
    /* It is browser's guid maintained by playwright, considering it is unique for one automate session
    will use it to cache the session details */
    const browserGuid = page._parent._parent._guid;
    let sessionDetails = Cache.getCache(browserGuid, Cache.sessionDetails);
    if (!sessionDetails) {
      sessionDetails = JSON.parse(await page.evaluate(/* istanbul ignore next */ _ => { }, `browserstack_executor: ${JSON.stringify({ action: 'getSessionDetails' })}`));
      Cache.setCache(browserGuid, Cache.sessionDetails, sessionDetails);
    }
    return sessionDetails;
  }
}

module.exports = {
  Utils
};
