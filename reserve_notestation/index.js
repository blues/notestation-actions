'use strict';

// Dependency-free GitHub Actions node20 script.
// Serves as both the main step and the post step (distinguished via IS_POST
// saved state). Main: reserves a Notestation and exports NS_* env vars.
// Post: sends SIGTERM to release the reservation.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

// ─── GitHub Actions protocol helpers ─────────────────────────────────────────
// These replicate the @actions/core API by writing directly to the files/env
// vars that the runner exposes, avoiding any npm dependencies.

function log(msg) { process.stdout.write(msg + '\n'); }
function logGroup(name) { process.stdout.write(`::group::${name}\n`); }
function logEndGroup() { process.stdout.write('::endgroup::\n'); }
function logError(msg) { process.stdout.write(`::error::${msg}\n`); }
function logWarning(msg) { process.stdout.write(`::warning::${msg}\n`); }

function setOutput(key, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function exportVariable(key, value) {
  fs.appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
}

function saveState(key, value) {
  // The runner reads this file after the step and surfaces values as
  // STATE_<KEY> env vars for post steps.
  fs.appendFileSync(process.env.GITHUB_STATE, `${key}=${value}\n`);
}

function getState(key) {
  // State written by saveState() is available as STATE_<KEY> in post steps.
  return (process.env[`STATE_${key}`] || '').trim();
}

function getInput(name) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (process.env[key] || '').trim();
}

function fail(msg) {
  logError(msg);
  process.exit(1);
}

// Synchronous sleep without busy-waiting (requires Node.js 9.4+ / SharedArrayBuffer).
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─── Polling helper ───────────────────────────────────────────────────────────
// Calls fn() every intervalMs until it returns a truthy value, or fails after
// timeoutMs. Returns the truthy value from fn().

function poll(description, fn, timeoutMs = 60000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    sleep(intervalMs);
  }
  fail(`Timed out after ${timeoutMs / 1000}s waiting for: ${description}`);
}

// ─── Tailscale reachability pre-check ─────────────────────────────────────────
// The reservation dial fails if it fires before Tailscale has converged a path
// to the Notestation. That is common on a freshly-connected ephemeral runner:
// its tailscaled came up seconds earlier and has no path yet. Waiting until the
// Notestation actually answers a `tailscale ping` before we spawn the client
// turns that race into a short, explicit wait instead of a hard reserve failure.

function haveTailscaleCli() {
  try {
    execFileSync('which', ['tailscale'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Returns true if `host` answers a Tailscale ping (over any path — direct or a
// DERP relay; we only need *a* working path before we dial). `tailscale ping`
// needs the local tailscaled socket, which is root-owned on GitHub-hosted
// runners, so fall back to sudo if a direct invocation is denied.
function tailscaleReachable(host) {
  const pingArgs = ['ping', '--c=1', '--until-direct=false', '--timeout=3s', host];
  for (const [cmd, args] of [['tailscale', pingArgs], ['sudo', ['-n', 'tailscale', ...pingArgs]]]) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' });
      return true;
    } catch {
      // Not reachable yet, or this invocation form was denied — try the next.
    }
  }
  return false;
}

// ─── Main step ────────────────────────────────────────────────────────────────

function runMain() {
  logGroup('Reserve Notestation');

  // ── Validate inputs ──────────────────────────────────────────────────────

  const notestation = getInput('notestation');
  const tagsInput   = getInput('tags');
  const force       = getInput('force') === 'true';
  const timeoutMs   = (parseInt(getInput('timeout'), 10) || 60) * 1000;
  const firmware    = getInput('notecard-firmware');
  const version     = getInput('version');
  const token       = getInput('token');

  if (notestation && tagsInput) {
    fail('Cannot specify both "notestation" and "tags" inputs — they are mutually exclusive.');
  }

  log('Inputs:');
  log(`  notestation : ${notestation || '(auto-select)'}`);
  log(`  tags        : ${tagsInput   || '(none)'}`);
  log(`  force       : ${force}`);
  log(`  timeout     : ${timeoutMs / 1000}s`);
  log(`  notecard-firmware : ${firmware || '(none)'}`);

  // ── Ensure notestation-client is on PATH ─────────────────────────────────

  let clientOnPath = false;
  try {
    execFileSync('which', ['notestation-client'], { stdio: 'ignore' });
    clientOnPath = true;
  } catch { /* not found */ }

  if (clientOnPath) {
    let ver;
    try {
      ver = execFileSync('notestation-client', ['--version'], { encoding: 'utf8' }).trim();
    } catch {
      ver = '(could not determine version)';
    }
    log(`\nnotestation-client already on PATH: ${ver}`);
  } else {
    log('\nnotestation-client not found on PATH.');
    if (!version) {
      fail(
        'notestation-client is not installed and no "version" input was provided.\n' +
        'Either run the install_notestation_client action first, or provide a "version" input.'
      );
    }
    if (!token) {
      fail('A "token" input is required to install notestation-client from blues/notestation.');
    }

    log(`Installing notestation-client ${version}...`);
    const installScript = path.join(
      __dirname,
      '../install_notestation_client/install.sh'
    );

    if (!fs.existsSync(installScript)) {
      fail(
        `install.sh not found at ${installScript}. ` +
        'Ensure install_notestation_client and reserve_notestation actions are in the same repo.'
      );
    }

    try {
      execFileSync('bash', [installScript], {
        stdio: 'inherit',
        env: { ...process.env, INPUT_VERSION: version, INPUT_TOKEN: token },
      });
    } catch (e) {
      fail(`notestation-client installation failed: ${e.message}`);
    }
  }

  // ── Build reserve command arguments ─────────────────────────────────────

  const args = ['reserve'];

  if (notestation) {
    args.push('--notestation', notestation);
  }
  if (tagsInput) {
    const tags = tagsInput.trim().split(/\s+/).filter(Boolean);
    args.push('--tags', tags.join(','));
  }
  if (force) {
    args.push('--force');
  }

  // ── Wait for the Notestation to be reachable over Tailscale ──────────────
  // Front-load the path-convergence wait here so the client dials a target it
  // can already reach, instead of racing (and losing to) convergence on its
  // first dial. Only meaningful for an explicit host — for tag selection the
  // client picks a reachable Notestation itself.

  const waitForReachable = getInput('wait-for-reachable') !== 'false';
  const reachableTimeoutMs = (parseInt(getInput('reachable-timeout'), 10) || 60) * 1000;

  if (waitForReachable && notestation) {
    if (!haveTailscaleCli()) {
      logWarning(
        'wait-for-reachable is enabled but the tailscale CLI was not found on PATH — ' +
        'skipping the reachability pre-check. Ensure Tailscale is connected before this action.'
      );
    } else {
      log(`\nWaiting for ${notestation} to be reachable over Tailscale (up to ${reachableTimeoutMs / 1000}s)...`);
      poll(
        `${notestation} reachable over Tailscale`,
        () => tailscaleReachable(notestation),
        reachableTimeoutMs,
        1000
      );
      log(`${notestation} is reachable — proceeding to reserve.`);
    }
  } else if (waitForReachable && tagsInput) {
    log('\nSkipping reachability pre-check for tag-based selection (the client selects a reachable Notestation itself).');
  }

  log(`\nSpawning: notestation-client ${args.join(' ')}`);

  // ── Spawn notestation-client reserve ────────────────────────────────────
  // The process is long-running (it blocks until SIGTERM) so we detach it and
  // unref() to let this Node.js process exit. stdio is inherited so that the
  // client's log output (e.g. "queued at position N", "reserved") appears in
  // this step's log. Inheritance avoids SIGPIPE that would kill the child if
  // we used pipes and the parent exited before the child finished writing.

  const child = spawn('notestation-client', args, {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (!child.pid) {
    fail('Failed to spawn notestation-client — no PID was returned.');
  }

  const pid = child.pid;
  log(`PID: ${pid}`);

  // Save state for the post step before we do anything else, so that if we
  // fail partway through, the post step can still attempt cleanup.
  saveState('IS_POST', 'true');
  saveState('reserve_pid', String(pid));

  child.unref();

  // ── Poll for reservation directory ───────────────────────────────────────
  // notestation-client creates ~/.notestation/pid-<PID>_<hostname>/ when the
  // server grants the reservation. We don't know the hostname upfront (it may
  // be auto-selected), so we glob for any dir starting with pid-<PID>_.

  const baseDir = path.join(os.homedir(), '.notestation');
  log(`\nPolling for reservation directory under ${baseDir}...`);

  const reservationDir = poll(
    `~/.notestation/pid-${pid}_* directory`,
    () => {
      if (!fs.existsSync(baseDir)) return null;
      const match = fs.readdirSync(baseDir).find((e) => e.startsWith(`pid-${pid}_`));
      return match ? path.join(baseDir, match) : null;
    },
    timeoutMs
  );

  // Extract hostname from directory name: "pid-<PID>_<hostname>"
  const hostname = path.basename(reservationDir).slice(path.basename(reservationDir).indexOf('_') + 1);

  log(`Reservation directory : ${reservationDir}`);
  log(`Notestation hostname  : ${hostname}`);

  // Save the dir so the post step can confirm cleanup.
  saveState('reservation_dir', reservationDir);

  // ── Poll for reservation.json ────────────────────────────────────────────
  // The server writes reservation.json once the reservation is granted.

  const reservationJsonPath = path.join(reservationDir, 'reservation.json');
  log('\nWaiting for reservation.json...');
  poll('reservation.json', () => fs.existsSync(reservationJsonPath), timeoutMs);

  let reservationData;
  try {
    reservationData = JSON.parse(fs.readFileSync(reservationJsonPath, 'utf8'));
  } catch (e) {
    fail(`Failed to parse reservation.json: ${e.message}`);
  }
  log('reservation.json parsed.');

  // ── Poll for interface symlinks ──────────────────────────────────────────
  // Each interface listed in reservation.json gets a PTY symlink created by a
  // tunnel goroutine. Those goroutines start *after* reservation.json is
  // written, so there is a small window where the file exists but symlinks
  // don't yet. We poll only for the interfaces listed in reservation.json —
  // never for a fixed set — to avoid waiting for devices that don't exist.

  const interfaces = reservationData.interfaces || [];

  if (interfaces.length === 0) {
    logWarning('reservation.json lists no interfaces. This is unexpected.');
  } else {
    log(`\nInterfaces in reservation.json (${interfaces.length}):`);
    for (const iface of interfaces) {
      log(`  ${iface.name.padEnd(22)} ${iface.path}`);
    }

    log('\nWaiting for interface symlinks to appear...');
    for (const iface of interfaces) {
      poll(
        `${iface.name} symlink at ${iface.path}`,
        () => {
          try { fs.lstatSync(iface.path); return true; } catch { return false; }
        },
        30000
      );
      log(`  Ready: ${iface.name}`);
    }
  }

  // ── Build NS_* variable map ──────────────────────────────────────────────

  // Maps reservation.json interface names to NS_* env var names.
  const IFACE_ENV_MAP = {
    notecard_usb:      'NS_NOTECARD_USB',
    notecard_aux_uart: 'NS_NOTECARD_AUX_UART',
    notecard_lp_uart:  'NS_NOTECARD_LP_UART',
    host_mcu_usb:      'NS_HOST_MCU_USB',
    host_mcu_uart0:    'NS_HOST_MCU_UART0',
    host_mcu_uart1:    'NS_HOST_MCU_UART1',
    starnote_usb:      'NS_STARNOTE_USB',
  };

  const vars = {
    NS_HOSTNAME:        hostname,
    NS_RESERVATION_DIR: reservationDir,
  };

  for (const iface of interfaces) {
    const envKey = IFACE_ENV_MAP[iface.target];
    if (envKey) {
      vars[envKey] = iface.path;
    } else {
      logWarning(`Interface "${iface.name}" (target: "${iface.target}") has no NS_* mapping — it will not be exported. ` +
                 'Update IFACE_ENV_MAP in reserve_notestation/index.js if this is a new interface type.');
    }
  }

  // GPIO: the D-Bus tunnel socket is not a filesystem file — it's an abstract
  // Unix socket. The address is constructed from the reservation dir path.
  const gpio = reservationData.gpio;
  if (gpio && gpio.dbus_port) {
    const dbusSocket = path.join(reservationDir, 'dbus_sock');
    vars['NS_DBUS_ADDRESS'] = `unix:abstract=${dbusSocket}`;
    log(`\nGPIO D-Bus port : ${gpio.dbus_port}`);
    log(`NS_DBUS_ADDRESS : ${vars['NS_DBUS_ADDRESS']}`);
  }

  // ── Export to GITHUB_ENV and GITHUB_OUTPUT ───────────────────────────────
  // GITHUB_ENV makes vars available to all subsequent steps in this job.
  // GITHUB_OUTPUT makes them available as step outputs for cross-job wiring.

  log('\nExporting NS_* variables:');
  for (const [key, value] of Object.entries(vars)) {
    log(`  ${key.padEnd(22)} = ${value}`);
    exportVariable(key, value);
    setOutput(key.toLowerCase(), value);
  }

  log('\nNotestation reserved and ready.');
  logEndGroup();

  // ── Flash firmware (optional) ────────────────────────────────────────────
  if (firmware) {
    logGroup('Flash Notecard firmware');

    const flashArgs = ['flash', '--notestation', hostname];
    if (firmware === 'nightly') {
      flashArgs.push('--notecard-nightly');
    } else {
      flashArgs.push('--file', firmware);
    }

    log(`Running: notestation-client ${flashArgs.join(' ')}`);
    try {
      execFileSync('notestation-client', flashArgs, { stdio: 'inherit' });
    } catch (e) {
      fail(`Firmware flash failed: ${e.message}`);
    }

    log('Firmware flash complete.');
    logEndGroup();
  }
}

// ─── Post step ────────────────────────────────────────────────────────────────

function runPost() {
  logGroup('Release Notestation');

  const pidStr         = getState('reserve_pid');
  const reservationDir = getState('reservation_dir');

  if (!pidStr) {
    log('No PID found in state — the reservation step may not have started successfully. Nothing to release.');
    logEndGroup();
    return;
  }

  const pid = parseInt(pidStr, 10);
  log(`Releasing reservation held by notestation-client (PID ${pid})...`);

  // ── Send SIGTERM ─────────────────────────────────────────────────────────
  // notestation-client catches SIGTERM, calls SendDone() to notify the server,
  // and removes the reservation directory before exiting.

  try {
    process.kill(pid, 'SIGTERM');
    log(`SIGTERM sent to PID ${pid}.`);
  } catch (err) {
    if (err.code === 'ESRCH') {
      log(`PID ${pid} is no longer running — reservation was already released.`);
      logEndGroup();
      return;
    }
    // Any other error is unexpected but not worth failing the whole job over;
    // the server will eventually expire the reservation.
    logWarning(`Unexpected error sending SIGTERM to PID ${pid}: ${err.message}`);
    logEndGroup();
    return;
  }

  // ── Wait for reservation directory to be removed ─────────────────────────
  // notestation-client removes the directory as part of its shutdown, so its
  // absence confirms the server was notified and local state is clean.

  if (!reservationDir) {
    logWarning('No reservation directory path in state — cannot verify cleanup.');
    logEndGroup();
    return;
  }

  log(`Waiting for reservation directory to be removed: ${reservationDir}`);

  poll(
    'reservation directory removal',
    () => !fs.existsSync(reservationDir),
    30000
  );

  log('Reservation directory removed. Notestation released successfully.');
  logEndGroup();
}

// ─── Entry point ─────────────────────────────────────────────────────────────
// IS_POST is written to GITHUB_STATE by runMain() and surfaced as STATE_IS_POST
// when the post step runs, allowing a single index.js to serve both roles.

if (getState('IS_POST') === 'true') {
  runPost();
} else {
  runMain();
}
