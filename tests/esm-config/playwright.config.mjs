// Fixture for the ESM-config regression in dropin.spec.mjs: the drop-in is imported next to
// @playwright/test from an ES module config.
import '../../dropin/index.js';
import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: '.', testMatch: 'esm-fixture.check.mjs' });
