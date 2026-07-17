'use strict';

// Resolve the user's Playwright config OUTSIDE a test run by letting Playwright itself load it:
// spawn `playwright test --list` with the config-capture reporter (config-reporter.js). Handles
// JS/TS/ESM configs uniformly — we never parse config files ourselves. Returns the minimal
// resolved shape discovery needs, or null when it can't be resolved (callers degrade, never
// guess).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

// `--list` only discovers tests; generous cap so a large repo can still compile its config/specs.
const RESOLVE_TIMEOUT_MS = 120_000;

function resolvePlaywrightConfig({ cwd = process.cwd(), log, spawn = childProcess.spawnSync } = {}) {
  const out = path.join(
    os.tmpdir(), `percy-pw-config-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`
  );
  const reporter = require.resolve('./config-reporter.js');

  try {
    // Windows-safe invocation: `npx` is npx.cmd there (plain spawn ENOENTs, and Node >=18.20
    // blocks implicit .cmd resolution). Prefer the project's own Playwright CLI through the
    // current Node binary; fall back to npx only when it isn't resolvable from `cwd`.
    let cmd, args;
    try {
      const cli = require.resolve('@playwright/test/cli', { paths: [cwd] });
      cmd = process.execPath;
      args = [cli, 'test', '--list', `--reporter=${reporter}`];
    } catch {
      cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      args = ['playwright', 'test', '--list', `--reporter=${reporter}`];
    }
    const result = spawn(cmd, args, {
      cwd,
      env: { ...process.env, PERCY_PW_CONFIG_OUT: out },
      encoding: 'utf8',
      timeout: RESOLVE_TIMEOUT_MS
    });

    // The reporter writes the file from `onBegin`, which fires even when discovery later fails —
    // trust the file's presence over the exit code (e.g. `--list` exits non-zero on "no tests").
    if (!fs.existsSync(out)) {
      if (log) {
        log.debug('Percy: could not resolve the Playwright config — ' +
          `playwright test --list ${result.error ? `failed (${result.error.message})` : `exited ${result.status}`}`);
        if (result.stderr) log.debug(String(result.stderr).slice(0, 2000));
      }
      return null;
    }

    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (err) {
    if (log) log.debug(`Percy: could not resolve the Playwright config — ${err.message}`);
    return null;
  } finally {
    try { fs.unlinkSync(out); } catch { /* never created */ }
  }
}

module.exports = { resolvePlaywrightConfig, RESOLVE_TIMEOUT_MS };
