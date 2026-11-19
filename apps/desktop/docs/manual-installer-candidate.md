# Windows installer review candidate

This packet contains an unsigned installer compiled from the identified desktop
source and pinned engine. It is prepared for attended testing. It is not an
accepted public 1.0 release. The build does not launch the installer or app.

`INSTALLER-CANDIDATE.json` records the source, resource inputs, installer hash,
actual template and rendered script hashes. `bundle-config.json` adds the staged
legal files and inventories to the existing dashboard resources. `installer.nsi`
is the actual rendered compiler input. The ordinary portable candidate remains
available separately.

Installer manifest schema 2 records `mainBinarySha256` for the executable
extracted from the installer and `portableMainBinarySha256` for the portable
input. Pinned Tauri 2.12.3 changes its bundle marker for NSIS and then restores
the input file. The build verifies that this is the only byte difference;
release preparation independently derives the NSIS hash from the portable ZIP.

Signing, publisher key/channel, runtime source/relink obligations, current NSIS
payload obligations and human acceptance remain open. The included inventories
retain their explicit coverage holds. Compilation alone does not establish
installation, startup, retirement or uninstall behavior.

## Attended Windows checks

Wait until the operator permits foreground work. Keep the previous candidate,
profile and original receipts available before replacing the running app.

1. Verify the installer bytes match `INSTALLER-CANDIDATE.json` and record the
   source commit, engine and Windows account used. The artifact is unsigned;
   record the actual Windows trust prompt and the operator's choice.
2. Close the existing app and its owned Hearth normally. Record whether any
   recovery dialog belongs to the older binary; do not force termination.
3. Exercise the current-user install at its fixed LocalAppData target. Record
   refusal or success and the actual installed executable path. An unsupported
   legacy target or running process should be preserved and refused.
4. Launch the installed app. Select the real harness project, explore its
   Beads and dependencies, and verify project navigation and Runs. Start a
   supported session only with the operator's intended Bead and worktree.
5. Change appearance, save, and exercise normal navigation. Close the new app:
   ordinary Close/Quit should exit without the repeated confirmation dialog.
   Confirm that the app's owned host and Hearth retire and that unrelated
   processes remain running. Tray keep-alive is deferred to 1.1.
6. Read and change launch-at-login through Settings, recording exact outcomes.
   Exercise upgrade/retirement/uninstall only as the next attended test step;
   preserve foreign entries, pending uncertainty and the existing profile.
7. Record the actual remaining files, startup value and profile state after
   uninstall. Do not substitute compiler logs or pure tests for this evidence.

Keep private transcripts, tokens, session keys and raw diagnostic homes out of
the review packet. Record fixed outcome facts and source identities instead.
