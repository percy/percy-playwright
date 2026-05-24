import { test, expect } from '@playwright/test';
import percySnapshot from '../index.js';

const {
  frameDepth,
  isCyclicFrame,
  captureSerializedDOM,
  resolveIgnoreSelectors,
  isUnsupportedIframeSrc,
  resolveMaxFrameDepth
} = percySnapshot;

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
      if (!fnStr.includes('querySelectorAll')) return undefined;
      // Two distinct in-frame evaluations share the same querySelectorAll
      // shape: the flag lookup (`data-percy-ignore`) and the percyElementId
      // lookup (`data-percy-element-id`). The flag lookup also passes an
      // object payload, while the percyElementId lookup passes a bare URL.
      const arg0 = args && args[0];
      const fUrl = (arg0 && typeof arg0 === 'object') ? arg0.fUrl : arg0;
      const matchingFrame = frames.find(f => f.url === fUrl);
      if (fnStr.includes('data-percy-ignore')) {
        if (matchingFrame?.flagsResolver) return matchingFrame.flagsResolver();
        return { dataPercyIgnore: false, matchesIgnoreSelector: false };
      }
      if (fnStr.includes('data-percy-element-id')) {
        if (matchingFrame?.percyElementId) {
          return { percyElementId: matchingFrame.percyElementId };
        }
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
    // captureSerializedDOM only sets corsIframes when at least one frame
    // survives the filter — leaving it undefined when empty.
    expect(result.corsIframes).toBeUndefined();
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

  test('continues snapshot when percyDOM injection rejects on a frame', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      frames: [{
        url: 'https://other.com/embed',
        percyElementId: 'percy-iframe-x'
      }]
    });
    // Force the percyDOM-injection evaluate to reject — covers the per-frame
    // .catch around the injection Promise.all.
    page.frames()[1].evaluate = async () => { throw new Error('detached'); };

    const result = await captureSerializedDOM(page, {}, '');
    // Snapshot still completes; the failed frame contributes nothing.
    expect(result.html).toBeDefined();
  });

  test('drops a frame whose processFrame call throws', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      frames: [{
        url: 'https://other.com/embed',
        percyElementId: 'percy-iframe-y'
      }]
    });
    // First evaluate succeeds (percyDOM injection), second (inside
    // processFrame) throws — covers the per-frame .catch around processFrame.
    let callCount = 0;
    page.frames()[1].evaluate = async () => {
      callCount += 1;
      if (callCount === 1) return undefined;
      throw new Error('navigated');
    };

    const result = await captureSerializedDOM(page, {}, '');
    expect(result.corsIframes).toBeUndefined();
  });
});

test.describe('resolveIgnoreSelectors helper', () => {
  test('returns [] for falsy input', () => {
    expect(resolveIgnoreSelectors({})).toEqual([]);
    expect(resolveIgnoreSelectors({ ignoreIframeSelectors: null })).toEqual([]);
  });

  test('returns [] when called with no arguments', () => {
    expect(resolveIgnoreSelectors()).toEqual([]);
  });

  test('prefers ignoreIframeSelectors over ignoreSelectors (LHS defined)', () => {
    expect(resolveIgnoreSelectors({
      ignoreIframeSelectors: ['.a'],
      ignoreSelectors: ['.b']
    })).toEqual(['.a']);
  });

  test('wraps a single string into an array', () => {
    expect(resolveIgnoreSelectors({ ignoreIframeSelectors: '.ad' })).toEqual(['.ad']);
  });

  test('filters non-string entries from an array', () => {
    expect(resolveIgnoreSelectors({ ignoreIframeSelectors: ['.a', '', 0, '.b'] }))
      .toEqual(['.a', '.b']);
  });

  test('returns [] for selectors of unsupported type (e.g. number)', () => {
    expect(resolveIgnoreSelectors({ ignoreIframeSelectors: 42 })).toEqual([]);
  });
});

test.describe('resolveMaxFrameDepth helper', () => {
  test('returns the sdk-utils default when no option is provided', () => {
    expect(resolveMaxFrameDepth({})).toBe(3); // DEFAULT_MAX_IFRAME_DEPTH in 1.31.14-beta.4
  });

  test('returns the default when called with no arguments', () => {
    expect(resolveMaxFrameDepth()).toBe(3);
  });

  test('prefers maxFrameDepth over maxIframeDepth (LHS defined)', () => {
    expect(resolveMaxFrameDepth({ maxFrameDepth: 4 })).toBe(4);
  });

  test('returns the default when the option is null', () => {
    expect(resolveMaxFrameDepth({ maxIframeDepth: null })).toBe(3);
  });

  test('returns the default when the option is NaN', () => {
    expect(resolveMaxFrameDepth({ maxIframeDepth: 'abc' })).toBe(3);
  });

  test('clamps a value above the hard cap', () => {
    expect(resolveMaxFrameDepth({ maxIframeDepth: 999 })).toBe(10); // HARD_MAX_IFRAME_DEPTH
  });

  test('treats 0 as "use default" (matches sdk-utils clampIframeDepth)', () => {
    // Previously Math.max(0, ...) returned 0, which disabled all CORS
    // iframe capture (depth > 0 filter rejected every iframe at depth 1).
    expect(resolveMaxFrameDepth({ maxIframeDepth: 0 })).toBe(3);
  });

  test('treats negative values as default rather than clamping to 0', () => {
    expect(resolveMaxFrameDepth({ maxIframeDepth: -5 })).toBe(3);
  });

  test('floors fractional values', () => {
    expect(resolveMaxFrameDepth({ maxIframeDepth: 4.7 })).toBe(4);
  });

  test('returns a valid value unchanged', () => {
    expect(resolveMaxFrameDepth({ maxIframeDepth: 5 })).toBe(5);
  });

  test('prefers maxFrameDepth over maxIframeDepth when both set', () => {
    expect(resolveMaxFrameDepth({ maxFrameDepth: 7, maxIframeDepth: 2 })).toBe(7);
  });
});

test.describe('isUnsupportedIframeSrc helper', () => {
  test('treats falsy src as unsupported', () => {
    expect(isUnsupportedIframeSrc('')).toBe(true);
    expect(isUnsupportedIframeSrc(null)).toBe(true);
  });

  test('flags browser-internal prefixes', () => {
    expect(isUnsupportedIframeSrc('about:blank')).toBe(true);
    expect(isUnsupportedIframeSrc('javascript:void(0)')).toBe(true);
    expect(isUnsupportedIframeSrc('blob:https://example.com/abc')).toBe(true);
  });

  test('passes ordinary http(s) URLs through', () => {
    expect(isUnsupportedIframeSrc('https://example.com/page')).toBe(false);
  });
});
