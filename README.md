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
- `options` - [See per-snapshot configuration options](https://docs.percy.io/docs/cli-configuration#per-snapshot-configuration)

## Upgrading

### Automatically with `@percy/migrate`

We built a tool to help automate migrating to the new CLI toolchain! Migrating
can be done by running the following commands and following the prompts:

``` shell
$ npx @percy/migrate
? Are you currently using @percy/playwright? Yes
? Install @percy/cli (required to run percy)? Yes
? Migrate Percy config file? Yes
? Upgrade SDK to @percy/playwright@2.0.0? Yes
```

This will automatically run the changes described below for you.

### Manually

#### Import change

In `v1.x` there wasn't a default export of the package (only a named
export). With `v2.x` the named export is removed and there is only a default
export.

``` javascript
// old
import { percySnapshot } from '@percy/playwright';
const { percySnapshot } = require('@percy/playwright');

// new
import percySnapshot from '@percy/playwright';
const percySnapshot = require('@percy/playwright');
```

#### Migrating Config

If you have a previous Percy configuration file, migrate it to the newest version with the
[`config:migrate`](https://github.com/percy/cli/tree/master/packages/cli-config#percy-configmigrate-filepath-output) command:

```sh-session
$ percy config:migrate
```
