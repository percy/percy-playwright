'use strict';

// Unit 5 — the opt-in gate reporter (R5/KD7).
//
// A Playwright reporter whose `onEnd` waits for the Percy build to finish and decides CI pass/fail:
//   • Default = INFORMATIONAL (green + the Percy build link) — Percy never reds CI unless opted in.
//   • Opt-in gate (config.gate === 'fail-on-changes') → reuse `build:wait --fail-on-changes`
//     semantics (cli/packages/cli-build/src/wait.js `isFailing`): red when a FINISHED build has
//     diffs, unless the build is approved (pass-if-approved).
//   • KD7 — the FIRST build is REVIEW-ONLY: build #1 has no base build (its repo-PNG-base-vs-head
//     diffs are baseline-establishment noise, not regressions) → surface, NEVER hard-fail.
//   • Attribution: list changed comparisons (test title + snapshot + browser/width) so a red build
//     is traceable to the exact assertions.
//
// This is ALSO the mandatory Gate-A backstop for sync mode (Unit 5b/KD14): it catches the
// no-verdict population (their diffs still land in build-level total-comparisons-diff). So when sync
// is on we keep the gate active even if the consumer left it informational — see resolveGateMode.
const utils = require('@percy/sdk-utils');

const log = utils.logger('playwright-dropin');

const TRUNCATE_AT = 20;

// Lazily load the ESM @percy/client (the drop-in is CommonJS).
async function loadClient() {
  const mod = await import('@percy/client');
  return mod.default || mod.PercyClient;
}

// `build:wait` failing semantics (mirror of cli/packages/cli-build/src/wait.js `isFailing`), with
// the KD7 first-build carve-out folded in. `attrs` is the build's JSONAPI attributes.
function isFailing(attrs = {}, { failOnChanges, passIfApproved, isFirstBuild } = {}) {
  const state = attrs.state;
  const diffs = attrs['total-comparisons-diff'];
  const reviewState = attrs['review-state'];

  // KD7: the first build is review-only — never hard-fail on its (noise-dominated) diffs.
  if (isFirstBuild) return false;

  return state != null && state !== 'pending' && state !== 'processing' &&
    (state !== 'finished' || (failOnChanges && !!diffs && !(passIfApproved && reviewState === 'approved')));
}

// First-build detection: a build with no resolved base build is build #1 for its lineage (its
// diffs are baseline-establishment noise — KD7). We treat a missing `base-build` relationship OR
// build-number 1 as first-build; either signal is sufficient.
function isFirstBuildResponse(buildResponse) {
  const data = buildResponse && buildResponse.data;
  if (!data) return false;
  const baseRel = data.relationships && data.relationships['base-build'];
  const hasBase = Boolean(baseRel && baseRel.data);
  const number = data.attributes && data.attributes['build-number'];
  return !hasBase || number === 1;
}

// Format the attribution list (plan §User-Facing States "Gate attribution list"). `changed` is a
// list of { title, snapshot, browserFamily, width, url, reason? } already mapped from comparisons.
function formatAttribution(changed, { webUrl } = {}) {
  if (!changed.length) {
    return [`Percy: no visual changes — ${webUrl || ''}`.trim()];
  }
  const lines = [`Percy: ${changed.length} visual change${changed.length === 1 ? '' : 's'} need review`];
  const shown = changed.slice(0, TRUNCATE_AT);
  for (const c of shown) {
    const id = [c.title || c.snapshot, c.browserFamily, c.width && `${c.width}px`].filter(Boolean).join(' · ');
    const reason = c.reason ? ` (${c.reason})` : '';
    lines.push(`  • ${id}${reason}${c.url ? ` — ${c.url}` : ''}`);
  }
  if (changed.length > TRUNCATE_AT) {
    lines.push(`  • …and ${changed.length - TRUNCATE_AT} more`);
  }
  return lines;
}

// Map a build's changed comparisons to attribution rows. The comparison's snapshot name carries the
// test-title path the override derived (identity.js: titlePath joined with " > "); browser/width
// come from the comparison tag. `comparisons` is a JSONAPI list (data + included tags).
function mapChangedComparisons(comparisons = []) {
  return comparisons
    .filter(c => {
      const a = c.attributes || {};
      // A diff: any non-equal/unreviewed-with-diff comparison. The API marks diffs via
      // `diff-ratio` > 0 or a `state`/`review-state` change; we treat a positive diff-ratio as the
      // signal (screenshot/BYOS comparisons always carry it when they differ).
      return Number(a['diff-ratio']) > 0;
    })
    .map(c => {
      const a = c.attributes || {};
      const tag = a.tag || {};
      return {
        title: a['snapshot-name'] || a.name,
        snapshot: a['snapshot-name'] || a.name,
        browserFamily: tag.name || tag['browser-name'],
        width: tag.width,
        url: a['web-url'] || a.url
      };
    });
}

// The reporter class. Playwright instantiates `new Reporter(options)` from the `reporter` config
// entry; we accept injectable deps for unit testing.
class PercyGateReporter {
  // `deps` (test-only): { client, buildId, config, exit }.
  constructor(options = {}, deps = {}) {
    this._options = options || {};
    this._deps = deps || {};
  }

  // Resolve the gate mode. Default informational; opt-in via reporter option or config; sync mode
  // forces the gate ON as its mandatory backstop (KD14) — sync-without-gate would false-green the
  // no-verdict population.
  _gateMode(config) {
    if (config && config.sync) return 'fail-on-changes';
    const opt = this._options.gate || (config && config.gate);
    return opt === 'fail-on-changes' ? 'fail-on-changes' : 'informational';
  }

  // Resolve the build id: explicit dep (tests) → PERCY_BUILD_ID (set by `percy exec`) → healthcheck.
  _resolveBuildId() {
    if (this._deps.buildId) return this._deps.buildId;
    if (process.env.PERCY_BUILD_ID) return process.env.PERCY_BUILD_ID;
    return utils.percy && utils.percy.build && utils.percy.build.id;
  }

  async onEnd() {
    try {
      const config = this._deps.config || require('./config').loadConfig();
      const enabled = await utils.isPercyEnabled().catch(() => false);
      if (!enabled) {
        // Native fallback was active (Unit 6) — a green CI here is NOT "Percy passed".
        log.info('Percy: gate skipped — Percy not active for this run');
        return;
      }

      const buildId = this._resolveBuildId();
      if (!buildId) {
        log.info('Percy: gate skipped — no Percy build id found for this run');
        return;
      }

      const gateMode = this._gateMode(config);
      const failOnChanges = gateMode === 'fail-on-changes';
      const passIfApproved = Boolean(this._options.passIfApproved ?? (config && config.passIfApproved));

      const PercyClient = this._deps.client ? null : await loadClient();
      const client = this._deps.client || new PercyClient({ token: process.env.PERCY_TOKEN });

      // Wait for the build to reach a terminal state (reuse the client's waitForBuild poller).
      const buildResponse = await client.waitForBuild({ build: String(buildId) });
      const attrs = (buildResponse && buildResponse.data && buildResponse.data.attributes) || {};
      const webUrl = attrs['web-url'];
      const isFirstBuild = isFirstBuildResponse(buildResponse);

      // Attribution: fetch + map changed comparisons (best-effort — never block the verdict on it).
      let changed = [];
      try {
        const comparisons = await this._fetchChangedComparisons(client, buildId);
        changed = mapChangedComparisons(comparisons).map(c => ({ ...c, url: c.url || webUrl }));
      } catch (err) {
        log.debug(`Percy: could not fetch comparison attribution — ${err.message}`);
      }

      for (const line of formatAttribution(changed, { webUrl })) log.info(line);

      if (isFirstBuild) {
        log.info('Percy: first build — diffs compare your committed baselines against this CI run ' +
          'and may reflect environment differences, not regressions. Reviewing them sets your baseline.');
      }

      const failing = isFailing(attrs, { failOnChanges, passIfApproved, isFirstBuild });
      if (failing) {
        log.error(`Percy: visual changes detected — failing CI. ${webUrl || ''}`.trim());
        this._fail();
      } else if (!failOnChanges) {
        log.info(`Percy: informational — review your build at ${webUrl || ''}`.trim());
      }
    } catch (err) {
      // D3: a Percy/gate error must never red the suite by accident. A gate that can't reach Percy
      // stays green (the user's tests already passed/failed on their own merits).
      log.debug(`Percy: gate skipped — ${err.message}`);
    }
  }

  // Fetch the build's comparisons for attribution. Tries the client's comparison-list accessor;
  // returns [] if the client/version doesn't expose one (attribution is best-effort).
  async _fetchChangedComparisons(client, buildId) {
    if (typeof client.getComparisons === 'function') {
      const res = await client.getComparisons(buildId);
      return (res && res.data) || [];
    }
    return [];
  }

  // Set the failing exit status. Playwright's reporter contract honours a non-zero process.exitCode
  // (or an exit-status return); we set process.exitCode so the CI run reds.
  _fail() {
    if (this._deps.exit) return this._deps.exit(1);
    process.exitCode = 1;
  }
}

module.exports = PercyGateReporter;
module.exports.PercyGateReporter = PercyGateReporter;
module.exports.isFailing = isFailing;
module.exports.isFirstBuildResponse = isFirstBuildResponse;
module.exports.formatAttribution = formatAttribution;
module.exports.mapChangedComparisons = mapChangedComparisons;
