import type { Page } from "playwright";
import { gotoAuthenticated } from "../lib/session";
import { nextTimeoutError } from "../lib/next-timeout";
import { waitForMobileConfirmation } from "../wait";
import type { FlowResult } from "./add-payroll-flow";

const URL = "https://kbiz.kasikornbank.com/menu/payroll/upload-transfer";

/**
 * K BIZ's Next, in both languages. The session has run THAI since 2026-08-12
 * (`login.jsp?lang=th`) and the Thai label for Next is **"ต่อไป"** — verified
 * live on fundtranfer-other (2026-08-12) AND on this very page (2026-09-04,
 * read-only probe after the incident): `a.btn.fixed-width.btn-gradient` with
 * the text "ต่อไป", rendered ONLY after a file has been selected; nothing on
 * the page reads "ถัดไป" or "Next". "ถัดไป" was the unverified guess this flow
 * used to match, which is why the 2026-09-04 payroll upload timed out after
 * 30 s — it is deliberately NOT in the list any more (verified labels only).
 *
 * Selector ORDER confers no priority (Playwright resolves a CSS union in DOM
 * order — the same fact clickDialogButton documents in transfer-other-flow.ts),
 * so the narrowing that matters is the `.disabled-button` filter applied where
 * this list is used. That filter is copied from the ONE live-verified Next
 * locator (transfer-other-flow.ts): KBIZ renders its Next anchor
 * VISIBLE-but-disabled while the form is incomplete, `:visible` is satisfied by
 * it, and Playwright's enabled-check does not apply to an `<a>` — so without the
 * filter this flow would wait out the fixed 2 s post-upload delay, click a dead
 * anchor and fail 60 s later with a misleading error.
 */
const NEXT_SELECTOR =
  'a:has-text("Next"):visible, a:has-text("ต่อไป"):visible, button:has-text("Next"):visible, button:has-text("ต่อไป"):visible, #nextBtn:visible';

/**
 * The review screen's Confirm — the click that ARMS the phone push here. Same
 * bilingual rule as NEXT_SELECTOR.
 *
 * MONEY SAFETY: these are SUBSTRING matches, and this repo already knows that a
 * substring "ยืนยัน" hits "ยืนยันการทำรายการ" in 7 of 9 production dumps and that
 * KBIZ's own refusal dialogs carry a "ยืนยัน" anchor (`#popup-duplicate
 * .action > a.btn.btn-gradient > span`, operator-captured — transfer-other-flow.ts
 * money review finding 5). So this locator is NEVER trusted on its own: the
 * refusal re-check below runs after the race and before the arming click.
 */
const CONFIRM_SELECTOR =
  'a:has-text("Confirm"):visible, a:has-text("ยืนยัน"):visible, button:has-text("Confirm"):visible, button:has-text("ยืนยัน"):visible';

export async function runTransferPayrollFlow(page: Page, xlsxAbs: string): Promise<FlowResult> {
  await gotoAuthenticated(page, URL);

  console.log("→ Set file:", xlsxAbs);
  await page.locator('input[type="file"][name="uploadfile"]').setInputFiles(xlsxAbs);
  await page.waitForTimeout(2000);

  console.log("→ Click Next");
  const next = page
    .locator(NEXT_SELECTOR)
    .filter({ hasNot: page.locator(".disabled-button") })
    .first();
  try {
    await next.waitFor({ state: "visible", timeout: 30_000 });
  } catch (e) {
    // PRE-ARM failure: Confirm (the click that arms the phone push) has not
    // happened and cannot have, so this stays a plain { success:false } with
    // NO pushMayBeLive — process-queue.ts / transfer-payroll.ts release the
    // conservative lock as "confirmed-failed", exactly as before. Returning
    // instead of throwing is the whole point: the crash on 2026-09-04 said
    // only which selector we waited on, never what the page was offering.
    return { success: false, error: await nextTimeoutError(page, "payroll-next-timeout", xlsxAbs, e) };
  }

  try {
    await next.click();
  } catch (e) {
    // ALSO pre-arm — on THIS page Next only advances to the review screen; the
    // arming click is Confirm, below. An actionability failure here (a still
    // disabled anchor, an overlay intercepting the click) must RETURN, not
    // throw: a throw takes process-queue's crash path, which by design leaves
    // the arm lock standing "armed"/unconfirmed and holds the rest of the
    // batch — the exact blast radius of the 2026-09-04 incident. Only the
    // message's first line is kept (our locator, never page content).
    return { success: false, error: `Next click failed: ${String((e as Error)?.message ?? e).split("\n")[0]}` };
  }

  const formatErrPopup = page.locator("#popup-payroll-incorrect");
  const duplicatePopup = page.locator("#popup-duplicate");
  // The Thai refusal token is a bare stem ("cannot"), so it is only counted
  // inside one of KBIZ's popup containers — this page names its dialogs
  // `#popup-*` (#popup-payroll-incorrect, #popup-duplicate) and their buttons
  // `.popup-modal-close` (captured 2026-09-04) — never in page copy, where the
  // stem would refuse a valid batch. The English phrases stay page-wide as before.
  const cannotPopup = page
    .locator("text=/cannot be added|cannot be processed/i")
    .or(page.locator('[id^="popup"]:visible, [class*="popup"]:visible').filter({ hasText: /ไม่สามารถ/ }));
  const reviewConfirm = page.locator(CONFIRM_SELECTOR).first();

  type Outcome = "review" | "format-error" | "duplicate" | "cannot";
  let outcome: Outcome;
  try {
    outcome = await Promise.race<Outcome>([
      reviewConfirm.waitFor({ state: "visible", timeout: 60_000 }).then(() => "review"),
      formatErrPopup.waitFor({ state: "visible", timeout: 60_000 }).then(() => "format-error"),
      duplicatePopup.waitFor({ state: "visible", timeout: 60_000 }).then(() => "duplicate"),
      cannotPopup.first().waitFor({ state: "visible", timeout: 60_000 }).then(() => "cannot"),
    ]);
  } catch (e) {
    return { success: false, error: `No expected popup after Next: ${(e as Error).message}` };
  }

  // MONEY SAFETY — a "review" win is not proof there is a review screen. KBIZ's
  // refusal dialogs carry their own visible "ยืนยัน" anchor (`#popup-duplicate
  // .action > a.btn.btn-gradient > span`, operator-captured — transfer-other-flow.ts),
  // which satisfies reviewConfirm's substring match, so when KBIZ answers with one
  // BOTH arms become satisfiable in the same poll window and the winner is
  // nondeterministic. If "review" wins there, the click below would CONFIRM a batch
  // the bank just refused. So re-check the refusals — id-scoped containers the review
  // screen cannot satisfy — and let a visible one beat the race result. Still pre-arm:
  // Confirm has not been clicked, so every exit here stays a plain { success:false }.
  //
  // `count()` on a `:visible`-scoped selector, NOT isVisible(): the captured DOM has
  // #popup-duplicate TWICE while the dialog is open (active copy + hidden .mfp-hide
  // template), and isVisible() enforces strict mode — a swallowed "resolved to 2
  // elements" would read as "no refusal", i.e. fail OPEN on the money path.
  if (outcome === "review") {
    let refusal: Outcome | undefined;
    try {
      if (await page.locator("#popup-payroll-incorrect:visible").count()) refusal = "format-error";
      else if (await page.locator("#popup-duplicate:visible").count()) refusal = "duplicate";
      else if (await cannotPopup.first().isVisible()) refusal = "cannot";
    } catch (e) {
      // The probe itself failed, so we cannot prove KBIZ did NOT refuse — and the
      // very next click is the arming one. Fail closed, pre-arm.
      return {
        success: false,
        error: `Could not verify the review screen before Confirm: ${String((e as Error)?.message ?? e).split("\n")[0]}`,
      };
    }
    if (refusal) outcome = refusal;
  }
  console.log(`   post-Next outcome: ${outcome}`);

  if (outcome === "format-error") return { success: false, error: "File-format error" };
  if (outcome === "duplicate") return { success: false, error: "Duplicate-pending warning" };
  if (outcome === "cannot") {
    const txt = (await cannotPopup.first().innerText()).trim();
    return { success: false, error: `KBIZ refused: ${txt.slice(0, 400)}` };
  }

  console.log("→ Click Confirm — KBIZ pushes mobile notification");
  const beforeUrl = page.url();
  await reviewConfirm.click();

  await waitForMobileConfirmation({
    reason: "ยืนยันการโอนเงินเดือน (Payroll Transfer)",
    until: () =>
      page.waitForURL((url) => url.toString() !== beforeUrl, { timeout: 5 * 60_000 }),
    timeoutMs: 5 * 60_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  return { success: true, finalUrl: page.url() };
}
