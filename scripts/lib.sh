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
