import { expectType, expectError } from 'tsd';
import * as Playwright from 'playwright';
import percySnapshot from '.';
import percyScreenshot from '.';

declare const page: Playwright.Page;

expectError(percySnapshot());
expectError(percySnapshot(page));
expectError(percySnapshot('Snapshot name'));
expectError(percyScreenshot());
expectError(percyScreenshot(page));
expectError(percyScreenshot('Snapshot name'));

expectType<Promise<void>>(percySnapshot(page, 'Snapshot name'));
expectType<Promise<void>>(percySnapshot(page, 'Snapshot name', { widths: [1000] }));

expectType<Promise<void>>(percyScreenshot(page, 'Snapshot name'));
expectType<Promise<void>>(percyScreenshot(page, 'Snapshot name', { widths: [1000] }));

expectError(percySnapshot(page, 'Snapshot name', { foo: 'bar' }));
expectError(percyScreenshot(page, 'Snapshot name', { foo: 'bar' }));
