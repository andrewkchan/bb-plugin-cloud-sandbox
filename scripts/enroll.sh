# Turn a fresh sandbox into a bb machine.
# Args: join code, host id, server URL, machine code.
# Runs after prerequisites.sh, which is prepended to it.
set -e

join_code=${1:?join code required}
host_id=${2:?host id required}
server_url=${3:?server URL required}
machine_code=${4:?machine code required}

# The installer's last step registers a systemd user service and containers
# have no systemd, so skip it. The server URL must be the bb connect tunnel
# URL: the sandbox is on the public internet and cannot reach 127.0.0.1.
export BB_INSTALL_SKIP_SERVICE=1
curl -fL --connect-timeout 10 --max-time 60 --retry 2 "$server_url/install.sh" |
  sh -s -- --join-code "$join_code" --host-id "$host_id" --server "$server_url" --machine-code "$machine_code"

# Skipping the service also skipped its restart policy, and the installer left
# its temporary daemon running unwatched in place of one. Swap it for a
# supervised daemon.
locate_enrollment
# Written now so the file exists from the machine's first boot: a wake then
# compares against it rather than rewriting and restarting the daemon on a
# machine whose credentials never changed.
write_machine_env || true
stop_install_daemon
start_supervisor
await_daemon
