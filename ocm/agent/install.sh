#!/bin/sh
# OCM provider installer for macOS (Apple Silicon).
#
# Read this before running it: piping an unread script into a shell is a bad habit.
# It is about 500 lines. The two parts worth your attention are the token check at the
# top, which runs before anything is written, and the launchd handling at the end.
#
# What it does:
#   1. refuses to run on anything but Apple Silicon macOS
#   2. requires an existing, explicitly located uv binary
#   3. downloads the agent over HTTPS and proves its doctor path before replacing files
#   4. stores your provider token in an owner-only environment file
#   5. installs a launchd daemon that runs as the invoking non-root user
#
# Human path — get an enrollment code from the console (Enroll a machine), then:
#   sudo OCM_AGENT_ID="my-mac" sh install.sh
# It prompts for the code with echo off and exchanges it, over HTTPS, for a provider
# token that is already bound to this machine. The code is single-use and expires in
# minutes, so nothing long-lived is ever typed. Enrolling the same machine name again
# rotates it: the old token is revoked once the new one exists.
#
# A provider token works everywhere a code does. To hand one over without putting it
# on argv or in shell history, prompt with echo off and hand the variable to sudo:
#   read -rsp "Provider token: " OCM_HOST_TOKEN
#   printf '\n'
#   sudo --preserve-env=OCM_HOST_TOKEN sh install.sh
#
# Running this script under sudo without OCM_HOST_TOKEN set also prompts, with
# terminal echo disabled. Automation may use a secret file or stdin instead, holding
# either a code or a token:
#   sudo env OCM_HOST_TOKEN_FILE=/path/to/token sh install.sh
#   sudo sh install.sh < /path/to/token
#
# Optional:
#   OCM_AGENT_ID="my-mac"   the name this machine registers under; defaults to the
#                           hostname. Keep it stable, or a reinstall registers a
#                           second host instead of recovering the first.
#   OCM_MODEL_MAP="public=local,…"  what this machine advertises. Defaults to
#                           ocm-coder=<the MLX coder model>, which is the name
#                           consumers actually request.
#   OCM_UV_BIN="/opt/homebrew/bin/uv"  explicit uv path when sudo has a narrow PATH.
#   OCM_RUN_USER="alice"    account that runs inference. Defaults to SUDO_USER and
#                           may never be root.
#   OCM_REGION="us-west-2"  what the machine reports as its region. A reinstall keeps
#                           the value already in /etc/ocm/agent.env; unset means "local".
set -eu

# Root must not inherit a caller-controlled PATH while downloading or installing
# executable code. Homebrew locations are included after the system directories.
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/var/root/.local/bin
export PATH

GATEWAY="${OCM_GATEWAY_URL:-wss://api.ocm.getdasha.com}"
# The download and credential-check origin is derived from the socket origin. A
# second arbitrary source URL previously allowed a token to be checked against one
# deployment while root downloaded executable code from another.
SOURCE=$(printf '%s\n' "$GATEWAY" | sed 's|^wss://|https://|')
# Set OCM_AGENT_ID to keep a machine's identity stable across reinstalls. Without it
# this defaults to the hostname, and a reinstall that produces a different name
# registers a SECOND host rather than recovering the existing one.
AGENT_ID="${OCM_AGENT_ID:-$(hostname -s)}"
# What this machine ADVERTISES to consumers. Without a map an MLX host advertises
# the raw model id, which no consumer asks for — the docs, the console and every
# example say `ocm-coder`, so a provider installed by this script was invisible to
# the people it was meant to serve. `ocm-coder` is a public alias for the coder
# model, which is exactly what OCM_MODEL_MAP exists to express.
MLX_MODEL="${OCM_MLX_MODEL:-mlx-community/Qwen2.5-Coder-7B-Instruct-4bit}"
MODEL_MAP="${OCM_MODEL_MAP:-ocm-coder=$MLX_MODEL}"
RUN_USER="${OCM_RUN_USER:-${SUDO_USER:-}}"
PREFIX=/opt/ocm

die() { printf '\nerror: %s\n' "$1" >&2; exit 1; }
# Length is bounded by ${#} rather than in the pattern: BSD grep on macOS 15 rejects
# any repetition bound above 255 ("maximum repetition exceeds 255"), so a 512-wide bound
# aborted the installer on the first real Mac it met.
matches() {
  if [ -n "${3:-}" ] && [ "${#1}" -gt "$3" ]; then return 1; fi
  printf '%s\n' "$1" | LC_ALL=C grep -Eq "$2"
}
curl_https() {
  curl --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 "$@"
}

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS"
[ "$(uname -m)" = "arm64" ] || die "Apple Silicon is required — MLX cannot run on an Intel Mac"
[ "$(id -u)" = "0" ] || die "run with sudo: installing the launchd daemon needs root"

# Resolve the provider token without requiring it on argv. Putting the secret
# on sudo's environment command line would also put it in shell history and
# the process list. Never print the value.
if [ -z "${OCM_HOST_TOKEN:-}" ] && [ -n "${OCM_HOST_TOKEN_FILE:-}" ]; then
  matches "$OCM_HOST_TOKEN_FILE" '^/[-A-Za-z0-9._/+]+$' 512 \
    || die "OCM_HOST_TOKEN_FILE must be a safe absolute path"
  [ -f "$OCM_HOST_TOKEN_FILE" ] && [ -r "$OCM_HOST_TOKEN_FILE" ] \
    || die "OCM_HOST_TOKEN_FILE is missing or unreadable"
  IFS= read -r OCM_HOST_TOKEN < "$OCM_HOST_TOKEN_FILE" || true
fi
if [ -z "${OCM_HOST_TOKEN:-}" ]; then
  if [ -t 0 ]; then
    printf 'Provider token or enrollment code (input is hidden): ' >&2
    if stty_state=$(stty -g 2>/dev/null); then
      stty -echo
      IFS= read -r OCM_HOST_TOKEN || true
      stty "$stty_state"
    else
      IFS= read -r OCM_HOST_TOKEN || true
    fi
    printf '\n' >&2
  else
    IFS= read -r OCM_HOST_TOKEN || true
  fi
fi
[ -n "${OCM_HOST_TOKEN:-}" ] || die "provide OCM_HOST_TOKEN via --preserve-env, OCM_HOST_TOKEN_FILE, stdin, or the hidden prompt"
# The prompt, file and stdin paths leave this as a plain shell variable. The doctor
# below runs under `sudo -u … --preserve-env=OCM_HOST_TOKEN`, which can only carry an
# exported one; without this line every path except --preserve-env failed the doctor
# with "OCM_HOST_TOKEN is not set".
export OCM_HOST_TOKEN
[ -n "$RUN_USER" ] || die "run through sudo from the account that should run inference, or set OCM_RUN_USER"
[ "$RUN_USER" != root ] || die "the OCM inference daemon may not run as root; set OCM_RUN_USER to a normal account"

# Every value below is written to a shell-sourced environment file or generated
# wrapper. The allowlists are therefore a code-execution boundary, not cosmetic
# validation.
matches "$GATEWAY" '^wss://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' \
  || die "OCM_GATEWAY_URL must be a bare wss:// host with an optional port"
matches "$SOURCE" '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' \
  || die "the gateway could not be converted to a safe HTTPS source"
# The agent id is validated before the enrollment exchange below, because it goes
# into that request body.
matches "$AGENT_ID" '^[-A-Za-z0-9._]{1,64}$' \
  || die "OCM_AGENT_ID may contain only letters, numbers, dot, underscore and hyphen (64 max)"

# An enrollment code is exchanged for a provider token before anything else happens.
# The code travels in a JSON body over HTTPS, never in a URL, a log line or argv; the
# gateway mints a token already bound to this agent id and revokes any older token
# bound to the same id on the same account, so re-enrolling is how a machine rotates.
if matches "$OCM_HOST_TOKEN" '^ocm_enroll_[-A-Za-z0-9_]{16,}$'; then
  printf 'exchanging the enrollment code for a provider token …\n'
  ENROLL=$(curl_https --fail -H 'content-type: application/json' \
    --data "{\"code\":\"$OCM_HOST_TOKEN\",\"agent_id\":\"$AGENT_ID\"}" \
    "$SOURCE/v1/provider/enroll" 2>/dev/null) || {
    REASON=$(curl_https -H 'content-type: application/json' \
      --data "{\"code\":\"$OCM_HOST_TOKEN\",\"agent_id\":\"$AGENT_ID\"}" \
      "$SOURCE/v1/provider/enroll" 2>/dev/null \
      | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
    die "${REASON:-could not reach $SOURCE to exchange the enrollment code}
  nothing was installed"
  }
  OCM_HOST_TOKEN=$(printf '%s' "$ENROLL" | sed -n 's/.*"token":"\(ocm_host_[-A-Za-z0-9_]*\)".*/\1/p')
  [ -n "$OCM_HOST_TOKEN" ] || die "the gateway did not return a provider token for that enrollment code
  nothing was installed"
  export OCM_HOST_TOKEN
  ROTATED=$(printf '%s' "$ENROLL" | sed -n 's/.*"rotated":\([0-9]*\).*/\1/p')
  printf '  enrolled as %s\n' "$AGENT_ID"
  if [ -n "$ROTATED" ] && [ "$ROTATED" != 0 ]; then
    printf '  (rotated %s older token(s) for this machine)\n' "$ROTATED"
  fi
fi
matches "$OCM_HOST_TOKEN" '^ocm_host_[-A-Za-z0-9_]{16,}$' \
  || die "OCM_HOST_TOKEN must be an issued provider token beginning ocm_host_, or an ocm_enroll_ code"
matches "$MLX_MODEL" '^[-A-Za-z0-9._/:@+]+$' 512 \
  || die "OCM_MLX_MODEL contains unsupported characters or is too long"
matches "$MODEL_MAP" '^[-A-Za-z0-9._/:@=,+]+$' 2048 \
  || die "OCM_MODEL_MAP contains unsupported characters or is too long"
matches "$RUN_USER" '^[-A-Za-z0-9._]{1,64}$' \
  || die "OCM_RUN_USER contains unsupported characters"
# A reinstall or update must not silently drop the region a machine already reports.
# Explicit OCM_REGION wins; otherwise keep what the existing env file says; otherwise
# leave it unset and the agent reports "local".
REGION="${OCM_REGION:-$(sed -n 's|^OCM_REGION=||p' /etc/ocm/agent.env 2>/dev/null | head -1)}"
if [ -n "$REGION" ]; then
  matches "$REGION" '^[-A-Za-z0-9._]{1,32}$' \
    || die "OCM_REGION contains unsupported characters"
fi
id "$RUN_USER" >/dev/null 2>&1 || die "OCM_RUN_USER does not name a local account"
RUN_HOME=$(dscl . -read "/Users/$RUN_USER" NFSHomeDirectory 2>/dev/null \
  | awk '{ print $2; exit }')
[ -n "$RUN_HOME" ] || die "could not determine the home directory for OCM_RUN_USER"
matches "$RUN_HOME" '^/[-A-Za-z0-9._/+]+$' 512 \
  || die "the provider account home directory contains unsupported characters"

# Require uv rather than piping a third party installer into a root shell. Homebrew's
# default Apple Silicon path and the provider user's local path are checked explicitly.
# OCM_UV_BIN is accepted only when it is an absolute executable path with a shape
# that cannot break the generated wrapper.
UV="${OCM_UV_BIN:-}"
if [ -z "$UV" ]; then
  UV=$(command -v uv 2>/dev/null || true)
fi
if [ -z "$UV" ]; then
  for candidate in /opt/homebrew/bin/uv /usr/local/bin/uv "$RUN_HOME/.local/bin/uv"; do
    if [ -x "$candidate" ]; then UV=$candidate; break; fi
  done
fi
[ -n "$UV" ] && [ -x "$UV" ] \
  || die "uv is required before running this root installer. Install it yourself (for example: brew install uv), then rerun with OCM_UV_BIN=\"$(command -v uv 2>/dev/null || echo /opt/homebrew/bin/uv)\""
matches "$UV" '^/[-A-Za-z0-9._/+]+$' 512 \
  || die "OCM_UV_BIN must be a safe absolute executable path"
sudo -u "$RUN_USER" test -x "$UV" \
  || die "OCM_UV_BIN is not executable by OCM_RUN_USER"

# Check the credential BEFORE downloading or replacing anything. Fail here, with a
# useful reason, while the operator is still watching the terminal.
printf 'checking your provider token …\n'
VERIFY=$(curl_https --fail -H "Authorization: Bearer $OCM_HOST_TOKEN" \
  "$SOURCE/v1/provider/verify" 2>/dev/null) || {
  REASON=$(curl_https -H "Authorization: Bearer $OCM_HOST_TOKEN" \
    "$SOURCE/v1/provider/verify" 2>/dev/null \
    | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
  die "${REASON:-could not reach $SOURCE to check the token}"
}
printf '%s' "$VERIFY" | grep -q '"ok":true' \
  || die "the gateway response did not confirm this provider token"
printf '  token accepted\n'

printf 'OCM provider install\n  host    %s (%s)\n  user    %s\n  gateway %s\n  serving %s\n\n' \
  "$AGENT_ID" "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo mac)" \
  "$RUN_USER" "$GATEWAY" "$MODEL_MAP"

# Download to a private temporary file and prove the new agent's diagnostic path as
# the same unprivileged account that launchd will use. Only then replace installed
# files. HTTPS authenticates the current gateway; broad deployment still requires a
# release artifact pinned to an immutable digest.
umask 077
TMP_AGENT=$(mktemp "${TMPDIR:-/tmp}/ocm-agent.XXXXXX")
trap 'rm -f "$TMP_AGENT"' EXIT HUP INT TERM
printf 'downloading agent …\n'
curl_https --fail "$SOURCE/agent.py" -o "$TMP_AGENT" \
  || die "could not fetch $SOURCE/agent.py"
chmod 755 "$TMP_AGENT"

printf 'checking the downloaded agent as %s …\n' "$RUN_USER"
# Leave the caller's directory first. Run from root's home (an operator over SSM,
# say) the unprivileged account cannot stat the cwd, and uv dies with "Current
# directory does not exist" before the doctor runs at all.
cd /
sudo -u "$RUN_USER" --preserve-env=OCM_HOST_TOKEN env \
  HOME="$RUN_HOME" \
  OCM_GATEWAY_URL="$GATEWAY" \
  OCM_AGENT_ID="$AGENT_ID" \
  OCM_MODEL_MAP="$MODEL_MAP" \
  "$UV" run --quiet --python 3.12 "$TMP_AGENT" --doctor \
  || die "downloaded agent doctor failed — no installed files were changed"

mkdir -p "$PREFIX/agent" "$PREFIX/bin"
install -m 755 "$TMP_AGENT" "$PREFIX/agent/agent.py"

# The token lives in an owner-only file, never in the plist — plists are
# world-readable. The provider process runs as RUN_USER, not as root.
install -d -m 700 /etc/ocm
chown "$RUN_USER" /etc/ocm
umask 077
cat > /etc/ocm/agent.env <<ENV
OCM_HOST_TOKEN=$OCM_HOST_TOKEN
OCM_GATEWAY_URL=$GATEWAY
OCM_AGENT_ID=$AGENT_ID
OCM_MODEL_MAP=$MODEL_MAP
ENV
[ -z "$REGION" ] || printf 'OCM_REGION=%s\n' "$REGION" >> /etc/ocm/agent.env
chown "$RUN_USER" /etc/ocm/agent.env
chmod 600 /etc/ocm/agent.env

cat > "$PREFIX/bin/ocm-agent-run" <<RUN
#!/bin/bash
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$RUN_HOME/.local/bin
export HOME="$RUN_HOME"
set -a; . /etc/ocm/agent.env; set +a
exec "$UV" run --quiet --python 3.12 $PREFIX/agent/agent.py "\$@"
RUN
# 755, not the 700 that `umask 077` above would otherwise leave. This file holds no
# secret — the token lives in /etc/ocm/agent.env — so root-only mode protects nothing
# and blocks the owner (or their agent) from reading back what was just installed,
# which is exactly the verification this script asks people to perform.
chmod 755 "$PREFIX/bin/ocm-agent-run"

# Rotating a token had no supported path, so people edited ocm-agent-run by hand —
# which silently breaks the daemon, because that file is regenerated on reinstall
# and is not where the token lives. This is the one command that does it correctly.
cat > "$PREFIX/bin/ocm-agent-token" <<'TOK'
#!/bin/sh
# Replace this machine's provider token and restart the agent.
#   sudo /opt/ocm/bin/ocm-agent-token              # prompts, input hidden
#   sudo /opt/ocm/bin/ocm-agent-token < token      # automation stdin
#   sudo env OCM_HOST_TOKEN_FILE=/path /opt/ocm/bin/ocm-agent-token
#
# Do not pass the token as a command-line argument: it would appear in
# process lists and shell history.
# Use this rather than editing any file by hand: the token lives in
# /etc/ocm/agent.env, and ocm-agent-run is regenerated on every reinstall.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$(id -u)" = "0" ] || { echo "run with sudo" >&2; exit 1; }
if [ $# -ne 0 ]; then
  echo "usage: ocm-agent-token" >&2
  echo "  do not pass the token on the command line" >&2
  echo "  you will be prompted, or provide it on stdin / OCM_HOST_TOKEN_FILE" >&2
  exit 1
fi
NEW_TOKEN=""
if [ -n "${OCM_HOST_TOKEN_FILE:-}" ]; then
  IFS= read -r NEW_TOKEN < "$OCM_HOST_TOKEN_FILE" || true
elif [ -t 0 ]; then
  printf 'Provider token or enrollment code (input is hidden): ' >&2
  if stty_state=$(stty -g 2>/dev/null); then
    stty -echo
    IFS= read -r NEW_TOKEN || true
    stty "$stty_state"
  else
    IFS= read -r NEW_TOKEN || true
  fi
  printf '\n' >&2
else
  IFS= read -r NEW_TOKEN || true
fi
OWNER=$(stat -f '%Su' /etc/ocm/agent.env 2>/dev/null || true)
printf '%s\n' "$OWNER" | LC_ALL=C grep -Eq '^[-A-Za-z0-9._]{1,64}$' \
  || { echo "error: could not identify the provider account" >&2; exit 1; }
[ "$OWNER" != root ] || { echo "error: the provider environment may not be owned by root" >&2; exit 1; }
BASE=$(sed -n 's|^OCM_GATEWAY_URL=||p' /etc/ocm/agent.env | sed 's|^wss://|https://|')
printf '%s\n' "$BASE" | LC_ALL=C grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' \
  || { echo "error: unsafe or missing gateway URL in /etc/ocm/agent.env" >&2; exit 1; }
# An enrollment code from the console is exchanged for a token bound to this machine,
# using the agent id already recorded here; the old token is revoked by the gateway.
if printf '%s\n' "$NEW_TOKEN" | LC_ALL=C grep -Eq '^ocm_enroll_[-A-Za-z0-9_]{16,}$'; then
  AGENT_ID=$(sed -n 's|^OCM_AGENT_ID=||p' /etc/ocm/agent.env)
  printf '%s\n' "$AGENT_ID" | LC_ALL=C grep -Eq '^[-A-Za-z0-9._]{1,64}$' \
    || { echo "error: unsafe or missing OCM_AGENT_ID in /etc/ocm/agent.env" >&2; exit 1; }
  printf 'exchanging the enrollment code ...\n'
  ENROLL=$(curl --silent --show-error --location --fail \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    -H 'content-type: application/json' \
    --data "{\"code\":\"$NEW_TOKEN\",\"agent_id\":\"$AGENT_ID\"}" \
    "$BASE/v1/provider/enroll" 2>/dev/null) || {
    curl --silent --show-error --location \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      -H 'content-type: application/json' \
      --data "{\"code\":\"$NEW_TOKEN\",\"agent_id\":\"$AGENT_ID\"}" \
      "$BASE/v1/provider/enroll" 2>/dev/null \
      | sed -n 's/.*"message":"\([^"]*\)".*/error: \1/p' >&2
    echo "nothing was changed" >&2
    exit 1
  }
  NEW_TOKEN=$(printf '%s' "$ENROLL" | sed -n 's/.*"token":"\(ocm_host_[-A-Za-z0-9_]*\)".*/\1/p')
  printf 'enrolled as %s\n' "$AGENT_ID"
fi
printf '%s\n' "$NEW_TOKEN" | LC_ALL=C grep -Eq '^ocm_host_[-A-Za-z0-9_]{16,}$' \
  || { echo "error: expected an issued ocm_host_ provider token" >&2; exit 1; }
printf 'checking token ...\n'
if ! curl --silent --show-error --location --fail \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  -H "Authorization: Bearer $NEW_TOKEN" "$BASE/v1/provider/verify" >/dev/null 2>&1; then
  curl --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    -H "Authorization: Bearer $NEW_TOKEN" "$BASE/v1/provider/verify" 2>/dev/null \
    | sed -n 's/.*"message":"\([^"]*\)".*/error: \1/p' >&2
  echo "nothing was changed" >&2
  exit 1
fi
umask 077
TMP=$(mktemp "${TMPDIR:-/tmp}/ocm-token.XXXXXX")
trap 'rm -f "$TMP"' EXIT HUP INT TERM
grep -v '^OCM_HOST_TOKEN=' /etc/ocm/agent.env > "$TMP" || true
printf 'OCM_HOST_TOKEN=%s\n' "$NEW_TOKEN" >> "$TMP"
cat "$TMP" > /etc/ocm/agent.env
chown "$OWNER" /etc/ocm/agent.env
chmod 600 /etc/ocm/agent.env
launchctl kickstart -k system/com.ocm.agent
echo "token accepted, written, and agent restarted."
echo "watch it connect:  tail -f /var/log/ocm-agent.log"
TOK
chmod 755 "$PREFIX/bin/ocm-agent-token"   # readable for the same reason

# Fixes reached existing hosts only on reinstall, and a reinstall needs a token that
# was shown once; a bare file swap leaves old modes and config behind. This does the
# reinstall with what is already on disk, so nothing is retyped and nothing is skipped.
cat > "$PREFIX/bin/ocm-agent-update" <<'UPD'
#!/bin/sh
# Move this machine to the current agent build without retyping anything.
#   sudo /opt/ocm/bin/ocm-agent-update            # update
#   sudo /opt/ocm/bin/ocm-agent-update --check    # report only; change nothing
#
# It reads /etc/ocm/agent.env, fetches the current installer from the same gateway,
# verifies the published checksum, and runs the installer with the token handed over
# in a root-only temporary file — never on a command line. The installer then proves
# the new agent's doctor path as the runtime account before replacing anything,
# exactly as a first install does.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$(id -u)" = "0" ] || { echo "run with sudo" >&2; exit 1; }
CHECK=0
[ $# -le 1 ] || { echo "usage: ocm-agent-update [--check]" >&2; exit 1; }
case "${1:-}" in
  "") ;;
  --check) CHECK=1 ;;
  *) echo "usage: ocm-agent-update [--check]" >&2; exit 1 ;;
esac
umask 077
# The installer rewrites this very file while it runs, and sh reads scripts lazily
# by byte offset, so the live file only takes a private snapshot of itself and runs
# that. The snapshot inherits the work directory; the live file owns its cleanup.
if [ -z "${OCM_UPDATE_WORK:-}" ]; then
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/ocm-update.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT HUP INT TERM
  cp /opt/ocm/bin/ocm-agent-update "$WORK/self"
  OCM_UPDATE_WORK="$WORK" sh "$WORK/self" "$@"
  exit $?
fi
WORK="$OCM_UPDATE_WORK"
ENV=/etc/ocm/agent.env
[ -r "$ENV" ] || { echo "error: $ENV is missing; this machine was not set up by install.sh — run the installer once" >&2; exit 1; }
OWNER=$(stat -f '%Su' "$ENV" 2>/dev/null || true)
printf '%s\n' "$OWNER" | LC_ALL=C grep -Eq '^[-A-Za-z0-9._]{1,64}$' \
  || { echo "error: could not identify the provider account" >&2; exit 1; }
[ "$OWNER" != root ] || { echo "error: the provider environment may not be owned by root" >&2; exit 1; }
val() { sed -n "s|^$1=||p" "$ENV" | head -1; }
GATEWAY=$(val OCM_GATEWAY_URL); AGENT_ID=$(val OCM_AGENT_ID); MODEL_MAP=$(val OCM_MODEL_MAP)
printf '%s\n' "$GATEWAY" | LC_ALL=C grep -Eq '^wss://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' \
  || { echo "error: unsafe or missing gateway URL in $ENV" >&2; exit 1; }
printf '%s\n' "$AGENT_ID" | LC_ALL=C grep -Eq '^[-A-Za-z0-9._]{1,64}$' \
  || { echo "error: unsafe or missing OCM_AGENT_ID in $ENV" >&2; exit 1; }
BASE=$(printf '%s\n' "$GATEWAY" | sed 's|^wss://|https://|')
UV=$(sed -n 's/^exec "\([^"]*\)" run .*/\1/p' /opt/ocm/bin/ocm-agent-run 2>/dev/null | head -1)
[ -n "$UV" ] && [ -x "$UV" ] \
  || { echo "error: could not find uv via /opt/ocm/bin/ocm-agent-run; rerun the installer with OCM_UV_BIN" >&2; exit 1; }
fetch() {
  curl --silent --show-error --location --fail \
    --proto '=https' --proto-redir '=https' --tlsv1.2 "$@"
}
fetch "$BASE/install.sh" -o "$WORK/install.sh" \
  || { echo "error: could not fetch $BASE/install.sh" >&2; exit 1; }
fetch "$BASE/install.sh.sha256" -o "$WORK/install.sh.sha256" \
  || { echo "error: could not fetch the installer checksum" >&2; exit 1; }
( cd "$WORK" && shasum -a 256 -c install.sh.sha256 >/dev/null 2>&1 ) \
  || { echo "error: the downloaded installer does not match its published checksum; nothing was changed" >&2; exit 1; }
fetch "$BASE/agent.py" -o "$WORK/agent.py" \
  || { echo "error: could not fetch $BASE/agent.py" >&2; exit 1; }
if cmp -s "$WORK/agent.py" /opt/ocm/agent/agent.py; then AGENT_STATE="already current"
else AGENT_STATE="new build available"; fi
printf 'OCM provider update\n  host     %s\n  user     %s\n  gateway  %s\n  agent    %s\n' \
  "$AGENT_ID" "$OWNER" "$GATEWAY" "$AGENT_STATE"
if [ "$CHECK" = 1 ]; then
  echo "check only; nothing was changed"
  exit 0
fi
# The token goes to the installer in a root-only file under $WORK, which the trap
# removes; it is never placed on a command line or in a visible environment.
sed -n 's/^OCM_HOST_TOKEN=//p' "$ENV" | head -1 > "$WORK/token"
[ -s "$WORK/token" ] || { echo "error: no OCM_HOST_TOKEN in $ENV; run ocm-agent-token first" >&2; exit 1; }
cd /
OCM_HOST_TOKEN_FILE="$WORK/token" OCM_AGENT_ID="$AGENT_ID" OCM_MODEL_MAP="$MODEL_MAP" \
  OCM_RUN_USER="$OWNER" OCM_UV_BIN="$UV" OCM_GATEWAY_URL="$GATEWAY" \
  sh "$WORK/install.sh"
UPD
chmod 755 "$PREFIX/bin/ocm-agent-update"

# launchd opens the log as RUN_USER. Pre-create it owner-only rather than relying on
# launchd to create a world-readable root log or failing because /var/log is closed.
touch /var/log/ocm-agent.log
chown "$RUN_USER" /var/log/ocm-agent.log
chmod 600 /var/log/ocm-agent.log

cat > /Library/LaunchDaemons/com.ocm.agent.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ocm.agent</string>
  <key>UserName</key><string>$RUN_USER</string>
  <key>ProgramArguments</key><array><string>$PREFIX/bin/ocm-agent-run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/var/log/ocm-agent.log</string>
  <key>StandardErrorPath</key><string>/var/log/ocm-agent.log</string>
  <key>WorkingDirectory</key><string>$PREFIX</string>
</dict></plist>
PLIST
chmod 644 /Library/LaunchDaemons/com.ocm.agent.plist

# bootout is ASYNCHRONOUS. Bootstrapping while teardown is still in flight fails
# with "Bootstrap failed: 5: Input/output error", and under `set -eu` the script
# then dies having ALREADY removed the working daemon — a reinstall took a healthy
# provider offline and left it there. Wait for the old job to actually go.
launchctl bootout system/com.ocm.agent 2>/dev/null || true
n=0
while launchctl print system/com.ocm.agent >/dev/null 2>&1 && [ "$n" -lt 50 ]; do
  sleep 0.2; n=$((n + 1))
done
if ! launchctl bootstrap system /Library/LaunchDaemons/com.ocm.agent.plist; then
  # Never exit quietly here: at this point the old daemon is gone, so a silent
  # failure means the machine is left with no agent at all.
  die "the daemon could not be loaded, and this machine now has NO agent running.
  Retry:  sudo launchctl bootstrap system /Library/LaunchDaemons/com.ocm.agent.plist
  Then:   sudo -u $RUN_USER $PREFIX/bin/ocm-agent-run --doctor"
fi

rm -f "$TMP_AGENT"
trap - EXIT HUP INT TERM

cat <<DONE

installed. Inference runs as $RUN_USER, never as root.

  status   launchctl print system/com.ocm.agent
  logs     tail -f /var/log/ocm-agent.log
  check    sudo -u $RUN_USER $PREFIX/bin/ocm-agent-run --doctor
  rotate   sudo $PREFIX/bin/ocm-agent-token
  update   sudo $PREFIX/bin/ocm-agent-update      (--check to only look)
  stop     sudo launchctl bootout system/com.ocm.agent
  remove   sudo launchctl bootout system/com.ocm.agent; sudo rm -rf $PREFIX /etc/ocm \\
             /Library/LaunchDaemons/com.ocm.agent.plist /var/log/ocm-agent.log

Your Mac should appear in the console within a few seconds.

Note: prompts routed to this machine are visible to you in plaintext. That is true of
every provider, and is why the network claims no confidentiality it cannot enforce.
DONE
