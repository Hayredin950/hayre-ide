import { execSync } from "child_process";
import net from "net";

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

function killPort(p) {
  try { execSync(`fuser -k ${p}/tcp`, { stdio: "pipe" }); } catch {}
}

if (await isPortFree(port)) {
  console.log(`Port ${port} already free`);
  process.exit(0);
}

console.log(`Port ${port} in use, clearing...`);
killPort(port);

for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (await isPortFree(port)) {
    console.log(`Port ${port} freed after ${i + 1}s`);
    process.exit(0);
  }
  console.log(`Still waiting for port ${port}... (${i + 1}/15)`);
  killPort(port);
}

console.error(`Could not free port ${port} after 15s — continuing anyway`);
process.exit(0);
