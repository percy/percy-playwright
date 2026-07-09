'use strict';

// KD4 (spike-decided): full-override capture — own the screenshot, return a pure PNG buffer with
// NO assertion side-effects. Capture options mirror Playwright's toHaveScreenshot defaults so the
// bytes match how repo baselines were generated (D2 — keeps first-build noise low).
const PASS_THROUGH_OPTS = ['clip', 'fullPage', 'mask', 'maskColor', 'omitBackground', 'scale', 'animations', 'caret', 'style', 'stylePath'];

async function captureFullOverride(pageOrLocator, options = {}) {
  const target = pageOrLocator && typeof pageOrLocator.screenshot === 'function'
    ? pageOrLocator // Page or Locator both expose screenshot()
    : pageOrLocator.page();

  const shotOpts = { animations: 'disabled', caret: 'hide', scale: 'css' };
  for (const k of PASS_THROUGH_OPTS) {
    if (options && options[k] !== undefined) shotOpts[k] = options[k];
  }
  return target.screenshot(shotOpts);
}

module.exports = { captureFullOverride };
