/**
 * Diagnose why the usage bubble's expand/collapse does not animate.
 *
 * Drives the paired web app in a real Chromium, toggles the bubble, and
 * samples the animated wrapper's height every frame. If the height jumps in a
 * single step the animation is not running; if it ramps, it is.
 *
 * Usage: node scripts/diagnose-usage-animation.mjs "<pair-url>"
 */
import { chromium } from "playwright-core";

const pairUrl = process.argv[2];
if (!pairUrl) {
  console.error("need a pair URL argument");
  process.exit(1);
}

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (message) => {
  if (message.type() === "error") console.log("[page error]", message.text());
});

await page.goto(pairUrl, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
console.log("url after pairing:", page.url());

// The bubble only exists inside a chat view, so open a draft if we landed
// somewhere else.
const bubbleSelector = '[data-usage-bubble="true"]';
let bubble = await page.$(bubbleSelector);
if (!bubble) {
  console.log("no bubble on landing page; looking for a way into a chat");
  const newChat = await page.$(
    '[data-testid="new-thread"], a[href*="draft"], button:has-text("New")',
  );
  if (newChat) {
    await newChat.click();
    await page.waitForTimeout(3000);
    bubble = await page.$(bubbleSelector);
  }
}

console.log("bubble present:", Boolean(bubble));
if (!bubble) {
  console.log(
    "page text sample:",
    (await page.evaluate(() => document.body.innerText)).slice(0, 400),
  );
  await page.screenshot({ path: "usage-anim-nobubble.png" });
  await browser.close();
  process.exit(0);
}

const report = await page.evaluate(async () => {
  const wrap = document.querySelector('[data-usage-charts-wrap="true"]');
  const toggle = document.querySelector('[data-usage-toggle="true"]');
  if (!wrap || !toggle) return { error: "missing wrap or toggle" };

  const samples = [];
  let sampling = true;
  const sample = () => {
    if (!sampling) return;
    samples.push(Math.round(wrap.getBoundingClientRect().height));
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 600));
  sampling = false;

  return {
    samples,
    animationCount: wrap.getAnimations().length,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    computedTransition: getComputedStyle(wrap).transition,
    inlineHeight: wrap.style.height,
  };
});

console.log(JSON.stringify(report, null, 2));
await page.screenshot({ path: "usage-anim-expanded.png" });
await browser.close();
