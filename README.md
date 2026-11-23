# Agent Forge Desktop

The desktop product for exploring Beads and dependencies, managing projects, and working with agent sessions and runs. This repository owns the desktop UI, Windows native shell, desktop tests, and app distribution.

To use the Windows app, open a valid Agent Forge Harness checkout in the workspace chooser. The harness also runs on its own as a CLI and browser dashboard. Desktop pins its engine revision in `engine.lock.json` and the `engine` submodule. [Get the harness](https://github.com/jupes/agent-forge-harness#get-started)

![Agent Forge Desktop’s Projects view with two example projects, their pinned status, and controls for opening a project or asking Keeper.](apps/desktop/docs/screenshots/projects-home.png)

<details>
<summary>See how a project tracks dependencies</summary>

![The Beads Dependencies tab shows that the selected task is blocked by another task that is in progress.](apps/desktop/docs/screenshots/beads-detail.png)

</details>

## Development

Use Bun 1.4.2. Clone with submodules:

```sh
git clone --recurse-submodules https://github.com/jupes/agent-forge-desktop.git
cd agent-forge-desktop
bun run prepare
bun install --cwd=.work/desktop --frozen-lockfile
bun run typecheck
bun run test
```

`bun run prepare` assembles an ignored Git build workspace at `.work/desktop`. It copies the pinned engine and overlays the desktop-owned paths from `product.json`, preserving existing relative imports. Edit source in this repository, then prepare again; earlier generated workspaces are archived locally. Edits in a generated workspace are refused rather than discarded.

`bun run desktop:build` produces the Windows portable candidate under `.work/desktop/apps/desktop/build/windows-x64`. Native compilation requires the Rust/MSVC/Windows SDK versions listed in [desktop build documentation](apps/desktop/README.md). `bun run dashboard --mode desktop` starts the development renderer.

Desktop quality CI runs the complete assembled unit and browser suites, including worktree, Shift and restart journeys. The separate Windows candidate workflow builds the native executable and runs Rust checks. Build identity records both desktop and engine commits.

## Versions and downloads

There is no published stable 1.0 installer yet. Published downloads belong on the Releases page. Windows CI produces temporary engineering candidates with checksums and source evidence. [Releases](https://github.com/jupes/agent-forge-desktop/releases) · [Windows release distribution](docs/release-distribution.md)

The unpublished RC4 built from `dac04ed3` passed fresh installation and a witnessed upgrade from corrected RC2 on Windows. Both paths verified the three NSIS notices and ended with a clean uninstall. The upgrade test recorded file identity when RC2 was installed. An ordinary RC2 installation without that record preserves the superseded dashboard file. [Installer lifecycle run](https://github.com/jupes/agent-forge-desktop/actions/runs/45079743947)

Installed Settings and launch after an actual Windows sign-in remain unverified. Stable 1.0 also awaits human workflow and accessibility checks, publisher signing, signed update-channel testing and redistribution review. [Candidate walkthrough](apps/desktop/docs/manual-1.0-candidate.md)

## Migration and history

Git history through `c886f54814f36804f812b56f0935ca8841d72dcc` is preserved. Desktop-owned files retain their original paths. The shared engine is maintained in the harness; update its submodule and lock together after verifying compatibility. Distribution notices and licenses are assembled from the pinned engine and the desktop Rust dependency lock.

See [Repository content](apps/desktop/docs/repository-content.md) for source ownership and publication rules.
