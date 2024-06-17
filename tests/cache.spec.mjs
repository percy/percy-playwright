import { test, expect } from '@playwright/test';
import { Cache } from '../cache.js';
import sinon from 'sinon';

test.describe('Cache', () => {
  test.afterEach(() => {
    sinon.restore();
    Cache.cleanupCache();
  });

  test.describe('setCache', () => {
    test('should set cache correctly', () => {
      const sessionId = 'mockSessionId';
      const property = 'mockProperty';
      const value = 'mockValue';
      const now = 1234567890;

      // Stub Date.now() to return a fixed value
      sinon.stub(Date, 'now').returns(now * 1000);

      Cache.setCache(sessionId, property, value);

      expect(Cache.CACHE[sessionId]).toEqual({
        [Cache.TIMEOUT_KEY]: now,
        [property]: value
      });
    });

    test('should initialize session to empty object if not found in CACHE', () => {
      const sessionId = 'nonExistentSessionId';
      const property = 'mockProperty';
      sinon.stub(Date, 'now').returns(1234567890 * 1000);

      Cache.setCache(sessionId, property, 'mockValue');

      expect(Cache.CACHE[sessionId]).toEqual({ [Cache.TIMEOUT_KEY]: 1234567890, [property]: 'mockValue' });
    });
  });

  test.describe('getCache', () => {
    test('should return null if cache entry does not exist', () => {
      const sessionId = 'nonExistentSessionId';
      const property = 'mockProperty';
      const value = Cache.getCache(sessionId, property);

      expect(value).toBeNull();
    });

    test('should return cached value if cache entry exists', () => {
      const sessionId = 'existingSessionId';
      const property = 'mockProperty';
      const cachedValue = 'cachedValue';
      const now = 1234567890;
      sinon.stub(Cache, 'cleanupCache');

      Cache.CACHE[sessionId] = {
        [Cache.TIMEOUT_KEY]: now,
        [property]: cachedValue
      };

      const value = Cache.getCache(sessionId, property);

      expect(value).toEqual(cachedValue);
    });
  });

  test.describe('cleanupCache', () => {
    test('should remove expired cache entries', () => {
      const sessionId1 = 'expiredSessionId';
      const sessionId2 = 'validSessionId';
      const property = 'mockProperty';
      const now = 1234567890;
      const expiredTime = now - (Cache.CACHE_TIMEOUT + 1);
      const validTime = now - (Cache.CACHE_TIMEOUT - 1);

      Cache.CACHE[sessionId1] = {
        [Cache.TIMEOUT_KEY]: expiredTime,
        [property]: 'expiredValue'
      };
      Cache.CACHE[sessionId2] = {
        [Cache.TIMEOUT_KEY]: validTime,
        [property]: 'validValue'
      };

      sinon.stub(Date, 'now').returns(now * 1000);

      Cache.cleanupCache();

      expect(Cache.CACHE[sessionId1]).toEqual({ sessionDetails: undefined });
      expect(Cache.CACHE[sessionId2]).toBeDefined();
    });
  });

  test.describe('checkTypes', () => {
    test('should throw TypeError if sessionId is not a string', () => {
      expect(() => Cache.checkTypes(123, 'property')).toThrowError(TypeError, 'Argument sessionId should be a string');
    });

    test('should throw TypeError if property is not a string', () => {
      expect(() => Cache.checkTypes('sessionId', 123)).toThrowError(TypeError, 'Argument property should be a string');
    });

    test('should not throw any error if sessionId and property are strings', () => {
      expect(() => Cache.checkTypes('sessionId', 'property')).not.toThrowError(TypeError);
    });
  });
});
