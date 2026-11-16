#!/usr/bin/env node
/*
 * Motion QA: look at the film the way a director would, frame by frame.
 *
 *   node tools/motion-qa.mjs index.html [--every 1] [--out qa]
 *
 * Needs only Node 22+ and Chrome or Edge (set CHROME_PATH for another
 * Chromium). Nothing to install: it drives the browser over the DevTools
 * protocol. It seeks window.MOTION to the moments that matter (the start,
 * middle and end of every scene, the middle of every transition, every
 * second), captures each one, checks it, and writes:
 *
 *   qa/report.md          what is wrong, blocking first, with times
 *   qa/contact-sheet.png  every captured frame; red = a finding there
 *   qa/frames/*.jpg       each frame, to open with view_image
 *
 * Exits 1 when anything blocking is found.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---- arguments ----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const file = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--")) ?? "index.html";
const every = Number(flag("every", "1"));
const outDir = path.resolve(flag("out", "qa"));
if (!fs.existsSync(file)) fail(`No such file: ${file}`);
if (typeof WebSocket === "undefined") fail("Node 22 or newer is needed (it has WebSocket built in). Check with: node --version");

function fail(message) {
  console.error(`motion-qa: ${message}`);
  process.exit(2);
}

// ---- the browser ----------------------------------------------------------------
function findBrowser() {
  const env = process.env.CHROME_PATH || process.env.CHROME;
  if (env && fs.existsSync(env)) return env;
  const win = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates =
    process.platform === "win32"
      ? win.flatMap((d) => [path.join(d, "Google/Chrome/Application/chrome.exe"), path.join(d, "Microsoft/Edge/Application/msedge.exe"), path.join(d, "Chromium/Application/chrome.exe")])
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].map((n) => spawnSync("which", [n], { encoding: "utf8" }).stdout?.trim()).filter(Boolean);
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) fail("No Chrome or Edge found. Install one, or set CHROME_PATH to a Chromium browser.");
  return found;
}

/** A headless browser and one page in it, spoken to over the DevTools protocol. */
async function openBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "motion-"));
  const proc = spawn(findBrowser(), [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--mute-audio", "--disable-gpu", "--force-device-scale-factor=1", "--allow-file-access-from-files",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--window-size=1920,1080", "about:blank",
  ], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (!fs.existsSync(portFile)) {
    if (Date.now() - started > 30_000) { proc.kill(); fail("The browser did not start within 30 s."); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const waiting = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? no(new Error(`${msg.error.message}`)) : ok(msg.result);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };
  const send = (method, params = {}) => new Promise((ok, no) => { const n = ++id; waiting.set(n, { ok, no }); ws.send(JSON.stringify({ id: n, method, params })); });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const close = () => { try { ws.close(); } catch {} proc.kill(); setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500); };
  return { send, on, evaluate, close };
}

// ---- in the page: helpers to judge a captured frame ----------------------------------
const PAGE_HELPERS = `
window.__qa = {
  img: (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/jpeg" })),
  pixels: async (b64, w = 480) => { const bm = await __qa.img(b64); const h = Math.round(bm.height * w / bm.width); const c = new OffscreenCanvas(w, h); const g = c.getContext("2d"); g.drawImage(bm, 0, 0, w, h); return { w, h, d: g.getImageData(0, 0, w, h).data, sx: w / bm.width }; },
  lum: (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); },
  diff: async (a, b) => { const A = await __qa.pixels(a), B = await __qa.pixels(b); let n = 0; for (let i = 0; i < A.d.length; i += 4) { if (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]) > 30) n++; } return n / (A.d.length / 4); },
  spread: async (b64) => { const P = await __qa.pixels(b64, 240); let s = 0, s2 = 0, n = 0; for (let i = 0; i < P.d.length; i += 4) { const l = (P.d[i] + P.d[i + 1] + P.d[i + 2]) / 3; s += l; s2 += l * l; n++; } return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)); },
  contrast: async (b64, boxes) => {
    const P = await __qa.pixels(b64, 960);
    return boxes.map((b) => {
      const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/.exec(b.color || ""); if (!m) return null;
      const ink = __qa.lum(+m[1], +m[2], +m[3]);
      const x0 = Math.max(0, Math.floor(b.x * P.sx)), y0 = Math.max(0, Math.floor(b.y * P.sx)), x1 = Math.min(P.w - 1, Math.ceil((b.x + b.w) * P.sx)), y1 = Math.min(P.h - 1, Math.ceil((b.y + b.h) * P.sx));
      const ls = [];
      for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) { const i = (y * P.w + x) * 4; ls.push(__qa.lum(P.d[i], P.d[i + 1], P.d[i + 2])); }
      if (ls.length < 8) return null;
      ls.sort((p, q) => Math.abs(p - ink) - Math.abs(q - ink));
      // The background is what is least like the ink: the far half of the samples.
      const far = ls.slice(Math.floor(ls.length / 2)); const bg = far.reduce((s, v) => s + v, 0) / far.length;
      const hi = Math.max(ink, bg), lo = Math.min(ink, bg); return (hi + 0.05) / (lo + 0.05);
    });
  },
};`;

// ---- run ---------------------------------------------------------------------------
const html = fs.readFileSync(file, "utf8");
const filmPart = html.split("MOTION KIT ENGINE")[0];
const browser = await openBrowser();
const consoleErrors = [];
browser.on("Runtime.exceptionThrown", (p) => consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception"));
browser.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error") consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? "").join(" ")); });
browser.on("Log.entryAdded", (p) => { if (p.entry.level === "error") consoleErrors.push(`${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ""}`); });
await browser.send("Page.enable");
await browser.send("Runtime.enable");
await browser.send("Log.enable");

const url = `${pathToFileURL(path.resolve(file)).href}?clean=1`;
await browser.send("Page.navigate", { url });
const ready = await browser
  .evaluate(`new Promise((ok) => { const t0 = Date.now(); const c = () => (document.documentElement.dataset.ready === "1" ? ok(true) : Date.now() - t0 > 30000 ? ok(false) : setTimeout(c, 50)); c(); })`)
  .catch(() => false);
if (!ready) {
  browser.close();
  fail(`The film never became ready (window.MOTION missing or fonts/images stuck).${consoleErrors.length ? `\n  ${consoleErrors.join("\n  ")}` : ""}`);
}
/*
 * A font loaded if any face of its family did. Google Fonts splits a font
 * into subsets by script, so document.fonts.check() of a weight can be false
 * while every letter on screen is drawn in it. A system font has no face to
 * load, and is checked as one.
 */
const info = await browser.evaluate(`({ duration: MOTION.duration, width: MOTION.width, height: MOTION.height, marks: MOTION.marks, transitions: MOTION.transitions ?? [],
  fonts: MOTION.fonts.map((stack) => { const name = stack.split(",")[0].trim().replace(/^['"]|['"]$/g, ""); const faces = [...document.fonts].filter((f) => f.family.replace(/^['"]|['"]$/g, "") === name); return [name, faces.length ? faces.some((f) => f.status === "loaded") : document.fonts.check('16px "' + name + '"')]; }) })`);
const inTransition = (t) => info.transitions.some((x) => Math.abs(t - x.t) <= x.dur / 2 + 0.02);
await browser.send("Emulation.setDeviceMetricsOverride", { width: info.width, height: info.height, deviceScaleFactor: 1, mobile: false });
await browser.evaluate(PAGE_HELPERS);

// The moments that matter.
const D = info.duration;
const times = new Set();
info.marks.forEach((m, i) => {
  const end = info.marks[i + 1]?.t ?? D;
  for (const t of [m.t + 0.15, (m.t + end) / 2, end - 0.2]) times.add(Math.round(Math.max(0, Math.min(D - 0.02, t)) * 100) / 100);
  if (i > 0) times.add(Math.round(m.t * 100) / 100);
});
for (let t = 0; t < D; t += every) times.add(Math.round(t * 100) / 100);
const moments = [...times].sort((a, b) => a - b).slice(0, 90);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
const findings = [];
const add = (level, t, what) => findings.push({ level, t, what });

const LAW = [
  [/Math\.random\s*\(/, "Math.random: every visual must be a function of t (use kit.noise(t, seed) or kit.hash)"],
  [/Date\.now\s*\(|performance\.now\s*\(/, "Date.now / performance.now: the clock is t, nothing else"],
  [/setInterval\s*\(|setTimeout\s*\(|requestAnimationFrame\s*\(/, "timers or requestAnimationFrame: draw in draw(t) only"],
  [/@keyframes|animation\s*:|transition\s*:/, "CSS animation or transition: they run on their own clock and break seeking"],
];
for (const [re, why] of LAW) if (re.test(filmPart)) add("blocking", null, `Breaks the deterministic law: ${why}.`);
if (/Placeholder/i.test(filmPart)) add("warning", null, "Placeholder text is still in the film.");

const frames = [];
for (const t of moments) {
  const view = await browser.evaluate(`MOTION.seek(${t}).then(() => MOTION.inspect())`);
  const shot = (await browser.send("Page.captureScreenshot", { format: "jpeg", quality: 82 })).data;
  const name = `t-${t.toFixed(2).padStart(6, "0")}.jpg`;
  fs.writeFileSync(path.join(outDir, "frames", name), Buffer.from(shot, "base64"));
  const frame = { t, scene: view.scene, name, shot, texts: view.texts, issues: [] };
  frames.push(frame);
  const flagFrame = (level, what) => { add(level, t, `${what} [${view.scene}]`); frame.issues.push(level); };
  // Through a transition, text slides off the frame and under the next scene by design: only errors count there.
  if (inTransition(t)) continue;

  const visible = view.texts.filter((x) => x.opacity > 0.5);
  for (const x of visible) {
    if (x.x < -2 || x.y < -2 || x.x + x.w > info.width + 2 || x.y + x.h > info.height + 2) flagFrame("blocking", `Text cut by the frame's edge: "${x.text}"`);
    else if (x.x < info.width * 0.05 || x.y < info.height * 0.05 || x.x + x.w > info.width * 0.95 || x.y + x.h > info.height * 0.95) flagFrame("warning", `Text outside the title-safe area: "${x.text}"`);
    if (x.size < 28) flagFrame("blocking", `Text too small to read (${Math.round(x.size)} px): "${x.text}"`);
  }
  for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
    const a = visible[i], b = visible[j];
    if (a.text.includes(b.text) || b.text.includes(a.text)) continue;
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    if (ix * iy > 0.08 * Math.min(a.w * a.h, b.w * b.h)) flagFrame("blocking", `Text overlaps text: "${a.text}" and "${b.text}"`);
  }
  const sizes = new Set(visible.map((x) => Math.round(x.size / 12)));
  if (sizes.size >= 3) flagFrame("warning", "Three or more text sizes on screen at once");
  const contrasts = visible.length ? await browser.evaluate(`__qa.contrast(${JSON.stringify(shot)}, ${JSON.stringify(visible)})`) : [];
  contrasts.forEach((c, i) => {
    if (c == null) return;
    if (c < 2.2) flagFrame("blocking", `Unreadable contrast (${c.toFixed(1)}:1) behind "${visible[i].text}"`);
    else if (c < 3.2) flagFrame("warning", `Weak contrast (${c.toFixed(1)}:1) behind "${visible[i].text}"`);
  });
  if ((await browser.evaluate(`__qa.spread(${JSON.stringify(shot)})`)) < 2.5) flagFrame("blocking", "Blank frame: nothing on screen");
}

// Same time, same picture: seek away and back, a few times.
for (const frame of frames.filter((_, i) => i % 4 === 1)) {
  await browser.evaluate(`MOTION.seek(${Math.min(D - 0.05, frame.t + 1.37)})`);
  await browser.evaluate(`MOTION.seek(${frame.t})`);
  const again = (await browser.send("Page.captureScreenshot", { format: "jpeg", quality: 82 })).data;
  const share = await browser.evaluate(`__qa.diff(${JSON.stringify(frame.shot)}, ${JSON.stringify(again)})`);
  if (share > 0.004) { add("blocking", frame.t, `Not deterministic: the frame differs when sought twice (${(share * 100).toFixed(1)}% of pixels) [${frame.scene}]`); frame.issues.push("blocking"); }
}

// Holds: whole seconds where nothing moves.
const seconds = frames.filter((f) => Math.abs(f.t / every - Math.round(f.t / every)) < 0.001);
let still = 0;
for (let i = 1; i < seconds.length; i++) {
  const share = await browser.evaluate(`__qa.diff(${JSON.stringify(seconds[i - 1].shot)}, ${JSON.stringify(seconds[i].shot)})`);
  still = share < 0.0015 ? still + every : 0;
  if (still >= 2.5) { add("blocking", seconds[i].t, `Nothing moves for ${still.toFixed(1)} s [${seconds[i].scene}]: keep the background or camera alive`); seconds[i].issues.push("blocking"); still = 0; }
}
for (const e of [...new Set(consoleErrors)]) add("blocking", null, `Page error: ${e}`);
// Only the fonts text on screen is set in: a mono face declared for code the film never shows is not missing.
const used = new Set(frames.flatMap((f) => f.texts.map((x) => x.font.split(",")[0].trim().replace(/^['"]|['"]$/g, ""))));
for (const [f, ok] of info.fonts) if (!ok && used.has(f)) add("blocking", null, `Font did not load: ${f}. Check its family name and the Google Fonts URL in theme.fonts.`);

// ---- the contact sheet -----------------------------------------------------------------
const sheet = path.join(outDir, "sheet.html");
fs.writeFileSync(sheet, `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:14px;background:#15161a;font:600 15px system-ui;color:#ddd;display:grid;grid-template-columns:repeat(4,1fr);gap:12px">${frames
  .map((f) => `<figure style="margin:0;border:3px solid ${f.issues.includes("blocking") ? "#ff4d4f" : f.issues.length ? "#f5a524" : "#2a2c33"};border-radius:6px;overflow:hidden;background:#000"><img src="frames/${f.name}" style="width:100%;display:block"><figcaption style="padding:6px 8px">${f.t.toFixed(2)} s · ${f.scene ?? ""}</figcaption></figure>`)
  .join("")}</body>`);
await browser.send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1000, deviceScaleFactor: 1, mobile: false });
await browser.send("Page.navigate", { url: pathToFileURL(sheet).href });
await browser.evaluate(`new Promise((ok) => (document.readyState === "complete" ? ok() : addEventListener("load", ok)))`);
await browser.evaluate(`Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))))`);
const { cssContentSize } = await browser.send("Page.getLayoutMetrics");
const png = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1800, height: Math.ceil(cssContentSize.height), scale: 1 } });
fs.writeFileSync(path.join(outDir, "contact-sheet.png"), Buffer.from(png.data, "base64"));
browser.close();

// ---- the report -----------------------------------------------------------------------
const blocking = findings.filter((f) => f.level === "blocking");
const warnings = findings.filter((f) => f.level === "warning");
const line = (f) => `- ${f.t == null ? "" : `**${f.t.toFixed(2)} s** `}${f.what}`;
const dedupe = (list) => [...new Map(list.map((f) => [`${f.what}`, f])).values()];
const report = [
  `# Motion QA: ${path.basename(file)}`,
  "",
  `${blocking.length === 0 ? "PASS" : "FAIL"} · ${D.toFixed(2)} s · ${info.width}x${info.height} · ${frames.length} frames checked · ${blocking.length} blocking · ${warnings.length} warnings`,
  "",
  "## Blocking",
  ...(blocking.length ? dedupe(blocking).map(line) : ["None."]),
  "",
  "## Warnings",
  ...(warnings.length ? dedupe(warnings).map(line) : ["None."]),
  "",
  "## Next",
  blocking.length ? "Fix every blocking finding, then run this again." : "Look at qa/contact-sheet.png with view_image and judge it as a director: one idea per frame, the eye knows where to look, the camera moves at every cut, nothing looks like a slide.",
  "",
].join("\n");
fs.writeFileSync(path.join(outDir, "report.md"), report);
console.log(report);
console.log(`Contact sheet: ${path.join(outDir, "contact-sheet.png")}`);
process.exit(blocking.length ? 1 : 0);
