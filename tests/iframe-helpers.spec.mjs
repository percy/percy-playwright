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

  test('processes cross-origin frame with percy-element-id (covers processFrame)', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      frames: [{
        url: 'https://other.com/embed',
        percyElementId: 'percy-iframe-1',
        snapshot: { html: '<html><body>cross-origin</body></html>', resources: [], warnings: [] }
      }]
    });

    const result = await captureSerializedDOM(page, {}, '');
    expect(result.corsIframes).toBeDefined();
    expect(result.corsIframes.length).toBe(1);
  });

  test('processFrame uses page fallback when neither frame.parentFrame nor page.mainFrame yield a frame', async () => {
    // Real mainFrame at index 0; a sibling cross-origin frame with NO parentFrame method
    // and a page where mainFrame() returns null. processFrame's parent lookup must
    // fall through both ORs and end up using `page` directly.
    const realMainFrame = {
      url: () => 'https://example.com/',
      parentFrame: () => null,
      evaluate: async (fn, ...args) => {
        const fnStr = fn.toString();
        if (fnStr.includes('querySelectorAll')) {
          // Flag lookup: return empty flags so the filter falls through
          if (args && args[0]?.fUrl !== undefined) {
            return { dataPercyIgnore: false, matchesIgnoreSelector: false };
          }
          // percyElementId lookup
          return { percyElementId: 'percy-id-orphan' };
        }
        return undefined;
      }
    };
    const orphanFrame = {
      url: () => 'https://orphan.com/',
      // NO parentFrame method
      evaluate: async (fn) => {
        if (typeof fn === 'function' && fn.toString().includes('PercyDOM.serialize')) {
          return { html: '<html><body>orphan</body></html>', resources: [], warnings: [] };
        }
        return undefined;
      }
    };
    const minimalPage = {
      url: () => 'https://example.com/',
      mainFrame: () => null, // Falsy — forces fallback in processFrame
      evaluate: async (fn) => {
        if (typeof fn === 'function' && fn.toString().includes('PercyDOM.serialize')) {
          return { html: '<html></html>', resources: [], warnings: [] };
        }
        // page acts as the parent frame for the orphan; respond like mainFrame would
        const fnStr = fn.toString();
        if (fnStr.includes('querySelectorAll')) {
          return { percyElementId: 'percy-id-orphan' };
        }
        return undefined;
      },
      frames: () => [realMainFrame, orphanFrame],
      context: () => ({ cookies: async () => [] })
    };

    const result = await captureSerializedDOM(minimalPage, {}, '');
    expect(result.corsIframes).toBeDefined();
  });

  test('handles empty parent.url() and empty page.url() (parentUrl falsy branch)', async () => {
    const realMainFrame = {
      url: () => '',
      parentFrame: () => null,
      evaluate: async () => ({ dataPercyIgnore: false, matchesIgnoreSelector: false })
    };
    const childFrame = {
      url: () => 'https://other.com/',
      // parent.url() returns ''
      parentFrame: () => ({ url: () => '' }),
      evaluate: async () => undefined
    };
    const emptyUrlPage = {
      url: () => '',
      mainFrame: () => realMainFrame,
      evaluate: async (fn) => {
        if (typeof fn === 'function' && fn.toString().includes('PercyDOM.serialize')) {
          return { html: '<html></html>', resources: [], warnings: [] };
        }
        return undefined;
      },
      frames: () => [realMainFrame, childFrame],
      context: () => ({ cookies: async () => [] })
    };

    // parentUrl resolves to '' — origin check returns false, frame skipped.
    await captureSerializedDOM(emptyUrlPage, {}, '');
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
