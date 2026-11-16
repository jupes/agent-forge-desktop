# Agent Forge Desktop

The desktop product for exploring Beads and dependencies, managing projects, and working with agent sessions and runs. This repository owns the desktop UI, Windows native shell, desktop tests, and app distribution.

The cloneable [Forge Harness](https://github.com/jupes/agent-forge-harness) remains the headless engine and agent-workflow product. Desktop consumes an exact engine commit recorded by `engine.lock.json` and the `engine` submodule; it does not keep a second engine implementation.

## Development

Use Bun 1.4.2. Clone with submodules:

```sh
git clone --recurse-submodules https://github.com/jupes/agent-forge-desktop.git
cd agent-forge-desktop
bun install --frozen-lockfile
bun run prepare
bun run typecheck
bun run test
```

`bun run prepare` assembles an ignored Git build workspace at `.work/desktop`. It copies the pinned engine and overlays the desktop-owned paths from `product.json`, preserving existing relative imports. Edit source in this repository, then prepare again; earlier generated workspaces are archived locally. Edits in a generated workspace are refused rather than discarded.

`bun run desktop:build` produces the Windows portable candidate under `.work/desktop/apps/desktop/build/windows-x64`. Native compilation requires the Rust/MSVC/Windows SDK versions listed in [desktop build documentation](apps/desktop/README.md). `bun run dashboard -- --mode desktop` starts the development renderer.

Desktop quality CI runs the complete assembled unit and browser suites, including worktree, Shift and restart journeys. The separate Windows candidate workflow builds the native executable and runs Rust checks. Build identity records both desktop and engine commits.

## Versions and downloads

App versions and downloadable installers belong to [this repository’s Releases](https://github.com/jupes/agent-forge-desktop/releases). CI artifacts remain temporary engineering candidates. There is no published stable 1.0 installer yet. Signing/channel provisioning, installer qualification and the remaining manual acceptance requirements stay open.

The current app still opens a valid harness checkout. This source split does not change workspace selection, existing projects, Beads membership, provider configuration or user data. Supporting ordinary repositories without a harness checkout is a separate product change.

## Migration and history

Git history through `c886f54814f36804f812b56f0935ca8841d72dcc` is preserved. Desktop-owned files retain their original paths. The shared engine is maintained in the harness; update its submodule and lock together after verifying compatibility. Distribution notices and licenses are assembled from the pinned engine and the desktop Rust dependency lock.

See [Repository content](apps/desktop/docs/repository-content.md) for source ownership and publication rules.
