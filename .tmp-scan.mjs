import { chromium } from "playwright-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath: EDGE, args: ["--enable-unsafe-swiftshader","--use-angle=swiftshader","--hide-scrollbars"] });
async function measure(q, vw, vh, n = 60) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto("http://127.0.0.1:5173/" + q, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__solarReady === true, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const s = await page.evaluate((count) => new Promise((done) => {
    const out = [];
    (function tick() {
      const p = window.__solarPixels();
      if (p) out.push(p);
      if (out.length < count) requestAnimationFrame(tick); else done(out);
    })();
  }), n);
  await ctx.close();
  if (!s.length) return { err: "no samples" };
  const xs = s.map(p => p.x);
  const pp = a => Math.max(...a) - Math.min(...a);
  return { x_pp: +pp(xs).toFixed(4), x0: +xs[0].toFixed(2), rows: s[0].rows, rad: s[0].radiusPx, n: s.length };
}
for (const vp of [[1280,720],[1920,1080]]) {
  console.log("vp " + vp.join("x"));
  for (const [tag, q] of [["still  ","?proto=1&dist=1.2e7&still=1"],["proto  ","?proto=1&dist=1.2e7"],["legacy ","?proto=1&legacy=1&dist=1.2e7"]]) {
    try { console.log("  "+tag+":", JSON.stringify(await measure(q, ...vp))); }
    catch (e) { console.log("  "+tag+": FAIL", e.message.slice(0,80)); }
  }
}
await browser.close();
