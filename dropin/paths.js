'use strict';

// Path hygiene at the filesystem boundary. The drop-in only ever reads the developer's own
// working tree, but the values reaching `path.join` (config rootDir, configured snapshotDir,
// directory-walk entries) are still validated before use (CWE-22).

// Strip NUL bytes — the one byte that can smuggle a truncated path past fs APIs.
function sanitizePath(p) {
  return String(p).replace(/\0/g, '');
}

// A directory entry name must be a single path component: no separators, no `.`/`..`.
// fs.readdir can't actually return anything else — enforced anyway; violations return null.
function sanitizeDirentName(name) {
  const clean = sanitizePath(name);
  if (!clean || clean === '.' || clean === '..' || clean.includes('/') || clean.includes('\\')) return null;
  return clean;
}

module.exports = { sanitizePath, sanitizeDirentName };
