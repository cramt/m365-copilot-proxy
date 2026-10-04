---
name: safe-rebase-pull
description: "Safely pull latest changes from origin/main in this repo with rebase, require a clean committed worktree first, integrate both sides of conflicts without dropping upstream additions, exclude Falcon-triggering openclaw paths, avoid keeping local nix changes, and validate the complete result."
argument-hint: "Optional: remote and branch (defaults: origin main), plus conflict preference overrides"
---

# Safe Rebase Pull

## What This Skill Produces

- Local branch rebased onto latest upstream branch (default: origin/main).
- Local commits replayed on top of upstream, with explicit conflict policy.
- Falcon-sensitive openclaw paths excluded from checkout.
- Local nix changes intentionally excluded during conflict resolution.
- Existing user changes are preserved because the operation does not stash, reset,
  clean, or drop worktree changes.
- Upstream additions are checked for omission after conflict resolution.
- Builds and unit tests pass before the operation is reported complete.

## Safety Invariants

- Never stash, reset, clean, discard, or drop user work as part of this skill.
- Require the user to commit existing changes before changing checkout state.
- During a rebase, `ours` means the upstream base currently checked out by the
	rebase, and `theirs` means the local commit currently being replayed. These
	names are the opposite of what many users expect from a normal merge.
- Never resolve a substantial non-Nix conflict by blindly taking an entire file
	from one side. Whole-file selection can silently remove unrelated upstream
	exports, helpers, tests, options, or runtime behavior.
- After the rebase, treat a successful Git status as necessary but insufficient:
	compile-time and behavior-level checks are required.

## When To Use

- You need latest upstream while keeping local commits.
- Your machine may kill git operations when openclaw folders are checked out.
- Rebase stops with stale lock files or interrupted metadata.
- You want to keep local product changes but not local nix changes.

## Inputs

- Remote name: default origin.
- Branch name: default main.
- Local conflict policy for non-nix files: decide per file each run.
- A clean worktree with all intended changes already committed before starting.
- The pre-rebase commit, recorded before pulling, so the result can be audited.

## Procedure

1. Preflight snapshot.
- Run: git status --short --branch
- Run: git remote -v
- Run: git branch -vv
- Confirm current branch and divergence.
- Record the current commit before any pull: `git rev-parse HEAD`.
- If the status output contains any modified, staged, deleted, or untracked paths,
	stop and ask the user to commit the existing changes before continuing.
- Do not stash, reset, clean, discard, or otherwise alter those existing changes.
- Continue only after the user confirms the changes are committed and the worktree
	is clean. Re-run `git status --short --branch` to verify.

2. Recover interrupted state before new pull.
- If rebase is in progress and should be restarted: git rebase --abort
- If index lock exists and no active git process is running:
- Run: rm -f .git/index.lock
- Do not abort an active rebase without confirming that it is stale or the user
	explicitly asked to restart it.

3. Apply Falcon-safe sparse checkout exclusions.
- Run: git sparse-checkout init --no-cone
- Run: git sparse-checkout set --no-cone '/*' '!/packages/openclaw/' '!/packages/openclaw/**' '!/packages/openclaw-plugin/' '!/packages/openclaw-plugin/**'
- Verify: git sparse-checkout list

4. Rebase pull from upstream.
- Run: git pull --rebase <remote> <branch>
- Default command: git pull --rebase origin main
- Do not proceed if the pull did not fetch the requested upstream branch.
- If Git stops for conflicts, do not run `git rebase --continue` until every
	unmerged path has been reviewed and staged intentionally.

5. Resolve conflicts with branching rules.
- Decision rule A (nix files): do NOT keep local nix changes.
- For nix conflicts, keep upstream side during rebase:
- Run: git diff --name-only --diff-filter=U | rg '^nix/|\.nix$' | xargs -I{} git checkout --ours -- '{}'
- Run: git diff --name-only --diff-filter=U | rg '^nix/|\.nix$' | xargs -I{} git add -- '{}'

- Decision rule B (non-Nix files): merge at hunk or symbol level.
- First enumerate conflicts: `git diff --name-only --diff-filter=U`.
- For every conflicted file, inspect all three views before editing:
- Run: `git diff --ours -- <path>`
- Run: `git diff --theirs -- <path>`
- Run: `git diff --cc -- <path>`
- Read the relevant upstream and local commits with `git show` when the hunk's
	intent is unclear.
- Preserve compatible changes from both sides. Manually combine imports,
	exports, signatures, constants, tests, and adjacent logic where both are valid.
- Choose `git checkout --ours -- <path>` only when the whole upstream version is
	intentionally authoritative for that file. Choose `git checkout --theirs --
	<path>` only when the whole replayed local version is intentionally
	authoritative. Record why in the working notes or final report.
- For modify/delete conflicts, determine which side intentionally deleted the
	file. For excluded sparse paths, use `git rm --sparse <path>` when accepting a
	deletion; do not let sparse-checkout hide an unresolved index entry.
- Stage only after review: `git add <path>` or `git rm --sparse <path>`.
- Run `git diff --cached --check` after each conflict set.

- Continue rebase.
- Run: git rebase --continue
- Repeat conflict resolution until complete.

6. Audit for omitted upstream changes.
- Confirm there are no unresolved paths:
	`git diff --name-only --diff-filter=U` must be empty.
- Check the complete rebased range, not only the conflict files:
- Run: `git diff --stat <pre-rebase-head> HEAD`
- Run: `git --no-pager log --oneline --decorate --graph --max-count=12`
- Review every file changed by the rebased commits, including files Git merged
	automatically. Automatic merging does not prove that cross-file contracts
	survived.
- For every changed public export, type, function, option, or method signature:
	search its definition, all imports/exports, and all call sites. Pay special
	attention to changes that add a parameter or optional object: update every
	caller and verify boolean/object meanings were not swapped.
- Compare upstream additions in conflict-heavy files against the final result.
	Check for missing model IDs, exported helpers, feature flags, allowed message
	types, stream fields, parser patterns, and tests.
- Specifically inspect stream implementations when a rebase touches streaming:
	queue and completion state must live outside the iterator factory so early
	deltas cannot be dropped; final snapshots must not duplicate already-emitted
	text.
- Specifically inspect feature additions that cross modules. For example, image
	generation requires the auth token helper, public types, session options,
	request capability flags, frame capture, and the consumer call site together.

7. Verify success.
- Run: git status --short --branch
- Expected: ahead N, behind 0 (or no behind count).
- Run: git merge-base --is-ancestor <remote>/<branch> HEAD
- Expected exit code: 0
- Run: git --no-pager log --oneline --decorate --graph --max-count=12

8. Build and test the result.
- Run the narrowest relevant check first for the changed package.
- Then run the repository checks when available:
- Run: `pnpm build`
- Run: `pnpm test`
- If a focused test fails, fix the same local slice and rerun it before widening
	the investigation. Do not report success based on Git status alone.

9. Post-checks.
- Verify openclaw folders are not present in working tree checkout.
- Verify no unresolved merge markers remain.
- Verify nix files reflect upstream, not local replayed edits.
- Run: `git diff --check`
- Run: `git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- .` and confirm no
	conflict markers remain in tracked files.
- Keep Falcon-safe sparse checkout exclusions enabled for this repo.
- Do not drop, rewrite, or clean any existing stash entries.

## Common Failure Recovery

- Rebase says rebase-merge already exists:
- Check git status.
- If stale and clean, run git rebase --abort, then retry from step 4.

- Worktree is not clean at preflight:
- Stop and ask the user to commit the changes.
- Do not create a temporary stash as a substitute for user confirmation.

- A conflict was resolved by taking one whole file and later a symbol or export
	is missing:
- Recover the pre-rebase commit from the recorded hash and compare it with both
	conflict stages. Revisit the file at hunk/symbol level; do not repeat the
	whole-file choice.
- Search for the missing symbol in `origin/<branch>`, the replayed commit, and
	all current call sites. A clean build may not catch an unexercised runtime
	contract, so add or run a focused test.

- The build passes but behavior changed after a signature conflict:
- Compare the definition and every caller. Test both old/default and new option
	paths, especially streaming, tools, image generation, model selection, and
	proxy response modes.

- Rebase or pull dies with signal 9:
- Re-check sparse exclusions from step 3.
- Retry git pull --rebase after confirming openclaw paths are excluded.

- Ref update lock errors during rebase continue:
- Confirm no git process is active.
- Remove stale lock files under .git if present.
- Retry git rebase --continue.

## Completion Criteria

- Upstream branch is an ancestor of HEAD.
- Branch includes latest upstream commits plus expected local commits.
- No unmerged files remain.
- Falcon-sensitive paths remain excluded.
- No pre-existing user changes were stashed or dropped.
- Nix conflicts were resolved to upstream side.
- All changed cross-file contracts were audited for matching definitions,
	exports, and call sites.
- `pnpm build` and `pnpm test` pass, or any unavailable check is explicitly
	reported as a limitation.
