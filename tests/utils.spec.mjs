import sinon from "sinon";
import { test, expect } from "@playwright/test";
import { Utils } from "../utils.js";
import utils from "@percy/sdk-utils";

test.describe("Utils", () => {
  test.afterEach(() => {
    sinon.restore();
  })
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
      const data = {abc: true};
      const spy = sinon.spy(utils.captureAutomateScreenshot);
      Utils.captureAutomateScreenshot(data);
      expect(spy.calledOnceWithExactly(data)).toBeTruthy;
    });
  });
});
