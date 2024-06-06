const utils = require('@percy/sdk-utils');
const { Cache } = require('./cache');

class Utils {
  static projectType() {
    return utils.percy?.type;
  }

  static async captureAutomateScreenshot(data) {
    return await utils.captureAutomateScreenshot(data);
  }

  static async getSessionId(page) {
    /* It is browser's guid maintained by playwright, considering it is unique for one automate session
     will use it to cache the session details */
    const browserId = page._parent._parent._guid;
    return await Cache.withCache(Cache.sessionId, browserId, async () => {
      return JSON.parse(await page.evaluate(/* istanbul ignore next */ _ => { }, `browserstack_executor: ${JSON.stringify({ action: 'getSessionDetails' })}`));
    });
  }
}

module.exports = {
  Utils
};
