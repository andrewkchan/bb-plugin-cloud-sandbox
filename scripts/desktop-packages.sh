# Give a sandbox the X display, VNC server and WebSocket bridge a remote
# desktop needs.
#
# Shared by prerequisites.sh, so every sandbox carries the desktop, and by
# desktop.sh, so a sandbox from an image built before the desktop existed
# installs it the first time one is opened. Both paths are guarded: a machine
# that already has the packages pays nothing.
#
# Deliberately minimal — an X server, a window manager, a taskbar, a terminal
# and the bridge. Anything else worth looking at is what the thread installed.
if command -v Xvfb >/dev/null 2>&1 &&
  command -v x11vnc >/dev/null 2>&1 &&
  command -v openbox >/dev/null 2>&1 &&
  command -v tint2 >/dev/null 2>&1 &&
  command -v websockify >/dev/null 2>&1; then
  echo "remote desktop already present; skipping apt"
else
  sudo apt-get update -qq
  # websockify is its own package on recent Ubuntu and a python3- one before
  # that; ask for whichever this release has.
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    xvfb x11vnc openbox tint2 xterm x11-utils x11-xserver-utils >/dev/null 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    websockify >/dev/null 2>&1 ||
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      python3-websockify >/dev/null 2>&1
fi
