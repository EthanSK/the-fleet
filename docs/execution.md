# Managed job execution

## Incremental source transfer

Set `"sourceTransfer": "rsync"` on a profile with a named bounded `cache`, for example `"cache": { "name": "my-project-setup", "maxGiB": 4 }`. The default remains streamed tar. Rsync requires `/usr/bin/rsync` on the client and ship and uses the same paired SSH route and options.

The selector and SHA-256 manifest define the exact source: staged, unstaged and untracked on-disk files, exclusions, sizes, modes and safe relative symlinks. The client checks local staging space and validates each input as it copies it to `source-staging.noindex/<job-id>/` under the Fleet state home (normally `~/.the-fleet` on the internal SSD). This fully ephemeral copy is independent of `TMPDIR` and the results-folder setting. An explicit state-home override also relocates staging. The client verifies the original source once more after syncing, before allowing the job to start, then removes the copy. The receiver verifies the copied bytes against the manifest. Logs, receipts, returned reports and retained recovery archives remain in the configured results folder on external storage. A missing external results drive still refuses the run; there is no fallback to internal results storage.

Fleet keeps one verified source baseline per project worktree inside the named cache. The key uses a hash of the resolved source root, so switching worktrees does not overwrite a neighbour's retained copy. Concurrent uploads seed independent job directories from that baseline. On macOS copying asks for copy-on-write clones and can fall back to ordinary copies on unsupported volumes. Rsync then sends differences and deletions, and Fleet verifies the exact private tree it will execute. A failed sync cannot write into a retained baseline. If retention will not fit, Fleet can still run the verified private tree. Existing cache limits and post-job retention apply.

The upload guard covers rsync, verification and baseline publication; cancellation/disconnection stops the receiver before cleanup. Receipts include staging, sync and original-source recheck times, rsync's reported sent/received protocol bytes and a `rsync.log`. The byte counts describe the rsync protocol. Every new ship still needs real-route qualification. A registered machine or a controlled multi-ship fixture is not that evidence.

Normal completion, transfer failure and cancellation remove local staging after rsync exits. If a client is force-killed, a later run reclaims only marked staging whose recorded client and rsync processes are gone, even if the results drive is unavailable. Rsync waits until its PID is recorded before reading source; losing the controller before that point closes the launch gate without starting a reader. Recovery preserves live or unknown ownership, unrelated files, logs, receipts and returned results. Older run-folder staging is still reclaimed conservatively; an old interrupted launch with an unknown child PID is preserved.

```json
{
  "schemaVersion": 1,
  "id": "my-project",
  "sync": { "include": ["package.json", "package-lock.json", "src/**", "test/**"] },
  "profiles": {
    "test": {
      "description": "Run automated tests",
      "kind": "test",
      "prepare": [["npm", "ci", "--no-audit", "--no-fund"]],
      "argv": ["npm", "test"],
      "timeoutMinutes": 10,
      "requires": { "tools": ["node", "npm"] },
      "success": { "minTestCount": { "pattern": "# tests (\\d+)", "min": 1 } }
    }
  }
}
```

Choose the test-count pattern from the real runner output. `test` profiles require a positive count or specific required output; zero tests must not count as a pass. `build` and `check` profiles are labelled separately. Build success is not test evidence. Profile schema and defaults are owned by `src/schema/manifest.ts`; `validate` reports unsupported fields.

## Inputs, outputs and limits

Patterns are rooted at the source directory. `*` matches one path segment, `**` matches any depth, `{a,b}` picks alternatives, and a directory name includes its subtree. Character classes are unsupported. Include only required source and fixtures. Safety rules always block known credentials, VCS internals and browser stores. Default rules exclude dependencies, caches, logs, databases and generated folders. Narrow `sync.allowDefaultExcluded` deliberately when a fixture genuinely needs one of these. Filename rules are a guard, not a secret scanner.

Symlinks are not followed for source transfer. Only relative links contained by the source root are sent. Required external dependencies must already exist remotely or be explicitly prepared in the disposable job. Credentials, app archives, live browser profiles and personal runtime state must not be copied.

Profiles accept argv arrays, `prepare` steps, `env`, `pathPrepend`, `cwd`, tool/GUI requirements, timeout, success patterns and relative `artifacts`. `@JOB_DIR@`, `@SRC_DIR@`, `@CACHE_DIR@` expand to owned remote paths. Caches are opt-in, named and bounded; share only disposable dependency caches. Cache tools remain serialized unless `cache.concurrent` opts in to safe simultaneous use. Ordinary profiles consume bounded job slots; `exclusive` and named `resources` declare actual conflicts. See README’s shared job capacity contract. Leave `isolatedTmp` false for test hosts needing short macOS socket paths, including Better Git.

### Reusing installed dependencies

Opt in with `cache.setup` for a relocatable generated directory such as `node_modules`. All declared inputs must be regular files selected for upload. This example includes the package files and a script that applies an installation patch:

```json
{
  "name": "my-project-setup",
  "maxGiB": 8,
  "setup": {
    "directory": "node_modules",
    "inputs": ["package.json", "package-lock.json", "scripts/patch-install.mjs"],
    "runtime": [["node", "--version"], ["npm", "--version"]],
    "steps": [["npm", "ci", "--ignore-scripts", "--prefer-offline"], ["node", "scripts/patch-install.mjs"]]
  }
}
```

List every install input, including workspace package manifests and patch files. Add ambient environment names that affect installation under `keyEnv`. Fleet also keys the cache by the setup commands, tool paths and version output, host platform and architecture, and declared job environment. Runtime probes run on the ship and their output is hashed. A cold job runs setup in the profile's working directory. A warm macOS job requests an independent copy-on-write clone of the installed tree. Other systems run setup normally. Setup output that contains absolute or escaping symlinks is left in the disposable job. Retained trees share the named cache's size limit. Keep setup steps reproducible and independent of the absolute job path.

By default, setup sees and keys every variable declared in the profile or ship configuration. Set `declaredEnv` to the list of declared names needed by setup when other variables only apply to the job itself. An empty list is valid. Declared variables outside `declaredEnv` and `keyEnv` are removed from setup commands and version probes. Ordinary `prepare`, the job command and its finalizer still see their original environment.

Fleet checks the allocated KiB reported by `du -sk` for the private clone and named cache before publishing a source baseline or setup copy. Uncertain measurements or insufficient space skip publication and leave the job's private tree usable. Old setup keys remain until the named cache is cleared. If later writes put it over its cap, the last job to release it can clear the whole cache using that job's limit. Give profiles sharing a cache name a consistent cap.

Use the profile's ordinary `prepare` steps for work required on every job. Fleet does not initialize Git inside the disposable source. If a command needs a Git snapshot, declare that setup only in the profiles that use it.

Use a profile's `extraInputs` for additional fixtures needed only by that profile. These patterns extend `sync.include` under the same exclusions, credential rules and byte limits. For example, Wand's normal software tests use a small input set; its `full-test` profile also selects manufacturing CAD files. `show` lists the extra patterns and `plan` measures the selected profile's actual transfer.

Returned regular files require a matching SHA-256. Absolute paths, traversal, hard links, escaping symlinks and writes through symlinks are rejected. Every declared output must return verified content. Logical sizes and archive creation are bounded. A pass also requires confirmed job cleanup and lock release.

Only successful archive extraction, hash checks and declared-output completeness send `ACK`. A failed check sends `NACK`; connection EOF also leaves the archive unacknowledged. The remote retains its bounded `artifacts.tar`, original hashes and declaration after removing disposable source. This includes available outputs from cancelled or timed-out jobs. Recover them with `the-fleet recover <job-id> --machine mini`; recovery uses the same verification, records a new local recovery receipt and deletes the remote copy only after verified return. It never changes the original test outcome. The pending archive count is capped by the machine's `keepJobs` limit: admission refuses further jobs at the cap, and retention never rotates an unacknowledged archive away. Each archive is capped by its profile's artifact limit plus 1 MiB of archive metadata.

After a verified return and confirmed job cleanup, the controller removes its temporary `artifacts.tar.part` copy. Extracted outputs, logs and receipts stay available. Incomplete, unverified or unconfirmed returns retain their local transfer copy for recovery; this does not change the worker's pending-archive policy.

Fleet reports the end of execution, output transfer, verification, and cleanup. Once a complete archive is available, Fleet can delete disposable source during the return. The job keeps its admission guard until the cleanup child has exited. The final receipt still waits for cleanup. If a managed job is active, recovery tells the caller to wait for the original operation. After cleanup, if the ship has no pending archive and the receipt records a complete return, recovery points to that receipt.

Preflight reports the pending archive count and checks the same existing `keepJobs` cap, so automatic managed-job selection skips a full ship. The supervisor rechecks the count before its job lock, upload or command starts; a cap filled since preflight uses the existing conclusive `BUSY` refusal and next-candidate path. Generic connection errors and admitted jobs never replay. Direct-SSH reservations do not create these managed archives and retain their existing admission checks.

Profiles which start detached resources must declare an idempotent ownership-checked `finalizer`, for example `"finalizer": { "argv": ["python3", "scripts/stop-owned-job.py", "@JOB_DIR@"], "timeoutSeconds": 30 }`. The finalizer runs after the ordinary job group has stopped on success, failure, cancellation, disconnection and timeout, before artifacts are captured or source/scratch is deleted. It shares the profile environment, paths, cwd and placeholders; it does not rerun prepare steps. Its explicit limit is 1–300 seconds, followed by bounded TERM/KILL cleanup. Use the job ID/folder to target only resources that profile created; there is no generic Docker pruning.

Failure, timeout or leftover hook processes keep that job’s owner record and full source. Once the failed hook has stopped, Fleet can still return already prepared artifacts. Inspect `finalizer.log` and `finalizer.result`, fix the cause, then explicitly run `the-fleet lock clear --machine mini --job JOB_ID`: stale recovery invokes the same hook and only deletes scratch after success. The hook may be retried after a crash and must therefore be idempotent. A kernel guard also covers the hook and its children. A finalizer is not run for a cancelled upload that never started its command.

Explicit and automatic stale cleanup both allow up to 360 seconds for the worker call, including its finalizer, output capture and scratch cleanup.

After a successful stale finalizer retry, lock clearing captures the declared outputs into the same bounded archive and hash metadata used by normal completion. The archive stays pending for `recover` before source/scratch is deleted. Missing, unsafe, oversized or unwritable declared outputs keep both source and lock instead of deleting the only copy; inspect `artifact-capture.log` before another explicit clear. Repeated clearing reuses an already pending archive. Neither cleanup nor recovery changes the original failed result or receipt.

## Ownership and stopping

SSH compresses streamed source transfers; no local snapshot copy is created. The remote supervisor takes an atomic lock before upload, enforces the timeout and stops the process group on cancel or input disconnection. TERM is followed by KILL after the configured grace. Remaining processes keep the lock. The permanent kernel admission guard lets ordinary shared jobs coexist under bounded slot/resource locks; exclusive work and stale cleanup require exclusive admission. Separate owner records identify each shared job. A separate per-job transfer guard stops active uploads before cleanup and refuses late uploads after a terminal result. Never delete the persistent `locks/admission` file.

```sh
the-fleet cancel --machine mini
the-fleet status --machine mini
the-fleet lock clear --machine mini
```

Foreground coordinator maintenance may clear an exact marked stale job only when no reservation exists. It rechecks the expected job under the same kernel guard, refuses live supervisors/groups/uploads/finalizers and keeps unknown or symlink ownership. It shares the finalizer, bounded artifact capture and scratch cleanup used by explicit recovery. Ordinary discovery remains read-only; large resident memory and swap never authorize termination. Explicit clearing continues to refuse an active supervisor or process group. There is no background watcher, local fallback, retry queue or paid-model invocation. Programs that deliberately detach into a different process group are outside ordinary group containment; finite profiles may use detached resources only with their ownership-checked finalizer. Permanent services or daemons are outside these profiles. Other tools do not take this runner's lock, so preflight checks for existing compilers and refuses conflicts by default.

Source and temporary scratch are removed from the owned job folder after successful cleanup; an unacknowledged bounded archive survives for recovery. Failed finalizers retain source and ownership. Remote evidence and local receipts use bounded counts, with the pending-output admission limit described above. Logs grow while a job runs and are capped remotely afterward; use finite, reasonably quiet profiles. The runner does not clean other workspaces or arbitrary files a trusted profile writes outside its job root.
