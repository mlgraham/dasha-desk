import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { renderProviderGuide } from '../gateway/console.mjs';

const source = readFileSync(new URL('../agent/install.sh', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const verifyM4 = readFileSync(new URL('../scripts/verify-m4.sh', import.meta.url), 'utf8');
// Quoted or unquoted — either form is a copy-paste argv / history assignment.
const COPY_PASTE_TOKEN_ARGV = /OCM_HOST_TOKEN=["']?ocm_host_/;

test('the root installer never pipes downloaded code into a shell', () => {
  assert.doesNotMatch(source, /astral\.sh\/uv\/install\.sh/,
    'uv must be installed and reviewed independently');
  assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:ba)?sh\b/,
    'network responses must never execute directly as root');
  assert.match(source, /uv is required before running this root installer/);
});

test('the installer resets PATH before using privileged commands', () => {
  const setPath = source.indexOf('PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/var/root/.local/bin');
  const gateway = source.indexOf('GATEWAY=');
  assert.ok(setPath > 0 && setPath < gateway,
    'a caller-controlled PATH must not choose curl, sed, grep, install, sudo or launchctl');
  assert.match(source.slice(setPath, gateway), /export PATH/);
});

test('the executable source is derived from the authenticated gateway', () => {
  assert.match(source,
    /SOURCE=\$\(printf '%s\\n' "\$GATEWAY" \| sed 's\|\^wss:\/\/\|https:\/\/\|'\)/,
    'a separate arbitrary code-download origin must not drift from the gateway');
  assert.doesNotMatch(source, /OCM_SOURCE_URL/);
  assert.match(source, /--proto '=https' --proto-redir '=https' --tlsv1\.2/,
    'downloads and token checks must refuse plaintext redirects');
});

test('every shell-sourced provider value is constrained before agent.env is written', () => {
  for (const variable of [
    'GATEWAY',
    'SOURCE',
    'OCM_HOST_TOKEN',
    'AGENT_ID',
    'MLX_MODEL',
    'MODEL_MAP',
    'RUN_USER',
    'RUN_HOME',
    'UV',
  ]) {
    assert.match(source, new RegExp(`matches "\\$${variable}"`),
      `${variable} must be allowlisted before entering a privileged shell or wrapper`);
  }

  const validation = source.indexOf('matches "$GATEWAY"');
  const envWrite = source.indexOf('cat > /etc/ocm/agent.env');
  assert.ok(validation > 0 && validation < envWrite,
    'validation must happen before the provider environment file is written');
});

test('no regex in the installer uses a repetition bound BSD grep rejects', () => {
  // macOS 15 ships BSD grep with RE_DUP_MAX 255. `{1,512}` is not "a wide bound" there,
  // it is "maximum repetition exceeds 255" and a dead installer. Found on the first
  // real Mac the reinstall path met, after every test had passed on GNU grep and a
  // newer macOS. Bound length with ${#} instead; patterns bound shape only.
  const tooWide = [...source.matchAll(/\{(\d+),(\d+)\}/g)]
    .filter((m) => Number(m[1]) > 255 || Number(m[2]) > 255)
    .map((m) => m[0]);
  assert.deepEqual(tooWide, [],
    `repetition bounds above 255 abort BSD grep on macOS: ${tooWide.join(', ')}`);
  assert.match(source, /\[ "\$\{#1\}" -gt "\$3" \]/,
    'matches() must enforce length itself, since the pattern no longer can');
  for (const [variable, max] of [['MLX_MODEL', 512], ['MODEL_MAP', 2048], ['UV', 512]]) {
    assert.match(source, new RegExp(`matches "\\$${variable}" '[^']+' ${max}`),
      `${variable} must still have an explicit length limit of ${max}`);
  }
});

test('the inference daemon is explicitly forbidden from running as root', () => {
  assert.match(source, /RUN_USER="\$\{OCM_RUN_USER:-\$\{SUDO_USER:-\}\}"/);
  assert.match(source, /\[ "\$RUN_USER" != root \] \|\| die/,
    'root must be rejected as the provider runtime user');
  assert.match(source, /id "\$RUN_USER" >\/dev\/null/,
    'the selected provider account must exist locally');
  assert.match(source, /sudo -u "\$RUN_USER" --preserve-env=OCM_HOST_TOKEN env[\s\S]*"\$TMP_AGENT" --doctor/,
    'the downloaded code must be proved as the same unprivileged account that will run it, without putting the token on env argv');
  assert.match(source, /<key>UserName<\/key><string>\$RUN_USER<\/string>/,
    'launchd must drop privileges before executing the agent');
  assert.doesNotMatch(source, /export HOME=\/var\/root/,
    'the runtime wrapper must not inherit root as its home');
});

test('provider secrets and logs are owned only by the unprivileged runtime account', () => {
  const envWrite = source.indexOf('cat > /etc/ocm/agent.env');
  const launchd = source.indexOf('cat > /Library/LaunchDaemons/com.ocm.agent.plist');
  const section = source.slice(envWrite, launchd);
  assert.match(section, /chown "\$RUN_USER" \/etc\/ocm\/agent\.env/);
  assert.match(section, /chmod 600 \/etc\/ocm\/agent\.env/);
  assert.match(section, /touch \/var\/log\/ocm-agent\.log/);
  assert.match(section, /chown "\$RUN_USER" \/var\/log\/ocm-agent\.log/);
  assert.match(section, /chmod 600 \/var\/log\/ocm-agent\.log/);
});

test('the resolved token is exported before the doctor runs under sudo', () => {
  // The prompt, OCM_HOST_TOKEN_FILE and stdin paths set a shell variable, and
  // `sudo --preserve-env=OCM_HOST_TOKEN` carries only exported variables. Every path
  // except the human --preserve-env one failed the doctor until this was added.
  const exported = source.indexOf('\nexport OCM_HOST_TOKEN\n');
  const doctor = source.indexOf('--preserve-env=OCM_HOST_TOKEN env');
  assert.ok(exported > 0 && doctor > 0 && exported < doctor,
    'install.sh must `export OCM_HOST_TOKEN` after resolving it and before the doctor');
});

test('the doctor runs from a directory the runtime account can enter', () => {
  // `sudo -u ec2-user uv run` from /var/root (700) fails with "Current directory does
  // not exist". Found on the first reinstall over SSM, where cwd is root's home.
  const doctor = source.indexOf('"$UV" run --quiet --python 3.12 "$TMP_AGENT" --doctor');
  const cd = source.lastIndexOf('\ncd /\n', doctor);
  assert.ok(doctor > 0 && cd > 0 && cd < doctor,
    'the installer must cd / before running the doctor as the runtime account');
});

test('the downloaded agent is proved before a working installation is replaced', () => {
  const download = source.indexOf('curl_https --fail "$SOURCE/agent.py"');
  const doctor = source.indexOf('"$UV" run --quiet --python 3.12 "$TMP_AGENT" --doctor');
  const install = source.indexOf('install -m 755 "$TMP_AGENT" "$PREFIX/agent/agent.py"');
  assert.ok(download > 0 && doctor > download && install > doctor,
    'download -> unprivileged doctor -> install must be the only allowed order');
  assert.match(source, /no installed files were changed/);
});

test('token rotation validates credential, gateway and runtime owner', () => {
  const rotation = source.slice(source.indexOf("cat > \"$PREFIX/bin/ocm-agent-token\""));
  assert.match(rotation, /expected an issued ocm_host_ provider token/);
  assert.match(rotation, /unsafe or missing gateway URL/);
  assert.match(rotation, /could not identify the provider account/);
  assert.match(rotation, /provider environment may not be owned by root/);
  assert.match(rotation, /nothing was changed/);
  assert.match(rotation, /chown "\$OWNER" \/etc\/ocm\/agent\.env/);
  assert.match(rotation, /mktemp "\$\{TMPDIR:-\/tmp\}\/ocm-token\.XXXXXX"/);
  assert.match(rotation, /do not pass the token on the command line/);
  assert.match(rotation, /OCM_HOST_TOKEN_FILE/);
  assert.match(rotation, /stty -echo/);
});

test('human and automation install paths never put the token on argv', () => {
  assert.match(source, /read -rsp "Provider token: " OCM_HOST_TOKEN/,
    'the documented human path must prompt without echo');
  assert.match(source, /sudo --preserve-env=OCM_HOST_TOKEN sh install\.sh/,
    'sudo must inherit the prompted token rather than receiving it as env argv');
  assert.match(source, /OCM_HOST_TOKEN_FILE/,
    'automation must have a secret-file path');
  assert.match(source, /sudo sh install\.sh < \/path\/to\/token/,
    'automation must have a stdin path');
  assert.match(source, /stty -echo/,
    'an interactive sudo without the env var must prompt with echo disabled');
  assert.doesNotMatch(source, /sudo env OCM_HOST_TOKEN=/);
});

test('rendered provider guide, README and install comments reject copy-paste token argv', () => {
  const guide = renderProviderGuide({
    account: { email: 'provider@test.dev' },
    apiHost: 'api.ocm.getdasha.com',
    models: [],
  });
  assert.doesNotMatch(source, COPY_PASTE_TOKEN_ARGV,
    'install.sh must not document OCM_HOST_TOKEN="ocm_host_…" as a command');
  assert.doesNotMatch(readme, COPY_PASTE_TOKEN_ARGV,
    'README must not document OCM_HOST_TOKEN="ocm_host_…" as a command');
  assert.doesNotMatch(guide, COPY_PASTE_TOKEN_ARGV,
    'the rendered provider guide must not document OCM_HOST_TOKEN="ocm_host_…" as a command');
  assert.doesNotMatch(verifyM4, COPY_PASTE_TOKEN_ARGV,
    'verify-m4.sh must not document OCM_HOST_TOKEN=ocm_host_… as a command');
  assert.match(guide, /sudo OCM_AGENT_ID="my-mac" sh install.sh/,
    'the human install path is one line with no token on it');
  assert.match(guide, /typing hidden/,
    'the guide must say the installer prompts for the token without echo');
  assert.match(verifyM4, /OCM_HOST_TOKEN_FILE/,
    'M4 verification must offer a secret-file path');
  assert.match(verifyM4, /read -rsp "Provider token: " OCM_HOST_TOKEN/,
    'M4 verification must document a hidden-prompt path');
});

test('the installer never logs the provider token', () => {
  for (const line of source.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    if (/\/etc\/ocm\/agent\.env/.test(line)) continue;
    if (/Authorization: Bearer/.test(line)) continue;
    if (/printf 'OCM_HOST_TOKEN=%s/.test(line)) continue;
    // Quiet grep is validation, not a log line.
    if (/\| LC_ALL=C grep -Eq/.test(line)) continue;
    assert.doesNotMatch(line, /(?:echo|printf).*\$\{?OCM_HOST_TOKEN/,
      `installer must not print the token: ${line}`);
    assert.doesNotMatch(line, /(?:echo|printf).*\$\{?NEW_TOKEN/,
      `token rotator must not print the token: ${line}`);
  }
  assert.doesNotMatch(source, /^\s*set -x/m);
});

test('the update helper reinstalls from what is on disk and never exposes the token', () => {
  const start = source.indexOf("cat > \"$PREFIX/bin/ocm-agent-update\" <<'UPD'");
  assert.ok(start > 0, 'install.sh must install ocm-agent-update');
  const end = source.indexOf('\nUPD\n', start);
  assert.ok(end > start);
  const helper = source.slice(source.indexOf('\n', start) + 1, end + 1);
  // It is a reinstall with the values already on disk, gated by the same checksum a
  // human is told to verify, and the token travels in a root-only file.
  assert.match(helper, /shasum -a 256 -c install\.sh\.sha256/);
  assert.match(helper, /does not match its published checksum; nothing was changed/);
  assert.match(helper, /OCM_HOST_TOKEN_FILE="\$WORK\/token"/);
  assert.match(helper, /umask 077/);
  assert.match(helper, /trap 'rm -rf "\$WORK"'/);
  assert.match(helper, /provider environment may not be owned by root/);
  assert.match(helper, /--check/);
  // Never the token on argv or in a visible environment assignment.
  // (the sed that reads the env file mentions the key after a `^` anchor; that is a
  // pattern, not an assignment)
  assert.doesNotMatch(helper, /(^|[\s;])OCM_HOST_TOKEN=/m);
  assert.doesNotMatch(helper, COPY_PASTE_TOKEN_ARGV);
  // The installer overwrites the helper while it runs; it must continue from a snapshot.
  assert.match(helper, /OCM_UPDATE_WORK/);
  assert.match(helper, /cp \/opt\/ocm\/bin\/ocm-agent-update "\$WORK\/self"/);
  // No shell expansion leaks: the heredoc is quoted, and the generated file is valid sh.
  assert.match(source, /<<'UPD'\n/);
  const check = spawnSync('sh', ['-n'], { input: helper, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  // It is installed executable, after the rotation helper and before launchd is touched.
  const chmod = source.indexOf('chmod 755 "$PREFIX/bin/ocm-agent-update"');
  const token = source.indexOf('chmod 755 "$PREFIX/bin/ocm-agent-token"');
  const bootout = source.indexOf('launchctl bootout system/com.ocm.agent 2>/dev/null || true');
  assert.ok(token < start && chmod > end && chmod < bootout);
  // And it is documented where a provider will look.
  assert.match(source, /update\s+sudo \$PREFIX\/bin\/ocm-agent-update/);
  const guide = renderProviderGuide({ apiHost: 'api.example', models: ['ocm-coder'] });
  assert.match(guide, /sudo \/opt\/ocm\/bin\/ocm-agent-update/);
  assert.match(guide, /--check/);
});
