# Development

Build prerequisites and runtime setup are in the [README](../README.md). From the repository root:

```sh
npm ci
npm run check
```

The default suite includes real GDRE operations against synthetic fixtures. Provision the runtime before running it; building TypeScript alone does not verify GDRE behavior.

- `npm run build`: compile TypeScript into `dist/`.
- `npm run typecheck`: typecheck without emitting files.
- `npm test`: build and run the Node test suite.
- `npm run check`: typecheck, tests, and generated-reference freshness.
- `npm run reference:generate`: regenerate `docs/command-reference.md` after registry changes.
- `npm run reference:check`: verify the generated reference without changing it.

Keep runtime binaries, generated helper DLLs, local configuration and operation records out of Git. Do not use proprietary game assets as public test fixtures.

## Code and design references

- `src/`: typed registry, MCP adapter, execution, and operation modules.
- `native/`: fixed GDRE scripts and Windows process-helper source/scripts.
- `test/`: synthetic fixtures and unit/native/stdio tests.
- [Execution contract](operation-contract.md): current module boundaries, lifecycle, persistence, and semantic-success requirements. Read it before changing shared behavior.
- [Node baseline ADR](adr/0001-node-24-baseline.md): why the project supports Node 24 only.

Update the registry for parameter or coverage changes, regenerate the reference, and keep independent fixture expectations alongside the affected tests. Planned capabilities are not registered tools or public compatibility promises.

## Optional pre-commit checks

The tracked [pre-commit hook](../.githooks/pre-commit) runs two gates in Git Bash:

1. `git diff --cached --check` rejects staged trailing whitespace and extra blank lines at EOF, with Git's file/line diagnostics. Unstaged-only whitespace does not fail this gate.
2. `npm run typecheck` runs from the repository root. It requires Node.js, npm, and the project's installed dependencies; a missing script, missing tool, or failed check rejects the commit.

Whitespace validation reads the index, while typechecking reads the working tree, including unstaged TypeScript changes. The hook therefore does not validate the staged snapshot as a whole, and it does **not** replace `npm run check` (typechecking, tests, and generated-reference freshness).

Hook activation is an explicit maintainer opt-in. Before changing anything, inspect the effective configuration and existing hooks:

```sh
git config --show-origin --get core.hooksPath
git rev-parse --git-path hooks
```

An unset `core.hooksPath` makes the first command exit 1; inspect the hooks directory reported by the second command, including any existing `pre-commit`. If hooks or a hook manager are already configured, preserve them and integrate this check through that setup instead of replacing its hook path or overwriting a hook. An existing shell hook can run the check before continuing its other checks:

```sh
sh "$(git rev-parse --show-toplevel)/.githooks/pre-commit" || exit $?
```

Only when no existing hook setup needs preserving, explicitly enable this repository's hook directory:

```sh
git config --local core.hooksPath .githooks
```

This changes only the current checkout's local Git configuration, but overrides any inherited hook path there; do not use it to bypass an existing setup. No install/build/test command activates hooks or changes this checkout's Git configuration. The hook tests run in disposable repositories, not against the checkout's index.
