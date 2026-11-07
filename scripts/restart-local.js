const { spawn, execSync } = require('child_process');

function getListeningPids(port) {
  try {
    const out = execSync(`lsof -t -i TCP:${port} -s TCP:LISTEN`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    return out ? out.split(/\s+/).filter(Boolean) : [];
  } catch (_error) {
    return [];
  }
}

function killPids(pids) {
  if (!pids.length) return;
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch (_error) {
      // ignore stale pid values
    }
  }
}

const port = 4000;
const pids = getListeningPids(port);

if (pids.length) {
  console.log(`Stopping stale backend process(es) on port ${port}: ${pids.join(', ')}`);
  killPids(pids);
}

console.log('Manual test restart: restarting only the backend on port 4000.');
console.log('If you also need the static frontend, run: npm run serve');

const child = spawn('node', ['-r', 'dotenv/config', 'server.js'], {
  stdio: 'inherit',
  shell: false
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`Backend stopped by signal: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});
