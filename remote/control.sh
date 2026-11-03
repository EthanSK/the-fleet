# Fleet Runner lock and job control. Sent inline after lib.sh by
# `fleet-runner status`, `cancel` and `lock clear`.
#
# Arguments: root action [grace_s]
#   status       print the lock state and recent job results (read-only)
#   cancel       ask the running job's supervisor to stop it (cancel-requested
#                file); the supervisor then stops the process group, cleans
#                up and releases the lock itself
#   clear-stale  remove a lock only after re-verifying it is stale, and clear
#                that dead job's leftover scratch
#
# Conservative by design: a busy lock is never cleared, and processes are only
# signalled directly when their supervisor is gone AND they are verified to
# belong to the recorded job (same leader start time, or a working directory
# inside that job's folder). Unrelated processes are never touched.

FR_ROOT=$1
ACTION=$2
GRACE_S=${3:-20}
EXPECTED_JOB=${4:-}
fr_check_root "$FR_ROOT"
fr_is_uint "$GRACE_S" || GRACE_S=20
if [ -n "$EXPECTED_JOB" ]; then
  fr_is_job_id "$EXPECTED_JOB" || exit 64
  if [ -d "$FR_ROOT/locks/shared/$EXPECTED_JOB" ]; then
    FR_JOB_LOCK="$FR_ROOT/locks/shared/$EXPECTED_JOB"
  elif [ "$(fr_kv_get "$FR_ROOT/locks/heavy/owner" job_id)" != "$EXPECTED_JOB" ]; then
    printf 'result=unverified job-not-found\n'
    exit 0
  fi
fi
LOCK=$(fr_lock_dir)

# True when process group $1 is verifiably the recorded job (owner file $2).
fr_group_is_job() {
  _pgid=$1
  _owner=$2
  _recorded_start=$(fr_kv_get "$_owner" job_start)
  _job_dir=$(fr_kv_get "$_owner" job_dir)
  if [ -n "$_recorded_start" ] && [ "$(fr_proc_start "$_pgid")" = "$_recorded_start" ]; then
    return 0
  fi
  [ -n "$_job_dir" ] || return 1
  command -v lsof >/dev/null 2>&1 || return 1
  for _pid in $(pgrep -g "$_pgid" 2>/dev/null); do
    _cwd=$(lsof -a -d cwd -p "$_pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
    case "$_cwd" in "$_job_dir"|"$_job_dir"/*) return 0 ;; esac
  done
  return 1
}

case "$ACTION" in
  status)
    printf 'lock=%s\n' "$(fr_lock_state)"
    fr_shared_states
    if [ -d "$FR_ROOT/jobs" ]; then
      printf 'jobs_kb=%s\n' "$(du -sk "$FR_ROOT/jobs" 2>/dev/null | awk '{print $1}')"
      _count=0
      for _name in $(ls -1t "$FR_ROOT/jobs" 2>/dev/null); do
        fr_is_job_id "$_name" || continue
        _result="$FR_ROOT/jobs/$_name/result"
        [ -f "$_result" ] || continue
        _count=$((_count + 1))
        [ "$_count" -le 10 ] || break
        printf 'job=%s %s %s %s %s %s\n' "$_name" \
          "$(fr_kv_get "$_result" reason)" "$(fr_kv_get "$_result" exit_code || printf -- '-')" \
          "$(fr_kv_get "$_result" started || printf -- '-')" "$(fr_kv_get "$_result" ended || printf -- '-')" \
          "$(fr_kv_get "$_result" label)"
      done
    fi
    if [ -d "$FR_ROOT/cache" ]; then
      for _cache in "$FR_ROOT"/cache/*; do
        [ -d "$_cache" ] || continue
        printf 'cache=%s %s\n' "${_cache##*/}" "$(du -sk "$_cache" 2>/dev/null | awk '{print $1}')"
      done
    fi
    ;;
  cancel)
    if [ -z "$EXPECTED_JOB" ] && [ "$(fr_lock_state)" = free ]; then
      for _shared in "$FR_ROOT"/locks/shared/*; do
        [ ! -d "$_shared" ] || { printf 'result=unverified specify-job-id\n'; exit 0; }
      done
    fi
    _state=$(fr_lock_state)
    case "$_state" in
      free) printf 'result=nothing-running\n' ;;
      stale*) printf 'result=stale %s\n' "$_state" ;;
      busy*)
        _owner="$LOCK/owner"
        _job=$(fr_kv_get "$_owner" job_id)
        _job_dir=$(fr_kv_get "$_owner" job_dir)
        case "$_state" in
          *orphaned-processes)
            _pgid=$(fr_kv_get "$_owner" job_pgid)
            if ! fr_group_alive "$_pgid" && [ -f "$_job_dir/upload.owner" ]; then
              _owner="$_job_dir/upload.owner"
              _pgid=$(fr_kv_get "$_owner" job_pgid)
            fi
            if ! fr_group_alive "$_pgid" && [ -f "$_job_dir/finalizer.owner" ]; then
              _owner="$_job_dir/finalizer.owner"
              _pgid=$(fr_kv_get "$_owner" job_pgid)
            fi
            if fr_group_is_job "$_pgid" "$_owner"; then
              kill -TERM -- "-$_pgid" 2>/dev/null
              _waited=0
              while fr_group_alive "$_pgid" && [ "$_waited" -lt $((GRACE_S * 2)) ]; do sleep 0.5; _waited=$((_waited + 1)); done
              fr_group_alive "$_pgid" && kill -KILL -- "-$_pgid" 2>/dev/null
              printf 'result=stopped-orphaned %s\n' "$_job"
            else
              printf 'result=unverified %s\n' "$_job"
            fi
            ;;
          *)
            if [ -n "$_job_dir" ] && [ -f "$_job_dir/.fleet-job" ]; then
              : > "$_job_dir/cancel-requested"
              printf 'result=cancel-requested %s\n' "$_job"
            else
              printf 'result=unverified %s\n' "$_job"
            fi
            ;;
        esac
        ;;
    esac
    ;;
  clear-stale|reap-stale)
    if [ -z "$EXPECTED_JOB" ] && [ "$(fr_lock_state)" = free ]; then
      for _shared in "$FR_ROOT"/locks/shared/*; do
        [ ! -d "$_shared" ] || { printf 'result=unverified specify-job-id\n'; exit 0; }
      done
    fi
    _state=$(fr_lock_state)
    case "$_state" in
      free) printf 'result=free\n' ;;
      busy*) printf 'result=busy %s\n' "$_state" ;;
      stale*)
        _owner="$LOCK/owner"
        _job=$(fr_kv_get "$_owner" job_id)
        _job_dir=$(fr_kv_get "$_owner" job_dir)
        # Foreground automatic maintenance is narrower than explicit recovery.
        # Recheck the exact observed job under the persistent kernel guard;
        # an unknown owner, changed lock or symlink is never reclaimed.
        if [ "$ACTION" = reap-stale ]; then
          if ! fr_is_job_id "$EXPECTED_JOB" || [ "$_job" != "$EXPECTED_JOB" ] ||
             [ "$_job_dir" != "$FR_ROOT/jobs/$_job" ] || [ ! -f "$_job_dir/.fleet-job" ] ||
             [ -L "$FR_ROOT" ] || [ -L "$FR_ROOT/jobs" ] || [ -L "$LOCK" ] ||
             [ -L "$_owner" ] || [ -L "$_job_dir" ] || [ -L "$_job_dir/.fleet-job" ]; then
            printf 'result=unverified %s\n' "${_job:--}"
            exit 0
          fi
        fi
        # The job's processes are verified gone, so its scratch is safe to delete.
        if [ -n "$_job" ] && fr_is_job_id "$_job" && [ "$_job_dir" = "$FR_ROOT/jobs/$_job" ] && [ -f "$_job_dir/.fleet-job" ]; then
          [ -f "$_job_dir/result" ] || printf 'job_id=%s\nreason=abandoned\n' "$_job" > "$_job_dir/result"
          if ! fr_run_finalizer "$_job_dir"; then
            printf 'result=finalizer-failed %s\n' "$_job"
            exit 0
          fi
          # A successful finalizer retry may have just prepared the reports.
          # Save a bounded pending archive before the only source copy is removed.
          if [ -f "$_job_dir/job-started" ] && ! fr_capture_artifacts "$_job_dir" retain 2>> "$_job_dir/artifact-capture.log"; then
            printf 'result=artifact-capture-failed %s\n' "$_job"
            exit 0
          fi
          if ! fr_clean_job_scratch "$_job_dir"; then
            printf 'result=busy upload-still-running\n'
            exit 0
          fi
        fi
        rm -f "$_owner" "$LOCK"/owner.tmp.*
        if ! rmdir "$LOCK" 2>/dev/null; then
          printf 'result=unverified lock-not-removed\n'
          exit 0
        fi
        printf 'result=cleared %s\n' "${_job:--}"
        ;;
    esac
    ;;
  *)
    printf 'fleet-runner: unknown control action\n' >&2
    exit 64
    ;;
esac
