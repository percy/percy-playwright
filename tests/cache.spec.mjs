import sinon from "sinon";
import { test, expect } from "@playwright/test";
import { Cache } from "../cache.js";

test.describe("Cache", () => {
  const store = "abc";
  const key = "key";

  test.beforeEach(async () => {
    Cache.reset();
  });

  test.describe("withCache", () => {
    test("caches response", async () => {
      const expectedVal = 123;
      const func = sinon.stub().returns(expectedVal);
      let val = await Cache.withCache(store, key, func);
      expect(func.calledOnce).toBeTruthy;
      expect(val).toEqual(expectedVal);

      val = await Cache.withCache(store, key, func);
      expect(func.calledOnce).toBeTruthy;
      expect(val).toEqual(expectedVal);
    });
  });

  test.describe("with different key but same store", () => {
    test("calls func again and caches it", async () => {
      const expectedVal = 123;
      const funcStub = sinon.stub().returns(expectedVal);
      const key2 = "key2";

      let val = await Cache.withCache(store, key, funcStub);
      expect(funcStub.calledOnce).toBeTruthy;
      expect(val).toEqual(expectedVal);

      val = await Cache.withCache(store, key2, funcStub);
      expect(funcStub.calledTwice).toBeTruthy;
      expect(val).toEqual(expectedVal);

      // test both cache
      val = await Cache.withCache(store, key, funcStub);
      expect(funcStub.calledTwice).toBeTruthy; // does not increment
      expect(val).toEqual(expectedVal);

      val = await Cache.withCache(store, key2, funcStub);
      expect(funcStub.calledTwice).toBeTruthy; // does not increment
      expect(val).toEqual(expectedVal);
    });
  });

  test.describe("with different store but same key", () => {
    test("calls func again and caches it", async () => {
      const expectedVal = 123;
      const funcStub = sinon.stub().returns(expectedVal);
      const store2 = "store2";

      let val = await Cache.withCache(store, key, funcStub);
      expect(funcStub.calledOnce).toBeTruthy;
      expect(val).toEqual(expectedVal);

      val = await Cache.withCache(store2, key, funcStub);
      expect(funcStub.calledTwice).toBeTruthy;
      expect(val).toEqual(expectedVal);

      // test both cache
      val = await Cache.withCache(store, key, funcStub);
      expect(funcStub.calledTwice).toBeTruthy; // does not increment
      expect(val).toEqual(expectedVal);

      val = await Cache.withCache(store2, key, funcStub);
      expect(funcStub.calledTwice).toBeTruthy; // does not increment
      expect(val).toEqual(expectedVal);
    });
  });

  test.describe("with cacheExceptions", () => {
    test("caches exceptions", async () => {
      const expectedError = new Error("Some error");
      const funcStub = sinon.stub().throws(expectedError);

      let actualError = null;
      try {
        await Cache.withCache(store, key, funcStub, true);
      } catch (e) {
        actualError = e;
      }

      expect(funcStub.calledOnce).toBeTruthy;
      expect(actualError).toEqual(expectedError);

      try {
        await Cache.withCache(store, key, funcStub, true);
      } catch (e) {
        actualError = e;
      }

      expect(funcStub.calledOnce).toBeTruthy;
      expect(actualError).toEqual(expectedError);
    });
  });

  test.describe("with expired cache", () => {
    const originalCacheTimeout = Cache.timeout;

    test.beforeAll(() => {
      Cache.timeout = 7; // 7ms
    });

    test.afterAll(() => {
      Cache.timeout = originalCacheTimeout;
    });

    test("calls func again and caches it", async () => {
      const expectedVal = 123;
      const funcStub = sinon.stub().returns(expectedVal);

      let val = await Cache.withCache(store, key, funcStub);
      expect(funcStub.calledOnce).toBeTruthy;
      expect(val).toEqual(expectedVal);

      // wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      // create a test entry that should not get deleted
      Cache.cache.random_store = {};
      Cache.cache.random_store.some_new_key = {
        val: 1,
        time: Date.now(),
        success: true,
      };

      // test expired cache
      val = await Cache.withCache(store, key, funcStub);
      expect(funcStub.calledTwice).toBeTruthy;
      expect(val).toEqual(expectedVal);

      // Not deleted
      expect(Cache.cache.random_store.some_new_key).toBeOK;
    });

    test("invalidates all expired keys on any call", async () => {
      const expectedVal = 123;
      const funcStub = sinon.stub().returns(expectedVal);
      const key2 = "key2";
      const store2 = "store2";

      await Cache.withCache(store, key, funcStub);
      await Cache.withCache(store, key2, funcStub);
      await Cache.withCache(store2, key, funcStub);

      // wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      // test expired cache
      await Cache.withCache(store, key, funcStub);
      expect(funcStub.callCount).toEqual(4);

      // check internal to avoid calling via withCache
      expect(Cache.cache[store2][key]).toBeUndefined;
      expect(Cache.cache[store2][key2]).toBeUndefined;
    });
  });
});
