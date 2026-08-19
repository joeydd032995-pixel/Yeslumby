/**
 * Drive the running app with a real browser and capture what it renders.
 *
 * Asserting on rendered output rather than on component internals: these checks
 * fail if the database is empty, if authorization is wrong, or if a page throws
 * — the failure modes that unit tests of the same components would miss.
 *
 *   pnpm dev &   # or next start
 *   pnpm verify:ui
 */
import { chromium, type Browser, type Page } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.UI_BASE_URL ?? "http://localhost:3100";
const OUT = "artifacts/ui";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

async function run(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // --- landing + recommendation ------------------------------------------
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  record("landing renders", await page.locator("h1").first().isVisible());
  await shot(page, "01-landing");

  await page.fill(
    "textarea[name=objective]",
    "A widely cited study reports a large effect that three replication attempts failed to reproduce. What should we conclude, and what would settle it?",
  );
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");

  const recommended = await page.locator("text=adversarial-research").first().isVisible();
  record("recommender proposes an architecture", recommended);

  const agentsShown = await page.locator("table tbody tr").count();
  record("recommended genome lists its agents", agentsShown >= 3, `${agentsShown} rows`);
  await shot(page, "02-recommendation");

  // --- unauthenticated access --------------------------------------------
  await page.goto(`${BASE}/e/eco_dev`, { waitUntil: "networkidle" });
  record("signed-out visitor is sent to sign in", page.url().includes("/signin"));
  await shot(page, "03-signin");

  // --- sign in ------------------------------------------------------------
  await page.locator("form", { hasText: "Blaise" }).locator("button").click();
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  record("sign in reaches the dashboard", page.url().includes("/dashboard"));

  const ecoLink = page.locator('a[href="/e/eco_dev"]').first();
  record("dashboard lists the seeded ecosystem", await ecoLink.isVisible());
  await shot(page, "04-dashboard");

  // --- genome viewer ------------------------------------------------------
  await page.goto(`${BASE}/e/eco_dev`, { waitUntil: "networkidle" });
  record("genome page renders", await page.locator("h1").first().isVisible());
  record(
    "topology graph is drawn",
    await page.locator('svg[aria-label="Agent topology"]').isVisible(),
  );
  const nodeCount = await page.locator('svg[aria-label="Agent topology"] circle').count();
  record("topology has a node per agent", nodeCount >= 4, `${nodeCount} nodes`);
  record(
    "synthesizer is identified",
    await page.locator("text=synthesizer").first().isVisible(),
  );
  await shot(page, "05-genome");

  // --- evolution ----------------------------------------------------------
  await page.goto(`${BASE}/e/eco_dev/evolution`, { waitUntil: "networkidle" });
  record(
    "version graph is drawn",
    await page.locator('svg[aria-label="Version graph"]').isVisible(),
  );
  const versionRows = await page.locator("table tbody tr").count();
  record("evolution lists versions", versionRows >= 2, `${versionRows} rows`);
  record("a version is marked current", await page.locator("text=current").first().isVisible());
  await shot(page, "06-evolution");

  // --- memory -------------------------------------------------------------
  await page.goto(`${BASE}/e/eco_dev/memory`, { waitUntil: "networkidle" });
  const knowledgeVisible = await page.locator("text=Knowledge memory").isVisible();
  const evoVisible = await page.locator("text=Evolutionary memory").isVisible();
  record("memory shows both persistent stores separately", knowledgeVisible && evoVisible);
  record(
    "conversation state is counted distinctly",
    await page.locator("text=Conversation state").isVisible(),
  );
  await shot(page, "07-memory");

  // --- benchmarks ---------------------------------------------------------
  await page.goto(`${BASE}/e/eco_dev/benchmarks`, { waitUntil: "networkidle" });
  const benchRows = await page.locator("table tbody tr").count();
  record("benchmarks compare versions", benchRows >= 1, `${benchRows} rows`);
  await shot(page, "08-benchmarks");

  // --- completed run ------------------------------------------------------
  await page.goto(`${BASE}/e/eco_dev/runs/run_dev_1`, { waitUntil: "networkidle" });
  record("run page renders", await page.locator("h1").first().isVisible());
  record(
    "synthesis result is shown",
    await page.locator("text=High confidence").first().isVisible(),
  );
  record(
    "contested claims are surfaced",
    await page.locator("text=Contested").first().isVisible(),
  );
  record("cost is attributed per agent", await page.locator("text=Cost by agent").isVisible());
  await shot(page, "09-run");

  // --- live streaming -----------------------------------------------------
  await page.goto(`${BASE}/e/eco_dev`, { waitUntil: "networkidle" });
  await page.fill("textarea[name=objective]", "Should we trust this effect size?");
  await page.locator('form button[type=submit]', { hasText: "Run against" }).click();
  await page.waitForURL("**/runs/**", { timeout: 20000 });
  record("starting a run navigates to its live view", page.url().includes("/runs/"));

  // The stage track should light up as the run progresses.
  await page.waitForSelector('[data-stage="PROPOSALS"][data-state="done"]', { timeout: 120000 });
  record("stages stream to the browser as they complete", true);
  await shot(page, "10-live-run");

  await page.waitForSelector('[data-testid="run-message"]', { timeout: 180000 });
  const finished = (await page.locator('[data-testid="run-message"]').textContent()) ?? "";
  record("run reaches a terminal state", finished.includes("Stopped"), finished.trim());

  const agentRows = await page.locator('[data-testid="agent-log"] tbody tr').count();
  record("agent-level cost is streamed", agentRows > 1, `${agentRows} rows`);
  await shot(page, "11-live-run-complete");

  record(
    "no console errors",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(" | "),
  );

  await context.close();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium/chrome-linux/chrome",
  });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`screenshots in ${OUT}/`);
  if (failed.length > 0) {
    console.error(`\nfailed:\n${failed.map((f) => `  - ${f.name}: ${f.detail ?? ""}`).join("\n")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("verification failed:", error);
  process.exitCode = 1;
});
