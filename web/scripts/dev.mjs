#!/usr/bin/env node
// Live local development: the API and Vite side by side, straight from the
// working tree.
//
// The published container usually holds 8080 on a machine that already runs
// Crate, so the dev API gets a port of its own (AUDIODL_PORT, 8081 by default)
// and Vite proxies /api to it. Edits under web/src hot-reload in the browser;
// edits under web/server restart the API through `node --watch`. Nothing here
// builds an image, writes a tag or talks to the registry, so a change can be
// looked at while it is still uncommitted.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.AUDIODL_PORT || 8081);
const API = `http://127.0.0.1:${API_PORT}`;
const UI_PORT = process.env.CRATE_UI_PORT || "5173";

const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: WEB,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    // Both halves are needed for anything to render, so whichever one dies
    // takes the command down instead of leaving a half-working page behind.
    console.error(`[dev] ${name} exited (${signal ?? code})`);
    stop(code || 1);
  });
  children.push(child);
  return child;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function waitForApi() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${API}/api/health`);
      // Any answer at all means the listener is up; the status is the server's
      // business, and a 401 or a 400 here still proves it is answering.
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

// A dev server on 0.0.0.0 with a known password would be a shared instance
// nobody asked for, so this one is loopback-only. The seeded password is only
// for the throwaway folder under web/data: when AUDIODL_DATA is set the flag is
// left alone, because the server would otherwise rewrite that instance's real
// password hash.
const apiEnv = { AUDIODL_PORT: String(API_PORT), AUDIODL_HOST: process.env.AUDIODL_HOST || "127.0.0.1" };
const seeded = !process.env.AUDIODL_DATA && !process.env.AUDIODL_PASSWORD;
if (seeded) apiEnv.AUDIODL_PASSWORD = "crate-dev";

console.log(`[dev] api ${API}  ui http://localhost:${UI_PORT}`);
console.log("[dev] working tree only: no build, no tag, nothing published");
if (seeded) console.log("[dev] dev data is web/data, password 'crate-dev' (set AUDIODL_DATA to use another)");

start("api", ["--watch", "server/index.mjs"], apiEnv);

if (!(await waitForApi())) {
  console.error(
    `[dev] the api never answered on ${API}. Is port ${API_PORT} taken? ` +
      "Set AUDIODL_PORT to another one.",
  );
  stop(1);
}

start(
  "vite",
  [path.join(WEB, "node_modules", "vite", "bin", "vite.js"), "--port", UI_PORT, "--strictPort"],
  { CRATE_API: API },
);
