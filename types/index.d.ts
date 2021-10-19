import * as Playwright from 'playwright';
import { SnapshotOptions } from '@percy/core';

export default function percySnapshot(
  page: Playwright.Page,
  name: string,
  options?: SnapshotOptions
): Promise<void>;
