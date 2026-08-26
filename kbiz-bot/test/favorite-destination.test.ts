// The "favorite" destination path, end to end across every PURE layer it
// touches — the thinnest-tested of the three kinds (all 9 production transfers
// to date went through kind:"handle"), and the only one that addresses money
// by a masked last-4 instead of a full account number.
//
// The scenario is the operator's own KBIZ saved account, because that is the
// row a `favorite` transfer will actually select first and because its
// nickname is a genuine Thai substring hazard: "วิณัฐ สาขาสุราษ" is a PREFIX
// of the longer province spelling ("...สุราษฎร์ธานี"), and matchFavoriteRows
// gates on `t.includes(nickname)` — a substring test, not an identity test.
//
// WHAT IS REAL HERE, AND WHY THAT IS ALLOWED: nickname + bank + last-4 +
// account name of the operator's own row. Those four fields are exactly what
// the masked contract already publishes (queue/kbiz-favorites.json carries
// accountLast4/accountMasked and NO full number, by design — see
// favorites-core.ts's "MASKED BY CONTRACT"), so pinning them costs nothing a
// reader of the manifest does not already have.
//
// WHAT IS INVENTED: every account number below (the leading digits carry no
// information — only the trailing 1627 is real, and 999-8-… is a deliberately
// impossible Kasikorn prefix), and every SIBLING row. The real picker's other
// payees are bank data and stay out of this repo, exactly as
// scrape-favorites.test.ts says. The siblings reproduce the STRUCTURE that
// makes the live list hazardous rather than its contents: 7 of the 13 synced
// favorites are Kasikorn rows, so "the bank" disambiguates almost nothing and
// the nickname + last-4 pair carries the whole verification load.
//
// Run with `bun test` (from the repo root too — nothing here imports
// playwright; the flow half is pinned as source text at the bottom).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
  accountKeyForRow,
  bankPattern,
  decideFavoriteSelection,
  matchFavoriteRows,
  MAX_PICKER_PAGES,
  rowHasAccountEndingWith,
  type FavoritePageScan,
} from "../src/lib/favorites-core";
import {
  describeDestination,
  destinationSignature,
  parseDestination,
  resolveQueuePayee,
} from "../src/lib/transfer-other-queue";
import type { TransferConfig } from "../src/lib/transfer-config";

// ── the operator's row, as the masked contract knows it ─────────────────────

const OP = {
  nickname: "วิณัฐ สาขาสุราษ",
  bank: "ธนาคารกสิกรไทย",
  accountLast4: "1627",
  accountName: "นาย วิณัฐ จิรฤกษ์มงคล",
} as const;

/**
 * One picker row as innerText, in the Thai labelling the live session renders
 * (the bot logs in with lang=th since 2026-08-12). Labels are included on
 * purpose: matchFavoriteRows sees the WHOLE row text, labels and all, which is
 * why "does the nickname appear in this row" is a weaker question than "is
 * this row's Display Name the nickname".
 */
const rowText = (nickname: string, accountName: string, bank: string, accountNo: string) =>
  ["ชื่อย่อบัญชี", nickname, "ชื่อบัญชี", accountName, "ธนาคาร", bank, "เลขบัญชี", accountNo].join("\n");

/** The operator's row. Only the trailing 1627 is real. */
const OP_ROW = rowText(OP.nickname, OP.accountName, OP.bank, "999-8-77162-7");

/**
 * A realistic page of the picker: the operator's row among invented siblings,
 * keeping the live list's shape (Kasikorn dominant, plus the empty innerText
 * of every row's hidden viewport twin).
 */
const PAGE = [
  rowText("ร้านวัสดุ", "MR. TESTTWO SAMPLE", "ธนาคารกสิกรไทย", "111-2-34567-8"),
  rowText("พี่วิว", "MS. TESTONE SAMPLE", "ธนาคารไทยพาณิชย์", "222-3-45678-9"),
  OP_ROW,
  rowText("แม่บ้าน A", "MS. TESTTHREE SAMPLE", "ธนาคารกสิกรไทย", "333-4-56789-0"),
  "", // the hidden half of a double-rendered row: innerText gives nothing
  rowText("ช่างไฟ", "MR. TESTFOUR SAMPLE", "ธนาคารกสิกรไทย", "444-5-67890-1"),
  rowText("Guide HF", "MS. TESTFIVE SAMPLE", "ธนาคารกรุงศรีอยุธยา", "555-6-78901-2"),
  rowText("ร้าน 47", "MR. TESTSIX SAMPLE", "ธนาคารกสิกรไทย", "666-7-89012-3"),
];

const OP_INDEX = PAGE.indexOf(OP_ROW);

/** The criteria the flow builds from a kind:"favorite" destination. */
const opCriteria = { nickname: OP.nickname, bank: OP.bank, accountLast4: OP.accountLast4 };

// ── (a) exact resolution ───────────────────────────────────────────────────

describe("favorite → the operator's saved row resolves to exactly one index", () => {
  it("matches on nickname + bank + last 4, and only that row", () => {
    expect(matchFavoriteRows(PAGE, opCriteria)).toEqual([OP_INDEX]);
  });

  it("neither criterion alone would have picked it — the pair is load-bearing", () => {
    // The bank is nearly useless on this operator's list: 5 of the 7 rendered
    // rows here are Kasikorn (7 of 13 in the live synced set).
    const kasikorn = PAGE.filter((t) => t && bankPattern(OP.bank).test(t));
    expect(kasikorn.length).toBeGreaterThan(1);
    // And the last-4 alone is not addressed to anyone: it takes the nickname
    // to name a payee at all.
    expect(PAGE.filter((t) => rowHasAccountEndingWith(t, OP.accountLast4))).toEqual([OP_ROW]);
  });

  it("the Thai bank name in the manifest matches the Thai bank name on the page", () => {
    // The synced favorite carries "ธนาคารกสิกรไทย"; aliasesForBank has to
    // recognize it through the "กสิกร" stem, or every favorite transfer to a
    // Kasikorn account fails to find its row.
    expect(bankPattern(OP.bank).test(OP_ROW)).toBe(true);
    // …and an EN-spelled intent for the same bank still finds the Thai row.
    expect(matchFavoriteRows(PAGE, { ...opCriteria, bank: "Kasikornbank" })).toEqual([OP_INDEX]);
  });

  it("survives the picker's own whitespace: innerText is normalized before matching", () => {
    // KBIZ renders each cell in its own <p>, so innerText arrives newline- and
    // sometimes double-space-separated. The nickname's internal space must not
    // be what breaks the match.
    const wideRow = OP_ROW.replace(/\n/g, "  \n ");
    expect(matchFavoriteRows([wideRow], opCriteria)).toEqual([0]);
  });
});

// ── (b) the Thai substring hazard, asserted as IMPLEMENTED ─────────────────

describe("nickname is a SUBSTRING test, not an identity test", () => {
  it("FORGIVING DIRECTION: the synced nickname is a prefix of the rendered one → still matches", () => {
    // "วิณัฐ สาขาสุราษ" is a prefix of the full province spelling. If KBIZ
    // ever renders the longer form (or stops truncating it), the manifest's
    // shorter nickname keeps matching — deliberate, and the reason the
    // substring semantics is the right default.
    const longer = rowText(OP.nickname + "ฎร์ธานี", OP.accountName, OP.bank, "999-8-77162-7");
    expect(matchFavoriteRows([longer], opCriteria)).toEqual([0]);
  });

  it("STRICT DIRECTION: a nickname LONGER than the row's renders no match", () => {
    // Same asymmetry, the other way: an intent carrying the long spelling can
    // never select the row that renders the short one. It fails to find, which
    // is the safe failure — it does not fall back to the bank + last-4 pair.
    const shortRow = rowText("วิณัฐ", OP.accountName, OP.bank, "999-8-77162-7");
    expect(matchFavoriteRows([shortRow], { ...opCriteria, nickname: OP.nickname + "ฎร์ธานี" })).toEqual([]);
    expect(matchFavoriteRows([shortRow], { ...opCriteria, nickname: "วิณัฐ" })).toEqual([0]);
  });

  it("the nickname is matched against the WHOLE row, so the Account Name cell can satisfy it", () => {
    // A row whose Display Name is unrelated but whose Account Name carries the
    // person's name passes the nickname gate. This is real, implemented
    // behavior — assert it rather than pretend the gate is per-cell.
    const byAccountName = rowText("บัญชีสำรอง", OP.accountName, OP.bank, "999-8-77133-9");
    expect(byAccountName.includes("วิณัฐ")).toBe(true);
    expect(matchFavoriteRows([byAccountName], { ...opCriteria, nickname: "วิณัฐ" })).toEqual([]);
    //                                     ↑ no match, and the ONLY reason is
    // the last-4 verifier: the nickname gate let this row through.
    expect(bankPattern(OP.bank).test(byAccountName)).toBe(true);
    expect(rowHasAccountEndingWith(byAccountName, OP.accountLast4)).toBe(false);
  });

  it("a DIFFERENT account of the SAME person never matches", () => {
    // Same human, same bank, same nickname prefix, different account: the
    // last-4 is the whole defence and it holds.
    const secondAccount = rowText(OP.nickname + " 2", OP.accountName, OP.bank, "999-8-77133-9");
    expect(matchFavoriteRows([OP_ROW, secondAccount], opCriteria)).toEqual([0]);
  });
});

// ── (c) near misses fail closed ────────────────────────────────────────────

describe("a near-miss favorite finds nothing rather than something", () => {
  it("wrong bank (SCB intent against the Kasikorn row) → no match", () => {
    expect(matchFavoriteRows(PAGE, { ...opCriteria, bank: "ธนาคารไทยพาณิชย์" })).toEqual([]);
    expect(matchFavoriteRows(PAGE, { ...opCriteria, bank: "Siam Commercial" })).toEqual([]);
  });

  it("the Kasikorn ↔ SCB pair never cross-matches in either language", () => {
    expect(bankPattern("ธนาคารกสิกรไทย").test("ธนาคารไทยพาณิชย์")).toBe(false);
    expect(bankPattern("ธนาคารไทยพาณิชย์").test("ธนาคารกสิกรไทย")).toBe(false);
  });

  it("wrong last 4 → no match, including a transposition of the right one", () => {
    expect(matchFavoriteRows(PAGE, { ...opCriteria, accountLast4: "9999" })).toEqual([]);
    expect(matchFavoriteRows(PAGE, { ...opCriteria, accountLast4: "1672" })).toEqual([]); // 27 → 72
    expect(matchFavoriteRows(PAGE, { ...opCriteria, accountLast4: "162" })).toEqual([]); // short verifier verifies nothing
  });

  it("right nickname + right bank, but the last 4 of ANOTHER row's account → no match", () => {
    // 3456 is the sibling "ร้านวัสดุ" row's account, also Kasikorn. Borrowing
    // it must not select the operator's row, and must not select the sibling
    // either (its nickname is not the operator's).
    expect(matchFavoriteRows(PAGE, { ...opCriteria, accountLast4: "3456" })).toEqual([]);
  });

  it("no verifier at all → no match, never 'the row whose nickname fits'", () => {
    expect(matchFavoriteRows(PAGE, { nickname: OP.nickname, bank: OP.bank })).toEqual([]);
  });

  it("an empty nickname does NOT degrade to bank + last-4 (the flow refuses before this, belt and braces)", () => {
    // "".includes → every row passes the nickname gate, so this criteria set
    // reduces to bank + verifier and DOES return the operator's row. That is
    // exactly why selectFavoritePayee refuses an empty nickname before it ever
    // opens the picker — pinned as source text below.
    expect(matchFavoriteRows(PAGE, { nickname: "", bank: OP.bank, accountLast4: OP.accountLast4 })).toEqual([OP_INDEX]);
  });
});

// ── (d) ambiguity → more than one index, and the caller must refuse ────────

describe("ambiguity is reported, never resolved", () => {
  it("the same account saved twice (one nickname containing the other) → BOTH indices", () => {
    // The realistic way this happens on a KBIZ list: the payee is saved once,
    // then saved again with a longer Display Name. Both rows satisfy
    // nickname + bank + last-4, so there is no correct row to click.
    const dupe = rowText(OP.nickname + "ฎร์ธานี", OP.accountName, OP.bank, "999-8-77162-7");
    const rows = [OP_ROW, dupe];
    expect(matchFavoriteRows(rows, opCriteria)).toEqual([0, 1]);
  });

  it("two DIFFERENT accounts colliding on the last 4 → BOTH indices (last-4 cannot disambiguate)", () => {
    const collision = rowText(OP.nickname, OP.accountName, OP.bank, "123-4-56162-7");
    expect(matchFavoriteRows([OP_ROW, collision], opCriteria).length).toBe(2);
  });

  it("the two rows are genuinely different accounts — the ambiguity is real, not a fixture artifact", () => {
    const collision = rowText(OP.nickname, OP.accountName, OP.bank, "123-4-56162-7");
    expect(collision).not.toBe(OP_ROW);
    expect(rowHasAccountEndingWith(OP_ROW, OP.accountLast4)).toBe(true);
    expect(rowHasAccountEndingWith(collision, OP.accountLast4)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (d2) THE PICKER PAGINATES — the whole-list decision.
//
// Everything above scans ONE page, which is exactly what selectFavoritePayee
// used to do. The operator's devtools capture of 2026-08-19
// (test/fixtures/kbiz-payee-picker.dom.html) proves the picker pages at TEN
// rows: "บัญชีที่ 1-10 จาก 14 บัญชี", 2 pages. The ฿1 test destination sorts
// to ~row 11, so page 1 does not contain it — and the picker's search box,
// which the flow typed into as a best-effort narrowing until 2026-08-26,
// silently failed to filter, leaving the row unreachable. The search is gone
// from the flow now (review case D2): the book is walked unfiltered.
//
// The rows below mirror the fixture exactly (same placeholder book, same
// order), so the pure decision and the browser probe are describing one
// scenario. Every account number is INVENTED.
// ───────────────────────────────────────────────────────────────────────────

const PICKER_PAGE_SIZE = 10;

/** The ฿1 test destination, as the masked contract would carry it. */
const T = {
  nickname: "ทดสอบ โอนหนึ่งบาท",
  accountName: "MR. TEST PAYEE",
  bank: "ธนาคารกสิกรไทย",
  accountNo: "111-1-11111-7",
  accountLast4: "1117",
} as const;

const TARGET_ROW = rowText(T.nickname, T.accountName, T.bank, T.accountNo);

/** The fixture's 14-account book: the target is #11, i.e. the first row of page 2. */
const BOOK: string[] = [
  rowText("ร้านวัสดุ ก่อสร้าง", "MR. SAMPLE ONE", "ธนาคารกสิกรไทย", "100-1-00001-1"),
  rowText("พี่วิว", "MS. SAMPLE TWO", "ธนาคารไทยพาณิชย์", "100-2-00002-2"),
  rowText("แม่บ้าน เอ", "MS. SAMPLE THREE", "ธนาคารกสิกรไทย", "100-3-00003-3"),
  rowText("ช่างไฟ บี", "MR. SAMPLE FOUR", "ธนาคารกสิกรไทย", "100-4-00004-4"),
  rowText("Guide HF", "MS. SAMPLE FIVE", "ธนาคารกรุงศรีอยุธยา", "100-5-00005-5"),
  rowText("ร้าน 47", "MR. SAMPLE SIX", "ธนาคารกสิกรไทย", "100-6-00006-6"),
  rowText("ซัพพลายเออร์ ผ้า", "MS. SAMPLE SEVEN", "ธนาคารกรุงเทพ", "100-7-00007-7"),
  rowText("ร้านซ่อมแอร์", "MR. SAMPLE EIGHT", "ธนาคารกสิกรไทย", "100-8-00008-8"),
  rowText("คนสวน", "MR. SAMPLE NINE", "ธนาคารกสิกรไทย", "100-9-00009-9"),
  rowText("ครัวกลาง", "MS. SAMPLE TEN", "ธนาคารกสิกรไทย", "101-0-00010-0"),
  TARGET_ROW, // #11 → page 2
  rowText("แม่บ้าน ซี", "MS. SAMPLE TWELVE", "ธนาคารกสิกรไทย", "101-2-00012-2"),
  rowText("ร้านเครื่องเขียน", "MR. SAMPLE THIRTEEN", "ธนาคารทหารไทยธนชาต", "101-3-00013-3"),
  rowText("ค่าขนส่ง เจ", "MS. SAMPLE FOURTEEN", "ธนาคารกสิกรไทย", "101-4-00014-4"),
];

/** What the driver hands the decision: one scan per page it walked. */
const paginate = (rows: string[]): FavoritePageScan[] =>
  Array.from({ length: Math.max(1, Math.ceil(rows.length / PICKER_PAGE_SIZE)) }, (_, i) => ({
    page: i + 1,
    rowTexts: rows.slice(i * PICKER_PAGE_SIZE, (i + 1) * PICKER_PAGE_SIZE),
  }));

const tCriteria = { nickname: T.nickname, bank: T.bank, accountLast4: T.accountLast4 };

describe("the picker paginates — page 1 is not the list", () => {
  const pages = paginate(BOOK);

  it("the book really does span two pages, with the target on the second", () => {
    expect(pages.length).toBe(2);
    expect(pages[0].rowTexts.length).toBe(10);
    expect(pages[1].rowTexts[0]).toBe(TARGET_ROW);
  });

  it("THE DEFECT, in one assertion: scanning page 1 alone finds nothing at all", () => {
    // This is what the old selectFavoritePayee did — one read of div.lists.
    expect(matchFavoriteRows(pages[0].rowTexts, tCriteria)).toEqual([]);
    const pageOneOnly = decideFavoriteSelection([pages[0]], tCriteria);
    expect(pageOneOnly.outcome).toBe("none");
    expect(pageOneOnly.target).toBeUndefined();
  });

  it("walking both pages finds exactly one destination and names the row to click", () => {
    const d = decideFavoriteSelection(pages, tCriteria);
    expect(d.outcome).toBe("one");
    expect(d.destinationCount).toBe(1);
    expect(d.target).toEqual({ page: 2, rowIndex: 0, destinationKey: "1111111117" });
    expect(d.rowsScanned).toBe(14);
    expect(d.pagesScanned).toBe(2);
  });

  it("a one-page book holding only the row reaches the same decision", () => {
    // The decision does not care how many pages the book has — one page, one
    // row, same outcome. (This used to describe a WORKING search filter; the
    // flow no longer searches, but the pure rule is unchanged.)
    const filtered = decideFavoriteSelection([{ page: 1, rowTexts: [TARGET_ROW] }], tCriteria);
    expect(filtered.outcome).toBe("one");
    expect(filtered.target).toEqual({ page: 1, rowIndex: 0, destinationKey: "1111111117" });
  });

  it("a target that is not saved at all still refuses, having scanned every page", () => {
    const without = BOOK.filter((r) => r !== TARGET_ROW);
    const d = decideFavoriteSelection(paginate(without), tCriteria);
    expect(d.outcome).toBe("none");
    expect(d.destinationCount).toBe(0);
    expect(d.hits).toEqual([]);
    expect(d.rowsScanned).toBe(13);
  });

  it("ambiguity SPANNING two pages refuses exactly like ambiguity on one", () => {
    // A different account (2222221117) whose last 4 collide with the target's,
    // same bank, Display Name the target's nickname is a prefix of — on PAGE 1
    // while the target sits on page 2. The old single-page read saw this row
    // alone, called it unique, and would have clicked it: a misroute, and the
    // To-field check could not catch it (the last 4 match by construction).
    const collision = rowText(`${T.nickname} (สำรอง)`, "MR. TEST PAYEE TWO", T.bank, "222-2-22111-7");
    const rows = [...BOOK];
    rows[4] = collision;
    const pagesWithCollision = paginate(rows);

    expect(matchFavoriteRows(pagesWithCollision[0].rowTexts, tCriteria).length).toBe(1); // the trap
    const d = decideFavoriteSelection(pagesWithCollision, tCriteria);
    expect(d.outcome).toBe("ambiguous");
    expect(d.destinationCount).toBe(2);
    expect(d.target).toBeUndefined();
    expect(d.hits.map((h) => h.page)).toEqual([1, 2]);
  });

  it("the decision never resolves ambiguity by order — 'first match wins' is not reachable", () => {
    const collision = rowText(`${T.nickname} (สำรอง)`, "MR. TEST PAYEE TWO", T.bank, "222-2-22111-7");
    // Either order, either page: two accounts is two accounts.
    for (const rows of [[TARGET_ROW, collision], [collision, TARGET_ROW]]) {
      expect(decideFavoriteSelection([{ page: 1, rowTexts: rows }], tCriteria).outcome).toBe("ambiguous");
      expect(
        decideFavoriteSelection(
          [{ page: 1, rowTexts: [rows[0]] }, { page: 2, rowTexts: [rows[1]] }],
          tCriteria,
        ).outcome,
      ).toBe("ambiguous");
    }
  });

  it("is bounded by the same page ceiling as the read-only scrape", () => {
    expect(MAX_PICKER_PAGES).toBe(40);
    const core = readFileSync(fileURLToPath(new URL("../src/lib/favorites-core.ts", import.meta.url)), "utf8");
    // collectFavorites' own bound IS this constant, not a second literal.
    expect(core).toMatch(/const MAX_PAGES = MAX_PICKER_PAGES;/);
  });
});

// ── (d3) one real account can never become two "matches" ───────────────────
// kbiz-bot/CLAUDE.md: "every row rendered twice (dedupe)". Accumulating rows
// across pages multiplies that hazard — and a false ambiguity refusal blocks a
// transfer that was never ambiguous.

describe("duplicate-rendered rows are one destination, not an ambiguity", () => {
  it("the same row read twice on one page counts once", () => {
    const d = decideFavoriteSelection([{ page: 1, rowTexts: [TARGET_ROW, TARGET_ROW] }], tCriteria);
    expect(d.hits.length).toBe(2); // both rows matched…
    expect(d.destinationCount).toBe(1); // …and both are the same account
    expect(d.outcome).toBe("one");
    expect(d.target).toEqual({ page: 1, rowIndex: 0, destinationKey: "1111111117" });
  });

  it("a page that failed to turn (the same rows scanned twice) does not manufacture ambiguity", () => {
    const pages = paginate(BOOK);
    const d = decideFavoriteSelection([...pages, pages[1]], tCriteria);
    expect(d.pagesScanned).toBe(3);
    expect(d.hits.length).toBe(2);
    expect(d.outcome).toBe("one");
  });

  it("the same account saved twice under two Display Names is still ONE destination", () => {
    // Both rows send money to the same account, so there is no ambiguity about
    // where it goes — only about which row to click, and either is correct.
    const secondSaving = rowText(`${T.nickname} สำรอง`, T.accountName, T.bank, T.accountNo);
    const d = decideFavoriteSelection([{ page: 2, rowTexts: [TARGET_ROW, secondSaving] }], tCriteria);
    expect(d.destinationCount).toBe(1);
    expect(d.outcome).toBe("one");
    // Both hits are kept, so the driver can skip one whose link is not
    // clickable (a hidden duplicate render) and click the other.
    expect(d.hits.map((h) => h.rowIndex)).toEqual([0, 1]);
    expect(new Set(d.hits.map((h) => h.destinationKey)).size).toBe(1);
  });

  it("dedupe is by ACCOUNT, so two accounts sharing the last 4 stay two", () => {
    const collision = rowText(T.nickname, T.accountName, T.bank, "123-4-51111-7");
    expect(rowHasAccountEndingWith(collision, T.accountLast4)).toBe(true);
    expect(accountKeyForRow(collision)).not.toBe(accountKeyForRow(TARGET_ROW));
    expect(decideFavoriteSelection([{ page: 1, rowTexts: [TARGET_ROW, collision] }], tCriteria).outcome).toBe(
      "ambiguous",
    );
  });

  it("accountKeyForRow keys on the digits, ignoring formatting and repeated cells", () => {
    expect(accountKeyForRow(TARGET_ROW)).toBe("1111111117");
    // The desktop and iPad halves of one row repeat the number; still one key.
    expect(accountKeyForRow(`${TARGET_ROW}\n${T.accountNo}`)).toBe("1111111117");
    // Dashes are not part of the identity.
    expect(accountKeyForRow(rowText(T.nickname, T.accountName, T.bank, "1111111117"))).toBe("1111111117");
  });

  it("a row with no readable account token can only ADD ambiguity, never resolve it", () => {
    // No 8+-digit token ⇒ no identity ⇒ a key nothing can dedupe into. Only
    // reachable on the full-number path (a last-4 verifier needs a token), and
    // fail-closed by construction: two such rows refuse even though they may
    // well be the same account, because nothing here can prove that they are.
    const spaced = "111 1 11111 7";
    const noToken = rowText(T.nickname, T.accountName, T.bank, spaced);
    const criteria = { nickname: T.nickname, bank: T.bank, accountNo: spaced };
    expect(accountKeyForRow(noToken)).toBe("");

    const one = decideFavoriteSelection([{ page: 1, rowTexts: [noToken] }], criteria);
    expect(one.outcome).toBe("one");
    expect(one.target?.destinationKey).toBe("unidentified:p1:r0");

    const twin = rowText(`${T.nickname} สำรอง`, T.accountName, T.bank, spaced);
    const both = decideFavoriteSelection([{ page: 1, rowTexts: [noToken] }, { page: 2, rowTexts: [twin] }], criteria);
    expect(both.destinationCount).toBe(2);
    expect(both.outcome).toBe("ambiguous");
    expect(both.hits.map((h) => h.destinationKey)).toEqual(["unidentified:p1:r0", "unidentified:p2:r0"]);
  });
});

// ── the captured fixture the browser probe drives ──────────────────────────

describe("test/fixtures/kbiz-payee-picker.dom.html — provenance, scrub, selectors", () => {
  const fixture = readFileSync(
    fileURLToPath(new URL("./fixtures/kbiz-payee-picker.dom.html", import.meta.url)),
    "utf8",
  );

  it("keeps the capture's own facts: ten rows a page, 14 accounts, 2 pages", () => {
    expect(fixture).toContain("บัญชีที่ 1-10 จาก 14 บัญชี");
    expect(fixture).toMatch(/PAGE_SIZE = 10/);
    expect(fixture).toContain("2026-08-19");
    expect(fixture).toContain("SCRUBBED");
  });

  it("keeps the selectors the flow depends on", () => {
    for (const sel of [
      "div class=\"lists\"", // rows
      "c-bold c-green pointer", // the account link that SELECTS the payee
      "pagination-template", // the paginator
      "input-search-acc", // the icon that opens the picker
      'name="accountTo"', // the field the selection must fill
      "hidden-ip-pro", // the double-render classes
      "visible-ip-pro",
    ]) {
      expect(fixture).toContain(sel);
    }
  });

  it("keeps the search box the flow must NEVER type into (it is read, to refuse a pre-applied filter)", () => {
    // The capture has a working search box; the flow deliberately ignores it
    // (review case D2 — see assertPickerUnfiltered in the flow). The fixture
    // keeps it so the probe can prove the flow never touches it.
    expect(fixture).toContain('name="acctSearch"');
    expect(fixture).toContain('id="search-acct-to-btn"');
  });

  it("carries no real bank data — every account-shaped token is a placeholder", () => {
    // Guardrail: real payee numbers live only in transfer-other.config.json on
    // evergreen. If someone ever pastes a live capture in here verbatim, this
    // fails instead of committing it.
    const tokens = fixture.match(/\d[\d-]{6,}\d/g) ?? [];
    expect(tokens.length).toBeGreaterThan(10);
    for (const token of tokens) {
      expect(token).toMatch(/^(?:10[01]-\d-\d{5}-\d|111-1-11111-7|222-2-22111-7|\d{4}-\d{2}-\d{2})$/);
    }
  });
});

// ── the queue-item half: destination → Payee, with no number to leak ───────

describe("kind:'favorite' becomes a Payee that carries no account number", () => {
  // A payee book that DOES hold a full number, so "the favorite path leaked no
  // number" is a real claim about the favorite branch and not an artifact of an
  // empty config. (Invented handle + number; the production book holds exactly
  // one recipient and it is not the operator.)
  const config: TransferConfig = {
    maxTransfer: 50_000,
    recipients: {
      revew: { mode: "favorite", nickname: "พี่วิว", accountNo: "222-3-45678-9", bank: "Siam Commercial Bank" },
    },
  };

  const intent = {
    id: "op-favorite-1",
    payee: { handle: "revew" },
    destination: { kind: "favorite", ...OP },
  };

  it("parseDestination keeps the four masked fields and nothing else", () => {
    expect(parseDestination(intent.destination, intent.id)).toEqual({
      kind: "favorite",
      nickname: OP.nickname,
      bank: OP.bank,
      accountLast4: OP.accountLast4,
      accountName: OP.accountName,
    });
  });

  it("resolveQueuePayee hands the flow the last 4 and NO accountNo", () => {
    const payee = resolveQueuePayee(intent, config);
    expect(payee).toEqual({
      mode: "favorite",
      nickname: OP.nickname,
      bank: OP.bank,
      accountLast4: OP.accountLast4,
      accountName: OP.accountName,
    });
    expect(payee.accountNo).toBeUndefined();
  });

  it("the destination WINS over payee.handle — a favorite never falls back to the book's full number", () => {
    // Both are present here. If the precedence ever inverted, this favorite
    // would silently become a handle transfer to a different bank and a
    // different account, with a full number in hand.
    const payee = resolveQueuePayee(intent, config);
    expect(payee.bank).toBe(OP.bank);
    expect(payee.accountNo).toBeUndefined();
    expect(JSON.stringify(payee)).not.toContain("45678");
  });

  it("the resolved Payee reproduces the criteria that matched the row — one unbroken chain", () => {
    const payee = resolveQueuePayee(intent, config);
    expect(
      matchFavoriteRows(PAGE, {
        nickname: payee.nickname ?? "",
        bank: payee.bank,
        accountNo: payee.accountNo,
        accountLast4: payee.accountLast4,
      }),
    ).toEqual([OP_INDEX]);
  });
});

// ── (e) nothing wider than a last-4 is ever rendered ──────────────────────

describe("a favorite is never described with more than its last 4 digits", () => {
  const dest = { kind: "favorite", ...OP };

  it("describeDestination names nickname + bank + …last4, and no longer digit run exists to print", () => {
    const line = describeDestination({ payee: null, destination: dest });
    expect(line).toBe(`favorite "${OP.nickname}" (${OP.bank} …${OP.accountLast4})`);
    // Nothing in the line is a longer number than the 4 permitted digits.
    expect(line).not.toMatch(/\d{5,}/);
    expect((line.match(/\d/g) ?? []).join("")).toBe(OP.accountLast4);
  });

  it("destinationSignature (duplicate detection) is masked to the same 4 digits", () => {
    const sig = destinationSignature({ destination: dest });
    expect(sig).toBe(`favorite:${OP.bank.toLowerCase()}:${OP.nickname}:${OP.accountLast4}`);
    expect(sig).not.toMatch(/\d{5,}/);
  });

  it("even a favorite carrying a stray full number cannot widen either renderer", () => {
    // parseDestination has no accountNo field for a favorite, so a picker bug
    // on reimbursement's side that attached one is dropped, not printed.
    const polluted = { kind: "favorite", ...OP, accountNo: "9998771627" };
    expect(describeDestination({ payee: null, destination: polluted })).not.toContain("9998771627");
    expect(destinationSignature({ destination: polluted })).not.toContain("9998771627");
    expect(parseDestination(polluted)).not.toHaveProperty("accountNo");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The CALLER's exactly-one rule lives in src/flows/transfer-other-flow.ts,
// which imports playwright for real and therefore cannot be imported here
// (root CI runs this file before kbiz-bot/node_modules exists). Read it as
// TEXT, the same way transfer-other-queue.test.ts pins process-queue.ts's
// wiring. These are the four refusals that stand between a mis-keyed favorite
// and a misrouted transfer.
// ───────────────────────────────────────────────────────────────────────────

describe("transfer-other-flow.ts wiring — the favorite path's refusals", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/flows/transfer-other-flow.ts", import.meta.url)), "utf8");
  const fn = src.slice(src.indexOf("async function selectFavoritePayee"), src.indexOf("async function selectCategory"));

  const GUARD = 'if (decision.outcome !== "one" || !decision.target)';

  it("EXACTLY ONE destination, or it throws — anything else refuses to click a row", () => {
    expect(fn).toContain(GUARD);
    const guard = fn.slice(fn.indexOf(GUARD));
    expect(guard).toContain("throw new Error(");
    expect(guard).toContain("Refusing to select");
    // The refusal must come BEFORE the click that selects the payee.
    expect(fn.indexOf(GUARD)).toBeLessThan(fn.indexOf("a.c-bold.c-green.pointer:visible"));
  });

  it("the decision is taken over EVERY page walked, after the walk, never per page", () => {
    // The walk accumulates scans; nothing inside the loop may select or refuse.
    expect(fn).toContain("const scans: FavoritePageScan[] = []");
    expect(fn).toContain("decideFavoriteSelection(scans, criteria)");
    const loopStart = fn.indexOf("for (;;) {");
    expect(loopStart).toBeGreaterThan(0);
    const loop = fn.slice(loopStart, fn.indexOf("decideFavoriteSelection(scans, criteria)"));
    expect(loop).not.toContain("throw new Error(");
    expect(loop).not.toContain(".click(");
    // …and the walk is bounded by the shared ceiling, not a fresh literal.
    expect(loop).toContain("scans.length >= MAX_PICKER_PAGES");
    expect(loop).toContain("goToPickerPage(page, next)");
  });

  it("walks the paginator with the same rules the read-only scrape uses", () => {
    const pager = src.slice(src.indexOf("async function goToPickerPage"), src.indexOf("* THE PICKER IS NEVER SEARCHED"));
    // whole-text-anchored numeric anchor (so "2" never matches "12")…
    expect(src).toContain("`^\\\\s*${n}\\\\s*$`");
    // …a real row swap, not a fixed sleep…
    expect(pager).toContain("pickerSignature(page)");
    expect(pager).toMatch(/if \(after && after !== before\)/);
    // …and it reports failure to the caller instead of paging blind.
    expect(pager).toContain("return false");
  });

  it("a walk that could not finish refuses instead of deciding on a partial list", () => {
    // "Exactly one across everything scanned" is only honest if everything WAS
    // scanned: a page the paginator advertised and never rendered could hold a
    // second account matching the same nickname + bank + last-4.
    expect(fn).toContain("if (pagingNote) {");
    const truncation = fn.slice(fn.indexOf("if (pagingNote) {"));
    expect(truncation).toContain("could not read the whole saved list");
    expect(truncation).toContain("Refusing to select");
    expect(fn.indexOf("if (pagingNote) {")).toBeLessThan(fn.indexOf("a.c-bold.c-green.pointer:visible"));
    // The two ways a walk ends short both set that note.
    expect(fn).toContain("pagingNote = `stopped after ${MAX_PICKER_PAGES} picker pages`");
    expect(fn).toContain("pagingNote = `picker page ${next} was offered but never rendered`");
  });

  it("re-reads the winning page and re-checks the SAME account before clicking", () => {
    expect(fn).toContain("goToPickerPage(page, decision.target.page)");
    expect(fn).toContain("landed.target.destinationKey !== decision.target.destinationKey");
    expect(fn.indexOf("landed.target.destinationKey !== decision.target.destinationKey")).toBeLessThan(
      fn.indexOf("a.c-bold.c-green.pointer:visible"),
    );
  });

  it("NEVER types into the picker's search box — the whole unfiltered book is walked instead", () => {
    // Review case D2 (2026-08-26): a search filter that returns a NON-EMPTY
    // list which excludes a second saved account colliding on nickname + bank
    // + last-4 would let the walk select the intended row without ever SEEING
    // the collision. The bank's search semantics are not ours to pin (the
    // live box matches account numbers), so the flow uses no filter at all.
    // Re-introducing the old best-effort search — or any typing — fails here.
    expect(src).not.toContain("searchPickerFor");
    expect(src).not.toContain("search-acct-to-btn");
    expect(src).not.toContain("picker search did not take");
    // The selection function's only writes to the page are the numeric
    // page-anchor clicks and the one account-link click on the verified row.
    for (const write of [".fill(", ".type(", ".pressSequentially(", ".press(", ".keyboard.", ".selectOption("]) {
      expect(fn).not.toContain(write);
    }
    // The guard runs where the search used to, BEFORE the walk starts.
    expect(fn).toContain("await assertPickerUnfiltered(page);");
    expect(fn.indexOf("await assertPickerUnfiltered(page);")).toBeLessThan(
      fn.indexOf("const scans: FavoritePageScan[] = []"),
    );
    // The per-page scan line still narrates the walk.
    expect(fn).toContain("console.log(\n      `   scanned ${rowTexts.length} saved rows on picker page ${current}, `");
  });

  it("the search box is only ever READ — a pre-applied filter REFUSES, it is never cleared by typing", () => {
    // A filter someone else left in the modal would make the rows on screen a
    // subset of the book, and a subset is not something to decide on. The
    // guard reads the box and refuses; clearing it would itself be typing.
    const guard = src.slice(src.indexOf("* THE PICKER IS NEVER SEARCHED"), src.indexOf("* Select a SAVED payee"));
    expect(guard).toContain("async function assertPickerUnfiltered");
    expect(guard).toContain('input[name="acctSearch"]');
    expect(guard).toContain("inputValue()");
    expect(guard).toContain("throw new Error(");
    expect(guard).toContain("Refusing to select");
    for (const write of [".fill(", ".type(", ".pressSequentially(", ".press(", ".click(", ".keyboard."]) {
      expect(guard).not.toContain(write);
    }
    // The search box is named NOWHERE else in the driver: every reference to
    // it in the whole module lives inside that read-only guard.
    const count = (hay: string) => hay.split("acctSearch").length - 1;
    expect(count(guard)).toBeGreaterThan(0);
    expect(count(src)).toBe(count(guard));
  });

  it("the picker driver stays out of the pure core — favorites-core.ts has no browser in it", () => {
    // Guardrail: root `bun test` runs before kbiz-bot/node_modules exists, so
    // the module this file imports must never reach playwright.
    const core = readFileSync(fileURLToPath(new URL("../src/lib/favorites-core.ts", import.meta.url)), "utf8");
    expect(core).not.toMatch(/from "playwright"/);
    expect(core).not.toMatch(/require\(["']playwright/);
    for (const call of ["page.locator(", "page.click(", "waitForTimeout(", "page.screenshot("]) {
      expect(core).not.toContain(call);
    }
    // The paging helpers are the DRIVER's, and they live in the flow.
    for (const helper of ["async function goToPickerPage", "const pickerPageAnchor", "async function readPickerPage"]) {
      expect(src).toContain(helper);
      expect(core).not.toContain(helper);
    }
  });

  it("refuses an empty nickname before the picker is even opened", () => {
    // Without this, matchFavoriteRows' `t.includes("")` passes every row and
    // the triple-verify silently degrades to bank + last-4 (asserted above).
    expect(fn).toMatch(/if \(!nickname\) throw new Error\(/);
    expect(fn.indexOf("if (!nickname)")).toBeLessThan(fn.indexOf("input-search-acc"));
  });

  it("refuses a favorite with no verifier at all (no accountNo AND no 4-digit last4)", () => {
    expect(fn).toMatch(/if \(!acctD && last4\.length !== 4\)/);
    expect(fn.indexOf("if (!acctD && last4.length !== 4)")).toBeLessThan(fn.indexOf("input-search-acc"));
  });

  it("re-verifies the To field KBIZ filled in, requiring a whole account number ending in the last 4", () => {
    expect(fn).toMatch(/filledD\.length >= 8 && filledD\.endsWith\(last4\)/);
    expect(fn).toContain("if (!toOk)");
  });

  /**
   * Every `throw new Error(...)` in the function as a WHOLE STATEMENT.
   *
   * This used to be a per-LINE scan, which pinned nothing: all but one of these
   * throws span several lines, and the line carrying `throw new Error(` carries
   * none of the message — so a `not.toMatch(/payee\.accountNo/)` over that line
   * could never fail no matter what the message interpolated. Parens are
   * balanced from the `(` after `Error`, and the extractor asserts it landed on
   * the statement's end, so a future unbalanced literal fails loudly instead of
   * silently truncating the text under test.
   */
  const extractThrowStatements = (source: string): string[] => {
    const out: string[] = [];
    const needle = "throw new Error(";
    for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
      let depth = 0;
      let end = -1;
      for (let i = at + needle.length - 1; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      expect(end).toBeGreaterThan(at); // the walk found the statement's close
      out.push(source.slice(at, end + 1));
    }
    return out;
  };

  const throwStatements = extractThrowStatements(fn);

  /**
   * Expressions that hold a WHOLE account number. None may be interpolated into
   * a message: `result.error` becomes a Slack post and reimbursement's stored
   * `bundle.paymentError`. Shared by the real scan and by the leak-catch test
   * below, so the two can never drift into checking different things.
   */
  const FULL_NUMBER_EXPRESSIONS = [
    /payee\.accountNo/,
    /\$\{acctD\}/,
    /\$\{last4 \? payee/,
    /\$\{filled\}/,
    /\$\{filledD\}/,
    /destinationKey/,
    /accountKeyForRow/,
    /rowTexts/,
  ];

  it("the masking check reads whole throw STATEMENTS — the old per-line scan pinned nothing", () => {
    expect(throwStatements.length).toBeGreaterThanOrEqual(5);
    // Multi-line throws exist…
    const multiline = throwStatements.filter((s) => s.includes("\n"));
    expect(multiline.length).toBeGreaterThanOrEqual(4);
    // …and their FIRST line — the only line a per-line scan would have seen —
    // contains no message at all. That is why the old assertion was vacuous.
    for (const s of multiline) expect(s.split("\n")[0]).not.toContain("${");
    // The extractor really did capture the messages, not just the opener.
    expect(throwStatements.filter((s) => s.includes("${shown}")).length).toBeGreaterThanOrEqual(4);
  });

  it("every refusal names the destination masked — no full number reaches Slack or paymentError", () => {
    // `shown` is maskAccount(...) and is what the throws interpolate.
    expect(fn).toMatch(/const shown = maskAccount\(/);
    for (const stmt of throwStatements) {
      for (const re of FULL_NUMBER_EXPRESSIONS) expect(stmt).not.toMatch(re);
    }
    // …and every throw that names the destination at all names it through
    // `shown`, never by re-deriving it.
    const naming = throwStatements.filter((s) => s.includes("payee.bank"));
    expect(naming.length).toBeGreaterThanOrEqual(4);
    for (const stmt of naming) expect(stmt).toContain("${shown}");
  });

  it("the masking check would CATCH a leak (the scan is live, not decorative)", () => {
    // The SAME extractor and the SAME pattern list, over a deliberately leaky
    // multi-line throw — the shape the real ones have. Asserting the regex
    // matches the raw string would prove nothing (it is a literal matched
    // against a literal); what has to hold is that the extractor finds the
    // statement and the shared list flags it.
    const leaky = [
      "async function selectFavoritePayee() {",
      "  throw new Error(",
      '    `Favorite "${nickname}" (${payee.accountNo}, ${payee.bank}): nope.`,',
      "  );",
      "}",
    ].join("\n");

    const extracted = extractThrowStatements(leaky);
    expect(extracted.length).toBe(1);
    expect(extracted[0]).toContain("${payee.accountNo}"); // the message, not just the opener
    expect(FULL_NUMBER_EXPRESSIONS.some((re) => re.test(extracted[0]))).toBe(true);

    // …and the real function's throws are the ones that pass that same list.
    expect(throwStatements.some((s) => s.includes("(${shown}, ${payee.bank})"))).toBe(true);
  });
});
