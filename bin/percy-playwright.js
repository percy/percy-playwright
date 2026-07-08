#!/usr/bin/env node
'use strict';

// percy-playwright — zero-config head-build tagging wrapper.
//
// The head build is tagged via the PERCY_BUILD_SOURCE env var, which @percy/cli reads when it
// CREATES the build at `percy exec` startup — in the PARENT process, before any test runs. The SDK
// (which runs inside the test process) can't set it after the fact. This thin wrapper closes that
// gap: it sets PERCY_BUILD_SOURCE for you (when unset) and then execs `percy` with your args, so
// `npx percy-playwright exec -- npx playwright test` needs no manual env var.
//
// It is intentionally minimal — it only injects the env var and delegates everything else to the
// real `percy` binary (stdio inherited, exit code forwarded).
// NOTE: reference child_process as a module object (not a destructured `spawn`) so the spawn call
// site stays stubbable from tests (destructuring would bind the reference at import time).
const childProcess = require('child_process');
const path = require('path');
const fs = require('fs');

const BUILD_SOURCE = 'playwright-dropin';

// Resolve the `percy` executable from the locally-installed @percy/cli when possible (the version
// this drop-in was tested against), else fall back to PATH so a globally-installed `percy` works.
function resolvePercyBin() {
  try {
    // @percy/cli ships an `exports` map that does NOT expose ./package.json, so we resolve its main
    // entry and walk up to the package root (the dir containing package.json).
    const mainEntry = require.resolve('@percy/cli');
    let dir = path.dirname(mainEntry);
    while (dir !== path.dirname(dir)) {
      const pkgFile = path.join(dir, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg.name === '@percy/cli') {
          const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.percy;
          if (binRel) return path.resolve(dir, binRel);
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // @percy/cli not resolvable from here — fall back to PATH.
  }
  return 'percy';
}

function main(argv = process.argv.slice(2)) {
  // Zero-config tagging: only set PERCY_BUILD_SOURCE when the user hasn't already chosen a value.
  const env = { ...process.env };
  if (!env.PERCY_BUILD_SOURCE) env.PERCY_BUILD_SOURCE = BUILD_SOURCE;
  // First-build-as-baseline candidate flag: rides createBuild via @percy/client; the SERVER
  // decides first-ness (a no-op on established projects), so it is always safe to send.
  if (!env.PERCY_DROPIN_BASELINE_CANDIDATE) env.PERCY_DROPIN_BASELINE_CANDIDATE = 'true';

  const percyBin = resolvePercyBin();
  // When percyBin is a resolved .cjs/.js path, run it through the current node. When it's the bare
  // "percy" PATH fallback, spawn it directly (shell PATH resolution).
  const isScript = percyBin !== 'percy';
  const command = isScript ? process.execPath : percyBin;
  const args = isScript ? [percyBin, ...argv] : argv;

  const child = childProcess.spawn(command, args, { stdio: 'inherit', env });

  child.on('error', (err) => {
    if (err && err.code === 'ENOENT') {
      process.stderr.write(
        'percy-playwright: could not find the `percy` executable. Install @percy/cli ' +
        '(npm i -D @percy/cli) or ensure `percy` is on your PATH.\n'
      );
    } else {
      process.stderr.write(`percy-playwright: failed to launch percy — ${err && err.message}\n`);
    }
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise the signal so the parent's exit status reflects it (CI signal handling).
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code == null ? 1 : code);
  });

  return child;
}

module.exports = { main, resolvePercyBin, BUILD_SOURCE };

// Run when invoked as a CLI (not when required by the unit test).
if (require.main === module) main();
