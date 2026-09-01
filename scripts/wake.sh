# Bring a stopped machine's daemon back.
#
# A resumed microVM restores memory as well as disk, so the daemon is usually
# already running, with the same hostId — ~/.bb-machines survives too. This is
# the belt-and-braces half, for a cold disk-only restore.
set -e

locate_enrollment
if is_connected; then
  echo "daemon already connected"
  exit 0
fi

start_supervisor
await_daemon
