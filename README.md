# mend

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/iwankejar-ops/mend-20261122/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/iwankejar-ops/mend-20261122/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree of files: unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool-call edits. It finds the lines each edit names at the first of three matching tiers and writes every change or none.

Entry for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/c/hidden-spec-cli-01-run-20261122) (https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Run

    node main.ts [options] [PATCH]

`PATCH` is the patch file, or standard input when absent or `-`. See `SPEC.md` for the full specification.

## Files

- `main.ts` — the CLI (Node 22, standard library only)
- `runner.ts` — the trial runner, kept as the kit has it
- `check.ts` — practice checks on your own machine
- `SPEC.md` — the whole specification

## Tests

Practice set: 100 of 100 passed, practice score 1000.
