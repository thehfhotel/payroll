/**
 * Selector-vs-real-DOM probe for the SAVED-PAYEE PICKER's pagination.
 *
 * The defect this pins: selectFavoritePayee used to read `div.lists` once and
 * match, so it only ever saw PAGE ONE of a picker that paginates at ten rows
 * per page (operator's devtools capture, 2026-08-19 — footer "บัญชีที่ 1-10
 * จาก 14 บัญชี"). The ฿1 test target sorts to ~row 11, i.e. page 2, and every
 * step of the picker's search box was best-effort, so a silent search failure
 * left the target unreachable — or, worse, left a last-4 COLLISION on page 1
 * looking like the unique match (case D below: that is a misroute, not a
 * refusal).
 *
 * Since 2026-08-26 (review case D2) the flow does not search AT ALL: a filter
 * that keeps the intended row but drops a colliding one would hide the
 * ambiguity from the walk. So every scenario here, whatever its `search=`
 * variant does, must reach the same outcome — and the probe additionally
 * asserts the search box was never typed into or triggered (case H: a filter
 * already applied when the picker opens must refuse, never be cleared).
 *
 * This drives the REAL selectFavoritePayee (imported, not copied) against the
 * captured markup in test/fixtures/kbiz-payee-picker.dom.html in a local
 * chromium at the 1600px viewport the flow forces.
 *
 * NOT part of root `bun test` (imports playwright — root CI runs without
 * kbiz-bot/node_modules). Run manually:
 *     cd kbiz-bot && bun run probe-payee-picker
 * Exit code 0 = every assertion held; non-zero = regression.
 */
import { chromium, type Browser, type Page } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { selectFavoritePayee, type Payee } from "./flows/transfer-other-flow";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/kbiz-payee-picker.dom.html");

/** The ฿1 test destination as a masked (synced-favorite) payee: last 4 only. */
const PAYEE: Payee = {
  mode: "favorite",
  nickname: "ทดสอบ โอนหนึ่งบาท",
  bank: "ธนาคารกสิกรไทย",
  accountLast4: "1117",
  accountName: "MR. TEST PAYEE",
};

/** The placeholder account those criteria must resolve to (fixture row #11). */
const TARGET_ACCOUNT = "111-1-11111-7";
/** The page-1 decoy in the collision scenario — a DIFFERENT account, same last 4. */
const COLLIDING_ACCOUNT = "222-2-22111-7";

let failures = 0;
/** `detail` is printed only when the check fails — it describes what went wrong. */
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

type Attempt = {
  error: string | null;
  /** Which account the fixture says was clicked, if any. */
  selected: string | null;
  fromHiddenTemplate: boolean;
  /** The To field the flow verified. */
  accountTo: string;
  /** Everything the flow logged, so the per-page walk lines can be asserted. */
  log: string[];
  /** Did ANYTHING type into / key on the search box, or click its trigger? */
  touchedSearch: boolean;
  /** The search box's value after the attempt — "" unless the probe pre-filled it (case H). */
  searchValue: string;
};

/** Hook the search box so any typing, keypress or trigger click is recorded. */
async function watchSearchBox(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __touchedSearch?: boolean };
    const mark = () => (w.__touchedSearch = true);
    const box = document.querySelector('input[name="acctSearch"]');
    for (const ev of ["input", "keydown", "keypress", "keyup", "change", "paste"]) box?.addEventListener(ev, mark);
    document.getElementById("search-acct-to-btn")?.addEventListener("click", mark);
  });
}

/**
 * Run the real selection against one fixture scenario, capturing its logs.
 * `prefill` sets the search box's value BEFORE the flow runs (no events, no
 * filtering — the fixture only filters on click/Enter), modelling a filter
 * someone left in the modal.
 */
async function attempt(browser: Browser, query: string, prefill?: string): Promise<Attempt> {
  const page: Page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const log: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const capture = (...args: unknown[]) => {
    log.push(args.map(String).join(" "));
  };
  let error: string | null = null;
  try {
    await page.goto(`${pathToFileURL(FIXTURE).href}?${query}`);
    await watchSearchBox(page);
    if (prefill !== undefined) {
      await page.evaluate((v) => {
        (document.querySelector('input[name="acctSearch"]') as HTMLInputElement).value = v;
      }, prefill);
    }
    console.log = capture;
    console.warn = capture;
    try {
      await selectFavoritePayee(page, PAYEE, "probe");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  const selected = await page.evaluate(() => (window as unknown as { __selected?: string }).__selected ?? null);
  const fromHiddenTemplate = await page.evaluate(
    () => (window as unknown as { __selectedFromHiddenTemplate?: boolean }).__selectedFromHiddenTemplate === true,
  );
  const accountTo = await page.locator('input[name="accountTo"]').first().inputValue().catch(() => "");
  const touchedSearch = await page.evaluate(
    () => (window as unknown as { __touchedSearch?: boolean }).__touchedSearch === true,
  );
  const searchValue = await page.locator('input[name="acctSearch"]').first().inputValue().catch(() => "");
  await page.close();
  for (const line of log) realLog(`      | ${line}`);
  if (error) realLog(`      | REFUSED: ${error}`);
  return { error, selected, fromHiddenTemplate, accountTo, log, touchedSearch, searchValue };
}

/** The D2 invariant, asserted in EVERY scenario: the search box was never used. */
function checkNeverSearched(r: Attempt) {
  check("never typed into / triggered the search box", r.touchedSearch === false, "the search box saw an event");
  check("search box left empty", r.searchValue === "", `search box holds "${r.searchValue}"`);
  check("no 'picker search' log line", !r.log.some((l) => /picker search/i.test(l)), "a line mentions the picker search");
}

const pageLines = (r: Attempt) => r.log.filter((l) => /saved rows on picker page/i.test(l)).length;

async function run(browser: Browser) {
  // ── A) target on page 2, a WORKING search available — must not be used ──
  console.log("\nA) target on page 2, a working picker search is available (the flow must walk, not search)");
  {
    const r = await attempt(browser, "rows=base&search=on");
    check("selected the target account", r.selected === TARGET_ACCOUNT, `selected ${r.selected}`);
    check("no refusal", r.error === null, r.error ?? "");
    check("To field holds the target", r.accountTo === TARGET_ACCOUNT, `got "${r.accountTo}"`);
    check("walked BOTH pages despite the working search", pageLines(r) >= 2, `${pageLines(r)} page line(s)`);
    checkNeverSearched(r);
  }

  // ── B) target on page 2, search SILENTLY BROKEN — the real bug ──────────
  console.log("\nB) target on page 2, search silently broken (THE DEFECT: page 2 was unreachable)");
  {
    const r = await attempt(browser, "rows=base&search=broken");
    check("selected the target account anyway (paginated to page 2)", r.selected === TARGET_ACCOUNT, `selected ${r.selected}`);
    check("no refusal", r.error === null, r.error ?? "");
    check("To field holds the target", r.accountTo === TARGET_ACCOUNT, `got "${r.accountTo}"`);
    check("the walk logged more than one page", pageLines(r) >= 2, `${pageLines(r)} page line(s)`);
    checkNeverSearched(r);
  }

  // ── C) one account rendered twice must not become two matches ───────────
  console.log("\nC) target saved twice + a hidden duplicate render, search broken (dedupe, deliverable c)");
  {
    const r = await attempt(browser, "rows=dupe&search=broken");
    check("still selected the target account", r.selected === TARGET_ACCOUNT, `selected ${r.selected}`);
    check("no false ambiguity refusal", r.error === null, r.error ?? "");
    check("clicked a RENDERED row, not the hidden duplicate", r.fromHiddenTemplate === false);
    check("To field holds the target", r.accountTo === TARGET_ACCOUNT, `got "${r.accountTo}"`);
    checkNeverSearched(r);
  }

  // ── D) genuine cross-page ambiguity must refuse ─────────────────────────
  console.log("\nD) two DIFFERENT accounts sharing the last 4, one per page, search broken (must refuse)");
  {
    const r = await attempt(browser, "rows=collision&search=broken");
    check("refused", r.error !== null, "no error thrown");
    check("refusal says it refuses to select", (r.error ?? "").includes("Refusing to select"), r.error ?? "");
    check("clicked nothing at all", r.selected === null, `selected ${r.selected}`);
    check("did NOT misroute to the page-1 collision", r.accountTo !== COLLIDING_ACCOUNT, `To = "${r.accountTo}"`);
    check("To field untouched", r.accountTo === "", `To = "${r.accountTo}"`);
    check(
      "the refusal is masked — no full account number in the message",
      !/\d{5,}/.test(r.error ?? ""),
      r.error ?? "",
    );
    checkNeverSearched(r);
  }

  // ── D2) the same ambiguity with a WORKING search available ──────────────
  // THE REVIEW CASE: a working filter that returned a non-empty list missing
  // the colliding row would hide the ambiguity. The flow never filters, so
  // both rows are seen and it refuses exactly as in D.
  console.log("\nD2) same collision, a working search is available (never used → both rows seen → refuses)");
  {
    const r = await attempt(browser, "rows=collision&search=on");
    check("refused", r.error !== null, "no error thrown");
    check("clicked nothing", r.selected === null, `selected ${r.selected}`);
    check("To field untouched", r.accountTo === "", `To = "${r.accountTo}"`);
    check("walked BOTH pages", pageLines(r) >= 2, `${pageLines(r)} page line(s)`);
    checkNeverSearched(r);
  }

  // ── E) target absent entirely ──────────────────────────────────────────
  console.log("\nE) target not in the book at all, search broken (must refuse, having walked every page)");
  {
    const r = await attempt(browser, "rows=absent&search=broken");
    check("refused", r.error !== null, "no error thrown");
    check("refusal says it refuses to select", (r.error ?? "").includes("Refusing to select"), r.error ?? "");
    check("clicked nothing", r.selected === null, `selected ${r.selected}`);
    check("To field untouched", r.accountTo === "", `To = "${r.accountTo}"`);
    checkNeverSearched(r);
  }

  // ── F) the paginator advertises a page it never renders ────────────────
  console.log("\nF) page 2 advertised but inert, search broken (a partial scan is not the list → refuse)");
  {
    const r = await attempt(browser, "rows=base&search=broken&pager=stalled");
    check("refused", r.error !== null, "no error thrown");
    check(
      "says WHY it could not decide",
      (r.error ?? "").includes("could not read the whole saved list"),
      r.error ?? "",
    );
    check("clicked nothing", r.selected === null, `selected ${r.selected}`);
    check("To field untouched", r.accountTo === "", `To = "${r.accountTo}"`);
    checkNeverSearched(r);
  }

  // ── G) a search that would EMPTY the list on the nickname — irrelevant now ─
  console.log("\nG) search matches account numbers only (typing the nickname would empty the list — the flow never types)");
  {
    const r = await attempt(browser, "rows=base&search=acctonly");
    check("selected the target account", r.selected === TARGET_ACCOUNT, `selected ${r.selected}`);
    check("no refusal", r.error === null, r.error ?? "");
    check("To field holds the target", r.accountTo === TARGET_ACCOUNT, `got "${r.accountTo}"`);
    check("paged the whole book", pageLines(r) >= 2, `${pageLines(r)} page line(s)`);
    checkNeverSearched(r);
  }

  // ── H) a filter is ALREADY in the box when the picker opens ────────────
  console.log("\nH) the search box holds a filter before the flow starts (a subset is not the book → refuse, never clear it)");
  {
    const r = await attempt(browser, "rows=base&search=on", "ทดสอบ");
    check("refused", r.error !== null, "no error thrown");
    check(
      "says a filter was already applied",
      (r.error ?? "").includes("search filter already applied"),
      r.error ?? "",
    );
    check("refusal says it refuses to select", (r.error ?? "").includes("Refusing to select"), r.error ?? "");
    check("clicked nothing", r.selected === null, `selected ${r.selected}`);
    check("To field untouched", r.accountTo === "", `To = "${r.accountTo}"`);
    check("walked NO page (refused before the walk)", pageLines(r) === 0, `${pageLines(r)} page line(s)`);
    check("never typed into / triggered the search box", r.touchedSearch === false, "the search box saw an event");
    check("did not clear the filter (that would be typing)", r.searchValue === "ทดสอบ", `search box holds "${r.searchValue}"`);
    check("the refusal does not echo the filter text", !(r.error ?? "").includes("ทดสอบ"), r.error ?? "");
  }

  console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    return await run(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
