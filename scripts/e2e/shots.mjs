// Headless Chrome screenshots via the DevTools protocol.
// Usage: node shots.mjs <outDir> <cookieFile> <name=url>...
import { spawn } from "node:child_process";
import fs from "node:fs";

const [outDir, cookieFile, ...pages] = process.argv.slice(2);
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${outDir}/chrome-profile`,
  "--window-size=1440,900", "--hide-scrollbars", "--no-first-run", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch("http://127.0.0.1:9333/json")).json(); break; } catch { await sleep(200); }
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const [name, value] = fs.readFileSync(cookieFile, "utf8").trim().split("=");
for (const p of pages) {
  const [shot, url, wait = "2500", click] = p.split("|");
  if (shot.startsWith("nocookie")) await send("Network.clearBrowserCookies");
  else await send("Network.setCookie", { name, value, domain: "localhost", path: "/", httpOnly: true });
  await send("Page.navigate", { url });
  await sleep(Number(wait));
  if (click) {
    await send("Runtime.evaluate", { expression: `[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(click)}))?.click()` });
    await sleep(800);
  }
  const res = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${outDir}/${shot}.png`, Buffer.from(res.result.data, "base64"));
  console.log("saved", shot);
}
ws.close();
chrome.kill();
