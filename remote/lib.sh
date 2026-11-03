# Fleet Runner remote library. Prepended to every script sent to a fleet
# machine (supervisor.sh, preflight.sh, control.sh); never installed there.
#
# Written for macOS /bin/bash 3.2 as well as newer bash on Linux: no
# associative arrays, mapfile, ${x,,} or fractional `read -t`.
#
# Legacy/exclusive lock model (one lock per physical machine, shared by every alias
# because it lives on that machine's filesystem):
#   <root>/locks/heavy/         created with mkdir, which is atomic
# Shared jobs instead use <root>/locks/shared/<job-id>/ with inherited slot
# and named-resource guards, under SH admission. Exclusive work uses EX.
#   <root>/locks/heavy/owner    key=value: job_id, label, supervisor pid and
#                               start time, job process group, job folder
# A lock is BUSY while its supervisor is alive (same pid AND same start time,
# so a reused pid is not mistaken for it) or while any process remains in the
# job's process group. Only when both are gone is it STALE. Foreground
# maintenance can reclaim an exact marked stale job after coordinator ownership
# checks. It never kills a process on a stale lock's behalf; explicit
# `fleet-runner lock clear` retains its existing guarded recovery route.
# Admission and stale reclamation additionally share guard.py's persistent
# flock inode. Never unlink that inode: doing so could split its ownership.

fr_check_root() {
  case "$1" in
    /*.noindex) ;;
    *) printf 'fleet-runner: remote root must be an absolute path ending in .noindex\n' >&2; exit 64 ;;
  esac
  case "$1" in
    *'/../'*|*'/./'*|*'/..'|*'//'*) printf 'fleet-runner: remote root must be a normalized path\n' >&2; exit 64 ;;
  esac
}

fr_is_uint() {
  case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac
}

fr_is_job_id() {
  case "$1" in ''|*[!a-z0-9-]*) return 1 ;; -*) return 1 ;; *) return 0 ;; esac
}

# Reads one key from a key=value file. Prints the value; fails when absent.
fr_kv_get() {
  _fr_file=$1
  _fr_key=$2
  [ -f "$_fr_file" ] || return 1
  while IFS= read -r _fr_line || [ -n "$_fr_line" ]; do
    case "$_fr_line" in
      "$_fr_key="*) printf '%s' "${_fr_line#*=}"; return 0 ;;
    esac
  done < "$_fr_file"
  return 1
}

# Process start time with whitespace normalized; empty when the pid is gone.
fr_proc_start() {
  [ -n "$1" ] || return 0
  ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'
}

# True while any non-zombie process remains in process group $1.
fr_group_alive() {
  [ -n "$1" ] || return 1
  fr_is_uint "$1" || return 1
  for _fr_pid in $(pgrep -g "$1" 2>/dev/null); do
    _fr_state=$(ps -o stat= -p "$_fr_pid" 2>/dev/null)
    case "$_fr_state" in
      ''|Z*) ;;
      *) return 0 ;;
    esac
  done
  return 1
}

fr_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || printf '0'
}

fr_lock_dir() {
  if [ -n "${FR_JOB_LOCK:-}" ]; then printf '%s' "$FR_JOB_LOCK"; else printf '%s/locks/heavy' "$FR_ROOT"; fi
}

# Shared jobs have separate owner records. The admission inode and slot locks
# remain permanent; these removable records are only lifecycle evidence.
fr_shared_states() {
  for _shared in "$FR_ROOT"/locks/shared/*; do
    [ -d "$_shared" ] || continue
    ( FR_JOB_LOCK=$_shared
      _shared_state=$(fr_lock_state)
      case "$_shared_state" in
        free) exit 0 ;;
        'busy - '*|'stale - '*)
          # The preallocated job ID is already in the directory name before
          # the owner file exists. Keep it so the coordinator can deduplicate
          # this startup record against that same job's capacity claim.
          if fr_is_job_id "${_shared##*/}"; then
            _state_kind=${_shared_state%% *}
            _shared_state="$_state_kind ${_shared##*/} ${_shared_state#* - }"
          fi
          ;;
      esac
      printf 'shared_lock=%s\n' "$_shared_state"
      _pid=$(fr_kv_get "$_shared/owner" supervisor_pid)
      _start=$(fr_kv_get "$_shared/owner" supervisor_start)
      # Only a verified living supervisor can classify CPU work as managed.
      # Orphaned/stale PGIDs may have been reused by unrelated processes.
      if [ -n "$_start" ] && [ "$(fr_proc_start "$_pid")" = "$_start" ]; then
        printf 'managed_pgid=%s\n' "$(fr_kv_get "$_shared/owner" job_pgid)"
      fi )
  done
}

# Prints the lock state as one line:
#   free
#   busy <job_id> <started_epoch> <label> [detail]
#   stale <job_id> <started_epoch> <label>
fr_lock_state() {
  _fr_lock=$(fr_lock_dir)
  if [ ! -d "$_fr_lock" ]; then
    printf 'free\n'
    return 0
  fi
  _fr_owner="$_fr_lock/owner"
  if [ ! -f "$_fr_owner" ]; then
    # mkdir succeeded but the owner file is not written yet (or a crash in
    # that instant). Young locks are treated as busy, old ones as stale.
    _fr_age=$(( $(date +%s) - $(fr_mtime "$_fr_lock") ))
    if [ "$_fr_age" -lt 120 ]; then
      printf 'busy - - - starting\n'
    else
      printf 'stale - - -\n'
    fi
    return 0
  fi
  _fr_job=$(fr_kv_get "$_fr_owner" job_id)
  _fr_started=$(fr_kv_get "$_fr_owner" started)
  _fr_label=$(fr_kv_get "$_fr_owner" label)
  _fr_sup_pid=$(fr_kv_get "$_fr_owner" supervisor_pid)
  _fr_sup_start=$(fr_kv_get "$_fr_owner" supervisor_start)
  _fr_pgid=$(fr_kv_get "$_fr_owner" job_pgid)
  if [ -n "$_fr_sup_pid" ] && [ -n "$_fr_sup_start" ] && [ "$(fr_proc_start "$_fr_sup_pid")" = "$_fr_sup_start" ]; then
    printf 'busy %s %s %s\n' "${_fr_job:--}" "${_fr_started:--}" "${_fr_label:--}"
    return 0
  fi
  if fr_group_alive "$_fr_pgid"; then
    printf 'busy %s %s %s orphaned-processes\n' "${_fr_job:--}" "${_fr_started:--}" "${_fr_label:--}"
    return 0
  fi
  _fr_job_dir=$(fr_kv_get "$_fr_owner" job_dir)
  if [ "$_fr_job_dir" = "$FR_ROOT/jobs/$_fr_job" ] && fr_upload_busy "$_fr_job_dir"; then
    printf 'busy %s %s %s orphaned-processes\n' "${_fr_job:--}" "${_fr_started:--}" "${_fr_label:--}"
    return 0
  fi
  if [ "$_fr_job_dir" = "$FR_ROOT/jobs/$_fr_job" ] && fr_guard_busy "$_fr_job_dir/finalizer.guard"; then
    printf 'busy %s %s %s orphaned-processes\n' "${_fr_job:--}" "${_fr_started:--}" "${_fr_label:--}"
    return 0
  fi
  if [ "$_fr_job_dir" = "$FR_ROOT/jobs/$_fr_job" ] && fr_guard_busy "$_fr_job_dir/archive.guard"; then
    printf 'busy %s %s %s orphaned-processes\n' "${_fr_job:--}" "${_fr_started:--}" "${_fr_label:--}"
    return 0
  fi
  printf 'stale %s %s %s\n' "${_fr_job:--}" "${_fr_started:--}" "${_fr_label:--}"
}

fr_sha256_cmd() {
  if command -v shasum >/dev/null 2>&1; then
    printf 'shasum -a 256'
  else
    printf 'sha256sum'
  fi
}

# Extraction of existing fr_finish scratch cleanup from supervisor.sh, now
# also used for stale-job recovery. The added checks constrain both callers
# to a marked, non-symlink job folder directly under this runner's root.
fr_clean_job_scratch() {
  _clean_dir=$1
  _clean_id=${_clean_dir##*/}
  fr_is_job_id "$_clean_id" || return 1
  [ "$_clean_dir" = "$FR_ROOT/jobs/$_clean_id" ] || return 1
  [ ! -L "$_clean_dir" ] && [ -f "$_clean_dir/.fleet-job" ] || return 1
  fr_wait_upload "$_clean_dir" || return 1
  # Failed external capture keeps the original output for a verified retry.
  [ ! -f "$_clean_dir/meta/large-scratch-failed" ] || return 1
  if [ -f "$_clean_dir/meta/large-scratch-owner.json" ]; then
    python3 -B "$_clean_dir/meta/large_scratch.py" cleanup "$_clean_dir" || return 1
  fi
  for _scratch in "$_clean_dir"/* "$_clean_dir"/.[!.]* "$_clean_dir"/..?*; do
    case "${_scratch##*/}" in
      .fleet-job|meta|result|stdout.log|stderr.log|supervisor.log|control.in|cancel-requested|upload.guard|archive.guard|finalizer.guard|finalizer.owner|finalizer.done|finalizer.result|finalizer.log|artifact-capture.log|artifacts.pending) ;;
      artifacts.tar) [ -f "$_clean_dir/artifacts.pending" ] || rm -f -- "$_scratch" ;;
      *) rm -rf -- "$_scratch" ;;
    esac
  done
}

# Immutable output archives may be internal or in this job's verified scratch.
# The Python reader pins the external file; cat must never reopen a mount path.
fr_archive_size() {
  if [ -f "$1/meta/large-scratch-owner.json" ]; then
    python3 -B "$1/meta/large_scratch.py" size "$1"
  else
    [ -f "$1/artifacts.tar" ] && [ ! -L "$1/artifacts.tar" ] || return 1
    wc -c < "$1/artifacts.tar" | tr -d ' '
  fi
}

fr_archive_stream() {
  if [ -f "$1/meta/large-scratch-owner.json" ]; then
    python3 -B "$1/meta/large_scratch.py" stream "$1"
  else
    cat "$1/artifacts.tar"
  fi
}

# Shared by normal completion and explicit stale recovery. The hook is trusted,
# idempotent profile code; failure keeps the lock and full source for retry.
fr_run_finalizer() {
  _final_dir=$1
  [ -f "$_final_dir/job-started" ] || return 0
  [ -f "$_final_dir/meta/finalizer.sh" ] || return 0
  [ -f "$_final_dir/finalizer.done" ] && return 0
  [ -f "$_final_dir/meta/finalize.py" ] || return 1
  python3 "$_final_dir/meta/finalize.py" "$_final_dir"
}

# Read-only probe: the open-file lock survives in a receiver or its tar child,
# including after an unexpected supervisor exit.
fr_upload_busy() { fr_guard_busy "$1/upload.guard"; }

# Extracted from fr_upload_busy: finalizers need the same inherited-lock probe.
fr_guard_busy() {
  [ -f "$1" ] || return 1
  python3 - "$1" <<'PY'
import fcntl, os, sys
try:
    fd = os.open(sys.argv[1], os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)
    finally:
        # End the probe's critical section before interpreter teardown.
        os.close(fd)
    sys.exit(1)
except OSError:
    sys.exit(0)
PY
}

# Terminal result files make active receivers stop themselves. Keep ownership
# if one cannot be quiesced; never delete underneath a still-writing upload.
fr_wait_upload() {
  python3 - "$1/upload.guard" <<'PY'
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
deadline = time.monotonic() + 12
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(0.1)
PY
}

# Extraction of existing artifact symlink checking from supervisor.sh.
# True when any component of $2 under directory $1 is a symlink, so an
# artifact path can't lead outside the job folder.
fr_has_symlink_component() {
  _base=$1
  _rest=$2
  _path=$_base
  _old_ifs=$IFS
  IFS=/
  for _part in $_rest; do
    _path="$_path/$_part"
    if [ -L "$_path" ]; then IFS=$_old_ifs; return 0; fi
  done
  IFS=$_old_ifs
  return 1
}


# Extraction of existing fr_send_artifacts capture code from supervisor.sh.
# Both terminal paths use the same limits, hashes and tar writer. The added
# retain mode refuses scratch deletion when declared results cannot be saved.
fr_capture_artifacts() (
  JOB_DIR=$1
  _capture_mode=${2:-stream}
  _capture_id=${JOB_DIR##*/}
  fr_is_job_id "$_capture_id" || return 1
  [ "$JOB_DIR" = "$FR_ROOT/jobs/$_capture_id" ] && [ ! -L "$JOB_DIR" ] && [ -f "$JOB_DIR/.fleet-job" ] || return 1
  case "$_capture_mode" in stream|retain) ;; *) return 1 ;; esac
  # Never overwrite an unacknowledged archive during a repeated stale clear.
  if [ -f "$JOB_DIR/artifacts.pending" ]; then
    fr_archive_size "$JOB_DIR" >/dev/null || return 1
    rm -f "$JOB_DIR/meta/large-scratch-failed"
    return $?
  fi
  fr_capture_notice() {
    if [ "$_capture_mode" = stream ]; then fr_proto "$*"
    else printf '%s\n' "$*" >> "$JOB_DIR/artifact-capture.log"; fi
  }
  _capture_failed=0
  [ -f "$JOB_DIR/meta/artifacts" ] || return 0
  _max_kb=$(cat "$JOB_DIR/meta/max-artifact-kb" 2>/dev/null)
  fr_is_uint "$_max_kb" || _max_kb=0
  set --
  _total_kb=0
  while IFS= read -r _rel || [ -n "$_rel" ]; do
    [ -n "$_rel" ] || continue
    case "$_rel" in
      /*|-*|..|../*|*/..|*/../*) _capture_failed=1; fr_capture_notice "ARTIFACT-REJECTED $_rel"; continue ;;
    esac
    if fr_has_symlink_component "$JOB_DIR/src" "$_rel"; then
      _capture_failed=1
      fr_capture_notice "ARTIFACT-REJECTED $_rel"
      continue
    fi
    if [ ! -e "$JOB_DIR/src/$_rel" ]; then
      _capture_failed=1
      fr_capture_notice "ARTIFACT-MISSING $_rel"
      continue
    fi
    # Count logical bytes, not allocated blocks: sparse files expand in tar.
    _kb=$(python3 - "$JOB_DIR/src/$_rel" <<'PY'
import os, stat, sys
root = sys.argv[1]
total = 0
if os.path.isfile(root):
    total = os.stat(root).st_size
else:
    for directory, _, names in os.walk(root, followlinks=False):
        for name in names:
            info = os.lstat(os.path.join(directory, name))
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
print((total + 1023) // 1024)
PY
)
    fr_is_uint "$_kb" || _kb=0
    _total_kb=$((_total_kb + _kb))
    # "./" keeps names like "!x" or "(x" from being read as find/tar syntax.
    set -- "$@" "./$_rel"
  done < "$JOB_DIR/meta/artifacts"
  if [ "$_capture_mode" = retain ] && [ "$_capture_failed" = 1 ]; then return 1; fi
  [ "$#" -gt 0 ] || return 0
  if [ "$_total_kb" -gt "$_max_kb" ]; then
    fr_capture_notice "ARTIFACTS-TOO-LARGE $_total_kb"
    return 1
  fi
  _sha=$(fr_sha256_cmd)
  # "hash  path" lines; shasum prefixes "\" when a name needs escaping, and
  # such names are skipped (the CLI then rejects the unlisted file).
  if ! ( cd "$JOB_DIR/src" && find "$@" -type f -exec $_sha {} + 2>/dev/null ) > "$JOB_DIR/meta/artifact-hashes.part"; then
    fr_capture_notice 'ARTIFACTS-FAILED'
    # Preserve ordinary return: a bounded archive can still be retained on
    # failed verification. Stale cleanup must instead keep its source copy.
    [ "$_capture_mode" = retain ] && return 1
  fi
  if [ -f "$JOB_DIR/meta/large-scratch.json" ] && [ ! -f "$JOB_DIR/meta/large_scratch.py" ]; then
    : > "$JOB_DIR/meta/large-scratch-failed"
    fr_capture_notice 'ARTIFACTS-FAILED large scratch helper is missing; original outputs retained'
    return 73
  fi
  if [ -f "$JOB_DIR/meta/large_scratch.py" ]; then
    if _store=$(python3 -B "$JOB_DIR/meta/large_scratch.py" capture "$JOB_DIR" "$((_total_kb * 1024))" "$((_max_kb * 1024 + 1048576))" "$@" 2>> "$JOB_DIR/artifact-capture.log"); then
      :
    else
      _archive_status=$?
      if [ "$_archive_status" = 75 ]; then
        fr_capture_notice "DISK-SPACE $_store"
        # Explicit stale recovery uses key/value output rather than the
        # supervisor stream. Keep the same typed cause in both transports.
        [ "$_capture_mode" != retain ] || printf 'disk_space_problem=%s\n' "$_store"
        _archive_status=73
      fi
      fr_capture_notice 'ARTIFACTS-FAILED'
      return "$_archive_status"
    fi
    [ "$_store" != external ] || fr_capture_notice 'NOTE large output archive uses verified external scratch'
  else
  # Compatibility for retained jobs uploaded before the shared archive helper.
  # New jobs use the one Python writer for internal and external destinations.
  _tar_flags=''
  if tar --version 2>/dev/null | grep -q bsdtar; then _tar_flags='--no-mac-metadata'; fi
  if ! ( cd "$JOB_DIR/src" && COPYFILE_DISABLE=1 python3 -c '
import os, resource, sys
limit = int(sys.argv[1])
resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
os.execvp("tar", ["tar", *sys.argv[2:]])
' "$((_max_kb * 1024 + 1048576))" $_tar_flags -cf "$JOB_DIR/artifacts.tar.part" "$@" ); then
    fr_capture_notice "ARTIFACTS-FAILED"
    return 1
  fi
  mv -f "$JOB_DIR/artifacts.tar.part" "$JOB_DIR/artifacts.tar" || return 1
  fi
  mv -f "$JOB_DIR/meta/artifact-hashes.part" "$JOB_DIR/meta/artifact-hashes" || return 1
  : > "$JOB_DIR/artifacts.pending" || return 73
  rm -f "$JOB_DIR/meta/large-scratch-failed"
)
