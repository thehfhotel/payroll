import { basename, resolve } from "node:path";
import type { Page } from "playwright";
import { SLIPS_DIR, ensureSlipsDir } from "./capture-slip";

/**
 * Self-diagnosing "Next never appeared" reporting for the two payroll upload
 * flows.
 *
 * Both of them used to `await next.waitFor(...)` bare, so a label change on
 * KBIZ's side (the 2026-09-04 Thai "ต่อไป" incident) escaped as a raw
 * `locator.waitFor: Timeout` crash whose only content was OUR OWN selector —
 * it could not tell an operator what the page actually offered. These helpers
 * turn that into a plain FlowResult failure that names the URL, the visible
 * clickable controls, and a screenshot on disk.
 */

/** At most this many control labels reach the error string. */
const MAX_CONTROLS = 15;
/** …each trimmed to at most this many characters. */
const MAX_LABEL_CHARS = 40;

/**
 * Tag + trimmed label of every visible clickable control on the page.
 *
 * PRIVACY: the returned strings go into the queue JSON and into Slack, so this
 * deliberately reads ONLY control labels — never `document.body.innerText`,
 * which on the post-upload payroll page carries employee rows. Belt and
 * braces on top of that: every run of 3+ digits AND every digit/dash run of 6+
 * is masked — KBIZ writes accounts dash-grouped (XXX-X-XXXXX-X), whose
 * single-digit groups a bare `\d{3,}` would leave behind — so an account number
 * or a pay figure cannot survive even if KBIZ ever renders a data row as an
 * `<a>`; labels are capped at 40 chars and the list at 15 entries.
 */
export async function describeVisibleControls(page: Page): Promise<string[]> {
  return await page
    .evaluate(
      ({ max, maxChars }: { max: number; maxChars: number }) => {
        const out: string[] = [];
        const els = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit']"));
        for (const el of els) {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.visibility === "hidden" || style.display === "none") continue;
          const raw = el instanceof HTMLInputElement ? el.value : ((el as HTMLElement).innerText ?? el.textContent ?? "");
          const label = raw.replace(/\s+/g, " ").replace(/[\d-]{6,}|\d{3,}/g, "###").trim().slice(0, maxChars);
          if (!label) continue;
          const entry = `${el.tagName.toLowerCase()}:${label}`;
          if (out.indexOf(entry) === -1) out.push(entry);
          if (out.length >= max) break;
        }
        return out;
      },
      { max: MAX_CONTROLS, maxChars: MAX_LABEL_CHARS },
    )
    .catch(() => [] as string[]);
}

/**
 * Full-page screenshot next to the slips (same `KBIZ_SLIPS_DIR` the slip
 * capture uses). Best-effort exactly like `captureSlip`'s own screenshot: a
 * failure here must never mask the real error, so it is logged and swallowed.
 */
export async function saveTimeoutScreenshot(page: Page, prefix: string, xlsxAbs: string): Promise<string | undefined> {
  try {
    ensureSlipsDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = basename(xlsxAbs).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
    const path = resolve(SLIPS_DIR, `${prefix}-${safe}-${stamp}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`   📸 ${path}`);
    return path;
  } catch (e) {
    console.error(`   ⚠ ${prefix} screenshot failed: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * Build the FlowResult error string for a Next that never became visible.
 * Only the playwright message's FIRST line is kept (that is our own locator
 * text, not page content) plus the URL and the control labels.
 *
 * THIS FUNCTION MUST NEVER REJECT. It is awaited from inside a PRE-ARM catch
 * block, so a rejection here would turn the flow's `{ success:false }` return
 * back into a THROW — process-queue would file the item as crashed and leave
 * the arm lock standing, i.e. the 2026-09-04 failure mode reproduced by the
 * diagnostic meant to prevent it. So the whole body is guarded and degrades to
 * the bare headline. (`page.url()` in particular is synchronous: the old
 * `Promise.resolve(page.url()).catch(...)` evaluated it BEFORE the catch was
 * attached and would not have caught a throw from a closed page.)
 */
export async function nextTimeoutError(page: Page, prefix: string, xlsxAbs: string, cause: unknown): Promise<string> {
  let head = "unknown error";
  try {
    head = String((cause as Error)?.message ?? cause).split("\n")[0] ?? head;
  } catch {}
  try {
    const url = page.url();
    const controls = await describeVisibleControls(page);
    const shot = await saveTimeoutScreenshot(page, prefix, xlsxAbs);
    return (
      `Next never became visible (${head}). url=${url}; ` +
      `visible controls: ${controls.length ? controls.join(" | ") : "(none)"}` +
      (shot ? `; screenshot: ${shot}` : "")
    );
  } catch {
    return `Next never became visible (${head}).`;
  }
}
