# Helpers for the scripts a bb machine runs on itself. Prepended to each of
# them rather than sourced — only one file is sent to the sandbox — so keep
# this free of side effects.

# Sets DATA, PORT and SERVER. Discovered, not derived: bb connect can mint a
# different tunnel URL than the machine enrolled against, and the installer
# picks its own free port.
locate_enrollment() {
  DATA=$(find "$HOME/.bb-machines" -maxdepth 1 -mindepth 1 -type d ! -name host-daemon-ports | head -1)
  [ -n "$DATA" ] || { echo "no bb enrollment found in this sandbox"; exit 1; }
  PORT=$(cat "$DATA/host-daemon-port" 2>/dev/null || echo 38888)
  SERVER=$(node -e 'console.log(require(process.argv[1]).serverUrl)' "$DATA/config.json")
}

# Liveness from the daemon's own /status, the signal bb's installer waits on.
# Matching a process name would be wrong: the pattern appears in the command
# line of the shell running this script, so it matches itself.
is_connected() {
  curl -sf --max-time 2 "http://127.0.0.1:$PORT/status" 2>/dev/null |
    grep -q '"connected"[[:space:]]*:[[:space:]]*true'
}

# Persist the variables this command carried, for the daemon to inherit.
#
# The daemon is what spawns every shell a thread runs in, so what it was
# started with is what an agent sees. A sandbox's own environment is fixed
# when it is created, which leaves a machine woken months later still holding
# the token it was created with.
#
# BB_INJECTED_KEYS names the variables to keep: this command's environment
# also holds PATH and everything else the sandbox sets, and only the plugin's
# own values belong in the file.
#
# Returns 1 when the values changed, which is the caller's signal that a
# daemon already running with the old ones has to be restarted.
write_machine_env() {
  [ -n "${BB_INJECTED_KEYS:-}" ] || return 0

  file="$DATA/machine-env.sh"
  tmp="$file.new"
  # The file holds credentials, so it is never world-readable, not even
  # briefly between creating it and writing to it.
  : > "$tmp"
  chmod 600 "$tmp"

  for key in $BB_INJECTED_KEYS; do
    eval "value=\${$key:-}"
    [ -n "$value" ] || continue
    # Single-quoted with embedded quotes escaped, so a value containing
    # spaces, $ or backticks is data rather than shell.
    escaped=$(printf %s "$value" | sed "s/'/'\\\\''/g")
    printf "export %s='%s'\n" "$key" "$escaped" >> "$tmp"
  done

  if [ -f "$file" ] && cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
    return 0
  fi
  mv "$tmp" "$file"
  return 1
}

# The installer's temporary daemon holds the lock and the port; SIGTERM makes
# it release both.
stop_install_daemon() {
  if [ -f "$DATA/install-daemon.pid" ]; then
    kill "$(cat "$DATA/install-daemon.pid")" 2>/dev/null || true
    rm -f "$DATA/install-daemon.pid"
  fi
  i=0
  while [ $i -lt 15 ] && is_connected; do
    i=$((i + 1))
    sleep 1
  done
}

# Install the supervisor, replacing whatever an earlier enroll or wake left,
# and start it detached.
start_supervisor() {
  cat > "$DATA/daemon-supervisor.sh" <<'SUPERVISOR'
__DAEMON_SUPERVISOR__
SUPERVISOR
  chmod +x "$DATA/daemon-supervisor.sh"

  # Take the old one down with its daemon: the group kill reaches the children
  # setsid put in the supervisor's group. By pid, because pkill -f would match
  # this script. wake-supervisor is what a previous version of this plugin
  # installed.
  for pidfile in "$DATA/daemon-supervisor.pid" "$DATA/wake-supervisor.pid"; do
    [ -f "$pidfile" ] || continue
    stale=$(cat "$pidfile")
    # Pids get recycled; kill it only if it really is a supervisor.
    case "$(ps -p "$stale" -o args= 2>/dev/null)" in
      *supervisor.sh*) kill -- "-$stale" 2>/dev/null || kill "$stale" 2>/dev/null || true ;;
    esac
    rm -f "$pidfile"
  done
  rm -f "$DATA/wake-supervisor.sh"

  # setsid so the supervisor outlives the command that started it. Unquoted:
  # an image without setsid leaves this empty rather than passing "".
  detach=$(command -v setsid || true)
  export DATA PORT SERVER
  # shellcheck disable=SC2086 # empty $detach must expand to nothing, not ""
  nohup $detach "$DATA/daemon-supervisor.sh" >/dev/null 2>&1 &
}

# Wait for a usable machine rather than a spawned process. The window covers a
# self-update: install, exit, relaunch, connect.
await_daemon() {
  i=0
  while [ $i -lt 60 ]; do
    if is_connected; then
      echo "daemon connected"
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  echo "daemon did not connect; see $DATA/daemon-supervisor.log"
  exit 1
}
