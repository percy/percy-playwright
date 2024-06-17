class Cache {
  static CACHE = {};
  static CACHE_TIMEOUT = 5 * 60; // 300 seconds
  static TIMEOUT_KEY = 'last_access_time';

  // Caching Keys
  static sessionDetails = 'sessionDetails';

  static checkTypes(sessionId, property) {
    if (typeof sessionId !== 'string') {
      throw new TypeError('Argument sessionId should be a string');
    }
    if (typeof property !== 'string') {
      throw new TypeError('Argument property should be a string');
    }
  }

  static setCache(sessionId, property, value) {
    this.checkTypes(sessionId, property);
    let session = this.CACHE[sessionId] || {};
    session[this.TIMEOUT_KEY] = Math.floor(Date.now() / 1000);
    session[property] = value;
    this.CACHE[sessionId] = session;
  }

  static getCache(sessionId, property) {
    this.cleanupCache();
    this.checkTypes(sessionId, property);
    /* Below line is covered even then nyc is not able to consider it as coverage */
    /* istanbul ignore next */
    let session = this.CACHE[sessionId] || {};
    return session[property] || null;
  }

  static cleanupCache() {
    let now = Math.floor(Date.now() / 1000);
    for (let sessionId in this.CACHE) {
      let session = this.CACHE[sessionId];
      let timestamp = session[this.TIMEOUT_KEY];
      if (now - timestamp >= this.CACHE_TIMEOUT) {
        this.CACHE[sessionId] = {
          [this.sessionDetails]: session[this.sessionDetails]
        };
      }
    }
  }
}

module.exports = {
  Cache
};
