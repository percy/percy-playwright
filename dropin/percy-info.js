'use strict';

// Small accessors over the sdk-utils healthcheck state (`utils.percy`) so the null-chains and
// the baseline-source literal live in ONE place instead of being repeated across modules.
const utils = require('@percy/sdk-utils');

const BASELINE_SOURCE = 'playwright-dropin-baseline';

function percyBuild() {
  return (utils.percy && utils.percy.build) || null;
}

function percyProjectType() {
  return (utils.percy && utils.percy.type) || 'web';
}

// Whether THIS run's build is the seeded drop-in baseline (source set server-side and surfaced
// through the healthcheck build info) — its diffs are baseline-establishment noise (KD7).
function isBaselineBuildRun() {
  const build = percyBuild();
  return Boolean(build && build.source === BASELINE_SOURCE);
}

module.exports = { percyBuild, percyProjectType, isBaselineBuildRun, BASELINE_SOURCE };
