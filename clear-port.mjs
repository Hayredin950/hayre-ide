import { execSync } from "child_process";
import net from "net";
import fs from "fs";

const port = Number(process.env.PORT);
if (!port) { console.log("No PORT, skipping"); process.exit(0); }

function isPortFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(p, "0.0.0.0");
  });
}

function findPidsHoldingPort(p) {
  const inodes = new Set();
  // Check both IPv4 and IPv6 socket tables
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n").slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const localAddr = parts[1];
        const portHex = localAddr.split(":").pop();
        if (parseInt(portHex, 16) === p) {
          inodes.add(parts[9]); // socket inode
        }
      }
    } catch {}
  }

  const pids = new Set();
  if (inodes.size === 0) return pids;

  try {
    const procDirs = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    for (const pid of procDirs) {
      try {
        const fdDir = `/proc/${pid}/fd`;
        const fds = fs.readdirSync(fdDir);
        for (const fd of fds) {
          try {
            const link = fs.readlinkSync(`${fdDir}/${fd}`);
            const m = link.match(/socket:\[(\d+)\]/);
            if (m && inodes.has(m[1])) {
              pids.add(Number(pid));
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return pids;
}

function killPort(p) {
  // /proc-based precise kill
  const pids = findPidsHoldingPort(p);
  for (const pid of pids) {
    try { process.kill(pid, 9); console.log(`Killed PID ${pid} holding port ${p}`); } catch {}
  }
  // Fallback: fuser (both TCP variants)
  try { execSync(`fuser -k ${p}/tcp`, { stdio: "pipe" }); } catch {}
  try { execSync(`fuser -k ${p}/tcp6`, { stdio: "pipe" }); } catch {}
}

if (await isPortFree(port)) {
  console.log(`Port ${port} already free`);
  process.exit(0);
}

console.log(`Port ${port} in use, clearing...`);
killPort(port);

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (await isPortFree(port)) {
    console.log(`Port ${port} freed after ${i + 1}s`);
    process.exit(0);
  }
  console.log(`Waiting for port ${port}... (${i + 1}/20)`);
  killPort(port);
}

console.error(`Could not free port ${port} — continuing anyway`);
process.exit(0);
