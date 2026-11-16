#!/usr/bin/env node
/*
 * Export the film to MP4, frame-exact.
 *
 *   node tools/export-video.mjs index.html out/video.mp4 [--fps 60] [--scale 0.5] [--from 0] [--to 8] [--crf 18] [--grain]
 *
 * Needs Node 22+, Chrome or Edge (or CHROME_PATH), and ffmpeg on the PATH
 * (Windows: winget install Gyan.FFmpeg · macOS: brew install ffmpeg · Linux:
 * apt install ffmpeg). Every frame is window.MOTION.seek(i / fps), captured
 * and piped straight into ffmpeg, so the file has exactly the frames the
 * film defines, however slow the machine. The film's audio (MOTION.audio)
 * is muxed in.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1]?.startsWith("--") && !["grain"].includes(argv[i - 1].slice(2))));
const file = positional[0] ?? "index.html";
const out = path.resolve(positional[1] ?? "out/video.mp4");
const scale = Number(flag("scale", "1"));
const crf = flag("crf", "18");

function fail(message) {
  console.error(`export-video: ${message}`);
  process.exit(2);
}
if (!fs.existsSync(file)) fail(`No such file: ${file}`);
if (typeof WebSocket === "undefined") fail("Node 22 or newer is needed (it has WebSocket built in). Check with: node --version");
if (spawnSync("ffmpeg", ["-hide_banner", "-version"]).status !== 0) {
  fail("ffmpeg is not on the PATH. Install it (Windows: winget install Gyan.FFmpeg · macOS: brew install ffmpeg · Linux: apt install ffmpeg), open a new terminal, and run this again.");
}

// ---- the browser (the same launcher as motion-qa.mjs) -------------------------------
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
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((ok, no) => { const n = ++id; waiting.set(n, { ok, no }); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const close = () => { try { ws.close(); } catch {} proc.kill(); setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500); };
  return { send, evaluate, close };
}

// ---- export ------------------------------------------------------------------------
const browser = await openBrowser();
await browser.send("Page.enable");
await browser.send("Page.navigate", { url: `${pathToFileURL(path.resolve(file)).href}?clean=1` });
const ready = await browser
  .evaluate(`new Promise((ok) => { const t0 = Date.now(); const c = () => (document.documentElement.dataset.ready === "1" ? ok(true) : Date.now() - t0 > 30000 ? ok(false) : setTimeout(c, 50)); c(); })`)
  .catch(() => false);
if (!ready) { browser.close(); fail("The film never became ready: run motion-qa.mjs to see why."); }
const film = await browser.evaluate(`({ duration: MOTION.duration, fps: MOTION.fps, width: MOTION.width, height: MOTION.height, audio: MOTION.audio })`);
const fps = Number(flag("fps", String(film.fps || 30)));
const from = Number(flag("from", "0"));
const to = Math.min(film.duration, Number(flag("to", String(film.duration))));
// Even sizes: H.264 in yuv420p will not take an odd width or height.
const outW = Math.round((film.width * scale) / 2) * 2;
const outH = Math.round((film.height * scale) / 2) * 2;
await browser.send("Emulation.setDeviceMetricsOverride", { width: film.width, height: film.height, deviceScaleFactor: scale, mobile: false });

const audioPath = film.audio && !/^https?:/i.test(film.audio) ? path.resolve(path.dirname(path.resolve(file)), film.audio) : null;
const withAudio = audioPath && fs.existsSync(audioPath);
if (film.audio && !withAudio) console.warn(`export-video: the film's audio (${film.audio}) was not found beside it; exporting without sound.`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const ffmpeg = spawn("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", String(fps), "-i", "-",
  ...(withAudio ? ["-ss", String(from), "-i", audioPath] : []),
  "-map", "0:v", ...(withAudio ? ["-map", "1:a", "-c:a", "aac", "-b:a", "192k", "-shortest"] : []),
  "-vf", `scale=${outW}:${outH}:flags=lanczos,format=yuv420p`,
  "-c:v", "libx264", "-preset", "slow", "-crf", crf, ...(has("grain") ? ["-tune", "grain"] : []),
  "-r", String(fps), "-movflags", "+faststart", out,
], { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((ok) => ffmpeg.on("close", ok));

const total = Math.max(1, Math.round((to - from) * fps));
const started = Date.now();
for (let i = 0; i < total; i++) {
  const t = from + i / fps;
  await browser.evaluate(`MOTION.seek(${t})`);
  const { data } = await browser.send("Page.captureScreenshot", { format: "jpeg", quality: 95, optimizeForSpeed: true });
  if (!ffmpeg.stdin.write(Buffer.from(data, "base64"))) await new Promise((r) => ffmpeg.stdin.once("drain", r));
  if (i % fps === 0 || i === total - 1) {
    const rate = (i + 1) / ((Date.now() - started) / 1000);
    process.stdout.write(`\rframe ${i + 1}/${total} · ${rate.toFixed(1)} fps · ${Math.max(0, Math.round((total - i - 1) / rate))} s left   `);
  }
}
ffmpeg.stdin.end();
const code = await done;
browser.close();
process.stdout.write("\n");
if (code !== 0) fail(`ffmpeg failed (exit ${code}).`);
const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,r_frame_rate,codec_name", "-of", "default=nw=1", out], { encoding: "utf8" });
console.log(`Wrote ${out}\n${probe.status === 0 ? probe.stdout.trim() : ""}`);
console.log(`Look at it, not only at the page: ffmpeg -i "${out}" -vf fps=1,scale=480:-1,tile=4x3 -frames:v 1 out/tiles.png`);
