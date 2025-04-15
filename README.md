# @percy/playwright
[![Version](https://img.shields.io/npm/v/@percy/playwright.svg)](https://npmjs.org/package/@percy/playwright)
![Test](https://github.com/percy/percy-playwright/workflows/Test/badge.svg)

[Percy](https://percy.io) visual testing for Playwright.

## Installation

```sh-session
$ npm install --save-dev @percy/cli @percy/playwright
```

## Usage

This is an example using the `percySnapshot` function. For other examples of `playwright`
usage, see the [Playwright docs](https://playwright.dev/docs/library).

```javascript
const { chromium } = require('playwright');
const percySnapshot = require('@percy/playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://example.com/', { waitUntil: 'networkidle2' });
  await percySnapshot(page, 'Example Site');

  await browser.close();
})();
```

Running the code above directly will result in the following logs:

```sh-session
$ node script.js
[percy] Percy is not running, disabling snapshots
```

When running with [`percy
exec`](https://github.com/percy/cli/tree/master/packages/cli-exec#percy-exec), and your project's
`PERCY_TOKEN`, a new Percy build will be created and snapshots will be uploaded to your project.

```sh-session
$ export PERCY_TOKEN=[your-project-token]
$ percy exec -- node script.js
[percy] Percy has started!
[percy] Created build #1: https://percy.io/[your-project]
[percy] Running "node script.js"
[percy] Snapshot taken "Example Site"
[percy] Stopping percy...
[percy] Finalized build #1: https://percy.io/[your-project]
[percy] Done!
```

## Configuration

`percySnapshot(page, name[, options])`

- `page` (**required**) - A `playwright` page instance
- `name` (**required**) - The snapshot name; must be unique to each snapshot
- `options` - [See per-snapshot configuration options](https://www.browserstack.com/docs/percy/take-percy-snapshots/overview#per-snapshot-configuration)


## Percy on Automate

## Usage

```javascript
const { chromium } = require('playwright');
const percyScreenshot = require('@percy/playwright');

const desired_cap = {
  'browser': 'chrome',
  'browser_version': 'latest',
  'os': 'osx',
  'os_version': 'ventura',
  'name': 'Percy Playwright PoA Demo',
  'build': 'percy-playwright-javascript-tutorial',
  'browserstack.username': 'username',
  'browserstack.accessKey': 'accesskey'
};

(async () => {
  const cdpUrl = `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(desired_cap))}`;
  const browser = await chromium.connect(cdpUrl);
  const page = await browser.newPage();
  await page.goto("https://percy.io/");
  await percyScreenshot(page, 'Screenshot 1');

  // Options for percyScreenshot
  // await percyScreenshot(page, 'Screenshot 1', {
  //   fullPage: true,
  //   percyCSS: 'body { background: red; }',
  //   ignoreRegionSelectors: ['#ignore-this'],
  //   customIgnoreRegions: [{ top: 10, right: 10, bottom: 120, left: 10 }],
  // });

  await browser.close();
})();
```

## Configuration

`percyScreenshot(page, name[, options])`

- `page` (**required**) - A `playwright` page instance
- `name` (**required**) - The snapshot name; must be unique to each snapshot
- `options` (**optional**) - There are various options supported by percyScreenshot to server further functionality.
    - `sync` - Boolean value by default it falls back to `false`, Gives the processed result around screenshot [From CLI v1.28.8+]
    - `fullPage` - Boolean value by default it falls back to `false`, Takes full page screenshot [From CLI v1.27.6+]
    - `freezeAnimatedImage` - Boolean value by default it falls back to `false`, you can pass `true` and percy will freeze image based animations.
    - `freezeImageBySelectors` - List of selectors. Images will be freezed which are passed using selectors. For this to work `freezeAnimatedImage` must be set to true.
    - `freezeImageByXpaths` - List of xpaths. Images will be freezed which are passed using xpaths. For this to work `freezeAnimatedImage` must be set to true.
    - `percyCSS` - Custom CSS to be added to DOM before the screenshot being taken. Note: This gets removed once the screenshot is taken.
    - `ignoreRegionXpaths` - List of xpaths. elements in the DOM can be ignored using xpath
    - `ignoreRegionSelectors` - List of selectors. elements in the DOM can be ignored using selectors.
    - `customIgnoreRegions` - List of custom objects. elements can be ignored using custom boundaries. Just passing a simple object for it like below.
      - example: ```{top: 10, right: 10, bottom: 120, left: 10}```
      - In above example it will draw rectangle of ignore region as per given coordinates.
        - `top` (int): Top coordinate of the ignore region.
        - `bottom` (int): Bottom coordinate of the ignore region.
        - `left` (int): Left coordinate of the ignore region.
        - `right` (int): Right coordinate of the ignore region.
    - `considerRegionXpaths` - List of xpaths. elements in the DOM can be considered for diffing and will be ignored by Intelli Ignore using xpaths.
    - `considerRegionSelectors` - List of selectors. elements in the DOM can be considered for diffing and will be ignored by Intelli Ignore using selectors.
    - `customConsiderRegions` - List of custom objects. elements can be considered for diffing and will be ignored by Intelli Ignore using custom boundaries
      - example:  ```{top: 10, right: 10, bottom: 120, left: 10}```
      - In above example it will draw rectangle of consider region will be drawn.
      - Parameters:
        - `top` (int): Top coordinate of the consider region.
        - `bottom` (int): Bottom coordinate of the consider region.
        - `left` (int): Left coordinate of the consider region.
        - `right` (int): Right coordinate of the consider region.
    - `regions` parameter that allows users to apply snapshot options to specific areas of the page. This parameter is an array where each object defines a custom region with configurations.
      - Parameters:
        - `elementSelector` (optional, only one of the following must be provided, if this is not provided then full page will be considered as region)
            - `boundingBox` (object): Defines the coordinates and size of the region.
              - `x` (number): X-coordinate of the region.
              - `y` (number): Y-coordinate of the region.
              - `width` (number): Width of the region.
              - `height` (number): Height of the region.
            - `elementXpath` (string): The XPath selector for the element.
            - `elementCSS` (string): The CSS selector for the element.

        - `algorithm` (mandatory)
            - Specifies the snapshot comparison algorithm.
            - Allowed values: `standard`, `layout`, `ignore`, `intelliignore`.

        - `configuration` (required for `standard` and `intelliignore` algorithms, ignored otherwise)
            - `diffSensitivity` (number): Sensitivity level for detecting differences.
            - `imageIgnoreThreshold` (number): Threshold for ignoring minor image differences.
            - `carouselsEnabled` (boolean): Whether to enable carousel detection.
            - `bannersEnabled` (boolean): Whether to enable banner detection.
            - `adsEnabled` (boolean): Whether to enable ad detection.

         - `assertion` (optional)
            - Defines assertions to apply to the region.
            - `diffIgnoreThreshold` (number): The threshold for ignoring minor differences.

### Example Usage for regions

```
const obj1 = {
  elementSelector: {
    elementCSS: ".ad-banner" 
  },
  algorithm: "intelliignore", 
  configuration: {
    diffSensitivity: 2,
    imageIgnoreThreshold: 0.2,
    carouselsEnabled: true,
    bannersEnabled: true,
    adsEnabled: true
  },
  assertion: {
    diffIgnoreThreshold: 0.4,
  }
};

// we can use the createRegion function

const { createRegion } = percySnapshot;

const obj2 = createRegion({
  algorithm: "intelliignore",
  diffSensitivity: 3,
  adsEnabled: true,
  diffIgnoreThreshold: 0.4
});

percySnapshot(page, "Homepage 1", { regions: [obj1] });
```

### Creating Percy on automate build
Note: Automate Percy Token starts with `auto` keyword. The command can be triggered using `exec` keyword.
```sh-session
$ export PERCY_TOKEN=[your-project-token]
$ percy exec -- [playwright test command]
[percy] Percy has started!
[percy] [Playwright example] : Starting automate screenshot ...
[percy] Screenshot taken "Playwright example"
[percy] Stopping percy...
[percy] Finalized build #1: https://percy.io/[your-project]
[percy] Done!
```

Refer to docs here: [Percy on Automate](https://www.browserstack.com/docs/percy/integrate/functional-and-visual)
