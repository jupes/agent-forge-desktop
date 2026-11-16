# Desktop repository instructions

This repository owns Agent Forge Desktop. The `engine` submodule is an immutable source dependency on the harness, not a second editable engine. Change shared runtime code in the harness and update both the submodule and `engine.lock.json` after verification.

Use non-interactive commands and finite timeouts. Use Bun 1.4.2 and the pinned native tools. Never commit `.work`, `.tmp`, credentials, local trackers, provider homes or generated binaries.

Edit desktop source here; never edit `.work/desktop`. `bun run prepare` assembles the pinned engine plus desktop files and refuses to discard edits in an existing build workspace. `product.json` lists the desktop-owned build files; add new source paths there.

Run `bun run typecheck`, `bun run test`, and the affected browser/native gates. Source qualification does not establish native installer or human acceptance. Release signing remains required.

Task tracking remains in the operator’s existing harness Beads tracker. Do not initialize or publish a second tracker in this repository. Prefix new task titles with `[agent-forge-desktop]`.

Commit with `<type>(<scope>): <description>` and a `Refs:` line naming the task. Push completed work. Preserve original license/attribution files and engine source identity in every build.
