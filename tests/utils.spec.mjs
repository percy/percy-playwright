import sinon from 'sinon';
import { test, expect } from '@playwright/test';
import { Utils } from '../utils.js';
import utils from '@percy/sdk-utils';
import { Cache } from '../cache.js';

test.describe('Utils', () => {
  test.afterEach(() => {
    sinon.restore();
  });
  test.describe('projectType', () => {
    test('should return the project type', () => {
      const type = 'automate';
      sinon.stub(utils.percy, 'type').value(type);

      const result = Utils.projectType();

      expect(result).toEqual(type);
    });

    test('should return undefined if project type is not available', () => {
      sinon.stub(utils.percy, 'type').value(undefined);

      const result = Utils.projectType();

      expect(result).toBeUndefined;
    });
  });

  test.describe('captureAutomateScreenshot', () => {
    test('should capture an automated screenshot', async () => {
      const data = { abc: true };
      const spy = sinon.spy(utils.captureAutomateScreenshot);
      try {
        await Utils.captureAutomateScreenshot(data);
      } catch (err) {}
      expect(spy.calledOnceWithExactly(data)).toBeTruthy;
    });
  });

  test.describe('sessionDetails', () => {
    let page;

    test.beforeEach(() => {
      // Mocking page object
      page = {
        _parent: {
          _parent: {
            _guid: 'mockBrowserGuid'
          }
        },
        evaluate: async () => {}
      };
    });

    test.afterEach(() => {
      sinon.restore();
      Cache.cleanupCache();
    });

    test('should return session details from cache if available', async () => {
      const getCacheStub = sinon.stub(Cache, 'getCache').returns({ mockSessionDetails: 'cachedDetails' });

      const result = await Utils.sessionDetails(page);

      expect(result).toEqual({ mockSessionDetails: 'cachedDetails' });
      expect(getCacheStub.calledWith('mockBrowserGuid', 'sessionDetails')).toBe(true);
    });

    test('should fetch and cache session details if not available in cache', async () => {
      sinon.stub(Cache, 'getCache').returns(null);
      const setCacheStub = sinon.stub(Cache, 'setCache');
      const evaluateStub = sinon.stub(page, 'evaluate').resolves('{"mockSessionDetails": "fetchedDetails"}');

      const result = await Utils.sessionDetails(page);

      expect(result).toEqual({ mockSessionDetails: 'fetchedDetails' });
      expect(evaluateStub.calledOnce).toBe(true);
      expect(setCacheStub.calledWith('mockBrowserGuid', 'sessionDetails', { mockSessionDetails: 'fetchedDetails' })).toBe(true);
    });
  });
});
