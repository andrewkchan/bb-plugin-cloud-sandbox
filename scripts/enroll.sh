# Turn a fresh sandbox into a bb machine.
# Args: join code, host id, server URL, machine code.
set -e

join_code=${1:?join code required}
host_id=${2:?host id required}
server_url=${3:?server URL required}
machine_code=${4:?machine code required}

# The Vercel image ships Node but no C toolchain, and bb-app's node-pty is a
# native add-on npm compiles from source. A custom image already carries these,
# and installing them is most of what makes a bare sandbox slow to enroll.
if command -v make >/dev/null 2>&1 && command -v gcc >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  echo "prerequisites already present; skipping apt"
else
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential >/dev/null 2>&1
fi

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
stop_install_daemon
start_supervisor
await_daemon
