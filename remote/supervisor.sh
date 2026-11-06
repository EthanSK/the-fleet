# Fleet Runner job supervisor. Sent inline after lib.sh by `fleet-runner run`
# over one ssh session; it lives only for one job (no daemon, no queue).
#
# Arguments: root job_id nonce timeout_s grace_s upload_timeout_s keep_jobs label
#
# Why the remote side owns the lifecycle: the laptop can sleep, lose Wi-Fi or
# be interrupted. This process holds its job lock and inherited capacity, enforces the timeout
# itself, and releases the lock only after the job's whole process group is
# confirmed gone. A local timeout, Ctrl-C or crash therefore can't orphan a
# compiler while the lock says the machine is free.
#
# Channels (fd 3 = ssh stdout, fd 4 = ssh stderr; fd 0 = control from the CLI):
#   before the job   "@@FR <WORD> ..." protocol lines on stdout
#   during the job   raw job stdout/stderr, also copied to stdout.log/stderr.log
#   end of job       "\n@@FR-<nonce>@@END\n" on stdout (stripped by the CLI;
#                    the random nonce means job output can't collide with it)
#   after the job    protocol lines, then "@@FR ARTIFACTS <bytes>" + raw tar
# Control lines from the CLI: UPLOADED, ABORT, CANCEL, ACK. End of input means
# the CLI went away: the job is cancelled and cleaned up.
#
# The supervisor's own stderr goes to the job's supervisor.log, so bash's job
# notices never mix into the job's stderr.

FR_ROOT=$1
JOB_ID=$2
NONCE=$3
TIMEOUT_S=$4
GRACE_S=$5
UPLOAD_TIMEOUT_S=$6
KEEP_JOBS=$7
LABEL=$8

umask 077
# Ignore SIGPIPE so a vanished client causes write errors, not a dead
# supervisor that never cleans up. The job itself gets the default back.
trap '' PIPE
exec 3>&1 4>&2

fr_proto() {
  printf '@@FR %s\n' "$*" >&3
}

fr_fail_early() {
  fr_proto "ERROR $1"
  exit "${2:-70}"
}

fr_check_root "$FR_ROOT"
fr_is_job_id "$JOB_ID" || fr_fail_early 'invalid job id' 64
case "$NONCE" in ''|*[!A-Za-z0-9]*) fr_fail_early 'invalid nonce' 64 ;; esac
for _value in "$TIMEOUT_S" "$GRACE_S" "$UPLOAD_TIMEOUT_S" "$KEEP_JOBS"; do
  fr_is_uint "$_value" || fr_fail_early 'invalid numeric argument' 64
done
case "$LABEL" in ''|*[!A-Za-z0-9/._-]*) fr_fail_early 'invalid label' 64 ;; esac

mkdir -p "$FR_ROOT/locks" "$FR_ROOT/jobs" 2>/dev/null || fr_fail_early "can't create $FR_ROOT" 73
# Pending archives cannot rotate away before verified return. Bound their
# count by admission instead of deleting an unacknowledged result.
_pending=0
for _marker in "$FR_ROOT"/jobs/*/artifacts.pending; do
  [ -f "$_marker" ] && _pending=$((_pending + 1))
done
[ "$_pending" -lt "$KEEP_JOBS" ] || fr_fail_early 'recover pending artifacts before starting another job' 73
LOCK=$(fr_lock_dir)
JOB_DIR="$FR_ROOT/jobs/$JOB_ID"

# ------------------------------------------------------------------ lock
if ! mkdir "$LOCK" 2>/dev/null; then
  fr_proto "BUSY $(fr_lock_state)"
  exit 75
fi
SUPERVISOR_START=$(fr_proc_start $$)
LOCKED_AT=$(date +%s)
JOB_PGID=''
RESOURCE_SAMPLES=0
RESOURCE_PEAK_RSS_KIB=0
RESOURCE_PEAK_CPU_PERCENT=0

fr_write_owner() {
  _tmp="$LOCK/owner.tmp.$$"
  {
    printf 'job_id=%s\n' "$JOB_ID"
    printf 'label=%s\n' "$LABEL"
    printf 'started=%s\n' "$LOCKED_AT"
    printf 'supervisor_pid=%s\n' "$$"
    printf 'supervisor_start=%s\n' "$SUPERVISOR_START"
    printf 'job_pgid=%s\n' "$JOB_PGID"
    printf 'job_start=%s\n' "$(fr_proc_start "$JOB_PGID")"
    printf 'job_dir=%s\n' "$JOB_DIR"
    printf 'capacity_class=%s\n' "${FLEET_RUNNER_WORKLOAD:-standard}"
    printf 'cache_name=%s\n' "${FLEET_RUNNER_CLAIM_CACHE:-}"
  } > "$_tmp" && mv -f "$_tmp" "$LOCK/owner"
}
fr_write_owner

fr_release_lock() {
  [ "$(fr_kv_get "$LOCK/owner" job_id)" = "$JOB_ID" ] || return 1
  rm -f "$LOCK/owner" "$LOCK"/owner.tmp.*
  rmdir "$LOCK"
}

if ! mkdir "$JOB_DIR" 2>/dev/null; then
  fr_release_lock
  fr_fail_early 'job folder already exists' 73
fi
: > "$JOB_DIR/.fleet-job"
exec 2>>"$JOB_DIR/supervisor.log"

SIGNALLED=''
trap 'SIGNALLED=TERM' TERM
trap 'SIGNALLED=INT' INT
trap 'SIGNALLED=HUP' HUP

# --------------------------------------------------------------- control
# bash 3.2 can't tell a `read -t` timeout from end of input, so a background
# reader appends control lines to a file and writes EOF when the CLI goes away.
CTL="$JOB_DIR/control.in"
: > "$CTL"
exec 5<&0
( trap '' PIPE INT HUP
  while IFS= read -r _line; do printf '%s\n' "$_line" >> "$CTL"; done
  printf 'EOF\n' >> "$CTL" ) <&5 &
READER_PID=$!
exec 5<&- 0</dev/null
CTL_SEEN=0

# Sets CTL_LINE to the next unread control line; fails when there is none.
fr_ctl_next() {
  _total=$(wc -l < "$CTL" | tr -d ' ')
  [ "$_total" -gt "$CTL_SEEN" ] || return 1
  CTL_SEEN=$((CTL_SEEN + 1))
  CTL_LINE=$(sed -n "${CTL_SEEN}p" "$CTL")
  return 0
}

# --------------------------------------------------------------- helpers
fr_stop_group() {
  _pgid=$1
  kill -TERM -- "-$_pgid" 2>/dev/null
  _waited=0
  while fr_group_alive "$_pgid" && [ "$_waited" -lt $((GRACE_S * 2)) ]; do
    sleep 0.5
    _waited=$((_waited + 1))
  done
  if fr_group_alive "$_pgid"; then
    kill -KILL -- "-$_pgid" 2>/dev/null
    _waited=0
    while fr_group_alive "$_pgid" && [ "$_waited" -lt 20 ]; do
      sleep 0.5
      _waited=$((_waited + 1))
    done
  fi
  ! fr_group_alive "$_pgid"
}

fr_wait_pid_bounded() {
  [ -n "$1" ] || return 0
  _waited=0
  while kill -0 "$1" 2>/dev/null && [ "$_waited" -lt "$2" ]; do
    sleep 0.5
    _waited=$((_waited + 1))
  done
  kill "$1" 2>/dev/null
  wait "$1" 2>/dev/null
  return 0
}

# Sample only this owned process group. Reuse the supervisor's existing polling
# loop: no extra sleep, idle daemon, command arguments or per-sample log files.
# ps CPU percentages are process-lifetime averages, not instantaneous CPU time;
# summed RSS includes shared pages. These are bounded estimates, not accounting.
fr_sample_resources() {
  [ -n "$JOB_PGID" ] || return 0
  _resource_sample=$(LC_ALL=C ps -axo pgid=,rss=,pcpu= 2>/dev/null | LC_ALL=C awk -v pgid="$JOB_PGID" -v samples="$RESOURCE_SAMPLES" -v peak_rss="$RESOURCE_PEAK_RSS_KIB" -v peak_cpu="$RESOURCE_PEAK_CPU_PERCENT" '
    $1 == pgid { found=1; rss += $2; cpu += $3 }
    END { if (found) samples++; if (rss > peak_rss) peak_rss=rss; if (cpu > peak_cpu) peak_cpu=cpu; printf "%d %.0f %.2f", samples, peak_rss, peak_cpu }')
  [ -n "$_resource_sample" ] && read -r RESOURCE_SAMPLES RESOURCE_PEAK_RSS_KIB RESOURCE_PEAK_CPU_PERCENT <<< "$_resource_sample"
  return 0
}

fr_write_result() {
  {
    printf 'job_id=%s\n' "$JOB_ID"
    printf 'label=%s\n' "$LABEL"
    printf 'reason=%s\n' "$REASON"
    printf 'exit_code=%s\n' "$EXIT_CODE"
    printf 'started=%s\n' "$JOB_STARTED"
    printf 'ended=%s\n' "$JOB_ENDED"
    printf 'stragglers=%s\n' "$STRAGGLERS"
    printf 'stuck=%s\n' "$STUCK"
    printf 'resource_samples=%s\n' "$RESOURCE_SAMPLES"
    printf 'peak_rss_kib=%s\n' "$RESOURCE_PEAK_RSS_KIB"
    printf 'peak_process_cpu_percent=%s\n' "$RESOURCE_PEAK_CPU_PERCENT"
  } > "$JOB_DIR/result"
}

# Keeps only the last 16 MiB of each retained log.
fr_cap_logs() {
  for _log in "$JOB_DIR/stdout.log" "$JOB_DIR/stderr.log" "$JOB_DIR/supervisor.log" "$JOB_DIR/finalizer.log"; do
    [ -f "$_log" ] || continue
    _size=$(wc -c < "$_log" | tr -d ' ')
    if [ "$_size" -gt 16777216 ]; then
      tail -c 16777216 "$_log" > "$_log.tmp" && mv -f "$_log.tmp" "$_log"
    fi
  done
}

# Deletes the oldest finished job folders beyond KEEP_JOBS. Only folders this
# runner created (.fleet-job marker) whose job finished (result file) and whose
# scratch is already gone are removed; a stuck job's folder is kept.
fr_prune_jobs() {
  _count=0
  for _name in $(ls -1t "$FR_ROOT/jobs" 2>/dev/null); do
    _count=$((_count + 1))
    [ "$_count" -gt "$KEEP_JOBS" ] || continue
    [ "$_name" = "$JOB_ID" ] && continue
    fr_is_job_id "$_name" || continue
    _dir="$FR_ROOT/jobs/$_name"
    # Another job may already have its terminal result while still returning
    # outputs or running a finalizer. Its owner record protects its evidence.
    [ -d "$FR_ROOT/locks/shared/$_name" ] && continue
    [ "$(fr_kv_get "$FR_ROOT/locks/heavy/owner" job_id)" = "$_name" ] && continue
    [ -f "$_dir/meta/large-scratch-owner.json" ] && continue
    fr_guard_busy "$_dir/archive.guard" && continue
    if [ -f "$_dir/.fleet-job" ] && [ -f "$_dir/result" ] && [ ! -e "$_dir/src" ] && [ ! -f "$_dir/artifacts.pending" ]; then
      rm -rf "$_dir"
    fi
  done
}

fr_bound_cache() {
  # Shared jobs use guard.py's cache usage lock. Only the last departed user
  # can evict, after all inherited cache descriptors have closed.
  [ -n "${FLEET_RUNNER_SHARED_JOB:-}" ] && return 0
  [ -n "$CACHE_DIR" ] || return 0
  [ -d "$CACHE_DIR" ] || return 0
  _kb=$(du -sk "$CACHE_DIR" 2>/dev/null | awk '{print $1}')
  if fr_is_uint "$_kb" && [ "$_kb" -gt "$CACHE_MAX_KB" ]; then
    rm -rf "$CACHE_DIR"
    fr_proto "NOTE cache $CACHE_NAME exceeded its limit and was cleared"
  fi
}

fr_wait_for_ack() {
  [ "$REASON" = disconnected ] && return 1
  _deadline=$(( $(date +%s) + 600 ))
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    while fr_ctl_next; do
      case "$CTL_LINE" in ACK) return 0 ;; NACK|EOF|ABORT|CANCEL) return 1 ;; esac
    done
    sleep 0.5
  done
  return 1
}

fr_send_artifacts() {
  fr_capture_artifacts "$JOB_DIR" stream
  _capture_status=$?
  if [ "$_capture_status" = 73 ]; then CAPTURE_FAILED=1; return 0; fi
  [ "$_capture_status" = 0 ] || return 0
  [ -f "$JOB_DIR/artifacts.pending" ] || return 0
  while IFS= read -r _line; do
    case "$_line" in \\*) continue ;; esac
    _file=${_line#*  }
    fr_proto "AF ${_line%%  *} ${_file#./}"
  done < "$JOB_DIR/meta/artifact-hashes"
  _bytes=$(fr_archive_size "$JOB_DIR") || return 1
  fr_proto "ARTIFACTS $_bytes"
  fr_archive_stream "$JOB_DIR" >&3 || return 1
  if fr_wait_for_ack; then
    rm -f "$JOB_DIR/artifacts.pending"
  else
    fr_proto "NOTE artifacts retained for verified recovery: $JOB_DIR"
  fi
}

# Ends the session: artifacts (finished jobs only), cleanup, lock release.
fr_finish() {
  JOB_ENDED=$(date +%s)
  fr_write_result
  fr_wait_upload "$JOB_DIR" || STUCK=1
  FINALIZER_FAILED=0
  CLEANUP_FAILED=0
  CAPTURE_FAILED=0
  if [ "$STUCK" = 0 ] && ! fr_run_finalizer "$JOB_DIR"; then
    FINALIZER_FAILED=1
    fr_proto 'FINALIZER-FAILED'
  fi
  fr_write_result
  fr_proto "RESULT reason=$REASON exit_code=$EXIT_CODE started=$JOB_STARTED ended=$JOB_ENDED stragglers=$STRAGGLERS stuck=$STUCK resource_samples=$RESOURCE_SAMPLES peak_rss_kib=$RESOURCE_PEAK_RSS_KIB peak_process_cpu_percent=$RESOURCE_PEAK_CPU_PERCENT"
  if [ -n "$JOB_STARTED" ] && [ "$STUCK" = 0 ] && [ "$FINALIZER_FAILED" = 0 ]; then
    fr_send_artifacts
  fi
  rm -f "$JOB_DIR/stdout.fifo" "$JOB_DIR/stderr.fifo"
  if [ "$CAPTURE_FAILED" = 1 ]; then
    CLEANUP_FAILED=1
  elif [ "$STUCK" = 0 ] && [ "$FINALIZER_FAILED" = 0 ]; then
    # Includes profile scratch directly under @JOB_DIR@, such as DerivedData.
    fr_clean_job_scratch "$JOB_DIR" || CLEANUP_FAILED=1
    fr_bound_cache
  fi
  fr_cap_logs
  fr_write_result
  fr_prune_jobs
  if [ "$FINALIZER_FAILED" = 1 ]; then
    fr_proto 'LOCK-KEPT finalizer-failed'
  elif [ "$CLEANUP_FAILED" = 1 ]; then
    fr_proto 'LOCK-KEPT scratch cleanup is unverified'
  elif [ "$STUCK" = 0 ]; then
    fr_release_lock && fr_proto 'RELEASED'
  else
    # Never release while job processes might still be running.
    fr_proto "LOCK-KEPT processes remain in group $JOB_PGID"
  fi
  fr_proto 'BYE'
  kill "$READER_PID" 2>/dev/null
  wait "$READER_PID" 2>/dev/null
  exit 0
}

REASON=completed
EXIT_CODE=''
JOB_STARTED=''
JOB_ENDED=''
STRAGGLERS=0
STUCK=0
CACHE_DIR=''
CACHE_NAME=''
CACHE_MAX_KB=0

# ---------------------------------------------------------------- upload
fr_proto "READY $JOB_DIR"
_deadline=$(( $(date +%s) + UPLOAD_TIMEOUT_S ))
_uploaded=''
while [ -z "$_uploaded" ]; do
  while fr_ctl_next; do
    case "$CTL_LINE" in
      UPLOADED) _uploaded=1 ;;
      ABORT|EOF) REASON=aborted ;;
      CANCEL) REASON=cancelled ;;
    esac
  done
  [ -n "$SIGNALLED" ] && REASON=cancelled
  [ -e "$JOB_DIR/cancel-requested" ] && REASON=cancelled
  [ "$(date +%s)" -ge "$_deadline" ] && REASON=upload-timeout
  [ "$REASON" = completed ] || fr_finish
  [ -n "$_uploaded" ] || sleep 0.5
done

if [ ! -d "$JOB_DIR/src" ] || [ ! -f "$JOB_DIR/meta/command.sh" ] || [ ! -f "$JOB_DIR/meta/expected-count" ]; then
  fr_proto 'ERROR upload is incomplete'
  REASON=upload-failed
  fr_finish
fi
_expected=$(cat "$JOB_DIR/meta/expected-count")
if [ -f "$JOB_DIR/meta/source-rsync" ]; then
  if [ ! -f "$JOB_DIR/meta/rsync-verified" ] || [ "$(cat "$JOB_DIR/meta/rsync-verified")" != "$(cat "$JOB_DIR/meta/source-rsync")" ]; then
    fr_proto 'ERROR rsync source was not verified'
    REASON=upload-failed
    fr_finish
  fi
fi
_actual=$(cd "$JOB_DIR/src" && find . \( -type f -o -type l \) | wc -l | tr -d ' ')
if [ "$_expected" != "$_actual" ]; then
  fr_proto "ERROR upload is incomplete ($_actual of $_expected entries)"
  REASON=upload-failed
  fr_finish
fi

# ----------------------------------------------------------- environment
if [ -f "$JOB_DIR/meta/cache" ]; then
  read -r CACHE_NAME CACHE_MAX_KB < "$JOB_DIR/meta/cache"
  if fr_is_job_id "$CACHE_NAME" && fr_is_uint "$CACHE_MAX_KB"; then
    CACHE_DIR="$FR_ROOT/cache/$CACHE_NAME"
    mkdir -p "$CACHE_DIR"
    export FLEET_RUNNER_CACHE_DIR="$CACHE_DIR"
  else
    CACHE_NAME=''
  fi
fi
if [ -f "$JOB_DIR/meta/isolated-tmp" ]; then
  mkdir -p "$JOB_DIR/tmp"
  export TMPDIR="$JOB_DIR/tmp/"
fi
export FLEET_RUNNER=1
export FLEET_RUNNER_JOB_ID="$JOB_ID"
export FLEET_RUNNER_JOB_DIR="$JOB_DIR"
export FLEET_RUNNER_SRC_DIR="$JOB_DIR/src"

# ------------------------------------------------------------------- job
mkfifo "$JOB_DIR/stdout.fifo" "$JOB_DIR/stderr.fifo"
: > "$JOB_DIR/stdout.log"
: > "$JOB_DIR/stderr.log"
tee -a "$JOB_DIR/stdout.log" < "$JOB_DIR/stdout.fifo" >&3 2>/dev/null &
TEE_OUT=$!
tee -a "$JOB_DIR/stderr.log" < "$JOB_DIR/stderr.fifo" >&4 2>/dev/null &
TEE_ERR=$!

JOB_STARTED=$(date +%s)
: > "$JOB_DIR/job-started"
fr_proto "STARTED $JOB_STARTED"
# set -m gives the job its own process group (pgid = its pid), so the whole
# tree - compilers, test hosts, helpers - can be signalled and checked at once.
set -m
( trap - PIPE INT TERM HUP
  cd "$JOB_DIR/src" && exec /bin/bash "$JOB_DIR/meta/command.sh" ) > "$JOB_DIR/stdout.fifo" 2> "$JOB_DIR/stderr.fifo" < /dev/null &
JOB_PGID=$!
set +m
fr_write_owner

_deadline=$((JOB_STARTED + TIMEOUT_S))
_resource_tick=0
while kill -0 "$JOB_PGID" 2>/dev/null; do
  if [ "$((_resource_tick % 10))" = 0 ]; then fr_sample_resources; fi
  _resource_tick=$((_resource_tick + 1))
  while fr_ctl_next; do
    case "$CTL_LINE" in
      CANCEL|ABORT) REASON=cancelled ;;
      EOF) REASON=disconnected ;;
    esac
  done
  [ -e "$JOB_DIR/cancel-requested" ] && REASON=cancelled
  [ -n "$SIGNALLED" ] && REASON=cancelled
  [ "$(date +%s)" -ge "$_deadline" ] && REASON=timeout
  [ "$REASON" = completed ] || break
  sleep 0.5
done
fr_sample_resources

if [ "$REASON" != completed ]; then
  fr_stop_group "$JOB_PGID"
fi
wait "$JOB_PGID" 2>/dev/null
EXIT_CODE=$?
# Background children the job left behind are part of the job too.
if fr_group_alive "$JOB_PGID"; then
  STRAGGLERS=1
  fr_stop_group "$JOB_PGID" || STUCK=1
fi

# Let the log copies drain, then mark the end of job output.
fr_wait_pid_bounded "$TEE_OUT" 10
fr_wait_pid_bounded "$TEE_ERR" 10
printf '\n@@FR-%s@@END\n' "$NONCE" >&3

fr_finish
