# Give a fresh sandbox what bb's installer needs.
set -e

# The Vercel image ships Node but no C toolchain, and bb-app's node-pty is a
# native add-on npm compiles from source. A custom image already carries these,
# and installing them is most of what makes a bare sandbox slow to enroll.
if command -v make >/dev/null 2>&1 && command -v gcc >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  echo "prerequisites already present; skipping apt"
else
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential >/dev/null 2>&1
fi

# The GitHub CLI is not in Ubuntu's archive, so it comes from GitHub's own apt
# repo. A custom image already carries it; a bare sandbox does not.
if command -v gh >/dev/null 2>&1; then
  echo "github cli already present; skipping apt"
else
  keyring=/usr/share/keyrings/githubcli-archive-keyring.gpg
  sudo mkdir -p -m 0755 /usr/share/keyrings
  curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 \
    https://cli.github.com/packages/githubcli-archive-keyring.gpg |
    sudo tee "$keyring" >/dev/null
  sudo chmod go+r "$keyring"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=$keyring] https://cli.github.com/packages stable main" |
    sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh >/dev/null 2>&1
fi
