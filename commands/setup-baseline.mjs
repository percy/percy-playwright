// `percy playwright:setup-baseline` — explicitly (re-)establish a Percy project's baseline from
// the Playwright baseline screenshots committed in the repo, WITHOUT running any tests.
//
// Discovered by @percy/cli through this package's `"@percy/cli": { "commands": [...] }` entry
// (the same mechanism @percy/storybook uses), so installing @percy/playwright is all it takes.
// Unlike the automatic first-build seeding `percy exec` performs on an empty project, this
// command works on ESTABLISHED projects too: the build is created with the explicit
// `dropin-baseline-setup` attribute the API accepts as a deliberate, user-triggered re-baseline
// and auto-approves at finalize.
//
// ESM on purpose: @percy/cli-command and @percy/cli-exec are ESM-only; the CLI imports command
// modules with dynamic import, so this file never enters the (CJS) SDK require graph.
import command from '@percy/cli-command';

const BASELINE_SOURCE = 'playwright-dropin-baseline';

export const setupBaseline = command('setup-baseline', {
  description: 'Upload committed Playwright baseline screenshots as the auto-approved Percy baseline (no tests run)',

  examples: [
    '$0'
  ],

  percy: {
    skipDiscovery: true
  }
}, async function * ({ percy, log, exit }) {
  if (!percy) exit(1, 'Percy is disabled');

  // Web projects seed rendered snapshots; app projects seed raw comparison uploads (no render
  // flow — like App Percy). Anything else is a wrong token.
  let projectType = percy.client.tokenType();
  if (projectType !== 'web' && projectType !== 'app') {
    exit(1, 'playwright:setup-baseline requires a Percy web or app project token — ' +
      `the configured token is for a "${projectType}" project.`);
  }

  // The provider owns all Playwright knowledge (config resolution, snapshot discovery, identity
  // mapping); the CLI's exec package owns the upload loop. Nothing is reimplemented here.
  let { default: provider } = await import('../dropin/baseline/provider.js');

  // uploadBaselines ships in the companion @percy/cli release — an older CLI resolves the
  // package but not the export. Fail with guidance, not a bare TypeError.
  let uploadBaselines;
  try {
    ({ uploadBaselines } = await import('@percy/cli-exec'));
  } catch { /* handled below */ }
  if (typeof uploadBaselines !== 'function') {
    exit(1, 'playwright:setup-baseline requires a newer @percy/cli — ' +
      'upgrade with `npm i -D @percy/cli@latest` and retry.');
  }

  let { baselines = [], degraded, reason } =
    (await provider.discoverBaselines({ cwd: process.cwd(), log })) || {};

  if (degraded) {
    exit(1, `Could not map your committed Playwright baselines (${reason}). ` +
      'Custom snapshot path templates and projects without an explicit browser/viewport ' +
      'cannot be mapped automatically.');
  }
  if (!baselines.length) {
    exit(1, 'No committed Playwright baseline screenshots found ' +
      '(looked for Playwright\'s *-snapshots directories).');
  }

  log.info(`Uploading ${baselines.length} committed baseline snapshot(s) as the project baseline...`);

  let res = await percy.client.createBuild({
    projectType,
    source: BASELINE_SOURCE,
    dropinBaselineSetup: true
  });

  let buildId = res.data.id;
  let seeded = await uploadBaselines(percy.client, buildId, baselines, { log, projectType });
  await percy.client.finalizeBuild(buildId);

  if (!seeded) exit(1, 'No baseline snapshots could be uploaded.');

  log.info(`Baseline established from ${seeded}/${baselines.length} snapshot(s) and ` +
    `auto-approved: ${res.data.attributes['web-url']}`);
});

// Topic wrapper so the command surfaces as `percy playwright:setup-baseline`.
export const playwright = command('playwright', {
  description: 'Playwright drop-in utilities',
  commands: [setupBaseline]
});

export default playwright;
