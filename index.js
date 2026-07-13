const utils = require('@percy/sdk-utils');
const { Utils } = require('./utils');

// Inlined to stay robust across @percy/cli versions (this SDK has no direct
// @percy/sdk-utils dependency, so the hoisted version isn't guaranteed to
// export the resolver helpers). Kept behaviourally aligned with the canonical
// helpers in @percy/sdk-utils (percy/cli #2319): depth bounds come from
// sdk-utils (DEFAULT=3 / HARD=10) and this list mirrors the canonical
// UNSUPPORTED_IFRAME_SRCS (15 prefixes, incl. vbscript/file/ws/wss/ftp).
const BROWSER_INTERNAL_PREFIXES = [
  'about:', 'chrome:', 'chrome-extension:', 'devtools:',
  'edge:', 'opera:', 'view-source:', 'data:', 'javascript:', 'blob:',
  'vbscript:', 'file:', 'ws:', 'wss:', 'ftp:'
];

function resolveMaxFrameDepth(options = {}) {
  const { DEFAULT_MAX_IFRAME_DEPTH: def, HARD_MAX_IFRAME_DEPTH: hard } = utils;
  const requested = options.maxFrameDepth ?? options.maxIframeDepth;
  if (requested == null) return def;
  const value = Number(requested);
  // Match @percy/sdk-utils clampIframeDepth semantics: any non-finite or
  // sub-1 value falls back to the default. Without this, a caller passing
  // 0 (or a negative number) would silently set the depth gate to 0 and
  // disable all CORS iframe capture.
  if (!Number.isFinite(value) || value < 1) return def;
  return Math.min(Math.floor(value), hard);
}

function resolveIgnoreSelectors(options = {}) {
  // Mirrors @percy/sdk-utils resolveIgnoreSelectors: per-snapshot option wins,
  // otherwise fall back to the global percy.config.snapshot.ignoreIframeSelectors.
  const normalize = sel => {
    if (!sel) return [];
    if (Array.isArray(sel)) return sel.filter(s => typeof s === 'string' && s.length);
    if (typeof sel === 'string') return [sel];
    return [];
  };
  const perSnapshot = normalize(options.ignoreIframeSelectors ?? options.ignoreSelectors);
  if (perSnapshot.length) return perSnapshot;
  return normalize(utils?.percy?.config?.snapshot?.ignoreIframeSelectors);
}

function isUnsupportedIframeSrc(src) {
  if (!src) return true;
  const s = String(src).toLowerCase();
  return BROWSER_INTERNAL_PREFIXES.some(p => s.startsWith(p));
}

// Collect client and environment information
const sdkPkg = require('./package.json');
const CLIENT_INFO = `${sdkPkg.name}/${sdkPkg.version}`;
// Best-effort: on newer Playwright the runner may be mid-load when this module is required
// (CJS↔ESM interop), and consumers may have only @playwright/test installed — degrade to a bare
// label rather than crashing at import time.
// istanbul ignore next - which fallback executes depends on the consumer's installed packages
const ENV_INFO = (() => {
  try { return `playwright/${require('playwright/package.json').version}`; } catch {}
  try { return `playwright/${require('@playwright/test/package.json').version}`; } catch {}
  return 'playwright';
})();
const log = utils.logger('playwright');

// Use CDP to discover closed shadow roots and expose them to PercyDOM.serialize().
// Closed shadow roots are inaccessible from JS (element.shadowRoot === null),
// but CDP's DOM domain can pierce them. We resolve each closed shadow root to a
// JS object and store it in a WeakMap that clone-dom.js reads during serialization.
async function exposeClosedShadowRoots(page) {
  let cdpSession;
  try {
    cdpSession = await page.context().newCDPSession(page);
  } catch (err) {
    // Non-Chromium browser (Firefox/WebKit) or CDP session unavailable
    log.debug('CDP session unavailable:', err.message);
    return;
  }

  try {
    await cdpSession.send('DOM.enable');

    // Get the full DOM tree, piercing all shadow roots including closed ones
    const { root } = await cdpSession.send('DOM.getDocument', {
      depth: -1,
      pierce: true
    });

    // Walk the CDP DOM tree to find closed shadow roots
    const closedPairs = [];
    function walkNodes(node) {
      // Skip nodes inside child frame documents — cross-frame closed shadow
      // roots are not yet supported (their execution context lacks the WeakMap)
      if (node.contentDocument) return;
      if (node.shadowRoots) {
        for (const sr of node.shadowRoots) {
          if (sr.shadowRootType === 'closed') {
            closedPairs.push({
              hostBackendNodeId: node.backendNodeId,
              shadowBackendNodeId: sr.backendNodeId
            });
          }
          walkNodes(sr);
        }
      }
      if (node.children) {
        for (const child of node.children) {
          walkNodes(child);
        }
      }
    }
    walkNodes(root);

    if (closedPairs.length === 0) {
      return;
    }

    log.debug(`Found ${closedPairs.length} closed shadow root(s), exposing via CDP`);

    // Create the WeakMap on the page (same key as preflight.js uses)
    /* istanbul ignore next: browser-executed code */
    await page.evaluate(() => {
      window.__percyClosedShadowRoots = window.__percyClosedShadowRoots || new WeakMap();
    });

    // Parallelize CDP roundtrips — CDP handles concurrent requests on a single session
    await Promise.all(closedPairs.map(async (pair) => {
      const { object: hostObj } = await cdpSession.send('DOM.resolveNode', {
        backendNodeId: pair.hostBackendNodeId
      });
      const { object: shadowObj } = await cdpSession.send('DOM.resolveNode', {
        backendNodeId: pair.shadowBackendNodeId
      });

      // Runtime.callFunctionOn without explicit executionContextId uses the context
      // of the passed objectId (main world via DOM.resolveNode), which matches where
      // page.evaluate runs — this is load-bearing for the WeakMap lookup
      /* istanbul ignore next: CDP-injected function */
      await cdpSession.send('Runtime.callFunctionOn', {
        functionDeclaration: 'function(shadowRoot) { window.__percyClosedShadowRoots.set(this, shadowRoot); }',
        objectId: hostObj.objectId,
        arguments: [{ objectId: shadowObj.objectId }]
      });
    }));
  } catch (err) {
    // Non-fatal — closed shadow DOM just won't be captured
    log.debug('Could not expose closed shadow roots via CDP:', err.message);
  } finally {
    /* istanbul ignore else: cdpSession is always set when this finally block is reached */
    if (cdpSession) {
      /* istanbul ignore next: swallow detach errors */
      await cdpSession.detach().catch(() => {});
    }
  }
}

// Walk the parentFrame chain to determine the iframe's nesting depth (1 for a
// top-level iframe, 2 for once-nested, ...). Returns 0 for the main frame.
function frameDepth(frame) {
  let depth = 0;
  let cur = frame.parentFrame ? frame.parentFrame() : null;
  while (cur) {
    depth++;
    cur = cur.parentFrame ? cur.parentFrame() : null;
  }
  return depth;
}

// True if the frame's URL also appears somewhere in its ancestor chain.
// Skipping cyclic frames prevents A->B->A pages from generating up to
// MAX_FRAME_DEPTH duplicate corsIframes entries.
function isCyclicFrame(frame) {
  const url = frame.url ? frame.url() : null;
  if (!url) return false;
  let cur = frame.parentFrame ? frame.parentFrame() : null;
  while (cur) {
    if (cur.url && cur.url() === url) return true;
    cur = cur.parentFrame ? cur.parentFrame() : null;
  }
  return false;
}

// Processes a single cross-origin frame to capture its snapshot and resources.
// The iframe element holding this frame's percyElementId lives in the parent
// frame's DOM (not necessarily the top page) — important for nesting where the
// parent is itself a cross-origin frame.
async function processFrame(page, frame, options, percyDOM) {
  const frameUrl = frame.url();
  log.debug(`Processing cross-origin iframe (depth ${frameDepth(frame)}): ${frameUrl}`);

  /* istanbul ignore next: browser-executed iframe serialization */
  // enableJavaScript: true prevents the standard iframe serialization logic from running.
  // This is necessary because we're manually handling cross-origin iframe serialization here.
  const iframeSnapshot = await frame.evaluate((opts) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(opts);
  }, { ...options, enableJavaScript: true });

  // Look up the iframe element in the *parent frame's* DOM. For top-level
  // iframes the parent is the main frame; for nested iframes it's the
  // immediately enclosing frame. Reading from the top page would miss nested
  // iframes whose <iframe> element lives inside another frame's document.
  // Falls back to `page` if neither is available (e.g. minimal test stubs)
  // — page.evaluate has the same signature so the lookup still works for
  // top-level iframes.
  const parentFrame = (frame.parentFrame && frame.parentFrame()) ||
    (page.mainFrame && page.mainFrame()) ||
    page;
  // Match by exact src first; fall back to a normalized comparison that
  // tolerates only a trailing-slash difference. A naive `startsWith` would
  // mis-match siblings that share a URL prefix (e.g. `https://ads.com/` and
  // `https://ads.com/banner`).
  /* istanbul ignore next: browser-executed evaluation function */
  const iframeData = await parentFrame.evaluate((fUrl) => {
    const norm = (s) => (s || '').replace(/\/+$/, '');
    const target = norm(fUrl);
    const iframes = Array.from(document.querySelectorAll('iframe'));
    const matchingIframe = iframes.find(iframe => iframe.src === fUrl) ||
      iframes.find(iframe => norm(iframe.src) === target);
    if (matchingIframe) {
      return {
        percyElementId: matchingIframe.getAttribute('data-percy-element-id')
      };
    }
  }, frameUrl);

  return {
    iframeData,
    iframeSnapshot,
    frameUrl
  };
}

async function captureSerializedDOM(page, options, percyDOM) {
  // Readiness gate. All orchestration lives in @percy/sdk-utils
  // (disabled-check + shallow-merge config + script generation + try/catch).
  // The package.json floor pins runReadinessGate to be present.
  /* istanbul ignore next: sinon.spy on the playwright test fixture's page
     doesn't intercept the SDK's `(script) => page.evaluate(script)` callback
     to utils.runReadinessGate. Coverage is provided by @percy/sdk-utils'
     own runReadinessGate test suite. */
  const readinessDiagnostics = await utils.runReadinessGate(
    (script) => page.evaluate(script),
    options,
    { log }
  );

  /* istanbul ignore next: no instrumenting injected code */
  let domSnapshot = await page.evaluate((options) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(options);
  }, options);

  // Attach readiness diagnostics so the CLI can log timing and pass/fail
  /* istanbul ignore next: same coverage gap as line 46 */
  if (readinessDiagnostics && domSnapshot && typeof domSnapshot === 'object') {
    domSnapshot.readiness_diagnostics = readinessDiagnostics;
  }

  // Process CORS IFrames (including nested cross-origin iframes up to
  // maxIframeDepth). page.frames() returns a flat list of every frame on the
  // page tree, so descendants are already included; filter to non-main frames
  // whose origin differs from their *immediate parent* (same-origin descendants
  // are inlined as srcdoc by PercyDOM).
  const maxFrameDepth = resolveMaxFrameDepth(options);
  const ignoreSelectors = resolveIgnoreSelectors(options);
  const allFrames = page.frames();
  const mainFrame = (page.mainFrame && page.mainFrame()) || allFrames[0];

  // Resolve per-frame `data-percy-ignore` and ignoreIframeSelectors flags
  // from the parent frame's DOM (where the <iframe> element lives).
  const ignoreFlagsByFrame = new Map();
  await Promise.all(allFrames.map(async (frame) => {
    if (frame === mainFrame) return;
    try {
      const parent = (frame.parentFrame && frame.parentFrame()) || mainFrame;
      /* istanbul ignore next: browser-executed evaluate callback */
      const flags = await parent.evaluate(({ fUrl, selectors }) => {
        const norm = (s) => (s || '').replace(/\/+$/, '');
        const target = norm(fUrl);
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const el = iframes.find(i => i.src === fUrl) || iframes.find(i => norm(i.src) === target);
        if (!el) return { dataPercyIgnore: false, matchesIgnoreSelector: false };
        let matches = false;
        if (selectors && selectors.length) {
          for (let j = 0; j < selectors.length; j++) {
            try { if (el.matches(selectors[j])) { matches = true; break; } } catch (e) { /* invalid */ }
          }
        }
        return {
          dataPercyIgnore: el.hasAttribute('data-percy-ignore'),
          matchesIgnoreSelector: matches
        };
      }, { fUrl: frame.url(), selectors: ignoreSelectors });
      ignoreFlagsByFrame.set(frame, flags);
    } catch (e) { /* leave entry absent */ }
  }));

  const crossOriginFrames = allFrames
    .filter(frame => {
      if (frame === mainFrame) return false;
      const flags = ignoreFlagsByFrame.get(frame) || {};
      if (flags.dataPercyIgnore) {
        log.debug(`Skipping iframe marked with data-percy-ignore: ${frame.url()}`);
        return false;
      }
      if (flags.matchesIgnoreSelector) {
        log.debug(`Skipping iframe matching ignoreIframeSelectors: ${frame.url()}`);
        return false;
      }
      const frameUrl = frame.url();
      if (!frameUrl || isUnsupportedIframeSrc(frameUrl)) return false;
      const depth = frameDepth(frame);
      if (depth > maxFrameDepth) {
        log.debug(`Skipping iframe at depth ${depth} (max ${maxFrameDepth}): ${frameUrl}`);
        return false;
      }
      if (isCyclicFrame(frame)) {
        log.debug(`Skipping cyclic iframe (${frameUrl} appears in ancestor chain)`);
        return false;
      }
      try {
        const parent = frame.parentFrame && frame.parentFrame();
        const parentUrl = (parent && parent.url && parent.url()) || page.url();
        const parentOrigin = parentUrl ? new URL(parentUrl).origin : null;
        const frameOrigin = new URL(frameUrl).origin;
        return parentOrigin !== null && frameOrigin !== parentOrigin;
      } catch {
        return false;
      }
    });

  // Inject Percy DOM into all cross-origin frames before processing them in
  // parallel. Per-frame `.catch` so a single detached/navigating frame doesn't
  // fail-fast the whole Promise.all and abort the snapshot.
  await Promise.all(crossOriginFrames.map(frame =>
    frame.evaluate(percyDOM).catch(err => {
      log.debug(`Percy DOM injection failed for ${frame.url()}: ${err.message}`);
      return null;
    })
  ));

  const processedFrames = (await Promise.all(
    crossOriginFrames.map(frame =>
      processFrame(page, frame, options, percyDOM).catch(err => {
        log.debug(`Failed to process cross-origin frame ${frame.url()}: ${err.message}`);
        return null;
      })
    )
  ))
    // Drop frames that errored out, were detached mid-capture, or whose
    // percyElementId lookup came up empty. Shipping malformed entries would
    // make the CLI reject the whole snapshot on validation.
    .filter(f => f && f.iframeData && f.iframeData.percyElementId);

  if (processedFrames.length > 0) {
    domSnapshot.corsIframes = processedFrames;
  }
  domSnapshot.cookies = await page.context().cookies();
  return domSnapshot;
}

async function changeViewportAndWait(page, width, height, resizeCount) {
  try {
    await page.setViewportSize({ width, height });
  } catch (error) {
    log.debug(`Resizing using setViewportSize failed for width ${width}`, error);
    return;
  }

  try {
    /* istanbul ignore next: no instrumenting injected code */
    await page.waitForFunction((count) => window.resizeCount === count, resizeCount, { timeout: 1000 });
  } catch (error) {
    log.debug(`Timed out waiting for window resize event for width ${width}`, error);
  }
}

function isResponsiveDOMCaptureValid(options) {
  if (utils.percy?.config?.percy?.deferUploads) {
    return false;
  }
  return (
    options?.responsive_snapshot_capture ||
    options?.responsiveSnapshotCapture ||
    utils.percy?.config?.snapshot?.responsiveSnapshotCapture ||
    false
  );
}

async function captureResponsiveDOM(page, options, percyDOM) {
  const domSnapshots = [];
  /* istanbul ignore next: no instrumenting injected code */
  const currentViewport = page.viewportSize() || await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  let currentWidth = currentViewport.width;
  let currentHeight = currentViewport.height;
  let lastWindowWidth = currentWidth;
  let resizeCount = 0;

  /* istanbul ignore next: no instrumenting injected code */
  await page.evaluate(() => {
    /* eslint-disable-next-line no-undef */
    PercyDOM.waitForResize();
  });

  // Calculate default height for non-mobile widths
  let defaultHeight = currentHeight;
  if (process.env.PERCY_RESPONSIVE_CAPTURE_MIN_HEIGHT?.toLowerCase() === 'true' && options.minHeight) {
    defaultHeight = options.minHeight;
  }

  // Get width and height combinations
  /* istanbul ignore next: CLI version compatibility check */
  if (!utils.getResponsiveWidths) {
    throw new Error('Update Percy CLI to the latest version to use responsiveSnapshotCapture');
  }
  const widthHeights = await utils.getResponsiveWidths(options.widths);

  try {
    for (let { width, height } of widthHeights) {
      height = height || defaultHeight;
      if (lastWindowWidth !== width) {
        resizeCount++;
        await changeViewportAndWait(page, width, height, resizeCount);
        lastWindowWidth = width;
      }

      if (process.env.PERCY_RESPONSIVE_CAPTURE_RELOAD_PAGE?.toLowerCase() === 'true') {
        await page.reload();
        await page.evaluate(percyDOM);
        // Re-prime closed shadow root WeakMap — page.reload() creates a new
        // document and discards the previous window-bound state.
        await exposeClosedShadowRoots(page);
        /* istanbul ignore next: no instrumenting injected code */
        await page.evaluate(() => {
          /* eslint-disable-next-line no-undef */
          PercyDOM.waitForResize();
        });
        resizeCount = 0; // Reset local counter to match window.resizeCount after reload
      }

      if (process.env.RESPONSIVE_CAPTURE_SLEEP_TIME) {
        await new Promise(resolve => setTimeout(resolve, parseInt(process.env.RESPONSIVE_CAPTURE_SLEEP_TIME) * 1000));
      }

      let domSnapshot = await captureSerializedDOM(page, options, percyDOM);
      domSnapshot.width = width;
      domSnapshots.push(domSnapshot);
    }
  } finally {
    await changeViewportAndWait(page, currentWidth, currentHeight, resizeCount + 1);
  }
  return domSnapshots;
}

async function captureDOM(page, options, percyDOM) {
  const responsiveSnapshotCapture = isResponsiveDOMCaptureValid(options);
  if (responsiveSnapshotCapture) {
    return await captureResponsiveDOM(page, options, percyDOM);
  } else {
    return await captureSerializedDOM(page, options, percyDOM);
  }
}

// Take a DOM snapshot and post it to the snapshot endpoint
const percySnapshot = async function(page, name, options) {
  if (!page) throw new Error('A Playwright `page` object is required.');
  if (!name) throw new Error('The `name` argument is required.');
  if (!(await utils.isPercyEnabled())) return;

  try {
    // Inject the DOM serialization script
    const percyDOM = await utils.fetchPercyDOM();
    await page.evaluate(percyDOM);

    // Merge .percy.yml config options with snapshot options (snapshot options take priority)
    const mergedOptions = utils.mergeSnapshotOptions(options);
    // Expose closed shadow roots via CDP before serialization so
    // PercyDOM.serialize() can access them through the WeakMap
    await exposeClosedShadowRoots(page);

    let domSnapshot = await captureDOM(page, mergedOptions, percyDOM);

    // Post the DOM to the snapshot endpoint with snapshot options and other info
    const response = await utils.postSnapshot({
      ...options,
      environmentInfo: ENV_INFO,
      clientInfo: CLIENT_INFO,
      url: page.url(),
      domSnapshot,
      name
    });
    return response?.body?.data;
  } catch (err) {
    log.error(`Could not take DOM snapshot "${name}"`);
    log.error(err);
  }
};

const createRegion = function({
  boundingBox = null,
  elementXpath = null,
  elementCSS = null,
  padding = null,
  algorithm = 'ignore',
  diffSensitivity = null,
  imageIgnoreThreshold = null,
  carouselsEnabled = null,
  bannersEnabled = null,
  adsEnabled = null,
  diffIgnoreThreshold = null
} = {}) {
  const elementSelector = {};
  if (boundingBox) elementSelector.boundingBox = boundingBox;
  if (elementXpath) elementSelector.elementXpath = elementXpath;
  if (elementCSS) elementSelector.elementCSS = elementCSS;

  const region = {
    algorithm,
    elementSelector
  };

  if (padding) {
    region.padding = padding;
  }

  const configuration = {};
  if (['standard', 'intelliignore'].includes(algorithm)) {
    if (diffSensitivity) configuration.diffSensitivity = diffSensitivity;
    if (imageIgnoreThreshold) configuration.imageIgnoreThreshold = imageIgnoreThreshold;
    if (carouselsEnabled) configuration.carouselsEnabled = carouselsEnabled;
    if (bannersEnabled) configuration.bannersEnabled = bannersEnabled;
    if (adsEnabled) configuration.adsEnabled = adsEnabled;
  }

  if (Object.keys(configuration).length > 0) {
    region.configuration = configuration;
  }

  const assertion = {};
  if (diffIgnoreThreshold) {
    assertion.diffIgnoreThreshold = diffIgnoreThreshold;
  }

  if (Object.keys(assertion).length > 0) {
    region.assertion = assertion;
  }

  return region;
};

// Takes Playwright screenshot with Automate
const percyScreenshot = async function(page, name, options) {
  if (!page) throw new Error('A Playwright `page` object is required.');
  if (!name) throw new Error('The `name` argument is required.');
  if (!(await utils.isPercyEnabled())) return;
  if (Utils.projectType() !== 'automate') {
    throw new Error('Invalid function call - percyScreenshot(). Please use percySnapshot() function for taking screenshot. percyScreenshot() should be used only while using Percy with Automate. For more information on usage of PercySnapshot(), refer doc for your language https://www.browserstack.com/docs/percy/integrate/overview');
  }

  try {
    const sessionDetails = await Utils.sessionDetails(page);
    const sessionId = sessionDetails.hashed_id;
    const pageGuid = page._guid;
    const frameGuid = page._mainFrame._guid;
    const data = {
      environmentInfo: ENV_INFO,
      clientInfo: CLIENT_INFO,
      sessionId: sessionId,
      pageGuid: pageGuid,
      frameGuid: frameGuid,
      framework: 'playwright',
      snapshotName: name,
      options
    };
    const response = await Utils.captureAutomateScreenshot(data);
    return response?.body?.data;
  } catch (err) {
    log.error(`Could not take percy screenshot "${name}"`);
    log.error(err);
  }
};

module.exports = percySnapshot;
module.exports.percySnapshot = percySnapshot;
module.exports.createRegion = createRegion;
module.exports.percyScreenshot = percyScreenshot;
module.exports.CLIENT_INFO = CLIENT_INFO;
module.exports.ENV_INFO = ENV_INFO;
// Exported for direct unit testing of the parentFrame-chain walkers.
module.exports.frameDepth = frameDepth;
module.exports.isCyclicFrame = isCyclicFrame;
module.exports.captureSerializedDOM = captureSerializedDOM;
// Internal: full DOM capture (readiness gate + responsive + CORS iframes), reused by the
// toHaveScreenshot drop-in's snapshot mode (dropin/dom.js). Not public API.
module.exports.captureDOM = captureDOM;
module.exports.resolveIgnoreSelectors = resolveIgnoreSelectors;
module.exports.isUnsupportedIframeSrc = isUnsupportedIframeSrc;
module.exports.resolveMaxFrameDepth = resolveMaxFrameDepth;
