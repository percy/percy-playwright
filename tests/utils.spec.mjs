import sinon from "sinon";
import { test, expect } from "@playwright/test";
import { Utils } from "../utils.js";
import utils from "@percy/sdk-utils";
import { Cache } from "../cache.js";

test.describe("Utils", () => {
  test.afterEach(() => {
    sinon.restore();
  });
  test.describe("projectType", () => {
    test("should return the project type", () => {
      const type = "automate";
      sinon.stub(utils.percy, "type").value(type);

      const result = Utils.projectType();

      expect(result).toEqual(type);
    });

    test("should return undefined if project type is not available", () => {
      sinon.stub(utils.percy, "type").value(undefined);

      const result = Utils.projectType();

      expect(result).toBeUndefined;
    });
  });

  test.describe("captureAutomateScreenshot", () => {
    test("should capture an automated screenshot", async () => {
      const data = { abc: true };
      const spy = sinon.spy(utils.captureAutomateScreenshot);
      try {
        await Utils.captureAutomateScreenshot(data);
      } catch (err) {}
      expect(spy.calledOnceWithExactly(data)).toBeTruthy;
    });
  });

  test.describe("getSessionId", () => {
    let page;

    test.beforeEach(() => {
      page = {
        _parent: {
          _parent: {
            _guid: "browserId",
          },
        },
        evaluate: sinon.stub(),
      };
      Cache.cache[Cache.sessionId] = {};
    });

    test.afterEach(() => {
      sinon.restore();
      Cache.reset();
    });

    test("should return sessionId from cache if available", async () => {
      const sessionId = "fakeSessionId";
      Cache.cache[Cache.sessionId]["browserId"] = {
        success: true,
        val: "fakeSessionId",
      };

      const result = await Utils.getSessionId(page);

      expect(result).toEqual(sessionId);
    });

    test("should evaluate page to get sessionId if not in cache", async () => {
      const hashedId = "fakeSessionId";
      page.evaluate.resolves(JSON.stringify({ hashed_id: hashedId }));

      const result = await Utils.getSessionId(page);

      expect(result).toEqual({ hashed_id: hashedId });
    });

    test("should throw error if page evaluation fails", async () => {
      const error = new Error("Evaluation error");
      page.evaluate.rejects(error);

      try {
        await Utils.getSessionId(page);
        // The above line should throw an error, so we should not reach this point.
        expect.fail("Expected an error to be thrown");
      } catch (e) {
        expect(e).toEqual(error);
      }
    });
  });
});
