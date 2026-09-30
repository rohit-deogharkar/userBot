// Starts the server (which the website talks to, and where the bot runs) and the website together.
//   npm run testnet   BNB testnet
//   npm start         local copy of BNB Chain (needs anvil)
// Ctrl+C stops both.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testnet = process.argv[2] === "testnet";
const WEBSITE = "http://localhost:5173";

const parts = [
  { name: "server ", dir: "backend", script: testnet ? "dev:testnet" : "dev", ready: "userDexBot backend on" },
  { name: "website", dir: "frontend", script: "dev", ready: "localhost:5173" },
];

let stopping = false;
const ready = new Set();

const children = parts.map((part) => {
  const child = spawn(`npm run ${part.script}`, { cwd: path.join(root, part.dir), shell: true });
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      // Colour codes would break up text like "localhost:5173", so they are removed.
      for (const line of lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))) {
        if (!line.trim()) continue;
        console.log(`[${part.name}] ${line}`);
        if (line.includes(part.ready) && !ready.has(part.name)) {
          ready.add(part.name);
          if (ready.size === parts.length) {
            console.log(`\nReady. Open ${WEBSITE} in the browser that has MetaMask. Keep this window open; Ctrl+C stops everything.\n`);
          }
        }
      }
    });
  }
  child.on("exit", (code) => {
    console.log(`[${part.name}] stopped${code ? ` (exit code ${code})` : ""}`);
    stopAll();
  });
  return child;
});

// If one part stops, stop the other too, so nothing is left running half-working.
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else child.kill("SIGINT");
  }
}

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
