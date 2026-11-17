# Startup registration during install and uninstall

The Windows package uses one current-user location under the Windows user's
LocalAppData folder: **Agent Forge Harness**. A portable copy does not initialize
launch-at-login registration. Install the app before managing that setting.

An in-place update keeps the active installation generation. Uninstall retires
that generation before deleting payload files. A later reinstall creates a new
generation; a delayed Settings request from the old installation cannot enable
startup again. Downgrades, alternate locations and automatic migration from a
machine-wide installation are refused.

Close the app and its owned sessions before changing the installation. The
package checks the desktop, desktop-host and hearth executables together. It
does not force running processes to stop. Cancellation or an uncertain check
preserves the installation.

Only the exact startup command owned by the retiring generation may be removed.
Foreign, malformed and unreadable Run values remain unchanged. The package
keeps profile data, startup receipts and unknown or retired state. Obsolete
payload files can remain after an in-place update.

A timeout, abnormal helper exit, unresolved earlier operation or failed durable
verification stops deletion. Matching registry state alone does not establish
success. Do not automatically replay an unknown lifecycle operation. A
retirement followed by cancellation stays retired. An interrupted payload copy
can leave the previous generation active; this is not a transactional rollback
guarantee.

Source evidence includes the shared 51-case legacy-journal corpus, 40 isolated
pure/native policy tests, and a compiled custom NSIS template with an inert
payload. Compiler success proves syntax and plugin export resolution. It does
not establish runtime structure marshalling, a real install/uninstall, registry
effects, signing, logon behavior or human release acceptance. The installed
candidate has not been replaced by this source work.
