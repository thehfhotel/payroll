import type { Page } from "playwright";
import { sanitizeKbizMemo } from "@reimbursement/shared";
import { gotoAuthenticated, isUnauthenticatedUrl } from "../lib/session";
import { captureSlip, ensureSlipsDir, SLIPS_DIR, type SlipCapture } from "../lib/capture-slip";
import { finalizeTransfer } from "../lib/finalize-transfer";
import { aliasesForBank, matchFavoriteRows } from "../lib/scrape-favorites";
// The picker's paging + "exactly one destination" decision, straight from the
// PURE module rather than through scrape-favorites' `export *`: the deciding is
// what root `bun test` pins without a browser (favorite-destination.test.ts),
// and importing it where it lives keeps that split obvious.
import {
  decideFavoriteSelection,
  MAX_PICKER_PAGES,
  type FavoritePageScan,
} from "../lib/favorites-core";
import {
  APPROVAL_TIMEOUT_MS,
  waitForApproval,
  type ApprovalView,
  type TransferOutcome,
  type TransferFailureOutcome,
} from "../lib/approval-wait";
import { verifyArmed } from "../lib/post-next";
// Runtime import (not type-only): duplicateHeldText builds the Q6 held-text
// this module returns on a refused duplicate popup, and the string is pinned
// in ONE place (transfer-other-queue.ts, IMPL-C) so it can be unit-tested
// without a browser — this module has no test of its own (see the file
// footer). DuplicateReason stays type-only: process-queue.ts (IMPL-C) is the
// only writer of a `duplicatePolicy`, this module only ever reads one.
import { duplicateHeldText, type DuplicateReason } from "../lib/transfer-other-queue";

// isUnauthenticatedUrl is re-exported unchanged from session.ts (which now
// itself re-exports it from approval-wait.ts, per A3) — this import is kept
// per kbiz-interfaces.md A3 ("transfer-other-flow.ts:3 is unchanged") even
// though classifyFrame now owns the session-dead check internally; keeping
// it costs nothing (no noUnusedLocals in tsconfig) and avoids touching a
// line the contract didn't ask this edit to touch.

/**
 * Ad-hoc single transfer on KBIZ's "โอนเงินไปบัญชีบุคคลอื่น" page
 * (fundtranfer-other, "Other Account" / "New" tab). Two destination modes:
 *
 *   - "favorite": select a SAVED payee. The bot opens the saved-account picker,
 *     finds the one row matching ALL THREE of { nickname, account number, bank },
 *     requires EXACTLY ONE, clicks it, and re-reads "To" to confirm KBIZ filled
 *     OUR account. A mis-keyed number can't misroute — it's only a lookup key
 *     into the vetted list. This is the safe default. The account verifier is
 *     the full number when the payee book has one, or the last 4 digits when
 *     the payee came from the synced (masked) favorites list.
 *   - "custom": type the bank + account number for a payee not in the saved list.
 *     Less safe (the number is typed); use only when a saved favorite doesn't
 *     exist. The account name KBIZ resolves + your phone approval are the checks.
 *
 * FLOW FACTS pinned against the live page (2026-08-12):
 *   - The saved list is hidden until the address-book icon (a.input-search-acc)
 *     beside "Account No." is clicked.
 *   - Needs a desktop viewport (1600) — 1366 is KBIZ's iPad-pro breakpoint edge.
 *   - **"Next" IS the commit**: clicking it sends the phone push (there is no
 *     separate Confirm button). So PREVIEW stops BEFORE Next; CONFIRM clicks Next.
 *   - The memo rejects special characters — it is sanitized to Thai/alnum/space.
 *   - The desktop success page says "Transfer successfully" + "Transaction ID:
 *     TRBS…". The WAITING screen also contains the word "successfully", so success
 *     is keyed on those specific tokens, never bare "success".
 *
 * Two gates guard the money: `input.confirm` (default false → preview), and your
 * phone tap (the bot only arms; it never approves).
 */

const URL = "https://kbiz.kasikornbank.com/menu/fundtranfer/fundtranfer/fundtranfer-other";

export interface Payee {
  mode: "favorite" | "custom";
  /** Favorite only: Display Name (nickname) to select + verify, e.g. "พี่วิว". */
  nickname?: string;
  /**
   * Destination account number (favorite: verifier; custom: typed). Dashes
   * optional. REQUIRED for "custom"; a "favorite" may instead carry only
   * `accountLast4`, which is all a synced favorite ever knows.
   */
  accountNo?: string;
  /**
   * Favorite only: last 4 digits, when the full number isn't available (the
   * synced favorites list is masked by contract). Used as the row verifier
   * and re-checked against the filled "To" field after selection.
   */
  accountLast4?: string;
  /** Destination bank, matched case-insensitively as a substring / alternation. */
  bank: string;
  /** Name on the account (logging + a soft check). */
  accountName?: string;
}

export interface TransferOtherInput {
  payee: Payee;
  amount: number;
  /** Raw memo; sanitized to KBIZ's allowed set before typing. May be "". */
  memo: string;
  attachmentPath?: string;
  /**
   * KBIZ's own category picker anchor id (e.g. "30" = Refund) — see
   * KBIZ_CATEGORIES in reimbursement's packages/shared. Selected by id, never
   * by label text: the picker's id is what the anchor actually carries, and a
   * label-text click was the live-verified bug that silently left the
   * category on "Other". Omit to leave KBIZ's default.
   */
  kbizCategoryId?: string;
  slug: string;
  maxTransfer: number;
  /** false = preview (stop BEFORE Next). true = click Next (arm the phone push). */
  confirm: boolean;
  /**
   * Fired ONLY after post-next.ts's `verifyArmed` has SEEN the bank's own
   * "notification sent" / countdown block on the page — never on the bare
   * `next.click()` any more. Before 2026-08-19 this fired on the click
   * itself, so the TAP-NEEDED Slack ping, the `armedAt` stamp and the
   * 6.5-min lock refinement all asserted "a push exists" with zero
   * post-condition: a JS-inert click, or KBIZ's exact-duplicate popup
   * (§ below), both looked in the logs exactly like "the operator never got
   * pinged" (diagnosis finding 7). Between the click and this firing, the
   * flow's pre-click lock (arm-lock.ts, written conservatively BEFORE the
   * click) still covers the estate at its full 10.5-min window — strictly
   * MORE conservative than firing on the click, so moving this later cannot
   * fail open; it can only narrow the window the estate holds a lock for.
   * `armedAt` is the CLICK time, not the verification time, so the lock
   * refinement and the 6.5-min wait budget still measure the real window.
   * Fire-and-forget; a notification failure never touches the transfer.
   */
  onArmed?: (armedAt: number) => void | Promise<void>;
  /**
   * What to do if KBIZ raises its exact-duplicate confirmation popup (same
   * payee + same amount as an earlier transaction, user-verified
   * 2026-08-19). Decided by the caller — process-queue.ts is the only place
   * with filesystem access to the queue archive that can tell "no prior
   * attempt on this bundle" from "this bundle already paid". Absent ⇒ the
   * flow refuses to confirm (fail closed: see `decideDuplicateConfirm`'s own
   * doc comment for why "no policy" and "a policy saying no" must behave
   * identically here).
   */
  duplicatePolicy?: { confirm: boolean; reason: DuplicateReason; detail?: string };
  /**
   * Fired exactly once, the moment the duplicate popup is recognised —
   * BEFORE either button is clicked, because a refusal below reports
   * `armedAt: undefined` / "nothing submitted", which is only true because
   * the popup precedes any push (user-verified 2026-08-19). Never throws.
   */
  onDuplicatePopup?: (info: { confirmed: boolean; reason: DuplicateReason; detail?: string }) => void | Promise<void>;
}

// Single source of truth is approval-wait.ts; re-exported here so B (and
// anything importing the flow's public surface) keeps importing the type
// from this file.
export type { TransferOutcome };
export type { TransferFailureOutcome };

export type TransferOtherResult =
  | {
      success: true;
      finalUrl: string;
      previewOnly: boolean;
      formShot?: string;
      slip?: SlipCapture;
      reference?: string;
      /** Epoch ms of the Next click. Absent ⇒ no push was ever armed. */
      armedAt?: number;
      /** From ApprovalWaitResult. Absent ⇒ no push was armed ⇒ treat as false. */
      pushMayBeLive?: boolean;
    }
  | {
      success: false;
      /**
       * A success is never a failure outcome (TransferFailureOutcome =
       * Exclude<TransferOutcome, "success">) — absent ⇒ failed before Next
       * was ever clicked (payee resolution, the ceiling check, KBIZ's
       * duplicate popup refused pre-arm), never a push-related ambiguity.
       */
      outcome?: TransferFailureOutcome;
      error: string;
      shot?: string;
      /**
       * The bank's own scraped transaction reference, when the final page
       * carried one — kept on every non-success branch now, not only
       * success (finalize-transfer.ts §1.8): a reference is proof money
       * moved regardless of what classifyFrame decided about the page
       * around it.
       */
      reference?: string;
      /** Epoch ms of the Next click. Absent ⇒ no push was ever armed. */
      armedAt?: number;
      /** From ApprovalWaitResult. Absent ⇒ no push was armed ⇒ treat as false. */
      pushMayBeLive?: boolean;
    };

const digitsOnly = (s: string) => s.replace(/\D+/g, "");

/**
 * Last 4 digits only ("…7394"), for anything that names a destination account
 * in a message. Every throw below becomes `result.error` in the queue file,
 * which process-queue posts to Slack and reimbursement persists as
 * `bundle.paymentError` — a full account number belongs in none of those (the
 * same rule describeDestination applies, and ADR 0001 decision 4). Nothing
 * diagnostic is lost: each throw captures a screenshot first, and the number
 * is in the queue file's own destination.
 */
const maskAccount = (s: string) => {
  const d = digitsOnly(s);
  return d ? `…${d.slice(-4)}` : "?";
};

// The memo rule (KBIZ rejects everything outside Thai / ASCII alnum / space)
// used to live here as a bot-local `sanitizeMemo`. It belongs to the contract:
// reimbursement BUILDS the memo with the very same function (`buildKbizMemo` →
// `sanitizeKbizMemo`), so the bot re-sanitizing an intent's memo is now
// provably a no-op instead of "two regexes we believe agree".
//
// Deliberately NOT re-exported under the old name. This module imports
// ../lib/session and ../lib/capture-slip, both of which import playwright for
// real, and root CI runs `bun test` WITHOUT kbiz-bot/node_modules — a test that
// reached for the memo rule here would drag the browser stack in and break it.
// Need the rule? `import { sanitizeKbizMemo } from "@reimbursement/shared"`,
// which pulls nothing.

// ── the saved-payee picker, as a driver ────────────────────────────────────
// THE PICKER PAGINATES AT TEN ROWS PER PAGE — footer "บัญชีที่ 1-10 จาก 14
// บัญชี" in the operator's devtools capture of 2026-08-19, pinned as
// test/fixtures/kbiz-payee-picker.dom.html. Reading `div.lists` once therefore
// reads PAGE ONE, not the list; the ฿1 test target sorts to ~row 11.
// collectFavorites (the read-only scrape) already walks this paginator, but its
// driver lives in scrape-favorites.ts and is not exported, so the walk is
// re-stated here with the same three rules that made it trustworthy there:
// whole-text-anchored numeric anchors, wait for the rows to actually SWAP, and
// treat a blanked modal as "did not turn" rather than as an empty page.

/** Every picker row carrying an account anchor — the header `div.lists` has none. */
const pickerRows = (page: Page) =>
  page.locator("div.lists").filter({ has: page.locator("a.c-bold.c-green.pointer") });

/**
 * `innerText` of every row on whichever page the picker is showing.
 *
 * Deliberately NOT `:visible`-filtered, exactly like collectFavorites' read: a
 * duplicate render must be SEEN and then deduped by account
 * (decideFavoriteSelection), never filtered out by a CSS guess about which copy
 * is the real one. The index of each text is the row's index in this locator,
 * which is how the winner gets clicked again.
 */
async function readPickerPage(page: Page): Promise<string[]> {
  const rows = pickerRows(page);
  const n = await rows.count();
  const texts: string[] = [];
  for (let i = 0; i < n; i++) texts.push(await rows.nth(i).innerText().catch(() => ""));
  return texts;
}

/** A numeric page anchor, whole-text-anchored so "2" never matches "12". */
const pickerPageAnchor = (page: Page, n: number) =>
  page
    .locator("a.pointer:visible")
    .filter({ hasText: new RegExp(`^\\s*${n}\\s*$`) })
    .first();

/** The current page's first row, normalized — proof that a page turn landed. */
async function pickerSignature(page: Page): Promise<string> {
  const first = await pickerRows(page).first().innerText().catch(() => "");
  return first.replace(/\s+/g, " ").trim();
}

/**
 * Click the numeric anchor for page `n` and wait for the rows to swap.
 *
 * Returns false rather than throwing — the caller decides what a stalled
 * paginator means (it refuses, but only after saying which page it could not
 * reach). An empty read is NOT a page turn: a click that closed or blanked the
 * modal would otherwise pass as a swap and walk empty pages.
 */
async function goToPickerPage(page: Page, n: number): Promise<boolean> {
  const anchor = pickerPageAnchor(page, n);
  if ((await anchor.count()) === 0) return false;
  const before = await pickerSignature(page);
  if (!(await anchor.click({ timeout: 15_000 }).then(() => true).catch(() => false))) return false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const after = await pickerSignature(page);
    if (after && after !== before) {
      await page.waitForTimeout(400);
      return true;
    }
  }
  return false;
}

/**
 * THE PICKER IS NEVER SEARCHED. The flow reads the WHOLE saved-payee book, page
 * by page, and decides over everything it read — it never types into the
 * picker's search box (`input[name="acctSearch"]`) and never clicks the
 * magnifier anchor that triggers it.
 *
 * Until 2026-08-26 the nickname was typed into that box first, as a
 * best-effort narrowing, with the page walk as the fallback. That left one
 * hole (review case "D2"): a filter that returns a NON-EMPTY list which
 * excludes a second saved account colliding on nickname + bank + last-4 lets
 * the flow select the intended row without ever SEEING the collision — the
 * only thing left in front of the money is reimbursement's server-side
 * uniqueness check over the synced favorites. The bank's search semantics are
 * not ours to pin (the live box matches account numbers, and typing a nickname
 * EMPTIED the list on 2026-08-19), so no filter can be trusted to keep every
 * colliding row visible. Walking the unfiltered book is the only read that
 * can prove "exactly one destination", so it is the only read this flow does.
 *
 * The one thing done with the search box is READING it, so a filter someone
 * else left in the modal cannot quietly shrink "the whole book" either: a
 * non-empty box means the rows on screen are a subset, and a subset is not
 * something to decide on. Refuses (nothing has been clicked yet) rather than
 * clearing it — clearing would be typing.
 */
async function assertPickerUnfiltered(page: Page): Promise<void> {
  const search = page.locator('input[name="acctSearch"]').first();
  if ((await search.count()) === 0) return;
  const value = (await search.inputValue().catch(() => "")).trim();
  if (value) {
    throw new Error(
      `The saved-payee picker opened with a search filter already applied (${value.length} char(s)) — ` +
        "the rows on screen are not the whole saved list. Refusing to select.",
    );
  }
}

/**
 * Select a SAVED payee via the picker, triple-verified. Throws on any ambiguity.
 *
 * Exported ONLY so src/probe-payee-picker-pagination.ts can drive the real
 * thing against the captured picker markup
 * (test/fixtures/kbiz-payee-picker.dom.html) in a local chromium — the same
 * reason clickDialogButton is exported. Nothing in the money path calls it
 * from outside this module.
 */
export async function selectFavoritePayee(page: Page, payee: Payee, slug: string): Promise<void> {
  const acctD = payee.accountNo ? digitsOnly(payee.accountNo) : "";
  const last4 = payee.accountLast4 ? digitsOnly(payee.accountLast4) : "";
  const nickname = payee.nickname ?? "";
  // matchFavoriteRows tests `t.includes(criteria.nickname)`, which every row
  // passes when the nickname is "" — that would quietly degrade the
  // triple-verify to bank + verifier. Refuse before opening the picker.
  if (!nickname) throw new Error('A "favorite" payee needs a nickname (the KBIZ Display Name) — none was given.');
  // The verifier is what makes this path safe — without one, "the row whose
  // nickname matches" is a single unverified check. Fail before opening it.
  if (!acctD && last4.length !== 4) {
    throw new Error(
      `Favorite "${nickname}" carries neither an account number nor a 4-digit accountLast4 — refusing to select.`,
    );
  }
  // What errors name the destination as — masked either way, since they travel
  // to Slack and into reimbursement's stored paymentError.
  const shown = maskAccount(payee.accountNo ?? last4);

  console.log("→ Open saved-payee picker");
  const pick = page.locator("a.input-search-acc").first();
  await pick.waitFor({ state: "visible", timeout: 15_000 });
  await pick.click();
  await page.waitForTimeout(1_800);

  const criteria = {
    nickname,
    bank: payee.bank,
    accountNo: payee.accountNo,
    accountLast4: last4 || undefined,
  };
  const shot = async (kind: string) => {
    await page.screenshot({ path: `${SLIPS_DIR}/_${kind}-${slug}.png`, fullPage: true }).catch(() => {});
  };

  // No search, ever — see assertPickerUnfiltered. The book is read unfiltered.
  await assertPickerUnfiltered(page);

  // Walk EVERY page the paginator offers, accumulating candidates. The walk is
  // not short-circuited by a match on the current page: the ONLY way to know a
  // second saved account also satisfies nickname + bank + last-4 is to look at
  // the rest of the list, and the old single-page read is precisely how a
  // page-1 last-4 collision could pass as the unique match (probe case D) —
  // and a search filter is how a page-1 read could pass WITH the walk in place
  // (probe case D2).
  const scans: FavoritePageScan[] = [];
  let current = 1;
  let pagingNote: string | null = null;
  for (;;) {
    const rowTexts = await readPickerPage(page);
    scans.push({ page: current, rowTexts });
    console.log(
      `   scanned ${rowTexts.length} saved rows on picker page ${current}, ` +
        `${matchFavoriteRows(rowTexts, criteria).length} triple-verified`,
    );
    if (scans.length >= MAX_PICKER_PAGES) {
      pagingNote = `stopped after ${MAX_PICKER_PAGES} picker pages`;
      break;
    }
    const next = current + 1;
    // No anchor for the next page ⇒ this was the last one.
    if ((await pickerPageAnchor(page, next).count()) === 0) break;
    if (!(await goToPickerPage(page, next))) {
      pagingNote = `picker page ${next} was offered but never rendered`;
      break;
    }
    current = next;
  }

  // ONE decision, over everything scanned. More matching ROWS than accounts is
  // normal (every picker row renders twice, and a payee can be saved twice
  // under two Display Names); more than one distinct ACCOUNT is ambiguity and
  // refuses, whether the two rows shared a page or not.
  const decision = decideFavoriteSelection(scans, criteria);
  const scope =
    `${decision.rowsScanned} row(s) across ${decision.pagesScanned} picker page(s), ` +
    `${decision.hits.length} matching row(s)`;
  console.log(`   ${scope} → ${decision.destinationCount} distinct destination(s)`);

  // A walk that could not FINISH is not a scan of "everything scanned": a
  // second account matching nickname + bank + last-4 could be sitting on the
  // page we never reached, and that is the very ambiguity this function exists
  // to refuse. collectFavorites refuses a truncated read for the same reason.
  // Nothing has been clicked yet, so this costs a re-run and nothing else.
  if (pagingNote) {
    await shot("picker");
    throw new Error(
      `Favorite "${nickname}" (${shown}, ${payee.bank}): could not read the whole saved list ` +
        `(${pagingNote}); scanned ${scope}. Refusing to select.`,
    );
  }

  if (decision.outcome !== "one" || !decision.target) {
    await shot("picker");
    throw new Error(
      `Favorite "${nickname}" (${shown}, ${payee.bank}): expected exactly one matching ` +
        `saved account, found ${decision.destinationCount}. Refusing to select. ` +
        `(scanned ${scope})`,
    );
  }

  // The walk usually ends PAST the winning page, so go back to it and re-read
  // it: the row index that gets clicked is then one we verified on the page we
  // are actually looking at, not one remembered from before a page turn.
  if (decision.target.page !== current) {
    if (!(await goToPickerPage(page, decision.target.page))) {
      await shot("picker");
      throw new Error(
        `Favorite "${nickname}" (${shown}, ${payee.bank}): could not page back to picker ` +
          `page ${decision.target.page} to select it. Refusing to select.`,
      );
    }
    current = decision.target.page;
  }

  const landed = decideFavoriteSelection([{ page: current, rowTexts: await readPickerPage(page) }], criteria);
  if (
    landed.outcome !== "one" ||
    !landed.target ||
    landed.target.destinationKey !== decision.target.destinationKey
  ) {
    await shot("picker");
    throw new Error(
      `Favorite "${nickname}" (${shown}, ${payee.bank}): re-reading picker page ${current} no ` +
        `longer shows exactly the one account that matched (${landed.destinationCount} distinct ` +
        `destination(s) now). Refusing to select.`,
    );
  }

  // Click a RENDERED row for that one account. A duplicate render can put the
  // first matching row inside a hidden copy whose account link cannot be
  // clicked; every remaining hit addresses the SAME account (same
  // destinationKey), so trying the next one changes nothing about where the
  // money goes.
  const rows = pickerRows(page);
  const sameAccount = landed.hits.filter((h) => h.destinationKey === landed.target!.destinationKey);
  let clicked = false;
  for (const hit of sameAccount) {
    const link = rows.nth(hit.rowIndex).locator("a.c-bold.c-green.pointer:visible").first();
    if ((await link.count()) === 0) continue;
    console.log(`→ Select verified favorite "${nickname}" (picker page ${current}, row ${hit.rowIndex + 1})`);
    await link.click({ timeout: 15_000 });
    clicked = true;
    break;
  }
  if (!clicked) {
    await shot("picker");
    throw new Error(
      `Favorite "${nickname}" (${shown}, ${payee.bank}): the matching saved row on picker page ` +
        `${current} has no clickable account link. Refusing to select.`,
    );
  }
  await page.waitForTimeout(2_000);

  const filled = await page.locator('input[name="accountTo"]').first().inputValue().catch(() => "");
  const filledD = digitsOnly(filled);
  // Full number when we have one; otherwise the last 4 KBIZ itself filled in —
  // over a field that must still hold a whole account number. 8 is the same
  // floor rowHasAccountEndingWith uses to decide a token IS an account, and it
  // stops a masked or half-rendered field ("…5678") from confirming only the 4
  // digits we already assumed.
  const toOk = acctD ? filledD === acctD : filledD.length >= 8 && filledD.endsWith(last4);
  if (!toOk) {
    await shot("toMismatch"); // same `_toMismatch-<slug>.png` path as before, one idiom
    throw new Error(`After selecting "${nickname}", To account is ${maskAccount(filled)}, expected ${shown}.`);
  }
  console.log(`   ✓ To account = ${filled}`);
}

/**
 * Select KBIZ's transfer category by picker anchor id — never by label text
 * (a live-verified bug: clicking on visible text left the category on
 * "Other" when the popup rendered a translated/mismatched label). Category is
 * metadata, never a transfer-blocker: any step failing just warns and moves
 * on, it never throws.
 */
async function selectCategory(page: Page, kbizCategoryId: string): Promise<void> {
  try {
    const toggle = page.locator("a.popup-content-type").first();
    if (!(await toggle.isVisible().catch(() => false))) {
      console.warn(`⚠ category toggle (a.popup-content-type) not found — leaving category as-is (wanted id "${kbizCategoryId}").`);
      return;
    }
    const before = (await toggle.innerText().catch(() => "")).trim();

    await toggle.click();
    const popup = page.locator(".content-type-list, .type-list").first();
    await popup.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    const opt = page.locator(`a[id="${kbizCategoryId}"]:visible`).first();
    if (!(await opt.count())) {
      console.warn(`⚠ no visible category anchor with id "${kbizCategoryId}" — leaving category as-is.`);
      return;
    }
    await opt.click();
    await page.waitForTimeout(500);

    const after = (await toggle.innerText().catch(() => "")).trim();
    if (after === before) {
      console.warn(`⚠ category text unchanged after selecting id "${kbizCategoryId}" (still "${after}") — click may not have registered.`);
    } else {
      console.log(`   ✓ category → "${after}"`);
    }
  } catch (e) {
    console.warn(`⚠ category selection failed, continuing without it: ${(e as Error).message}`);
  }
}

/** Type the bank + account for a payee NOT in the saved list. */
async function selectCustomAccount(page: Page, payee: Payee, slug: string): Promise<void> {
  // Custom is the one mode that must type the number, so it must have one —
  // a favorite's masked last-4 is not enough to address a transfer.
  if (!payee.accountNo) throw new Error('A "custom" payee needs a full account number — none was given.');
  const acctD = digitsOnly(payee.accountNo);

  console.log(`→ Custom account: select bank "${payee.bank}"`);
  // Set the native <select> + sync jQuery/select2 (string eval avoids esbuild __name).
  const bankChosen = await page
    .evaluate(
      `(function(){
         var sel=document.querySelector('select[name="bank"]');
         if(!sel)return 'no-select';
         var wants=${JSON.stringify(aliasesForBank(payee.bank).map((a) => a.toLowerCase()))};
         var opt=Array.prototype.find.call(sel.options,function(o){var t=(o.textContent||'').toLowerCase();return wants.some(function(w){return t.indexOf(w)>=0;});});
         if(!opt)return 'no-option';
         sel.value=opt.value; sel.dispatchEvent(new Event('change',{bubbles:true}));
         if(window.jQuery){try{window.jQuery(sel).val(opt.value).trigger('change');}catch(e){}}
         return (opt.textContent||'').trim();
       })()`,
    )
    .catch((e) => "eval-fail:" + (e as Error).message);
  console.log(`   bank → ${bankChosen}`);
  if (typeof bankChosen === "string" && bankChosen.startsWith("no-")) {
    throw new Error(`Could not select bank "${payee.bank}" (${bankChosen}).`);
  }
  await page.waitForTimeout(1_000);

  console.log("→ Type destination account number");
  const acct = page.locator('input[name="accountTo"]').first();
  await acct.waitFor({ state: "visible", timeout: 10_000 });
  await acct.click().catch(() => {});
  await acct.fill(acctD);
  await acct.press("Tab").catch(() => {});
  await page.waitForTimeout(3_500); // KBIZ resolves the account name async

  const filled = await acct.inputValue().catch(() => "");
  if (digitsOnly(filled) !== acctD) {
    await page.screenshot({ path: `${SLIPS_DIR}/_toMismatch-${slug}.png`, fullPage: true }).catch(() => {});
    throw new Error(`Typed account did not stick: field shows ${maskAccount(filled)}, expected ${maskAccount(payee.accountNo)}.`);
  }
  console.log(`   ✓ To account = ${filled}`);
}

export async function runTransferOtherFlow(
  page: Page,
  input: TransferOtherInput,
): Promise<TransferOtherResult> {
  const amountStr = input.amount.toFixed(2);
  const p = input.payee;
  const memo = sanitizeKbizMemo(input.memo);

  if (input.amount > input.maxTransfer) {
    return { success: false, error: `Amount ฿${amountStr} exceeds ceiling ฿${input.maxTransfer.toLocaleString()} — refusing.` };
  }

  console.log("\n──────── โอนเงินไปบัญชีบุคคลอื่น (fundtranfer-other) ────────");
  console.log(
    `   payee:  [${p.mode}] ${p.nickname ?? p.accountName ?? "?"} · ${p.bank} · ` +
      `${maskAccount(p.accountNo ?? p.accountLast4 ?? "")}`,
  );
  console.log(`   amount: ฿${amountStr}`);
  console.log(`   memo:   ${memo || "—"}${memo !== input.memo.trim() ? "  (sanitized)" : ""}`);
  console.log(`   mode:   ${input.confirm ? "CONFIRM (Next arms the phone push)" : "PREVIEW (stops before Next)"}`);
  console.log("────────────────────────────────────────────────────────────\n");

  ensureSlipsDir();
  await gotoAuthenticated(page, URL);
  await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2_000);

  try {
    if (p.mode === "favorite") await selectFavoritePayee(page, p, input.slug);
    else await selectCustomAccount(page, p, input.slug);
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  // Built here (never throws — a Locator is a lazy handle, not a DOM query)
  // so it's reachable both inside the try below (preview return) and after
  // it closes (the Next click that arms the phone push).
  const next = page
    .locator('a.btn-gradient:has-text("Next"), a.btn:has-text("Next"), button:has-text("Next"), a:has-text("ต่อไป")')
    .filter({ hasNot: page.locator(".disabled-button") })
    .first();

  // Everything through the Next-visibility wait can fail closed: nothing has
  // been submitted to KBIZ yet, so any throw in this block returns
  // { success: false } with no `outcome` — mapFlowOutcomeToPatch files that
  // as "failed"/retryable, never "unconfirmed". Only next.click() below
  // (outside this try) arms the phone push and starts genuine ambiguity.
  try {
    console.log("→ Fill amount");
    const amt = page.locator('input[name="amount"]').first();
    await amt.click().catch(() => {});
    await amt.fill(amountStr);
    await amt.press("Tab").catch(() => {});
    await page.waitForTimeout(500);

    // fill() proves the DOM call succeeded, not that KBIZ's input mask kept
    // what we typed — read it back the same way selectFavoritePayee /
    // selectCustomAccount already verify accountTo, so a mask that reformats
    // (e.g. drops the decimal point) fails closed instead of arming with the
    // wrong sum.
    const filledAmount = await amt.inputValue().catch(() => "");
    const strippedAmount = filledAmount.replace(/,/g, "").trim();
    if (strippedAmount !== amountStr) {
      await page.screenshot({ path: `${SLIPS_DIR}/_amountMismatch-${input.slug}.png`, fullPage: true }).catch(() => {});
      throw new Error(`Amount did not stick: field shows "${filledAmount}", expected ฿${amountStr}.`);
    }
    console.log(`   ✓ amount = ${filledAmount}`);

    if (memo) {
      console.log("→ Fill memo");
      const m = page.locator('input[name="memo"]').first();
      await m.fill(memo);
      await m.press("Tab").catch(() => {});
    }

    if (input.kbizCategoryId) {
      console.log(`→ Set category (id "${input.kbizCategoryId}")`);
      await selectCategory(page, input.kbizCategoryId);
    }

    if (input.attachmentPath) {
      console.log("→ Attach file");
      // Best-effort, matching html-to-pdf's contract: a voucher problem is
      // metadata, never a transfer-blocker, so warn and continue instead of
      // throwing (which would otherwise escape as a mid-flow crash and file
      // needs-review for a payment that was never even attempted).
      try {
        const fileInput = page.locator('input[name="uploadfile"], input[type="file"]').first();
        if (!(await fileInput.count())) throw new Error("No file input found for the attachment.");
        await fileInput.setInputFiles(input.attachmentPath);
        await page.waitForTimeout(1_000);
      } catch (e) {
        console.warn(`⚠ attachment failed, continuing without it: ${(e as Error).message}`);
      }
    }

    const formShot = `${SLIPS_DIR}/_form-${input.slug}.png`;
    await page.screenshot({ path: formShot, fullPage: true }).catch(() => {});

    // PREVIEW: stop here. "Next" arms the push, so we never click it in preview.
    if (!input.confirm) {
      const ready = await next.isVisible().catch(() => false);
      console.log(`\n   PREVIEW — filled form captured (${formShot}). Next ${ready ? "is ready" : "NOT ready — check the form"}.`);
      console.log("   Nothing submitted, no phone push. Re-run with confirm to arm.\n");
      return { success: true, finalUrl: page.url(), previewOnly: true, formShot };
    }

    await next.waitFor({ state: "visible", timeout: 15_000 });
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  // CONFIRM: clicking Next sends the phone push — but from 2026-08-19 on,
  // "sends" is a claim this flow VERIFIES, not one it assumes. `clickedAt`
  // is deliberately not named `armedAt` here: that name is earned below,
  // only once verifyArmed (or the wait loop itself) has actually seen the
  // bank's own acknowledgement. See onArmed's doc comment above for the
  // full incident history this replaces.
  console.log("→ Click Next — KBIZ sends the approval push to your phone");
  await next.click();
  const clickedAt = Date.now();
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: `${SLIPS_DIR}/_waiting-${input.slug}.png`, fullPage: true }).catch(() => {});

  let post = await verifyArmed(playwrightApprovalView(page));

  if (post.state === "duplicate-popup") {
    // KBIZ's exact-duplicate confirmation dialog. User-verified 2026-08-19
    // to PRECEDE any push — that is the only reason a refusal below may
    // report `armedAt: undefined` ("nothing submitted") truthfully. Never
    // observed in 9/9 production arms; policy comes entirely from the
    // caller (process-queue.ts), the only place with fs access to the queue
    // archive that can tell "no prior attempt on this bundle" from "this
    // bundle already paid" (decideDuplicateConfirm, IMPL-C).
    await page.screenshot({ path: `${SLIPS_DIR}/_duplicate-${input.slug}.png`, fullPage: true }).catch(() => {});
    // Absent policy behaves exactly like a policy that says no — "no
    // information about whether this bundle already paid" must never be
    // read as permission to confirm.
    const policy = input.duplicatePolicy ?? { confirm: false, reason: "unknown-bundle" as DuplicateReason };
    await Promise.resolve()
      .then(() => input.onDuplicatePopup?.({ confirmed: policy.confirm, reason: policy.reason, detail: policy.detail }))
      .catch(() => {});

    if (!policy.confirm) {
      // Best-effort dismissal so the wizard doesn't sit on a dead-end modal
      // for the next queue item — never a transfer-blocker in itself.
      await clickDialogButton(page, DUPLICATE_DIALOG_HINT, ["ยกเลิก", "Cancel"]);
      return {
        success: false,
        // `reason`/`detail` passed straight through — SPEC REVIEW FINDING 3
        // (2026-08-19): this used to substitute a placeholder string
        // ("(no detail — see the queue archive)") whenever `policy.detail`
        // was absent (every `scan-failed` / `unknown-bundle` refusal, i.e.
        // EVERY manual `transfer-other -- --confirm` run, which passes no
        // duplicatePolicy at all), asserting "a prior attempt exists" when
        // the truth is "the bot could not even check". duplicateHeldText now
        // branches on `reason` and never interpolates a placeholder.
        error: duplicateHeldText(policy.reason, policy.detail),
        shot: `${SLIPS_DIR}/_duplicate-${input.slug}.png`,
        pushMayBeLive: false,
        // Deliberately NO `outcome`, NO `armedAt`: nothing was submitted to
        // the bank, so this is filed the same as any other pre-arm refusal
        // (mapFlowOutcomeToPatch → "failed", safe to retry once the earlier
        // attempt is checked in ประวัติทำรายการ).
      };
    }

    // KBIZ needs a second confirmation to actually arm the push. The click
    // is scoped to the visible dialog and matched EXACTLY on the BUTTON'S
    // OWN accessible name (MONEY REVIEW FINDING 5, 2026-08-19: `exact:
    // false` substring-matches "ยืนยัน" against "ยืนยันการทำรายการ" in 7 of 9
    // production dumps, AND — now that DUPLICATE_DIALOG_HINT is bilingual,
    // see below — "Confirm" against this same page's own "Confirm the
    // transaction" button, kbiz-live-push.en.txt:59) here would be a live
    // money-path bug, not a cosmetic one. The user's own screenshot shows
    // the real buttons are labelled EXACTLY "ยกเลิก" / "ยืนยัน", so nothing is
    // lost by requiring an exact match.
    const confirmResult = await clickDialogButton(page, DUPLICATE_DIALOG_HINT, ["ยืนยัน", "Confirm"]);
    if (confirmResult !== "clicked") {
      // clickDialogButton returns "clicked" ONLY immediately after a real
      // `.click()` call succeeds (see its own doc comment). Its OTHER two
      // outcomes are NOT equivalent on the money path (MONEY REVIEW FINDING,
      // 2026-08-19 second fix round — the original single-bit `false` here
      // conflated them, which released the estate-wide lock on a click that
      // may have already registered with the bank):
      //  "not-found"    — never clicked anything, on a popup that
      //                    (user-verified 2026-08-19) precedes any push BY
      //                    CONSTRUCTION. Nothing was submitted, exactly like
      //                    the policy-refused branch above — safe to say so
      //                    and safe to release the lock.
      //  "click-failed" — a click WAS dispatched and then the action threw
      //                    (element detached by the dialog's own transition,
      //                    the 5 s action budget elapsing post-input). We
      //                    cannot prove the bank never saw it, so this is
      //                    treated exactly like the "unknown" branch below:
      //                    `pushMayBeLive: true` keeps the lock held instead
      //                    of releasing it out from under a maybe-live push.
      const clickFailed = confirmResult === "click-failed";
      await page.screenshot({ path: `${SLIPS_DIR}/_unverified-${input.slug}.png`, fullPage: true }).catch(() => {});
      return {
        success: false,
        error: clickFailed
          ? `HELD: KBIZ แสดงหน้าต่างยืนยันรายการซ้ำ บอทกดปุ่ม "ยืนยัน" แล้วแต่ระบบไม่ยืนยันว่ากดสำเร็จ (อาจเป็นเพราะหน้าจอเปลี่ยนระหว่างกด) ` +
            `จึงไม่ทราบว่ามีการส่งคำสั่งไปที่ธนาคารหรือไม่ ห้ามลองใหม่จนกว่าจะเปิดแอป K BIZ ตรวจ "ประวัติทำรายการ" ก่อน`
          : `HELD: KBIZ แสดงหน้าต่างยืนยันรายการซ้ำ แต่บอทหาปุ่ม "ยืนยัน" ที่ปลอดภัยไม่พบ (อาจเป็นเพราะรูปแบบหน้าจอไม่ตรงกับที่ตรวจสอบไว้) ` +
            `จึงไม่ได้กดอะไรเลย ไม่มีการโอนในครั้งนี้ ให้เปิดแอป K BIZ ดู "ประวัติทำรายการ" ก่อนลองใหม่`,
        shot: `${SLIPS_DIR}/_unverified-${input.slug}.png`,
        pushMayBeLive: clickFailed,
        // "not-found": NO outcome / NO armedAt, same reasoning as the
        // policy-refused branch — no click was ever dispatched.
        // "click-failed": also no outcome/armedAt (we don't know a push
        // exists, only that we cannot rule one out) — `pushMayBeLive: true`
        // alone is what keeps the lock held; see process-queue.ts:367.
      };
    }
    await page.waitForTimeout(2_500);
    post = await verifyArmed(playwrightApprovalView(page));
  }

  if (post.state === "duplicate-popup") {
    // The confirm click's OWN dialog re-rendered — a second confirmation
    // stacked, a slow animate-out, or a genuine re-arm race. We can prove
    // NEITHER that the push armed (onArmed never fires ⇒ no TAP-NEEDED ping,
    // exactly the incident class this file exists to end) NOR that nothing
    // did (the popup may never have actually cleared). MONEY/SPEC REVIEW
    // FINDING 6/4 (2026-08-19): falling through to waitForApproval here used
    // to burn the FULL 6.5-min timeout on text neither classifyFrame nor
    // AMBIGUOUS_RE recognises, then filed `unconfirmed` and held the whole
    // estate via UNCONFIRMED_DEFER_MS for a state the bot already
    // recognised. Treat it exactly like "unknown" instead, reached
    // IMMEDIATELY: fail closed, keep the lock held, let a human check K BIZ.
    await page.screenshot({ path: `${SLIPS_DIR}/_unverified-${input.slug}.png`, fullPage: true }).catch(() => {});
    return finalizeTransfer({
      outcome: "unconfirmed",
      pushMayBeLive: true,
      armedAt: clickedAt,
      armVerified: false,
      captureSlip: () => captureSlip(page, input.slug),
      finalUrl: () => page.url(),
    });
  }

  if (post.state === "unknown") {
    // Neither "the panel is up" nor "a terminal frame already appeared" —
    // we clicked, so a push MAY exist; we saw no acknowledgement within the
    // budget, so we cannot claim one does. `pushMayBeLive: true` keeps the
    // estate-wide lock held (process-queue.ts does not release it), and
    // `armVerified: false` steers finalize-transfer.ts to the copy that
    // says so instead of the ordinary "the bank never answered" framing.
    await page.screenshot({ path: `${SLIPS_DIR}/_unverified-${input.slug}.png`, fullPage: true }).catch(() => {});
    return finalizeTransfer({
      outcome: "unconfirmed",
      pushMayBeLive: true,
      armedAt: clickedAt,
      armVerified: false,
      captureSlip: () => captureSlip(page, input.slug),
      finalUrl: () => page.url(),
    });
  }

  if (post.state === "armed" && input.onArmed) {
    // Fire-and-forget, off the money path — identical arrangement to the
    // bare-click version this replaces, just moved past the verification.
    void Promise.resolve()
      .then(() => input.onArmed!(clickedAt))
      .catch(() => {});
  }
  // post.state === "terminal": classifyFrame already has a verdict (most
  // plausibly push-expired, or a same-page failure) — there is nothing to
  // tap, so no TAP-NEEDED ping fires. Fall through; waitForApproval below
  // classifies the SAME page on its own first read, so nothing is lost.

  console.log(`   armed — waiting for your phone tap (up to ${Math.floor(APPROVAL_TIMEOUT_MS / 60000)} min)…`);

  const waitResult = await waitForApproval(playwrightApprovalView(page), {
    onTick: (elapsedMs) => {
      const s = Math.floor(elapsedMs / 1000);
      if (s % 20 < 4) console.log(`   …waiting ${s}s`);
    },
  });
  const { outcome, pushMayBeLive } = waitResult;
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Slip capture + result assembly live in lib/finalize-transfer.ts, which is
  // playwright-free ON PURPOSE: "a bank-confirmed success is never downgraded
  // because slip capture failed" is a money rule, and root `bun test` (which
  // runs before kbiz-bot's node_modules exist) has to be able to prove it.
  // The page reaches it only through these two thunks.
  return finalizeTransfer({
    outcome,
    pushMayBeLive,
    armedAt: clickedAt,
    captureSlip: () => captureSlip(page, input.slug),
    finalUrl: () => page.url(),
  });
}

// KBIZ's exact-duplicate dialog's own hint text, used ONLY to SCOPE the
// button search below to the visible duplicate dialog specifically — never to
// decide whether the popup is present at all (that decision already happened
// in verifyArmed/classifyPostNext). MONEY REVIEW FINDING 8 (2026-08-19): this
// used to be Thai-only while post-next.ts's DUPLICATE_POPUP_RE (the thing
// that actually DETECTS the popup) is bilingual — so an English duplicate
// popup was correctly recognised upstream but then this hint could never
// scope into it, and clickDialogButton always returned `false`. Mirrors
// DUPLICATE_POPUP_RE's own bilingual pattern.
export const DUPLICATE_DIALOG_HINT = /ทำรายการนี้ไปแล้ว|already (?:made|performed|done) this transaction/i;

/**
 * Tri-state, replacing a plain boolean (MONEY REVIEW FINDING, 2026-08-19
 * second fix round): a click attempt can fail two ways that are NOT
 * equivalent on the money path.
 *  "clicked"      — `.click()` returned normally. The button was pressed.
 *  "not-found"    — no dialog matched `hint`, or no button/link matched any
 *                    `buttonNames` and became visible. NOTHING was clicked.
 *  "click-failed" — a button/link WAS found and `.click()` was DISPATCHED,
 *                    but the awaited action then threw (element detached by
 *                    the dialog's own transition, the 5 s action budget
 *                    elapsing post-input, etc.). The click may have already
 *                    registered with the page before the throw — this is
 *                    genuinely ambiguous, not "found no safe button".
 * The duplicate-popup confirm caller (below) reports `pushMayBeLive: true`
 * for "click-failed" only — collapsing it into "not-found" (as this used to
 * return a bare `false` for both) let a click-then-throw on the ยืนยัน button
 * release the estate-wide arm lock while a push may be live, the one
 * direction that lock exists to prevent.
 */
export type ClickDialogResult = "clicked" | "not-found" | "click-failed";

/** Literal-escape a button name for the exact-innerText RegExp below. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
}

/**
 * Best-effort: click a button/link matched EXACTLY on its OWN accessible
 * name (or, per the real DOM, its own textContent — whitespace-tolerant,
 * see the ^\s*…\s*$ regex below), scoped to
 * whichever visible dialog contains `hint`. Errors are swallowed, and the
 * tri-state return (see `ClickDialogResult`) tells the caller whether a
 * click was ever dispatched.
 *
 * REAL DOM (operator devtools capture, 2026-08-19 — the duplicate popup is
 * still 0-of-9 in production arms, this capture is the only ground truth;
 * pinned in test/fixtures/kbiz-duplicate-popup.dom.html and verified by
 * src/probe-duplicate-popup-dom.ts):
 *   .mfp-wrap > .mfp-container > .mfp-content > #popup-duplicate.white-popup-block
 *     h3 "แจ้งเตือน" / p.desc "ท่านหรือบริษัทมีการทำรายการนี้ไปแล้ว …"
 *     .action > a.btn.popup-modal-close > span "ยกเลิก"
 *              a.btn.btn-gradient      > span "ยืนยัน"
 * Three traps that made the first shipped version inert (probe went 4/6 RED
 * against the capture before this fix):
 *   1. The container is Magnific Popup (.mfp-content/.white-popup-block) —
 *      none of .modal / [role='dialog'] / .popup / .layer exist on it.
 *   2. The action anchors carry NO href — no href means no implicit ARIA
 *      role, so getByRole("button") AND getByRole("link") both find nothing.
 *   3. #popup-duplicate exists TWICE (visible active copy in .mfp-content +
 *      hidden .mfp-hide source template), and an unrelated hidden dialog
 *      (#confrimDraft) has its own exact-text "ยืนยัน" anchor — so both the
 *      container and the anchor lookup must stay :visible-scoped.
 *
 * `exact: true` (money review finding 5, 2026-08-19): a substring match on
 * "ยืนยัน" hits "ยืนยันการทำรายการ" in 7 of 9 production dumps, and — now that
 * `hint` is bilingual — a substring match on "Confirm" would hit this same
 * page's own "Confirm the transaction" button (kbiz-live-push.en.txt:59).
 * The user's own screenshot shows the real buttons are labelled EXACTLY
 * "ยกเลิก" / "ยืนยัน", so nothing is lost by requiring an exact match.
 */
export async function clickDialogButton(page: Page, hint: string | RegExp, buttonNames: string[]): Promise<ClickDialogResult> {
  // Set the instant a click is dispatched — BEFORE the awaited `.click()` —
  // so a throw from inside `.click()` itself still reports "click-failed",
  // not "not-found". This flag, not the button lookup, is what the catch
  // block below consults.
  let clicked = false;
  try {
    // .white-popup-block IS the captured KBIZ dialog (it sits on
    // #popup-duplicate itself — see doc comment). Deliberately NOT its
    // ancestor .mfp-content: Playwright resolves a CSS union in DOM order,
    // so the ancestor would always win and widen the scope to the whole
    // Magnific slot, where a second stacked dialog's own "ยืนยัน" anchor
    // could be clicked first (money review, 2026-08-19, probe case E).
    // Selector order confers NO priority; only the union's membership and
    // the hasText filter narrow the scope.
    const dialog = page
      .locator(
        ".white-popup-block:visible, .modal:visible, .swal2-popup:visible, [role='dialog']:visible, .popup:visible, .layer:visible",
      )
      .filter({ hasText: hint })
      .first();
    if (!(await dialog.count().catch(() => 0))) return "not-found";
    for (const name of buttonNames) {
      const btn = dialog.getByRole("button", { name, exact: true }).first();
      if (await btn.isVisible().catch(() => false)) {
        clicked = true;
        await btn.click({ timeout: 5_000 });
        return "clicked";
      }
      // Some KBIZ dialogs render actions as <a href=…> — same scope, same
      // accessible-name match.
      const link = dialog.getByRole("link", { name, exact: true }).first();
      if (await link.isVisible().catch(() => false)) {
        clicked = true;
        await link.click({ timeout: 5_000 });
        return "clicked";
      }
      // The captured duplicate popup's anchors have NO href (trap 2 above):
      // role-less <a class="btn"><span>ยืนยัน</span></a>. Match the anchor's
      // own textContent EXACTLY, whitespace-tolerant via ^\s*…\s*$ — the
      // anchors keep money review finding 5 intact ("ยืนยัน" must not
      // substring-match the page's own "ยืนยันการทำรายการ"). Candidates are
      // :visible-scoped: with a bare `.first()` a display:none decoy earlier
      // in DOM order would MASK the real button (isVisible false → next
      // name, never next candidate) and turn a clickable dialog into
      // "not-found" (money review finding 2, 2026-08-19, probe case D).
      const bare = dialog
        .locator("a:visible, button:visible")
        .filter({ hasText: new RegExp(`^\\s*${escapeForRegExp(name)}\\s*$`) })
        .first();
      if (await bare.isVisible().catch(() => false)) {
        clicked = true;
        await bare.click({ timeout: 5_000 });
        return "clicked";
      }
    }
  } catch {
    // Never let a dialog-interaction failure crash the flow — but do NOT
    // collapse "never found a button" and "dispatched a click that then
    // threw" into the same outcome; `clicked` is what tells them apart.
  }
  return clicked ? "click-failed" : "not-found";
}

function playwrightApprovalView(page: Page): ApprovalView {
  return {
    url: () => page.url(),
    bodyText: () => page.evaluate(() => (document.body as any).innerText).catch(() => "") as Promise<string>,
    sleep: (ms) => page.waitForTimeout(ms),
    now: () => Date.now(),
  };
}
