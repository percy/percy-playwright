import { expectType, expectError } from 'tsd';
import * as Playwright from 'playwright';
import percySnapshot from '.';

declare const page: Playwright.Page;

expectError(percySnapshot());
expectError(percySnapshot(page));
expectError(percySnapshot('Snapshot name'));

expectType<Promise<void>>(percySnapshot(page, 'Snapshot name'));
expectType<Promise<void>>(percySnapshot(page, 'Snapshot name', { widths: [1000] }));

expectError(percySnapshot(page, 'Snapshot name', { foo: 'bar' }));
