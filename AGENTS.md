# The Fleet

Read README.md and LEARNINGS.md before changing transport, source selection, locking, cancellation or artifact handling. This is the shared program projects register with to run tests on the fleet, selected from the private worker inventory. Keep machine configuration and registrations as the single sources of truth; do not build another transport into each app.

Use TypeScript/Node for the client, Bash 3.2-compatible remote scripts and stdlib Python only for platform primitives Bash lacks. Scripts are sent inline; no installed remote daemon, scheduler or agent. Preserve existing Agent Bridge pairing and never print credentials.

Do not stage, commit, stash, clean or install the source apps. A profile reads their authoritative on-disk worktree and runs a disposable snapshot remotely. Tests needing physical devices, live desktop state or real accounts remain local. Existing Mini-only rules remain in force.

Validate changes with npm run typecheck and meaningful focused tests. For lifecycle changes exercise the exact supervisor locally and the real Mini route. A passed test requires actual nonzero test execution, verified declared artifacts and confirmed cleanup. Preserve failures after RESULT. Automatic cleanup is limited to foreground coordinator maintenance of an exact marked stale job, under the kernel guard and with no existing reservation. Never unlink the kernel admission inode or release ownership while job processes remain. Report suspicious process memory; never treat raw swap use or a large process as proof of a leak or authority to stop unrelated work. User-requested — 2026-11-02.

New generic projects should register suitable real automated tests and try the available fleet first. Do not add toy tests merely to satisfy registration. Project adapter commands and selected paths must come from their actual owning source; a registration is not execution evidence.

The Fleet is generic. Keep personal app adapters and worker guidance outside this repository. All normal CLI and Agent Bridge operations must share the local coordinator; direct SSH is allowed after centrally reserving capacity. Saved profiles are optional. Keep old protocol/path names stable where changing them would break existing workers.
