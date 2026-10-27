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

  // A Locator exposes `.page()` but no `.url()`; a Page has both.
  static isLocator(subject) {
    return !!subject && typeof subject.page === 'function' && typeof subject.url !== 'function';
  }

  // Marks the locator's element with `attr` so a server-side render can be scoped to `[attr]`. An
  // attribute survives DOM serialization, unlike a CSS selector reconstructed from the live element.
  static async withScopedLocator(locator, attr, fn) {
    await locator.evaluate(/* istanbul ignore next */ (el, a) => el.setAttribute(a, ''), attr);
    try {
      return await fn(`[${attr}]`);
    } finally {
      await locator.evaluate(/* istanbul ignore next */ (el, a) => el.removeAttribute(a), attr).catch(() => {});
    }
  }
}

module.exports = {
  Utils
};
