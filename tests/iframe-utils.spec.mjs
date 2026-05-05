import { test, expect } from '@playwright/test';
import {
  UNSUPPORTED_IFRAME_SRCS,
  DEFAULT_MAX_FRAME_DEPTH,
  HARD_MAX_FRAME_DEPTH,
  resolveMaxFrameDepth,
  resolveIgnoreSelectors,
  isUnsupportedIframeSrc
} from '../iframe-utils.js';

test.describe('iframe-utils', () => {
  test('UNSUPPORTED_IFRAME_SRCS list', () => {
    expect(UNSUPPORTED_IFRAME_SRCS).toContain('about:blank');
    expect(UNSUPPORTED_IFRAME_SRCS).toContain('javascript:');
    expect(UNSUPPORTED_IFRAME_SRCS).toContain('data:');
  });

  test('isUnsupportedIframeSrc', () => {
    expect(isUnsupportedIframeSrc(null)).toBe(true);
    expect(isUnsupportedIframeSrc(undefined)).toBe(true);
    expect(isUnsupportedIframeSrc('')).toBe(true);
    expect(isUnsupportedIframeSrc('about:blank')).toBe(true);
    expect(isUnsupportedIframeSrc('JavaScript:alert(1)')).toBe(true);
    expect(isUnsupportedIframeSrc('https://example.com')).toBe(false);
  });

  test('resolveMaxFrameDepth', () => {
    expect(resolveMaxFrameDepth()).toBe(DEFAULT_MAX_FRAME_DEPTH);
    expect(resolveMaxFrameDepth({})).toBe(DEFAULT_MAX_FRAME_DEPTH);
    expect(resolveMaxFrameDepth({ maxIframeDepth: 0 })).toBe(DEFAULT_MAX_FRAME_DEPTH);
    expect(resolveMaxFrameDepth({ maxIframeDepth: 'foo' })).toBe(DEFAULT_MAX_FRAME_DEPTH);
    expect(resolveMaxFrameDepth({ maxIframeDepth: 100 })).toBe(HARD_MAX_FRAME_DEPTH);
    expect(resolveMaxFrameDepth({ maxIframeDepth: 7 })).toBe(7);
  });

  test('resolveIgnoreSelectors', () => {
    expect(resolveIgnoreSelectors()).toEqual([]);
    expect(resolveIgnoreSelectors({})).toEqual([]);
    expect(resolveIgnoreSelectors({ ignoreIframeSelectors: 'string' })).toEqual([]);
    expect(resolveIgnoreSelectors({
      ignoreIframeSelectors: ['.x', '', null, 42, '.y']
    })).toEqual(['.x', '.y']);
  });
});
