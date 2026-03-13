import { expectType, expectError } from 'tsd';
import * as Playwright from 'playwright';
import percySnapshot from '.';
import { percyScreenshot } from '.';

declare const page: Playwright.Page;

//@ts-expect-error
expectError(percySnapshot());
//@ts-expect-error
expectError(percySnapshot(page));
//@ts-expect-error
expectError(percySnapshot('Snapshot name'));
//@ts-expect-error
expectError(percyScreenshot());
//@ts-expect-error
expectError(percyScreenshot(page));
//@ts-expect-error
expectError(percyScreenshot('Snapshot name'));

expectType<Promise<void>>(percySnapshot(page, 'Snapshot name'));
expectType<Promise<void>>(percySnapshot(page, 'Snapshot name', { widths: [1000] }));

expectType<Promise<void>>(percyScreenshot(page, 'Snapshot name'));
expectType<Promise<void>>(percyScreenshot(page, 'Snapshot name', { widths: [1000] }));

//@ts-expect-error
expectError(percySnapshot(page, 'Snapshot name', { foo: 'bar' }));
//@ts-expect-error
expectError(percyScreenshot(page, 'Snapshot name', { foo: 'bar' }));
