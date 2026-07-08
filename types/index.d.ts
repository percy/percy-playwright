import * as Playwright from 'playwright';
import { SnapshotOptions } from '@percy/core';

export default function percySnapshot(
  page: Playwright.Page,
  name: string,
  options?: SnapshotOptions
): Promise<void>;

export default function percyScreenshot(
  page: Playwright.Page,
  name: string,
  options?: SnapshotOptions
): Promise<void>;

// --- toHaveScreenshot drop-in (require('@percy/playwright/dropin')) ---------------------------
// Requiring the dropin entry registers a global override of Playwright's `toHaveScreenshot()`
// matcher (no new matcher signature; the existing one is intercepted). Capture is selected by the
// drop-in config `captureMode`: 'screenshot' (default — raw-PNG upload, generic/app projects) or
// 'snapshot' (serialized-DOM web snapshot via this package's own captureDOM, web projects).

// First-build baseline hook. Point `playwright.config` `globalSetup` at
// `@percy/playwright/dropin/global-setup`, or call this from your own globalSetup. Never throws.
export function baselineGlobalSetup(config?: unknown): Promise<unknown>;

// Opt-in CI gate reporter: reporter: [['@percy/playwright/dropin/reporter']].
export class PercyGateReporter {
  constructor(options?: { gate?: 'informational' | 'fail-on-changes'; passIfApproved?: boolean }, deps?: unknown);
  onEnd(): Promise<void>;
}
