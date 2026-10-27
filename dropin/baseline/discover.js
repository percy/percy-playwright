'use strict';

// Unit 3 / R6 — discover the repo's committed Playwright baseline PNGs and reconstruct their Percy
// identity `(name, browser_family, width)` so they pair with the head capture into ONE comparison.
//
// FORWARD reconstruction (not backward filename parsing). Playwright's default screenshot path is
//   {snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}
// with `snapshotSuffix` defaulting to `process.platform` (darwin|win32|linux). From the filename we
// can recover ONLY `name` (the `{arg}` stem, lossily — sanitization is irreversible). `browser_family`
// and `width` are NOT in the path: `browser_family` comes from `projectName → use.browserName` and
// `width` from `use.viewport.width`. So we enumerate the RESOLVED config's projects, derive
// `{browser_family, width}` per project, and match PNGs by peeling the known `-{projectName}` and
// `-{platform}` tail off the stem — the remainder (including any auto `-N` index) is the `name`,
// derived identically by the head capture (src/identity.js).
//
// When anything cannot be mapped cleanly we DEGRADE to baseline-only (a clear reason, never a guess)
// rather than seed a mismatched identity that would surface as a phantom "new" snapshot.
const fs = require('fs');
const path = require('path');
const { sanitizeForFilePath, SCREENSHOT_EXT_RE } = require('../identity');
const { sanitizePath, sanitizeDirentName } = require('../paths');

// Node's process.platform values Playwright bakes into the `{snapshotSuffix}` segment.
const PLATFORM_SUFFIXES = Object.freeze(['darwin', 'linux', 'win32']);

// Degrade reasons (surfaced by the seed/global-setup copy).
const DEGRADE = Object.freeze({
  CUSTOM_TEMPLATE: 'custom_path_template',
  PROJECT_MISSING_FIELDS: 'project_missing_browser_or_viewport',
  AMBIGUOUS_TAIL: 'ambiguous_project_platform_tail',
  PATH_ARG: 'path_array_arg',
  NO_PROJECTS: 'no_resolvable_projects',
  // The comparison ingest takes PNG tiles; a WebP-only baseline can't be seeded faithfully.
  WEBP_BASELINE: 'webp_baseline'
});

// A custom snapshot path template means the default `{arg}{-projectName}{-snapshotSuffix}` layout no
// longer holds, so forward reconstruction can't trust the tail. Detect by PRESENCE (unset-vs-set),
// not by string-matching the default — Playwright resolves the default internally, it never appears
// on the user's config object. Checked at both the config root and per-project.
function hasCustomTemplate(config = {}, project = {}) {
  const screenshotTpl = obj => obj && obj.expect && obj.expect.toHaveScreenshot && obj.expect.toHaveScreenshot.pathTemplate;
  return Boolean(
    config.snapshotPathTemplate ||
    project.snapshotPathTemplate ||
    screenshotTpl(config) ||
    screenshotTpl(project)
  );
}

// Pull `(name, browserFamily, width)` inputs from a resolved Playwright project. The project's
// `use.browserName` → browser_family; `use.viewport.width` → width. A project missing either cannot
// be mapped (we refuse to guess a default browser/width for an EXISTING project) → degrade.
function projectIdentity(project = {}) {
  const use = project.use || {};
  const browserFamily = use.browserName;
  const width = use.viewport && use.viewport.width;
  if (!browserFamily || !width) return null;
  // The sanitized project-name segment as Playwright writes it into the path (`-{projectName}`).
  const segment = project.name ? sanitizeForFilePath(project.name) : '';
  return { browserFamily, width, projectSegment: segment, projectName: project.name || '' };
}

// Find the directory holding committed baseline PNGs. An explicit `snapshotDir` always wins;
// otherwise probe for Playwright's `<testfile>-snapshots` convention under the root.
function findSnapshotDirs(rootDir, snapshotDir) {
  if (snapshotDir) {
    const dir = sanitizePath(snapshotDir);
    const abs = path.isAbsolute(dir) ? dir : path.join(sanitizePath(rootDir), dir);
    return fs.existsSync(abs) ? [abs] : [];
  }
  return collectSnapshotDirs(rootDir);
}

// Recursively collect every `*-snapshots` directory under `rootDir` (Playwright nests them next to
// each test file, which may itself sit in subdirs).
function collectSnapshotDirs(rootDir) {
  const out = [];
  const walk = current => {
    for (const entry of safeReaddir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = sanitizeDirentName(entry.name);
      if (name === null) continue;
      const full = path.join(sanitizePath(current), name);
      if (/-snapshots$/.test(name)) out.push(full);
      else if (name !== 'node_modules' && !name.startsWith('.')) walk(full);
    }
  };
  walk(rootDir);
  return out;
}

// Recursively collect every `.png`/`.webp` under `dir`, returning the path relative to `dir` (so
// nested `{arg}` subdir names are preserved for the path-array degrade check).
function listBaselines(dir) {
  const out = [];
  const walk = current => {
    for (const entry of safeReaddir(current, { withFileTypes: true })) {
      const name = sanitizeDirentName(entry.name);
      if (name === null) continue;
      const full = path.join(sanitizePath(current), name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SCREENSHOT_EXT_RE.test(name)) out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out;
}

// Peel the known `-{platform}` then `-{projectName}` tail off a PNG stem (filename minus `.png`),
// reconstructing `name`. Returns the matched project + name, or a degrade marker.
//
// `projects` is the list of resolved project identities; `platformSuffixes` the configured/observed
// suffix set. We try every (project, platform) combination and require EXACTLY ONE to match so a
// hyphenated project/platform name can't ambiguously peel two different ways.
function reconstructName(stem, projects, platformSuffixes) {
  // Path-array `{arg}` (nested subdirs) → the stem contains a path separator. We can't reliably map
  // it back to a single `name` token, so degrade rather than guess.
  if (stem.includes('/') || stem.includes(path.sep)) {
    return { degrade: DEGRADE.PATH_ARG };
  }

  // Strip the platform suffix (single-OS CI — do NOT fork identity by OS). Prefer a real platform
  // match; only when NO known platform suffix is present do we fall back to the suffix-less peel.
  // This keeps an unnamed/empty-segment project from spuriously double-matching (with and without a
  // platform) when the stem genuinely carries a suffix.
  const withPlatform = peelMatches(stem, projects, platformSuffixes);
  const matches = withPlatform.length ? withPlatform : peelMatches(stem, projects, [null]);

  if (!matches.length) return { degrade: null, unmatched: true };

  // Two genuinely different (name, project) resolutions of the same tail → ambiguous; don't guess.
  const distinct = dedupeMatches(matches);
  if (distinct.length > 1) return { degrade: DEGRADE.AMBIGUOUS_TAIL };

  return { name: distinct[0].name, project: distinct[0].project };
}

// Try peeling each (project, platform) combination off the stem. `platforms` may include `null` to
// mean "no platform suffix". Returns every combination that cleanly resolves to a non-empty name.
function peelMatches(stem, projects, platforms) {
  const out = [];
  for (const project of projects) {
    for (const platform of platforms) {
      let rest = stem;
      if (platform) {
        if (!rest.endsWith(`-${platform}`)) continue;
        rest = rest.slice(0, -(platform.length + 1));
      }
      if (project.projectSegment) {
        if (!rest.endsWith(`-${project.projectSegment}`)) continue;
        rest = rest.slice(0, -(project.projectSegment.length + 1));
      }
      if (!rest) continue; // nothing left to be the name → not a real match
      out.push({ name: rest, project, platform });
    }
  }
  return out;
}

// Two matches are equivalent when they resolve to the same name + project. A PNG with no platform
// suffix matches every project's `null`-platform peel identically; only genuinely different
// (name, project) pairs make the tail ambiguous.
function dedupeMatches(matches) {
  const seen = new Map();
  for (const m of matches) {
    const key = `${m.name} ${m.project.projectName}`;
    if (!seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()];
}

// Discover the committed baseline PNGs and reconstruct each one's Percy identity.
//
// Inputs:
//   rootDir       — repo root (where `*-snapshots` dirs live)
//   snapshotDir   — explicit Playwright `snapshotDir`, if configured
//   baseBranch    — passed through (KD2)
//   config        — the RESOLVED Playwright config: { projects: [{ name, use: { browserName,
//                   viewport: { width } } }], snapshotPathTemplate?, expect?: { toHaveScreenshot?:
//                   { pathTemplate? } } }
//
// Returns { baselines: [{ filepath, name, browserFamily, width }], snapshotDir, baseBranch, degraded?,
//   reason? }. On any unmappable condition `baselines` is empty and `{ degraded: true, reason }` is
// set so the caller seeds nothing and surfaces a clear baseline-only message.
function discoverBaselines({ rootDir = process.cwd(), snapshotDir = null, baseBranch = null, config = {} } = {}) {
  const projectsConfig = Array.isArray(config.projects) && config.projects.length
    ? config.projects
    : (config.use ? [{ name: '', use: config.use }] : []);

  // Degrade: a custom template anywhere means the default tail layout is gone — never guess.
  if (projectsConfig.some(p => hasCustomTemplate(config, p)) || hasCustomTemplate(config)) {
    return degraded(DEGRADE.CUSTOM_TEMPLATE, { baseBranch });
  }

  // Build the resolved project identities. ANY project missing browserName/viewport.width → degrade
  // (a real configured project we can't map would otherwise be silently dropped).
  const projects = [];
  for (const p of projectsConfig) {
    const id = projectIdentity(p);
    if (!id) return degraded(DEGRADE.PROJECT_MISSING_FIELDS, { baseBranch });
    projects.push(id);
  }
  if (!projects.length) return degraded(DEGRADE.NO_PROJECTS, { baseBranch });

  const dirs = findSnapshotDirs(rootDir, snapshotDir);
  if (!dirs.length) {
    return { baselines: [], snapshotDir: null, baseBranch };
  }

  const baselines = [];
  for (const dir of dirs) {
    const files = listBaselines(dir);
    const pngStems = new Set(files.filter(f => /\.png$/i.test(f)).map(f => f.replace(SCREENSHOT_EXT_RE, '')));
    for (const rel of files) {
      const stem = rel.replace(SCREENSHOT_EXT_RE, '');
      const isWebp = !/\.png$/i.test(rel);
      // The same identity committed in both formats: the PNG is the one that can be seeded.
      if (isWebp && pngStems.has(stem)) continue;
      const result = reconstructName(stem, projects, PLATFORM_SUFFIXES);

      if (result.degrade) {
        return degraded(result.degrade, { baseBranch });
      }
      if (result.unmatched) {
        // A PNG whose tail matches no configured project/platform — likely a stray file. Skip it
        // (do NOT seed an identity we can't trust), but don't fail the whole discovery.
        continue;
      }
      if (isWebp) return degraded(DEGRADE.WEBP_BASELINE, { baseBranch });

      baselines.push({
        filepath: path.join(dir, rel),
        name: result.name,
        browserFamily: result.project.browserFamily,
        width: result.project.width
      });
    }
  }

  return { baselines, snapshotDir: dirs.length === 1 ? dirs[0] : dirs, baseBranch };
}

function degraded(reason, extra = {}) {
  return { baselines: [], snapshotDir: null, degraded: true, reason, ...extra };
}

function safeReaddir(dir, opts) {
  try {
    return fs.readdirSync(dir, opts);
  } catch {
    return [];
  }
}

module.exports = {
  discoverBaselines,
  findSnapshotDirs,
  reconstructName,
  listBaselines,
  projectIdentity,
  hasCustomTemplate,
  PLATFORM_SUFFIXES,
  DEGRADE
};
