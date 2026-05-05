import { test, expect } from '@playwright/test';
import percySnapshot from '../index.js';

const { frameDepth, isCyclicFrame, captureSerializedDOM } = percySnapshot;

test.describe('frameDepth helper', () => {
  test('returns 0 for a frame with no parentFrame method', () => {
    expect(frameDepth({ url: () => 'https://x.com' })).toBe(0);
  });

  test('walks the parentFrame chain', () => {
    const a = { url: () => 'a' };
    const b = { url: () => 'b', parentFrame: () => a };
    const c = { url: () => 'c', parentFrame: () => b };
    expect(frameDepth(c)).toBe(2);
  });
});

test.describe('isCyclicFrame helper', () => {
  test('returns false when frame has no url method', () => {
    expect(isCyclicFrame({})).toBe(false);
  });

  test('returns false when frame.url() returns falsy', () => {
    expect(isCyclicFrame({ url: () => '' })).toBe(false);
  });

  test('returns false when no ancestor matches', () => {
    const a = { url: () => 'a' };
    const b = { url: () => 'b', parentFrame: () => a };
    expect(isCyclicFrame({ url: () => 'leaf', parentFrame: () => b })).toBe(false);
  });

  test('returns true when an ancestor URL matches', () => {
    const a = { url: () => 'leaf' };
    const b = { url: () => 'b', parentFrame: () => a };
    expect(isCyclicFrame({ url: () => 'leaf', parentFrame: () => b })).toBe(true);
  });

  test('handles ancestors with no parentFrame method', () => {
    const a = { url: () => 'a' };
    expect(isCyclicFrame({ url: () => 'leaf', parentFrame: () => a })).toBe(false);
  });
});

test.describe('captureSerializedDOM filter branches', () => {
  function buildMockPage({ pageUrl, frames = [] }) {
    const lookupResult = (fnStr, args) => {
      if (fnStr.includes('querySelectorAll')) {
        const fUrl = args && args[0]?.fUrl;
        const matchingFrame = frames.find(f => f.url === fUrl);
        if (matchingFrame?.flagsResolver) return matchingFrame.flagsResolver();
        if (matchingFrame?.percyElementId) return { percyElementId: matchingFrame.percyElementId };
        return undefined;
      }
      return undefined;
    };

    const mainFrame = {
      url: () => pageUrl,
      parentFrame: () => null,
      evaluate: async (fn, ...args) => {
        if (typeof fn === 'string') return undefined;
        return lookupResult(fn.toString(), args);
      }
    };

    const mockFrames = frames.map(f => ({
      url: () => f.url,
      parentFrame: () => f.parentFrame || mainFrame,
      evaluate: async (fn) => {
        if (typeof fn === 'string') return undefined;
        return f.snapshot || { html: '<html></html>', resources: [], warnings: [] };
      }
    }));

    return {
      url: () => pageUrl,
      mainFrame: () => mainFrame,
      evaluate: async (fn) => {
        if (typeof fn === 'function' && fn.toString().includes('PercyDOM.serialize')) {
          return { html: '<html><body>top</body></html>', resources: [], warnings: [] };
        }
        return undefined;
      },
      frames: () => [mainFrame, ...mockFrames],
      context: () => ({ cookies: async () => [] })
    };
  }

  test('skips frames with dataPercyIgnore flag', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      frames: [{
        url: 'https://other.com/embed',
        flagsResolver: () => ({ dataPercyIgnore: true, matchesIgnoreSelector: false }),
        snapshot: { html: 'ignored', resources: [], warnings: [] }
      }]
    });
    let called = false;
    page.frames()[1].evaluate = async () => { called = true; };

    const result = await captureSerializedDOM(page, {}, '');
    expect(called).toBe(false);
    expect(result.corsIframes).toEqual([]);
  });

  test('skips frames with matchesIgnoreSelector flag', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      frames: [{
        url: 'https://other.com/embed',
        flagsResolver: () => ({ dataPercyIgnore: false, matchesIgnoreSelector: true })
      }]
    });
    let called = false;
    page.frames()[1].evaluate = async () => { called = true; };

    await captureSerializedDOM(page, { ignoreIframeSelectors: ['.ad'] }, '');
    expect(called).toBe(false);
  });

  test('skips frames whose nesting depth exceeds maxIframeDepth', async () => {
    const a0 = { url: () => 'https://p0.com/' };
    const a1 = { url: () => 'https://p1.com/', parentFrame: () => a0 };
    const a2 = { url: () => 'https://p2.com/', parentFrame: () => a1 };
    const a3 = { url: () => 'https://p3.com/', parentFrame: () => a2 };
    const a4 = { url: () => 'https://p4.com/', parentFrame: () => a3 };
    const a5 = { url: () => 'https://p5.com/', parentFrame: () => a4 };
    const a6 = { url: () => 'https://p6.com/', parentFrame: () => a5 };
    const a7 = { url: () => 'https://p7.com/', parentFrame: () => a6 };
    const a8 = { url: () => 'https://p8.com/', parentFrame: () => a7 };
    const a9 = { url: () => 'https://p9.com/', parentFrame: () => a8 };
    const a10 = { url: () => 'https://p10.com/', parentFrame: () => a9 };
    const a11 = { url: () => 'https://p11.com/', parentFrame: () => a10 };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      frames: [{
        url: 'https://deep.example/leaf',
        parentFrame: a11
      }]
    });
    let called = false;
    page.frames()[1].evaluate = async () => { called = true; };

    await captureSerializedDOM(page, {}, '');
    expect(called).toBe(false);
  });

  test('skips cyclic frames', async () => {
    const root = { url: () => 'https://root.com/' };
    const ancestorA = { url: () => 'https://a.com/', parentFrame: () => root };
    const ancestorB = { url: () => 'https://b.com/', parentFrame: () => ancestorA };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      frames: [{
        url: 'https://b.com/',
        parentFrame: ancestorB
      }]
    });
    let called = false;
    page.frames()[1].evaluate = async () => { called = true; };

    await captureSerializedDOM(page, {}, '');
    expect(called).toBe(false);
  });
});
