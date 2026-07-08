'use strict';

// Unit 7 — optional in-package drop-in config (D8) + the CENTRAL throw-policy / footgun-rejection
// point (KD4/KD14).
//
// "One config line" stays the playwright.config registration; THIS file is an optional escape
// hatch. Zero-config works WITHOUT a file — the file only overrides defaults.
//
// Fields (drop-in only — NOT sync):
//   • gate:    'informational' (default) | 'fail-on-changes'   (Unit 5)
//   • compat:  boolean — preserve native throw semantics (Unit 6 / D6)
//   • fallback: boolean (default true) — native fallback when Percy is disabled at run start (D7)
//   • alwaysPass: boolean (default true) — the D6 async always-pass posture
//   • passIfApproved: boolean — gate carve-out
//
// SYNC IS NOT A DROP-IN FIELD. It is read from the GLOBAL `.percy.yml snapshot.sync` via the
// healthcheck `percy.config` (utils.percy.config.snapshot.sync), populated by isPercyEnabled().
//
// THREE-WAY MUTUAL EXCLUSION (resolved here): sync ⊕ always-pass ⊕ compat. Each changes the throw
// decision differently, so at most ONE may be active. validateConfig() rejects any pair.
const fs = require('fs');
const path = require('path');
const utils = require('@percy/sdk-utils');
const { preflightTokenScope } = require('./sync');
const { sanitizePath } = require('./paths');

const log = utils.logger('playwright-dropin');

const CONFIG_FILENAMES = ['.percy-playwright-dropin.js', '.percy-playwright-dropin.json', 'percy-playwright-dropin.config.js'];

const DEFAULTS = Object.freeze({
  gate: 'informational',
  compat: false,
  fallback: true,
  alwaysPass: true,
  passIfApproved: false
});

// Cache the loaded config for the process (re-read only via _reset in tests).
let _cache = null;

// Read the in-package config file from `rootDir` if present. Returns {} when absent.
function readConfigFile(rootDir) {
  const base = sanitizePath(rootDir);
  for (const name of CONFIG_FILENAMES) {
    const file = path.join(base, name);
    if (!fs.existsSync(file)) continue;
    try {
      if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
      return require(file);
    } catch (err) {
      throw new Error(`Percy drop-in: failed to load config file ${name} — ${err.message}`);
    }
  }
  return {};
}

// Read the GLOBAL sync flag from the healthcheck percy.config (populated by isPercyEnabled()).
function readSyncFromHealthcheck() {
  return Boolean(utils.percy && utils.percy.config && utils.percy.config.snapshot && utils.percy.config.snapshot.sync);
}

// Detect a deferred/skip/delay upload setting in the global percy.config — sync silently no-ops
// under any of these (percy.js syncMode()), so we must REJECT the combination (R-sync-silentdisable).
function deferredUploadSet() {
  const p = (utils.percy && utils.percy.config && utils.percy.config.percy) || {};
  return Boolean(p.deferUploads || p.delayUploads || p.skipUploads);
}

// Merge file overrides onto defaults + the (healthcheck-sourced) sync flag. SYNCHRONOUS — callable
// from inside the matcher (isPercyEnabled() has already run by then, so percy.config is cached).
// Footgun validation is async (token preflight) and lives in validateConfig().
function loadConfig({ rootDir = process.cwd(), force = false } = {}) {
  if (_cache && !force) return _cache;

  const file = readConfigFile(rootDir);
  const merged = { ...DEFAULTS };
  const explicit = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (file[key] !== undefined) { merged[key] = file[key]; explicit[key] = true; }
  }
  // Track which throw-mode fields the user set explicitly (vs the default). Used by validateConfig
  // to distinguish a deliberate conflict from the implicit always-pass default.
  merged._explicit = explicit;

  // sync comes from the global .percy.yml (never the file). When sync is on, the always-pass posture
  // is implicitly off (sync owns the throw decision) — but we DON'T silently flip the user's
  // explicit always-pass; validateConfig() rejects the conflicting pair instead.
  merged.sync = readSyncFromHealthcheck();

  _cache = merged;
  return _cache;
}

// Async footgun validation + pre-flight checks. Call once at run start (index.js resolveRunMode /
// globalSetup). Throws a clear error on a rejected combination so the user fixes their config rather
// than silently getting the wrong behaviour. Returns the validated config.
async function validateConfig(config = loadConfig(), { token = process.env.PERCY_TOKEN, probe } = {}) {
  // Determine which throw-modes are active. always-pass is the DEFAULT posture; sync (global) and
  // compat (file) are deliberate overrides that implicitly supersede the default always-pass.
  // A conflict is rejected when MORE THAN ONE mode is deliberately chosen — i.e. sync+compat, or an
  // EXPLICIT alwaysPass:true alongside sync/compat. The implicit default never conflicts (otherwise
  // turning on snapshot.sync would always require also editing the drop-in config).
  const explicit = (config._explicit) || {};
  const deliberate = [];
  if (config.sync) deliberate.push('sync (.percy.yml snapshot.sync)');
  if (config.compat) deliberate.push('compat-mode');
  if (config.alwaysPass && explicit.alwaysPass) deliberate.push('always-pass (explicit)');

  // THREE-WAY MUTUAL EXCLUSION: at most one throw-mode may be deliberately active.
  if (deliberate.length > 1) {
    throw new Error(
      `Percy drop-in: ${deliberate.join(' + ')} are mutually exclusive — pick one. ` +
      'always-pass (default), compat-mode, and sync (.percy.yml snapshot.sync) each define a ' +
      'different throw policy. To use sync or compat, do not also set alwaysPass:true.'
    );
  }

  // Normalise: a deliberate sync/compat override turns off the implicit always-pass so downstream
  // (index.js) doesn't run both the sync/compat path AND the always-pass return.
  if ((config.sync || config.compat) && !explicit.alwaysPass) config.alwaysPass = false;

  if (config.sync) {
    // sync + any deferred/skip/delay upload → rejected (else syncMode() silently no-ops sync).
    if (deferredUploadSet()) {
      throw new Error(
        'Percy drop-in: sync mode is incompatible with deferred/skip/delayed uploads — the CLI ' +
        'silently disables sync under those settings. Remove deferUploads/delayUploads/skipUploads ' +
        'or remove snapshot.sync from .percy.yml.'
      );
    }

    // Pre-flight token-scope check: refuse to enable sync on a write-only token (don't wait for the
    // first 403, which would bucket every assertion as no-verdict AND break the Gate-A backstop).
    const scope = await preflightTokenScope({ token, probe });
    if (!scope.ok) {
      throw new Error(
        'Percy: sync mode is disabled — it needs a read-capable token, but the configured token ' +
        `is write-only (${scope.reason}). Use a full/read token, or remove snapshot.sync. ` +
        'See https://percy.io/docs for token scopes.'
      );
    }

    // Blast-radius warning (a full token leak is org-wide — plan §User-Facing States).
    log.warn('Percy: sync mode is using a full-access token. If it leaks from CI it grants ' +
      'org-wide read/approve/delete across all projects. Prefer a dedicated read-only service ' +
      'account; never log it.');
  }

  return config;
}

// Runtime assertion that sync actually engaged (don't silently degrade). Call after the first
// comparison post in sync mode: if the CLI disabled sync (deferred uploads slipped in at runtime),
// surface it loudly rather than producing false-greens.
function assertSyncEngaged(config = loadConfig()) {
  if (!config.sync) return true;
  if (deferredUploadSet()) {
    log.error('Percy: sync mode did NOT engage — a deferred/skip/delayed upload setting disabled ' +
      'it at runtime. Inline verdicts are unavailable; rely on the post-run gate.');
    return false;
  }
  return true;
}

// Capture-flow dispatch — the override delegates to the SDK flow that matches the Percy PROJECT
// TYPE (the CLI healthcheck's `percy.type`, derived from the token). No user config involved:
//   • 'web' (and legacy/unknown tokens) → 'snapshot'  — percySnapshot's serialized-DOM flow,
//     rendered server-side by Percy.
//   • 'automate'                        → 'automate'  — percyScreenshot (Percy on Automate).
//   • 'app' / 'generic' (anything else) → 'screenshot' — raw-PNG upload through the comparison
//     ingest (the only screenshot path those projects accept; percyScreenshot is Automate-only).
function captureFlowFor(type = utils.percy && utils.percy.type) {
  if (type === 'automate') return 'automate';
  if (type == null || type === 'web') return 'snapshot';
  return 'screenshot';
}

// Status line (plan §User-Facing States "Mode status line").
function modeStatusLine(config = loadConfig()) {
  let mode = 'async-always-pass';
  if (config.sync) mode = 'sync';
  else if (config.compat) mode = 'compat';
  const gate = config.sync ? 'fail-on-changes' : config.gate;
  const type = (utils.percy && utils.percy.type) || 'web';
  return `Percy drop-in: mode=${mode} | capture=${captureFlowFor(type)} (auto: ${type} project) | gate=${gate}`;
}

function _reset() { _cache = null; }

module.exports = {
  loadConfig,
  validateConfig,
  assertSyncEngaged,
  modeStatusLine,
  captureFlowFor,
  readConfigFile,
  deferredUploadSet,
  DEFAULTS,
  CONFIG_FILENAMES,
  _reset
};
