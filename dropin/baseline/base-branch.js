'use strict';

// KD2 — the seeded baseline must live on the branch the HEAD actually resolves its base against,
// or the `latest_commit` base-selection (which matches by branch) will never pick it.
//
// percy-api's `LatestCommit` strategy walks: PR-base → target-branch → default_base_branch → head
// branch. We do NOT replicate that whole chain here (the server owns it). Instead we exploit a
// structural fact: the baseline build is created with the SAME git env as the head build, so
// percy-api derives an identical `branch` for both — they automatically share a branch and the
// `id <` ordering does the rest. This module exists to make that attribution EXPLICIT and to give
// the discover/seed path the branch value for logging + the KD2 same-branch (never default-branch)
// guard: we refuse to retarget the baseline onto the default branch (irreversible mainline
// contamination — KD2 / R-lineage-permanence).
//
// `env` is a @percy/env PercyEnv instance.
function resolveBaseBranch(env) {
  // The head build's branch is what percy-api keys the baseline match on. Reusing it guarantees
  // the baseline and head share a branch without us guessing the PR/target/default fallbacks.
  const branch = env?.git?.branch || null;
  return branch;
}

module.exports = { resolveBaseBranch };
