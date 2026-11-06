import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Layout smoke tests: a real browser, a seeded library, and three widths. They
// assert what a unit test cannot - that nothing sticks out of the viewport, the
// header's title and controls do not collide, and no card breaks its container.
// Deliberately no pixel baselines: those break on font rendering and would need
// re-approving after every intentional restyle.
//
//   npx playwright install chromium
//   npm run test:layout

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "../server/index.mjs");
let PORT;
let BASE;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "crate-layout-"));
const MUSIC = path.join(DATA, "music");
const BIN = path.join(DATA, "fake-dlAudio.sh");
const OWNER = { username: "owner", password: "layout-pass-1234" };

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

// The owner's pages. Guests see a smaller header, checked separately.
const OWNER_PAGES = [
  "/",
  "/dashboard",
  "/admin#general",
  "/admin#guests",
  "/admin#downloads",
  "/admin#sources",
  "/admin#library",
  "/admin#system",
];

let child;
let browser;
let releaseServer;

function seed() {
  fs.mkdirSync(path.join(MUSIC, "Lib Artist", "Lib Album"), { recursive: true });
  fs.writeFileSync(path.join(MUSIC, "Lib Artist", "Lib Album", "01 - Known Song.m4a"), "x".repeat(2048));
  const now = Date.now();
  fs.writeFileSync(
    path.join(DATA, "jobs.json"),
    JSON.stringify([
      {
        id: "layout1",
        url: "https://example.com/album",
        kind: "playlist",
        thumb: "",
        title: "Nightfall",
        artist: "Lib Artist",
        album: "Lib Album",
        lufs: -9,
        quality: 2,
        format: "m4a",
        onePass: false,
        art: true,
        trackPrefix: true,
        policy: "skip",
        selection: [1],
        total: 1,
        completed: 1,
        conflicts: 0,
        owner: "owner",
        host: "example.com",
        dir: MUSIC,
        state: "done",
        createdAt: now - 3600_000,
        startedAt: now - 3600_000,
        finishedAt: now - 3500_000,
        tracks: [
          {
            i: 1,
            title: "Known Song",
            artist: "Lib Artist",
            album: "Lib Album",
            duration: 214,
            state: "done",
            stage: null,
            pct: 100,
            path: path.join(MUSIC, "Lib Artist", "Lib Album", "01 - Known Song.m4a"),
            size: 2048,
          },
        ],
        log: ["[1/1] Known Song"],
      },
    ]),
  );
  fs.writeFileSync(
    path.join(DATA, "history.json"),
    JSON.stringify([
      {
        id: "h1",
        title: "Nightfall",
        artist: "Lib Artist",
        album: "Lib Album",
        kind: "playlist",
        format: "m4a",
        stream: false,
        total: 3,
        completed: 3,
        skipped: 0,
        failed: 0,
        state: "done",
        owner: "owner",
        finishedAt: now - 2 * 3600_000,
      },
    ]),
  );
  fs.writeFileSync(
    path.join(DATA, "stats.json"),
    JSON.stringify({ tracks: 340, guests: Array.from({ length: 12 }, (_, i) => `guest-${i}`) }),
  );
  fs.writeFileSync(BIN, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

async function startServer(releaseApi) {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      AUDIODL_DATA: DATA,
      AUDIODL_PORT: String(PORT),
      AUDIODL_HOST: "127.0.0.1",
      AUDIODL_BIN: BIN,
      MUSIC_DIR: MUSIC,
      AUDIODL_GUEST: "1",
      AUDIODL_RELEASE_API: releaseApi,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/me`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("the server never answered");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
  const [name, value] = raw.split(";")[0].split("=");
  return { name, value, url: BASE };
}

async function login(page) {
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.fill('input[placeholder="Username"]', OWNER.username);
  await page.fill('input[placeholder="Password"]', OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector("main, header", { timeout: 10_000 });
  await page.waitForTimeout(600);
}

// Everything wrong with the current layout, as strings.
async function audit(page) {
  return page.evaluate(() => {
    const issues = [];
    const doc = document.documentElement;
    const width = doc.clientWidth;

    if (doc.scrollWidth > width + 1) {
      issues.push(`the page scrolls sideways (${doc.scrollWidth} > ${width})`);
    }

    const header = document.querySelector("header");
    if (header?.firstElementChild) {
      const groups = [...header.firstElementChild.children];
      const [title, controls] = groups;
      if (title && controls) {
        const t = title.getBoundingClientRect();
        const c = controls.getBoundingClientRect();
        if (t.right - c.left > 1) {
          issues.push(`header title and controls overlap by ${Math.round(t.right - c.left)}px`);
        }
      }
      for (const group of groups) {
        const r = group.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.left < -1 || r.right > width + 1) {
          issues.push(`a header group sticks out (${Math.round(r.left)}..${Math.round(r.right)} of ${width})`);
        }
      }
    }

    // Containers that must stay inside the page. Hidden cards have no box and
    // are skipped; a horizontal scroller clips its own children, which is the
    // point of it.
    const selector = "main, header, footer, form, section.card, [role='tablist']";
    for (const el of document.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -1 || r.right > width + 1) {
        const label = el.tagName.toLowerCase() + (el.className ? `.${String(el.className).trim().split(/\s+/)[0]}` : "");
        issues.push(`${label} sits outside the viewport (${Math.round(r.left)}..${Math.round(r.right)} of ${width})`);
      }
    }

    return issues;
  });
}

async function open(viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  await context.addInitScript(() => {
    // Flat and still: identical geometry, no aura drift mid-measurement.
    localStorage.setItem("audiodl-theme", "light");
    localStorage.setItem("audiodl-effects", "off");
    localStorage.setItem("audiodl-2fa-nudge", "dismissed");
  });
  return context;
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  seed();
  // A stand-in for GitHub's releases API. The owner's update hint is part of
  // the page now, so it is audited like the rest of it - without depending on
  // the network or on what happens to be the latest release today.
  releaseServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        tag_name: "v9.9.9",
        html_url: "https://github.com/SmoothCLI/crate/releases/tag/v9.9.9",
        body: "Small fixes and a faster queue.",
      }),
    );
  });
  await new Promise((resolve) => releaseServer.listen(0, "127.0.0.1", resolve));
  const releaseApi = `http://127.0.0.1:${releaseServer.address().port}/releases/latest`;
  await startServer(releaseApi);
  await fetch(`${BASE}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ siteName: "Crate", username: OWNER.username, contact: "", password: OWNER.password }),
  });
  // The settings page takes its look from the server rather than from
  // localStorage, so the flat-and-still setup in open() cannot reach it: pick
  // the same look once here, through the route the page itself uses.
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...OWNER, remember: null }),
  });
  const session = (login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie") ?? "").split(";")[0];
  await fetch(`${BASE}/api/admin/look`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: session },
    body: JSON.stringify({ theme: "light", effects: "off", flavor: null, accent: "mauve" }),
  });
  // The layout tests read the built shell; say so rather than pass on a blank page.
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.ok(shell.includes("/assets/"), "no built assets - run `npm run build` first");
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  } catch (error) {
    assert.fail(
      `Chromium is not installed for Playwright (${String(error.message).split("\n")[0]}). ` +
        "Run `npx playwright install chromium` first.",
    );
  }
});

after(async () => {
  await browser?.close();
  child?.kill("SIGTERM");
  releaseServer?.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

for (const viewport of VIEWPORTS) {
  test(`layout holds at ${viewport.width}px (${viewport.name})`, async () => {
    const context = await open(viewport);
    const page = await context.newPage();
    await login(page);

    for (const route of OWNER_PAGES) {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      // Let the entrance animation and the first data fetch settle; geometry is
      // what is checked, not pixels.
      await page.waitForTimeout(700);
      const issues = await audit(page);
      assert.deepEqual(issues, [], `${viewport.name} ${route}`);
    }

    await context.close();
  });
}

// If the audit cannot see a deliberately broken header, a green run means
// nothing. This proves the detector works at the narrowest width.
test("the audit catches an overlap when one is introduced", async () => {
  const context = await open({ width: 390, height: 844 });
  const page = await context.newPage();
  await login(page);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  assert.deepEqual(await audit(page), []);

  // A transform moves the controls without giving flexbox room to re-space
  // them, which is what a real overflow looks like.
  await page.evaluate(() => {
    const row = document.querySelector("header").firstElementChild;
    row.lastElementChild.style.transform = "translateX(-140px)";
  });
  await page.waitForTimeout(100);
  const issues = await audit(page);
  assert.ok(
    issues.some((issue) => issue.includes("overlap")),
    `expected an overlap, got ${JSON.stringify(issues)}`,
  );
  await context.close();
});

test("guest queue fits on a phone, with the guest tag", async () => {
  const response = await fetch(`${BASE}/api/guest`, { method: "POST" });
  assert.equal(response.status, 200);
  const context = await open({ width: 390, height: 844 });
  await context.addCookies([cookieFrom(response)]);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  assert.deepEqual(await audit(page), []);
  assert.match(await page.locator("header").innerText(), /guest/);
  await context.close();
});

// The palette is a guest feature: it must work without the owner's password,
// survive a reload, and leave no trace once the built-in colours are chosen.
test("a guest can theme the queue with Catppuccin, and it sticks", async () => {
  const response = await fetch(`${BASE}/api/guest`, { method: "POST" });
  assert.equal(response.status, 200);
  const context = await open({ width: 390, height: 844 });
  await context.addCookies([cookieFrom(response)]);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);

  await page.getByRole("button", { name: "Appearance" }).click();
  const box = await page.locator('[role="dialog"]').boundingBox();
  assert.ok(
    box && box.x >= -1 && box.x + box.width <= 390 + 1,
    `the appearance dialog leaves the phone (${JSON.stringify(box)})`,
  );

  await page.getByRole("button", { name: "Mocha" }).click();

  // A swatch names itself on keyboard focus as well as on hover, and Escape
  // dismisses the tip rather than the dialog.
  const rosewater = page.getByRole("button", { name: "Rosewater accent" });
  await rosewater.focus();
  const tooltip = page.getByRole("tooltip");
  await tooltip.waitFor({ state: "visible", timeout: 3000 });
  assert.equal((await tooltip.innerText()).trim(), "Rosewater");
  assert.equal(await rosewater.getAttribute("aria-describedby"), await tooltip.getAttribute("id"));
  await page.keyboard.press("Escape");
  await tooltip.waitFor({ state: "hidden", timeout: 3000 });
  assert.equal(await page.locator('[role="dialog"]').count(), 1, "Escape closed the dialog");

  await page.getByRole("button", { name: "Green accent" }).click();
  // The pick is also written out, for touch and for shades that are hard to tell
  // apart in a 28px circle.
  assert.match(await page.locator('[role="dialog"]').innerText(), /Green/);
  await page.getByRole("button", { name: "Close appearance" }).click();
  await page.waitForTimeout(200);

  const themed = await page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      flavor: root.dataset.catppuccin ?? null,
      accent: root.dataset.accent,
      canvas: style.getPropertyValue("--canvas").trim(),
      accentToken: style.getPropertyValue("--accent").trim(),
      stored: localStorage.getItem("audiodl-catppuccin"),
    };
  });
  assert.equal(themed.flavor, "mocha");
  assert.equal(themed.accent, "green");
  assert.equal(themed.canvas, "#11111b");
  assert.equal(themed.accentToken, "#a6e3a1");
  assert.match(themed.stored ?? "", /mocha/);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  assert.deepEqual(await audit(page), []);
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.catppuccin ?? null),
    "mocha",
    "the flavor did not survive the reload",
  );

  // The choice also went out as a cookie, which is the only store the server
  // can read: a first byte fetched with those cookies is already themed, which
  // is what stops the flash of the default palette on the way in.
  const cookies = await context.cookies(BASE);
  assert.match(
    cookies.find((cookie) => cookie.name === "audiodl-catppuccin")?.value ?? "",
    /mocha/,
  );
  const firstByte = await (
    await fetch(`${BASE}/`, {
      headers: { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") },
    })
  ).text();
  const openTag = firstByte.match(/<html[^>]*>/)[0];
  assert.match(openTag, /data-catppuccin="mocha"/);
  assert.match(openTag, /data-accent="green"/);
  assert.match(openTag, /data-effects="off"/);
  assert.match(openTag, /data-theme="light"/);

  await page.getByRole("button", { name: "Appearance" }).click();
  // A flavor decides light or dark, so the theme row is off until Default.
  const disabled = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter((button) => /^(Auto|Light|Dark)$/.test(button.textContent ?? ""))
      .map((button) => button.disabled),
  );
  assert.deepEqual(disabled, [true, true, true]);

  await page.getByRole("button", { name: "Default" }).click();
  await page.waitForTimeout(200);
  const reset = await page.evaluate(() => ({
    flavor: document.documentElement.dataset.catppuccin ?? null,
    canvas: getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
    themeRow: [...document.querySelectorAll("button")]
      .filter((button) => /^(Auto|Light|Dark)$/.test(button.textContent ?? ""))
      .map((button) => button.disabled),
  }));
  assert.equal(reset.flavor, null);
  assert.equal(reset.canvas, "#eef0f6");
  assert.deepEqual(reset.themeRow, [false, false, false]);
  assert.deepEqual(await audit(page), []);

  await context.close();
});

// The release hint is only useful if it actually renders, and only for the
// owner: this walks both owner pages it appears on and checks the link target.
test("the owner sees the update hint on the queue and the overview", async () => {
  const context = await open({ width: 390, height: 844 });
  const page = await context.newPage();
  await login(page);

  for (const route of ["/", "/dashboard"]) {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    const hint = page.getByRole("status", { name: "Update available" });
    await hint.waitFor({ timeout: 10_000 });
    assert.match(await hint.innerText(), /Crate 9\.9\.9 is (out|available)/);
    assert.equal(
      await hint.getByRole("link", { name: "Release notes" }).getAttribute("href"),
      "https://github.com/SmoothCLI/crate/releases/tag/v9.9.9",
    );
    // The release body is readable without leaving the page.
    assert.equal(await hint.locator("details").count(), 1);
    assert.match(await hint.innerText(), /What's new/);
    assert.deepEqual(await audit(page), [], route);
  }

  // The gear in the header carries a dot while an update is waiting.
  assert.equal(await page.locator("[data-update-badge]").count(), 1);

  // Dismissing is per browser and per release: the page stays quiet after a
  // reload, but a newer release is not silenced by an older dismissal.
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  const hint = page.getByRole("status", { name: "Update available" });
  await hint.waitFor({ timeout: 10_000 });
  await hint.getByRole("button", { name: "Dismiss update notice" }).click();
  await hint.waitFor({ state: "detached" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  assert.equal(await page.getByRole("status", { name: "Update available" }).count(), 0);

  await page.evaluate(() => localStorage.setItem("audiodl-update-dismissed", "0.0.1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  const again = page.getByRole("status", { name: "Update available" });
  await again.waitFor({ timeout: 10_000 });
  assert.deepEqual(await audit(page), []);

  // Skipping is the lasting version of the same choice.
  await again.getByRole("button", { name: "Skip this version" }).click();
  await again.waitFor({ state: "detached" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  assert.equal(await page.getByRole("status", { name: "Update available" }).count(), 0);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("audiodl-update-skipped")),
    "9.9.9",
  );

  await context.close();
});

// The hint is the owner's. A guest's settings carry no release field, and the
// queue must not render the card even when the server knows a newer version.
test("a guest never sees the update hint", async () => {
  const response = await fetch(`${BASE}/api/guest`, { method: "POST" });
  assert.equal(response.status, 200);
  const context = await open({ width: 390, height: 844 });
  await context.addCookies([cookieFrom(response)]);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  assert.equal(await page.getByRole("status", { name: "Update available" }).count(), 0);
  assert.equal(await page.locator("[data-update-badge]").count(), 0);
  assert.deepEqual(await audit(page), []);
  await context.close();
});

test("the sign-in card fits on a phone", async () => {
  const context = await open({ width: 390, height: 844 });
  const page = await context.newPage();
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[placeholder="Password"]', { timeout: 10_000 });
  await page.waitForTimeout(500);
  assert.deepEqual(await audit(page), []);
  await context.close();
});
