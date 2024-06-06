const utils = require('@percy/sdk-utils');

class Utils {
  static projectType() {
    return utils.percy?.type;
  }

  static async captureAutomateScreenshot(data) {
    return await utils.captureAutomateScreenshot(data);
  }
}

module.exports = {
  Utils
};
