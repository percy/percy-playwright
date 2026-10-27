import * as Playwright from 'playwright';
import { SnapshotOptions } from '@percy/core';

export default function percySnapshot(
  page: Playwright.Page,
  name: string,
  options?: SnapshotOptions
): Promise<void>;

// A Locator snapshot is scoped to its element. The name may be omitted for a component mounted
// through percyTest()'s `mount`, in which case the story id is used.
export default function percySnapshot(
  locator: Playwright.Locator,
  name?: string,
  options?: SnapshotOptions
): Promise<void>;

// Wraps the stories-model `mount` fixture (@playwright/test 1.62+) to record story ids.
export function percyTest<T extends { extend: (...args: any[]) => any }>(test: T): T;

export default function percyScreenshot(
  page: Playwright.Page,
  name: string,
  options?: SnapshotOptions
): Promise<void>;

// --- toHaveScreenshot drop-in (require('@percy/playwright/dropin')) ---------------------------
// Requiring the dropin entry registers a global override of Playwright's `toHaveScreenshot()`
// matcher (no new matcher signature; the existing one is intercepted). Capture dispatches by the
// Percy project type behind the token: web projects post a serialized-DOM snapshot (server-side
// render), app projects post the captured PNG through the comparison ingest. Automate/generic
// tokens are rejected with a configuration error.

// Opt-in CI gate reporter, exported from the dropin subpath:
//   reporter: [['@percy/playwright/dropin/reporter']]
// Returning `{ status: 'failed' }` from onEnd is how a failing gate reds the run.
export class PercyGateReporter {
  constructor(options?: { gate?: 'informational' | 'fail-on-changes'; passIfApproved?: boolean }, deps?: unknown);
  onEnd(): Promise<{ status: 'failed' } | undefined>;
}
