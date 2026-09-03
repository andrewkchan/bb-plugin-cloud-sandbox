# Bring a stopped machine's daemon back.
#
# A resumed microVM restores memory as well as disk, so the daemon is usually
# already running, with the same hostId — ~/.bb-machines survives too. This is
# the belt-and-braces half, for a cold disk-only restore.
set -e

locate_enrollment

# A daemon that is already up is still running with the environment it was
# started with, so credentials that have changed since reach it only through a
# restart. Unchanged ones are the common case and cost nothing.
if write_machine_env; then
  if is_connected; then
    echo "daemon already connected"
    exit 0
  fi
else
  echo "injected credentials changed; restarting the daemon"
fi

start_supervisor
await_daemon
