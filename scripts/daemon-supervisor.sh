#!/bin/sh
# Keeps the bb host daemon alive on a machine, which has no service manager.
#
# --auto-update makes the daemon exit on purpose: when the server's protocol has
# moved ahead it installs the matching bb-app, stops, and expects a service
# manager to restart it. Without this the machine goes offline the moment it
# updates itself, and every later wake repeats the cycle.
#
# DATA, PORT and SERVER come from the environment.

# Owning the pid file is what makes this supervisor the current one.
echo $$ > "$DATA/daemon-supervisor.pid"
log="$DATA/daemon-supervisor.log"

quick_exits=0
while [ $quick_exits -lt 5 ]; do
  started=$(date +%s)
  # Read on every launch rather than once: a wake that carried new credentials
  # only has to rewrite this file for the next daemon to pick them up.
  # shellcheck disable=SC1091 # written by write_machine_env at runtime
  [ -f "$DATA/machine-env.sh" ] && . "$DATA/machine-env.sh"
  BB_APP_NPM_PREFIX="$DATA/npm" BB_DATA_DIR="$DATA" "$DATA/npm/bin/bb-app" host-daemon \
    --auto-update --host-daemon-port "$PORT" --server-url "$SERVER" >> "$log" 2>&1
  echo "host daemon exited ($?); relaunching" >> "$log"

  [ "$(cat "$DATA/daemon-supervisor.pid" 2>/dev/null)" = "$$" ] || {
    echo "superseded; standing down" >> "$log"
    exit 0
  }

  # Only rapid exits count towards the cap, so a self-update days from now is
  # not read as a crash loop.
  if [ $(($(date +%s) - started)) -ge 60 ]; then
    quick_exits=0
  else
    quick_exits=$((quick_exits + 1))
  fi
  sleep 2
done

echo "host daemon exited 5 times in quick succession; giving up" >> "$log"
