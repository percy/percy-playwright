'use strict';

// Shared client/environment-info strings sent on every Percy post (clientInfo /
// environmentInfo). Computed once and reused across the drop-in modules so they don't each
// recompute the identical pkg-name/version + playwright-version lookup.
const pkg = require('../package.json');

// `@percy/playwright/<version>` — identifies this SDK to Percy. Drop-in traffic is additionally
// attributed via the build source tag (`playwright-dropin`), not a separate client string.
const CLIENT_INFO = `${pkg.name}/${pkg.version}`;

// `playwright/<version>` — best-effort; degrades to a bare label if @playwright/test isn't present.
const ENV_INFO = (() => {
  try { return `playwright/${require('@playwright/test/package.json').version}`; } catch { return 'playwright'; }
})();

module.exports = { CLIENT_INFO, ENV_INFO };
