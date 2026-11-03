# Fleet Runner read-only machine check. Sent inline after lib.sh by `plan
# --preflight`, `run` and `doctor`. It never writes, installs, downloads or
# starts builds; it only reads system state and prints key=value lines.
#
# Arguments: root path_prepend(colon-separated, may be empty) tools(csv) heavy_names(csv)
#
# Limits worth knowing (also reported by doctor):
# - "Available memory" on macOS is free + inactive + speculative pages from
#   vm_stat. It ignores compressed memory and is an estimate, so the kernel's
#   pressure level is reported alongside it.
# - Heavy processes are recognized by executable name only. Jobs started by
#   other chats outside Fleet Runner don't take its lock; this is how they
#   are noticed.

FR_ROOT=$1
PATH_PREPEND=$2
TOOLS=$3
HEAVY=$4

fr_check_root "$FR_ROOT"

printf 'os=%s\n' "$(uname -s)"
printf 'arch=%s\n' "$(uname -m)"
printf 'host=%s\n' "$(hostname -s 2>/dev/null || hostname)"
printf 'user=%s\n' "$(id -un)"
printf 'bash_version=%s\n' "$BASH_VERSION"
printf 'cpu_count=%s\n' "$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"
printf 'load_average=%s\n' "$(python3 -c 'import os; print(" ".join(str(n) for n in os.getloadavg()))' 2>/dev/null)"

# Hashed hardware identity: lets doctor confirm that two names reach the same
# physical machine without printing or storing the raw device identifier.
_uuid=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/ {print $4}')
[ -n "$_uuid" ] || _uuid=$(cat /etc/machine-id 2>/dev/null)
[ -n "$_uuid" ] || _uuid="host:$(hostname)"
printf 'fingerprint=%s\n' "$(printf '%s' "$_uuid" | $(fr_sha256_cmd) | cut -c1-16)"

if [ -d "$FR_ROOT" ]; then printf 'root_exists=1\n'; else printf 'root_exists=0\n'; fi
_dir=$FR_ROOT
while [ ! -d "$_dir" ] && [ "$_dir" != "/" ]; do _dir=$(dirname "$_dir"); done
printf 'disk_free_kb=%s\n' "$(df -Pk "$_dir" 2>/dev/null | awk 'NR==2 {print $4}')"

# Display-only hardware description (model identifier, chip, OS release) for
# apps showing the fleet. Never used for identity or admission decisions.
case "$(uname -s)" in
  Darwin)
    printf 'model=%s\n' "$(sysctl -n hw.model 2>/dev/null)"
    printf 'cpu_brand=%s\n' "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
    printf 'os_version=%s\n' "$(sw_vers -productVersion 2>/dev/null)"
    printf 'mem_total_bytes=%s\n' "$(sysctl -n hw.memsize 2>/dev/null)"
    vm_stat 2>/dev/null | awk '
      /page size of/ { for (i = 1; i <= NF; i++) if ($i == "of") size = $(i + 1) }
      /^Pages free:/ { free = $3 }
      /^Pages inactive:/ { inactive = $3 }
      /^Pages speculative:/ { speculative = $3 }
      END { gsub(/\./, "", free); gsub(/\./, "", inactive); gsub(/\./, "", speculative);
            if (size > 0) printf "mem_available_bytes=%.0f\n", (free + inactive + speculative) * size }'
    printf 'mem_pressure_level=%s\n' "$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
    printf 'swap_used_mb=%s\n' "$(sysctl -n vm.swapusage 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "used") {v = $(i + 2); sub(/M$/, "", v); print v}}')"
    _console=$(stat -f %Su /dev/console 2>/dev/null)
    ;;
  *)
    printf 'model=%s\n' "$(cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null)"
    printf 'cpu_brand=%s\n' "$(awk -F': *' '/^model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null)"
    printf 'os_version=%s\n' "$( (. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME") )"
    awk '/^MemTotal:/ {printf "mem_total_bytes=%.0f\n", $2 * 1024} /^MemAvailable:/ {printf "mem_available_bytes=%.0f\n", $2 * 1024}' /proc/meminfo 2>/dev/null
    _console=''
    ;;
esac
if [ -n "$_console" ] && [ "$_console" = "$(id -un)" ]; then printf 'gui_session=1\n'; else printf 'gui_session=0\n'; fi

if tar --version 2>/dev/null | grep -q bsdtar; then printf 'tar=bsdtar\n'; else printf 'tar=other\n'; fi
for _tool in pgrep mkfifo tee find du python3; do
  command -v "$_tool" >/dev/null 2>&1 || printf 'missing_base_tool=%s\n' "$_tool"
done

# Tool lookup uses the same PATH the job will get.
_path=$PATH
if [ -n "$PATH_PREPEND" ]; then
  _prefix=''
  _old_ifs=$IFS
  IFS=:
  for _entry in $PATH_PREPEND; do
    case "$_entry" in "~/"*) _entry="$HOME/${_entry#\~/}" ;; esac
    _prefix="${_prefix}${_entry}:"
  done
  IFS=$_old_ifs
  _path="${_prefix}${PATH}"
fi
_old_ifs=$IFS
IFS=,
for _tool in $TOOLS; do
  IFS=$_old_ifs
  _found=$(PATH="$_path" command -v "$_tool" 2>/dev/null)
  if [ -n "$_found" ]; then printf 'tool=%s found\n' "$_tool"; else printf 'tool=%s missing\n' "$_tool"; fi
done
IFS=$_old_ifs

# Heavy processes outside this check's own process group.
_own_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
# Ethan's "leaks or sus things": a bounded resident-memory snapshot, never
# evidence by itself of a leak or authority to stop an unrelated process.
# Executable names only; command arguments can contain credentials.
python3 - "$_own_pgid" <<'PY'
import json, os, subprocess, sys
try:
    output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pgid=,uid=,rss=,pcpu=,etime=,comm='], text=True, timeout=10)
    rows = []
    for line in output.splitlines():
        fields = line.split(None, 7)
        if len(fields) != 8 or fields[2] == sys.argv[1]:
            continue
        try:
            pid, ppid, pgid, uid, rss = map(int, fields[:5])
            cpu = float(fields[5])
        except ValueError:
            continue
        rows.append(dict(pid=pid, ppid=ppid, pgid=pgid, uid=uid, rssKiB=rss, cpuPercent=cpu, elapsed=fields[6], name=os.path.basename(fields[7])))
    rows.sort(key=lambda p: p['rssKiB'], reverse=True)
    print('processes_json=' + json.dumps(rows[:20], separators=(',', ':')))
    print('process_count=' + str(len(rows)))
    print('process_sample=1')
except (OSError, subprocess.SubprocessError):
    print('process_sample=0')
PY
ps -axo pid=,pgid=,rss=,pcpu=,comm= 2>/dev/null | while read -r _pid _pgid _rss _cpu _comm; do
  [ "$_pgid" = "$_own_pgid" ] && continue
  _name=${_comm##*/}
  case ",$HEAVY," in
    *",$_name,"*) printf 'heavy=%s %s %s %s %s\n' "$_pid" "$_pgid" "$_rss" "$_cpu" "$_name" ;;
  esac
done

printf 'lock=%s\n' "$(fr_lock_state)"
fr_shared_states
if fr_guard_busy "$FR_ROOT/locks/admission"; then printf 'admission_free=0\n'; else printf 'admission_free=1\n'; fi
printf 'done=1\n'
