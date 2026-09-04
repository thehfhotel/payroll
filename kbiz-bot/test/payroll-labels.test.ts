/**
 * The payroll flows' Next / Confirm labels, pinned as TEXT.
 *
 * WHY TEXT: both flow files import playwright for real, and root `bun test`
 * (the CI context) runs BEFORE kbiz-bot/node_modules exists — so this reads
 * them the same way favorite-destination.test.ts pins transfer-other-flow.ts.
 *
 * WHY AT ALL: the KBIZ session has run Thai since 2026-08-12, but only
 * transfer-other-flow.ts was re-verified live against it. Both payroll flows
 * guessed "ถัดไป" for Next; K BIZ's Thai Next is "ต่อไป", and on 2026-09-04 the
 * first Next after the workbook upload timed out and crashed the queue item.
 * Whatever else these selectors grow, they must keep the VERIFIED label.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Assertions below are about CODE, not the prose around it. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FLOWS = [
  { file: "transfer-payroll-flow.ts", src: readFileSync(at("../src/flows/transfer-payroll-flow.ts"), "utf8") },
  { file: "add-payroll-flow.ts", src: readFileSync(at("../src/flows/add-payroll-flow.ts"), "utf8") },
];
const TRANSFER_PAYROLL = FLOWS[0]!.src;

/** The one const string per file that holds the selector union. */
const listOf = (src: string, name: string): string => {
  const decl = src.indexOf(`const ${name} =`);
  expect(decl).toBeGreaterThan(-1);
  const end = src.indexOf(";", decl);
  expect(end).toBeGreaterThan(decl);
  return src.slice(decl, end);
};

describe("payroll flows match K BIZ's Next in the VERIFIED Thai label", () => {
  for (const { file, src } of FLOWS) {
    const next = listOf(src, "NEXT_SELECTOR");

    it(`${file}: Next matches "ต่อไป" (the live-verified Thai label) and "Next"`, () => {
      expect(next).toContain("ต่อไป");
      expect(next).toContain("Next");
      // "ถัดไป" — the unverified guess that caused the 2026-09-04 incident — is
      // deliberately NOT required. It may stay as an extra alternative or be
      // dropped; only the verified label is load-bearing.
    });

    it(`${file}: every alternative keeps :visible, and the list is used with .first()`, () => {
      for (const alt of next.slice(next.indexOf("'") + 1).split(",")) {
        if (!alt.trim()) continue;
        expect(alt).toContain(":visible");
      }
      expect(src).toContain("page\n    .locator(NEXT_SELECTOR)");
      expect(src).toContain(".first()");
    });

    it(`${file}: the Next locator excludes a VISIBLE-but-disabled anchor`, () => {
      // Copied from the one live-verified Next (transfer-other-flow.ts): KBIZ
      // renders Next visible-but-disabled while the form is incomplete, and
      // Playwright's enabled-check does not apply to an <a>, so `:visible`
      // alone would match a dead anchor and the click would be a no-op.
      expect(code(src)).toContain('.filter({ hasNot: page.locator(".disabled-button") })');
    });

    it(`${file}: the Next wait REPORTS instead of throwing, and never claims the push may be live`, () => {
      // A Next that never appears is a pre-arm failure on both pages, so the
      // caller must be free to release the conservative lock as
      // "confirmed-failed" — a throw would instead leave it standing forever.
      const wait = code(src).slice(code(src).indexOf('console.log("→ Click Next")'));
      const block = wait.slice(0, wait.indexOf("await next.click()"));
      expect(block).toContain('await next.waitFor({ state: "visible", timeout: 30_000 })');
      expect(block).toContain("return { success: false, error: await nextTimeoutError(");
      expect(block).not.toContain("throw");
      expect(block).not.toContain("pushMayBeLive");
    });
  }

  it("transfer-payroll-flow.ts: Confirm matches ยืนยัน and Confirm", () => {
    // Only this flow has a Confirm step; on add-payroll the push is armed by
    // Next itself, so it carries no Confirm selector to pin.
    const confirm = listOf(TRANSFER_PAYROLL, "CONFIRM_SELECTOR");
    expect(confirm).toContain("ยืนยัน");
    expect(confirm).toContain("Confirm");
  });
});

describe("the Next-timeout report carries controls + URL, never page body text", () => {
  const src = readFileSync(at("../src/lib/next-timeout.ts"), "utf8");

  it("reads control labels only — never document.body.innerText", () => {
    expect(code(src)).not.toContain("document.body");
    expect(src).toContain('document.querySelectorAll("a, button, input[type=\'button\'], input[type=\'submit\']")');
  });

  it("masks digit runs AND dash-separated account numbers, caps label length and count", () => {
    expect(src).toContain('replace(/[\\d-]{6,}|\\d{3,}/g, "###")');
    expect(src).toContain("const MAX_CONTROLS = 15;");
    expect(src).toContain("const MAX_LABEL_CHARS = 40;");
  });

  it("keeps only the FIRST line of the playwright error (our selector, not the page)", () => {
    expect(src).toContain('.split("\\n")[0]');
  });

  it("a screenshot failure never masks the real error", () => {
    const c = code(src);
    const fn = c.slice(c.indexOf("export async function saveTimeoutScreenshot"), c.indexOf("export async function nextTimeoutError"));
    expect(fn).toContain("catch (e)");
    expect(fn).toContain("return undefined;");
    expect(fn).not.toContain("throw");
  });

  it("nextTimeoutError can never reject — it is awaited inside a pre-arm catch", () => {
    // If this helper rejected, the flow's { success:false } return would become
    // a throw and process-queue would leave the arm lock standing.
    const fn = code(src).slice(code(src).indexOf("export async function nextTimeoutError"));
    expect(fn).not.toContain("Promise.resolve(page.url())");
    expect(fn).toContain("const url = page.url();");
    expect(fn).toContain("} catch {\n    return `Next never became visible (${head}).`;");
  });

  it("saves next to the slips, under the same KBIZ_SLIPS_DIR the slip capture uses", () => {
    expect(src).toContain('from "./capture-slip"');
    expect(src).toContain("resolve(SLIPS_DIR,");
    expect(src).toContain("ensureSlipsDir();");
  });
});

describe("transfer-payroll never clicks Confirm on a dialog KBIZ refused with", () => {
  const src = TRANSFER_PAYROLL;

  it("races ALL FOUR outcomes unconditionally — no refusal arm is ever dropped", () => {
    // A refusal that is already visible when Next is clicked must still win the
    // race and return its precise error; dropping it would leave the substring
    // "ยืนยัน" review arm as the only one that can win — on a refusal dialog's
    // own confirm button.
    expect(code(src)).not.toContain("preVisible");
    const race = src.slice(src.indexOf("outcome = await Promise.race"), src.indexOf("} catch (e) {", src.indexOf("Promise.race")));
    for (const arm of ['"review"', '"format-error"', '"duplicate"', '"cannot"']) expect(race).toContain(arm);
  });

  it("re-checks the refusal popups after the race and BEFORE the arming Confirm click", () => {
    const guard = src.indexOf('if (outcome === "review") {');
    const armingClick = src.indexOf("await reviewConfirm.click()");
    expect(guard).toBeGreaterThan(src.indexOf("Promise.race"));
    expect(guard).toBeLessThan(armingClick);
    const block = code(src).slice(
      code(src).indexOf('if (outcome === "review") {'),
      code(src).indexOf("console.log(`   post-Next outcome"),
    );
    // count() on a :visible selector, never isVisible(): #popup-duplicate exists
    // twice while the dialog is open, and a swallowed strict-mode violation would
    // read as "no refusal" — fail-open on the money path.
    expect(block).toContain('await page.locator("#popup-payroll-incorrect:visible").count()');
    expect(block).toContain('await page.locator("#popup-duplicate:visible").count()');
    expect(block).toContain("await cannotPopup.first().isVisible()");
    expect(block).not.toContain("isVisible().catch(");
    // A probe that itself fails cannot prove KBIZ did not refuse ⇒ bail pre-arm.
    expect(block).toContain("return {");
    expect(block).toContain("success: false,");
    expect(block).not.toContain("pushMayBeLive");
  });

  it("the pre-arm Next CLICK returns instead of throwing (a throw holds the arm lock)", () => {
    const block = code(src).slice(code(src).indexOf("await next.click();"), code(src).indexOf("#popup-payroll-incorrect"));
    expect(block).toContain("return { success: false, error: `Next click failed:");
    expect(block).not.toContain("pushMayBeLive");
    expect(block).not.toContain("throw");
  });
});
