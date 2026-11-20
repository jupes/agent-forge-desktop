# Bundled Bun runtime originals

The portable engineering build stages 34 original upstream files under
legal/bun/ and records their exact provenance in
RUNTIME-DEPENDENCY-INVENTORY.json. The checked-in source is
third-party/bun-1.4.2/INVENTORY.json. Every original retains its upstream
repository, revision, path, Git blob SHA1, byte length and SHA256. Selected
native/build components also identify the Bun build-definition blob from
bun-v1.4.2. The collector verifies both hashes before copying any original.

The compiler must report Bun 1.4.2 with revision prefix 744846f84, matching
the pinned build runtime. Reads require bounded regular UTF8 files, refuse
linked originals/parents and duplicate Windows paths, and preserve all bytes.
There is no build-time network fetch, archive extraction or execution of
the collected source header. The outer CANDIDATE.json hashes staged files.

This is a conservative, selected source/build review set. Node's root license,
for example, carries a broader source notice collection; copying it does not
assert that every named component is linked into our binaries. Root license
files can themselves point to additional files. No alternative license is
selected by the collector.

The staged set includes the pinned Zstandard original and the complete SQLite
upstream declaration in `legal/bun/sqlite/LICENSE.md`, including its exceptions
for non-public-domain build scripts. The SQLite declaration is pinned to
[`sqlite/sqlite` at `3ee9f406`](https://github.com/sqlite/sqlite/blob/3ee9f4064e0025a029d648c5374a4d9db10aaa32/LICENSE.md).
Bun 1.4.2 selects its in-tree `src/jsc/bindings/sqlite/sqlite3.c` through build
definition blob `6d6eec0375d67bfee4f227ddc7f8015ffa98951c`. The declaration
is a separately pinned policy reference. The [Bun amalgamation](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/jsc/bindings/sqlite/sqlite3.c)
reports SQLite 3.53.2 with the upstream source ID. A byte comparison against
the [official 3.53.2 amalgamation](https://sqlite.org/releaselog/3_53_2.html)
found a formatting directive and generated parser differences for
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`. The vendored file has Git blob
`332ed4f45cd023ffccf42bcc82d13bd8ff3db7ae` and differs from the official
download. Exact parser regeneration, the remaining file-specific notices and
binary/source correspondence still require review.

The manifest deliberately retains releaseDisposition: hold. Remaining work
includes full Windows runtime membership and file-specific notices, Bun's
complete own MIT grant, Rust/polyfill/generated-source and patch mapping,
SQLite build and file correspondence, other named components, corresponding-source and build/relink
obligations, and actual NSIS terms and installer payload qualification.
WebKit's LGPL text and upstream links alone do not establish fulfillment of
source or relinking requirements.

Cargo originals and the actual compiled-sidecar NPM input inventories are
separate layers described in [distribution inventory](distribution-inventory.md)
and [compiled notices](compiled-notices.md). These collected bytes prepare
the independent content review; they do not certify complete release notices.
