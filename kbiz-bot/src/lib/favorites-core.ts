/**
 * PURE core of the favorites scrape — parsing, paging, masking, matching.
 * NO playwright/session imports: payroll's repo-root CI runs `bun test`
 * without kbiz-bot's node_modules, so anything a test touches must not pull
 * the browser stack (same split as scrape-registered's driver pattern).
 *
 * `@reimbursement/shared` below is exempt and stays safe under that rule: the
 * tsconfig `paths` entry maps it straight at a SOURCE file in the same repo, so
 * it resolves with no node_modules at all (verified against the CI layout).
 */

/**
 * Read-only scrape of KBIZ's saved-payee ("favorites") picker on the
 * fundtranfer-other page, published as `queue/kbiz-favorites.json` so the
 * reimbursement approver can pick a destination from the vetted list instead
 * of anyone re-typing an account number.
 *
 * READ-ONLY IS THE WHOLE POINT. The account-number link in a picker row
 * (a.c-bold.c-green.pointer) SELECTS that payee when clicked, so this walker
 * never clicks a row, a Next, or a Confirm — only the numeric page anchors.
 *
 * MASKED BY CONTRACT: only the last 4 digits cross the boundary ("…7394"),
 * the same rule payee-handles.ts publishes the payee book under. The bot
 * re-verifies nickname + bank + last-4 against the live picker at transfer
 * time (see matchFavoriteRows below), so nothing downstream ever needs the
 * full number.
 *
 * The manifest lives INSIDE queue/ for the same reason payee-handles.json
 * does: it is the only bot→reimbursement-visible path needing no new mount.
 * Both queue scanners skip it by name.
 *
 * PINNED DOM (probed + live-verified 2026-08-12):
 *   - the page needs a desktop viewport (1600) — 1366 is KBIZ's iPad-pro edge;
 *   - the picker opens from a.input-search-acc beside "Account No.";
 *   - rows are div.lists carrying a.c-bold.c-green.pointer;
 *   - each row renders its cells as <p>label</p><p>value</p> pairs
 *     (Display Name / Account Name / Bank / Account No.) — which is why this
 *     reads cell pairs and never splits a row's innerText into lines;
 *   - EVERY ROW RENDERS TWICE (desktop hidden-ip-pro + ipad visible-ip-pro
 *     variants), so rows are deduped by nickname + account number;
 *   - pages are plain numeric a.pointer anchors ("2", "3", …) in the modal.
 */


import { KBIZ_FAVORITES_FILE, type KbizFavorite } from "@reimbursement/shared";

/**
 * Shared-file name for the synced favorites — both queue scanners skip it.
 *
 * The name is the CONTRACT's (reimbursement writes the reader), so it is
 * imported rather than re-typed; the bot-local alias stays because the rest of
 * this repo knows it as FAVORITES_FILE.
 */
export const FAVORITES_FILE = KBIZ_FAVORITES_FILE;

/**
 * The picker paginates in the modal and the book is small in practice; 40
 * bounds the walk if the paginator ever misbehaves, matching scrape-registered.
 *
 * Exported since 2026-08-19 because the SELECTION path walks the very same
 * paginator (see decideFavoriteSelection below) and must be bounded by the
 * same number — two different ceilings for one modal would be a lie waiting
 * to happen.
 */
export const MAX_PICKER_PAGES = 40;
const MAX_PAGES = MAX_PICKER_PAGES;

/**
 * One synced saved account — reimbursement's `KbizFavorite`
 * (reimbursement/packages/shared/src/index.ts) ITSELF, not a copy of it. The
 * bot writes this shape into queue/kbiz-favorites.json and reimbursement's
 * approver picker reads it back, so a field rename over there is now a compile
 * error here instead of a silently-unread manifest.
 *
 * Re-exported so `scrape-favorites`'s `export *` and every existing importer
 * keep seeing the name where they always found it.
 */
export type { KbizFavorite };

/** The published `queue/kbiz-favorites.json` payload. */
export interface FavoritesManifest {
  favorites: KbizFavorite[];
  updatedAt: string;
}

/** One picker row as read off the page, before masking. */
export interface RawFavoriteRow {
  nickname: string;
  accountName: string;
  bank: string;
  /** Full number, as rendered (e.g. "100-0-00739-4"). NEVER published. */
  accountNo: string;
}

const digitsOnly = (s: string) => s.replace(/\D+/g, "");

// The picker's cell labels. English is what the live page renders (we log in
// with lang=en); the Thai alternates cost nothing and keep a language flip
// from silently scraping zero rows.
/**
 * EN ↔ TH aliases per KBIZ bank. The bot's session language decides which
 * name the page renders (the session runs Thai since 2026-08-12), but config
 * files, old intents and old manifests may carry either — so bank matching
 * always goes through aliasesForBank(), never a bare substring.
 *
 * Stems are deliberately short + distinctive (e.g. "กสิกร" not the full
 * ธนาคาร… string) so KBIZ's exact rendering can vary without breaking a
 * match, while no stem is a substring of another bank's name.
 */
export const BANK_ALIASES: string[][] = [
  ["Kasikornbank", "กสิกร"],
  ["Bangkok Bank", "กรุงเทพ"],
  ["Krung Thai Bank", "กรุงไทย"],
  ["TMBThanachart", "ทหารไทยธนชาต", "ทีเอ็มบีธนชาต", "ธนชาต"],
  ["Siam Commercial", "ไทยพาณิชย์"],
  ["CITIBANK", "ซิตี้แบงก์"],
  ["Sumitomo Mitsui", "ซูมิโตโม"],
  ["Standard Chartered", "สแตนดาร์ดชาร์เตอร์ด"],
  ["CIMB", "ซีไอเอ็มบี"],
  ["United Overseas", "ยูโอบี"],
  ["Ayudhya", "กรุงศรี"],
  ["Government Savings", "ออมสิน"],
  ["Hongkong and Shanghai", "เอชเอสบีซี", "ฮ่องกงและเซี่ยงไฮ้"],
  ["Deutsche Bank", "ดอยซ์"],
  ["Government Housing", "อาคารสงเคราะห์"],
  ["BAAC", "ธ.ก.ส", "เพื่อการเกษตรและสหกรณ์"],
  ["Mizuho", "มิซูโฮ"],
  ["BNP Paribas", "บีเอ็นพี"],
  ["Bank of China", "แห่งประเทศจีน"],
  ["Islamic Bank", "อิสลาม"],
  ["Tisco", "ทิสโก้"],
  ["Kiatnakin", "เกียรตินาคิน"],
  ["ICBC", "ไอซีบีซี"],
  ["Thai Credit", "ไทยเครดิต"],
  ["Land and Houses", "แลนด์ แอนด์ เฮ้าส์"],
];

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every name the wanted bank is known by. Unknown banks fall back to the
 * wanted string itself — matching still works, just without translation.
 */
export function aliasesForBank(wanted: string): string[] {
  const w = wanted.trim().toLowerCase();
  for (const group of BANK_ALIASES) {
    if (group.some((a) => w.includes(a.toLowerCase()) || a.toLowerCase().includes(w))) {
      return group;
    }
  }
  return [wanted.trim()];
}

/** Case-insensitive "text mentions this bank, under any of its names". */
export function bankPattern(wanted: string): RegExp {
  return new RegExp(aliasesForBank(wanted).map(escapeRe).join("|"), "i");
}

const CELL_LABELS: { key: keyof RawFavoriteRow; re: RegExp }[] = [
  { key: "nickname", re: /^(display name|ชื่อย่อบัญชี|ชื่อที่แสดง|ชื่อเล่น)$/i },
  { key: "accountName", re: /^(account name|ชื่อบัญชี)$/i },
  { key: "bank", re: /^(bank|ธนาคาร)$/i },
  { key: "accountNo", re: /^(account no|account number|เลขบัญชี|เลขที่บัญชี|บัญชีเลขที่)$/i },
];

/** Normalize a cell to its label key, or null when it isn't a label. */
function labelKey(cell: string): keyof RawFavoriteRow | null {
  const norm = cell.replace(/\s+/g, " ").replace(/[:.]+$/, "").trim();
  if (!norm) return null;
  return CELL_LABELS.find((l) => l.re.test(norm))?.key ?? null;
}

/**
 * Parse one row from its <p> cell texts, in DOM order.
 *
 * The row is a flat run of `label, value, label, value …` pairs, so a label
 * takes the cell after it as its value — and FIRST WINS, because a row that
 * renders both the desktop and the iPad variant repeats every label.
 *
 * Returns null for anything we can't both name and verify (nickname + bank +
 * account number): a half-read row must never become a selectable
 * destination.
 */
export function parseFavoriteRowCells(cells: string[]): RawFavoriteRow | null {
  const found: Partial<RawFavoriteRow> = {};
  for (let i = 0; i < cells.length - 1; i++) {
    const key = labelKey(cells[i]);
    if (!key || found[key] !== undefined) continue;
    const value = (cells[i + 1] ?? "").replace(/\s+/g, " ").trim();
    // The next cell is another label — this one rendered no value.
    if (!value || labelKey(value)) continue;
    found[key] = value;
  }
  if (!found.nickname || !found.bank || !found.accountNo) return null;
  if (digitsOnly(found.accountNo).length < 8) return null;
  return {
    nickname: found.nickname,
    accountName: found.accountName ?? "",
    bank: found.bank,
    accountNo: found.accountNo,
  };
}

/** Mask a scraped row down to what may leave this container. */
export function toFavorite(row: RawFavoriteRow): KbizFavorite {
  const last4 = digitsOnly(row.accountNo).slice(-4);
  return {
    nickname: row.nickname,
    accountName: row.accountName,
    bank: row.bank,
    accountMasked: `…${last4}`,
    accountLast4: last4,
  };
}

/**
 * The page operations collectFavorites needs, split out from Playwright so
 * the paging + dedupe logic is testable without a browser (the same driver
 * split scrape-registered.ts uses).
 */
export type FavoritesDriver = {
  /** The <p> cell texts of every picker row rendered on the current page. */
  readRows(): Promise<string[][]>;
  /** Is there a numeric page anchor after the current one? */
  hasNextPage(): Promise<boolean>;
  /** Click it. Never clicks a row, a Next, or a Confirm. */
  clickNextPage(): Promise<void>;
};

/**
 * Walk every page of the picker, accumulating masked favorites.
 *
 * Deduped by nickname + account number because each row renders twice (the
 * desktop and iPad variants), and both are read here — unlike the selection
 * path, which reads innerText and therefore only ever sees the visible one.
 *
 * Fails loudly instead of publishing a short list: a truncated
 * kbiz-favorites.json would quietly hide real saved accounts from the
 * approver's picker, which reads like "that payee isn't in KBIZ" — and pushes
 * the approver off the vetted saved-account path onto a typed number, the very
 * thing this list exists to avoid. A read of zero rows is refused for the same
 * reason: an operator with a destination picker has saved accounts, so "none"
 * means the modal never painted, not that the book is empty.
 */
export async function collectFavorites(driver: FavoritesDriver): Promise<KbizFavorite[]> {
  const byKey = new Map<string, KbizFavorite>();
  let rowsSeen = 0;
  let exhausted = false;

  for (let i = 0; i < MAX_PAGES; i++) {
    const rows = await driver.readRows();
    rowsSeen += rows.length;
    for (const cells of rows) {
      const row = parseFavoriteRowCells(cells);
      if (!row) continue;
      // "|" can't appear in the digits half, so nickname and number can never
      // blur into each other's key.
      const key = `${row.nickname}|${digitsOnly(row.accountNo)}`;
      if (!byKey.has(key)) byKey.set(key, toFavorite(row));
    }
    if (!(await driver.hasNextPage())) {
      exhausted = true;
      break;
    }
    await driver.clickNextPage();
  }

  if (!exhausted) {
    throw new Error(`Favorites paginator still offered more pages after ${MAX_PAGES} — refusing a truncated list`);
  }

  const favorites = [...byKey.values()];
  if (rowsSeen === 0) {
    throw new Error("Read no picker rows at all — the saved list never rendered; refusing to publish an empty list");
  }
  if (favorites.length === 0) {
    throw new Error(
      `Read ${rowsSeen} picker row(s) but parsed none — the picker markup changed; refusing to publish an empty list`,
    );
  }
  return favorites;
}

// ── selecting a favorite at transfer time ──────────────────────────────────
// Same picker, read the other way round: transfer-other-flow.ts matches the
// intended payee against the rendered rows and refuses anything but exactly
// one hit. Kept here so both directions share one description of the picker.

export interface FavoriteRowCriteria {
  /** KBIZ Display Name; must appear in the row. */
  nickname: string;
  /** Destination bank, matched case-insensitively as a substring. */
  bank: string;
  /** Full account number, when the caller has one (the payee-book path). */
  accountNo?: string;
  /** Last 4 digits, when it doesn't — a synced favorite carries only these. */
  accountLast4?: string;
}

// An account renders as "100-0-00739-4" / "020-4-00000-339"; a token of 8+
// digits is the only thing in a picker row that can be an account number.
const ACCOUNT_TOKEN_RE = /\d[\d-]{6,}\d/g;

/** Does this row render an account number whose digits end with `last4`? */
export function rowHasAccountEndingWith(text: string, last4: string): boolean {
  const want = digitsOnly(last4);
  if (want.length !== 4) return false;
  for (const token of text.match(ACCOUNT_TOKEN_RE) ?? []) {
    const d = digitsOnly(token);
    if (d.length >= 8 && d.endsWith(want)) return true;
  }
  return false;
}

/**
 * Indices of the picker rows matching ALL THREE of nickname, bank, and the
 * account verifier — the full number when we have it, otherwise an account
 * token ending in the synced last 4. The caller requires EXACTLY ONE: a
 * mis-keyed verifier can then never misroute money, it can only fail to find
 * its row.
 *
 * Rows arrive as innerText, so the hidden CELLS of a double-rendered row drop
 * out on their own. A whole hidden ROW does NOT: per the HTML spec innerText
 * falls back to textContent for an element that is not being rendered, so a
 * hidden copy of a row reads as a full match. Deduping that is
 * decideFavoriteSelection's job, not this function's — this one only reports
 * which rows matched, and reports every one of them.
 */
export function matchFavoriteRows(rowTexts: string[], criteria: FavoriteRowCriteria): number[] {
  const bankRe = bankPattern(criteria.bank);
  const acctD = criteria.accountNo ? digitsOnly(criteria.accountNo) : "";
  const out: number[] = [];

  rowTexts.forEach((raw, i) => {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t || !t.includes(criteria.nickname) || !bankRe.test(t)) return;
    const accountOk = criteria.accountNo
      ? t.includes(criteria.accountNo) || (!!acctD && t.includes(acctD))
      : !!criteria.accountLast4 && rowHasAccountEndingWith(t, criteria.accountLast4);
    if (accountOk) out.push(i);
  });

  return out;
}

// ── deciding WHICH row to click, across the WHOLE paginated picker ──────────
/**
 * THE PICKER PAGINATES AT TEN ROWS PER PAGE. Pinned by the operator's devtools
 * capture of 2026-08-19 (test/fixtures/kbiz-payee-picker.dom.html): the footer
 * reads "บัญชีที่ 1-10 จาก 14 บัญชี" — 14 saved accounts over 2 pages, with a
 * `pagination-template > ul.paginations > li > a.pointer` paginator.
 *
 * So "read div.lists once and match" only ever sees PAGE ONE. The saved
 * account a ฿1 test transfer wants sorts to roughly row 11 of 13 — page 2 —
 * and every step of the picker's search box was best-effort
 * (`.catch(() => {})`), so a search that silently failed to filter left the
 * target STRUCTURALLY UNREACHABLE and the flow refusing with "expected exactly
 * one matching saved account, found 0". (Since 2026-08-26 the driver does not
 * search at all — it walks the unfiltered book; see assertPickerUnfiltered in
 * transfer-other-flow.ts for why a filter can hide a collision.)
 *
 * This is the pure half of the fix: the driver (transfer-other-flow.ts) walks
 * the paginator the way collectFavorites already does and hands over one scan
 * per page; the decision is taken ONCE, over everything scanned.
 *
 * The rule does not soften: EXACTLY ONE destination across every scanned page,
 * or refuse. Ambiguity spanning two pages refuses exactly like ambiguity on
 * one — which is strictly SAFER than the old single-page read, since that read
 * could see one of two colliding rows, call it unique and click it.
 */

/** The rows of ONE picker page, as innerText, in DOM order. */
export interface FavoritePageScan {
  /** 1-based picker page these rows were read from. */
  page: number;
  /** `innerText` of every row on that page (empty strings included: index = row index). */
  rowTexts: string[];
}

/** One triple-verified row, located well enough to be clicked again. */
export interface FavoriteRowHit {
  /** Picker page it was found on. */
  page: number;
  /** Its index within that page's rows. */
  rowIndex: number;
  /**
   * Identity of the ACCOUNT this row addresses: every 8+-digit account token
   * in the row, deduped and sorted.
   *
   * FULL DIGITS — internal only. This never goes into a log line, an Error
   * message, a screenshot name or the queue file: masking is
   * transfer-other-flow.ts's `maskAccount`, and `destinationCount` below is
   * what messages are allowed to say about it.
   */
  destinationKey: string;
}

export interface FavoriteSelectionDecision {
  /** "one" ⇒ target is set and safe to click. Anything else ⇒ the caller refuses. */
  outcome: "one" | "none" | "ambiguous";
  /** The row to click. Present ONLY for outcome "one". */
  target?: FavoriteRowHit;
  /** Every matching row, all pages — more than one of these can be ONE account. */
  hits: FavoriteRowHit[];
  /** How many DISTINCT destination accounts matched. This is the number that decides. */
  destinationCount: number;
  rowsScanned: number;
  pagesScanned: number;
}

/**
 * The account this row addresses, as a dedupe identity.
 *
 * WHY A KEY AND NOT A ROW COUNT: kbiz-bot/CLAUDE.md — "every row rendered
 * twice (dedupe)". A picker row exists in the DOM more than once (the desktop
 * `hidden-ip-pro` / iPad `visible-ip-pro` variants, plus Magnific Popup's
 * hidden source template of the whole block), and a page that fails to turn
 * re-reads the rows it just read. Counting ROWS would turn one real account
 * into two "matches" and manufacture an ambiguity refusal that blocks a
 * perfectly unambiguous transfer. Counting ACCOUNTS cannot.
 *
 * The digits are the whole key on purpose: two saved rows differing only in
 * Display Name send money to the same place, so they are ONE destination —
 * while two accounts colliding on their last 4 digits (the very thing a masked
 * favorite verifies against) stay TWO, and refuse.
 *
 * Returns "" for a row carrying no recognizable account token; the caller
 * turns that into a per-row unique key, so an unidentifiable row can never
 * collapse into another one.
 */
export function accountKeyForRow(text: string): string {
  const seen = new Set<string>();
  for (const token of text.match(ACCOUNT_TOKEN_RE) ?? []) {
    const d = digitsOnly(token);
    if (d.length >= 8) seen.add(d);
  }
  return [...seen].sort().join(",");
}

/**
 * Decide over every page scanned: exactly one destination, or refuse.
 *
 * Pure — the driver does the walking (playwright) and this does the deciding,
 * the same split collectFavorites/FavoritesDriver already uses, so root
 * `bun test` can pin the money rule with no browser in sight.
 */
export function decideFavoriteSelection(
  scans: FavoritePageScan[],
  criteria: FavoriteRowCriteria,
): FavoriteSelectionDecision {
  const hits: FavoriteRowHit[] = [];
  let rowsScanned = 0;

  for (const scan of scans) {
    rowsScanned += scan.rowTexts.length;
    for (const rowIndex of matchFavoriteRows(scan.rowTexts, criteria)) {
      const key = accountKeyForRow(scan.rowTexts[rowIndex] ?? "");
      hits.push({
        page: scan.page,
        rowIndex,
        // No readable account token ⇒ a key nothing else can equal, so this
        // row is never deduped INTO another account's group. It can only add
        // ambiguity (refuse), never resolve it.
        destinationKey: key || `unidentified:p${scan.page}:r${rowIndex}`,
      });
    }
  }

  // First hit of each distinct account wins the click — earliest page, then
  // earliest row, because `scans` and `matchFavoriteRows` are both in order.
  const byDestination = new Map<string, FavoriteRowHit>();
  for (const hit of hits) if (!byDestination.has(hit.destinationKey)) byDestination.set(hit.destinationKey, hit);

  const destinationCount = byDestination.size;
  const outcome: FavoriteSelectionDecision["outcome"] =
    destinationCount === 1 ? "one" : destinationCount === 0 ? "none" : "ambiguous";

  return {
    outcome,
    target: outcome === "one" ? [...byDestination.values()][0] : undefined,
    hits,
    destinationCount,
    rowsScanned,
    pagesScanned: scans.length,
  };
}
