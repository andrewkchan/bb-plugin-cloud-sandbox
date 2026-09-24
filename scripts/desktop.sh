# Bring this sandbox's remote desktop up, or confirm it is already up.
#
# Args: VNC password, geometry as WxH.
# Runs after desktop-packages.sh, which is prepended to it.
#
# Idempotent by design: the panel runs this every time it connects, including
# after a wake, where the microVM's memory came back but its processes did
# not. Each piece is started only when its own pid is gone.
#
# Nothing here is reachable from outside the sandbox except the bridge on
# 6080, and the VNC server it bridges to listens on loopback only and demands
# the password. The plugin server holds that password; the exposed port is not
# a way in without it.
set -e

pass=${1:?vnc password required}
geometry=${2:-1440x900}

display_num=1
DISPLAY=":$display_num"
export DISPLAY
data="$HOME/.bb-desktop"
mkdir -p "$data"
chmod 700 "$data"

# A pid file is only evidence while its process is alive; pids get recycled,
# so match the command too.
alive() {
  pidfile="$data/$1.pid"
  [ -f "$pidfile" ] || return 1
  pid=$(cat "$pidfile" 2>/dev/null) || return 1
  [ -n "$pid" ] || return 1
  case "$(ps -p "$pid" -o comm= 2>/dev/null)" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

if alive xvfb Xvfb; then
  echo "display already running"
else
  # A previous session's lock survives a restore whose process did not, and
  # Xvfb refuses the display while it is there.
  rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}"
  nohup Xvfb "$DISPLAY" -screen 0 "${geometry}x24" -nolisten tcp \
    >>"$data/xvfb.log" 2>&1 &
  echo $! > "$data/xvfb.pid"
  # Everything below talks to the display, so wait for it to answer rather
  # than for the process to exist.
  i=0
  while [ $i -lt 100 ]; do
    xdpyinfo >/dev/null 2>&1 && break
    i=$((i + 1))
    sleep 0.1
  done
  xdpyinfo >/dev/null 2>&1 || { echo "display did not start; see $data/xvfb.log"; exit 1; }
fi

# Openbox on its own has no visible furniture: a minimized window is gone,
# because nothing lists it. The menu is what brings windows back by name, and
# tint2 below is what makes that discoverable. Written before openbox starts,
# since openbox reads it once.
menu="$HOME/.config/openbox/menu.xml"
if [ ! -f "$menu" ]; then
  mkdir -p "$HOME/.config/openbox"
  cat > "$menu" <<'MENU'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Desktop">
    <item label="Terminal">
      <action name="Execute"><command>xterm</command></action>
    </item>
    <separator/>
    <menu id="client-list-menu"/>
    <separator/>
    <item label="Restart window manager">
      <action name="Restart"/>
    </item>
  </menu>
</openbox_menu>
MENU
fi

if alive openbox openbox; then
  echo "window manager already running"
else
  xsetroot -solid "#1f2430" 2>/dev/null || true
  nohup openbox >>"$data/openbox.log" 2>&1 &
  echo $! > "$data/openbox.pid"
fi

# The taskbar. Without it a minimized window has nowhere to be clicked from,
# which is the one thing a bare window manager gets wrong for someone
# expecting a desktop. tint2 writes its own default config on first run, and
# that default is a taskbar of the open windows — which is exactly the part
# that was missing.
if alive tint2 tint2; then
  echo "taskbar already running"
else
  nohup tint2 >>"$data/tint2.log" 2>&1 &
  echo $! > "$data/tint2.pid"
fi

# One terminal, so an empty desktop still offers a way in. Not restarted once
# the user closes it: that is a choice, not a failure — and the taskbar and
# the desktop menu both reopen one.
if [ ! -f "$data/xterm.started" ]; then
  nohup xterm -fa Monospace -fs 11 -bg "#101317" -fg "#e6e6e6" \
    -geometry 110x32+60+40 >>"$data/xterm.log" 2>&1 &
  : > "$data/xterm.started"
fi

if alive x11vnc x11vnc; then
  echo "vnc server already running"
else
  x11vnc -storepasswd "$pass" "$data/passwd" >/dev/null 2>&1
  chmod 600 "$data/passwd"
  # -localhost keeps the RFB port off the exposed interface; -forever keeps
  # the server listening after a client leaves. Without -shared a second
  # client displaces the first, which is the single-seat rule this desktop
  # wants anyway.
  nohup x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -forever \
    -rfbauth "$data/passwd" -noxdamage -quiet \
    >>"$data/x11vnc.log" 2>&1 &
  echo $! > "$data/x11vnc.pid"
fi

if alive websockify websockify || alive websockify python3; then
  echo "bridge already running"
else
  nohup websockify 0.0.0.0:6080 127.0.0.1:5900 \
    >>"$data/websockify.log" 2>&1 &
  echo $! > "$data/websockify.pid"
fi

# Report on the bridge rather than on the pids: it is the only piece the
# panel actually connects to. Any answer at all means it is listening — a
# plain GET is not a WebSocket upgrade, so the status it returns says nothing
# useful. Only curl's "could not connect" (7) means not yet.
i=0
while [ $i -lt 100 ]; do
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:6080/" || [ $? -ne 7 ] || {
    i=$((i + 1))
    sleep 0.1
    continue
  }
  echo "desktop ready on $DISPLAY at $geometry"
  exit 0
done
echo "bridge did not start; see $data/websockify.log"
exit 1
