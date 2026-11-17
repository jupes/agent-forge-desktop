# Repository content

This repository owns Desktop UI, native host code, installers, release tooling,
product documentation and desktop tests. Shared Hearth and workflow source lives
in the pinned `engine` submodule. Change shared source upstream and advance the
submodule and `engine.lock.json` together after verification.

The desktop package and lockfile own native build dependencies. The assembled
`.work/desktop` checkout combines those dependencies with the pinned engine;
`.work` is generated local state and must never be committed.

Keep credentials, provider homes, local configuration, Beads databases, native
`target` output, generated installers and test reports outside the tracked tree.
Distribute qualified binaries through GitHub Release assets. Environment examples
must contain placeholders only. Required licenses and source attribution belong
in the source and distribution.

Use synthetic project data and generic paths in documentation and tests. Inspect
new captures for local filesystem paths and account or unrelated project details.
A screenshot demonstrates only the state actually captured; it does not establish
installer qualification or human acceptance.

Removing a current file does not erase its earlier Git history, cached copies or
forks. Any required history cleanup must be coordinated with the harness and its
existing immutable engine pins.
