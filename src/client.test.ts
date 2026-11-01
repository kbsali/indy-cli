import { afterEach, expect, spyOn, test } from "bun:test";

import { decryptValue } from "./browser-cookie.ts";
import { exclusive, listParams } from "./cli.ts";
import {
  buildQuery,
  IndyClient,
  IndyError,
  isScanFallback,
  normalizeCookie,
  PAGE_SIZE,
  parseSubdivision,
  toCents,
} from "./client.ts";
import type { Transaction } from "./client.ts";
import { euros, rate, transactionsToTsv, tsvRow } from "./format.ts";

test("buildQuery serializes arrays with brackets and skips empties", () => {
  const query = buildQuery({
    page: 1,
    search: "free",
    categories: ["626100", "613200"],
    hasReceipt: false,
    empty: undefined,
    blank: "",
    none: [],
  });
  expect(query).toBe(
    "?page=1&search=free&categories%5B%5D=626100&categories%5B%5D=613200&hasReceipt=false"
  );
});

test("toCents handles decimal commas and negative amounts", () => {
  expect(toCents("25,33")).toBe(2533);
  expect(toCents("-29.99")).toBe(-2999);
  expect(toCents(-4.66)).toBe(-466);
  expect(() => toCents("abc")).toThrow();
});

test("parseSubdivision reads amount:account:rate", () => {
  expect(parseSubdivision("-25,33:626100:2000")).toEqual({
    amountInCents: -2533,
    accountingAccountNumber: "626100",
    tvaRate: 2000,
    tvaToBeDefined: false,
    resourceLinks: [],
    editDisplay: { amountType: "TTC" },
  });
  expect(parseSubdivision("10:606300").tvaRate).toBe(0);
  expect(() => parseSubdivision("10")).toThrow();
});

test("normalizeCookie accepts a bare value, a pair, or a pasted header", () => {
  expect(normalizeCookie("  abc123 ")).toBe("__Http-sid=abc123");
  expect(normalizeCookie("__Http-sid=abc123")).toBe("__Http-sid=abc123");
  expect(normalizeCookie("Cookie: __Http-sid=abc123; _ga=x")).toBe(
    "__Http-sid=abc123; _ga=x"
  );
});

test("tsv uses tabs and decimal commas, quoting cells that contain a tab", () => {
  expect(euros(-2999)).toBe("-29,99");
  expect(rate(550)).toBe("5,50%");
  expect(tsvRow(["a", "b\tc", "29,99"])).toBe('a\t"b\tc"\t29,99');
});

test("transactionsToTsv emits a header plus one row per transaction", () => {
  const transactions: Transaction[] = [
    {
      _id: "abc",
      date: "2025-10-06T00:00:00.000Z",
      description: "Abonnement internet",
      amountInCents: -2999,
      isVerified: false,
      isDeleted: false,
      receiptIds: ["r1"],
      subdivisions: [
        {
          id: "s1",
          amount_in_cents: -2999,
          accounting_account: { number: "626100" },
          tva_rate: 2000,
        },
      ],
    },
  ];
  const [header, row] = transactionsToTsv(transactions).split("\n");
  expect(header).toBe(
    "id\tdate\tdescription\tmontant\tcategories\ttva\tjustificatifs\tverifiee"
  );
  expect(row).toBe(
    "abc\t2025-10-06\tAbonnement internet\t-29,99\t626100\t20,00%\t1\tnon"
  );
});

// --- state transitions (fetch stubbed, no network) -------------------------

const tx = (id: string): Transaction => ({
  _id: id,
  date: "2026-01-01",
  description: id,
  amountInCents: -100,
  isVerified: false,
  isDeleted: false,
  subdivisions: [],
});

/** Answers fetch calls in order; records the requested URLs and bodies. */
function stubFetch(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; body?: string }> = [];
  spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit
  ) => {
    calls.push({ url: String(url), body: init?.body as string | undefined });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request ${url}`);
    return new Response(JSON.stringify(next[1]), { status: next[0] });
  }) as unknown as typeof fetch);
  return calls;
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const client = () => new IndyClient({ cookie: "x" }, "https://indy.test");

test("isScanFallback: only a 4xx other than 401 falls through to the scan", () => {
  expect(isScanFallback(new IndyError(404, "GET", "/", ""))).toBe(true);
  expect(isScanFallback(new IndyError(401, "GET", "/", ""))).toBe(false);
  expect(isScanFallback(new IndyError(502, "GET", "/", ""))).toBe(false);
  expect(isScanFallback(new Error("network"))).toBe(false);
});

test("getTransaction rethrows a 5xx instead of scanning", async () => {
  const calls = stubFetch([[502, {}]]);
  await expect(client().getTransaction("a")).rejects.toThrow("502");
  expect(calls).toHaveLength(1);
});

test("getTransaction scans on 404 and passes deleted=both through", async () => {
  const calls = stubFetch([
    [404, {}],
    [200, { transactions: [tx("a")], nbTransactions: 1 }],
  ]);
  const found = await client().getTransaction("a", { deleted: "both" });
  expect(found._id).toBe("a");
  expect(calls[1]!.url).toContain("deleted=both");
});

test("getTransaction stops at nbTransactions, no extra empty page", async () => {
  const page = Array.from({ length: PAGE_SIZE }, (_, i) => tx(`t${i}`));
  const calls = stubFetch([
    [404, {}],
    [200, { transactions: page, nbTransactions: PAGE_SIZE }],
  ]);
  await expect(client().getTransaction("missing")).rejects.toThrow("not found");
  expect(calls).toHaveLength(2);
});

test("listAllTransactions drops a row repeated by a shifted page", async () => {
  const first = Array.from({ length: PAGE_SIZE }, (_, i) => tx(`t${i}`));
  stubFetch([
    [200, { transactions: first, nbTransactions: PAGE_SIZE + 2 }],
    [
      200,
      {
        transactions: [tx(`t${PAGE_SIZE - 1}`), tx("last")],
        nbTransactions: PAGE_SIZE + 2,
      },
    ],
  ]);
  const all = await client().listAllTransactions();
  expect(all.map((t) => t._id)).toEqual([...first.map((t) => t._id), "last"]);
});

test("updateTransaction sends no annotation unless one is given", async () => {
  const calls = stubFetch([
    [200, {}],
    [200, {}],
  ]);
  const info = { description: "d", amountInCents: -100, date: "2026-01-01" };
  await client().updateTransaction("a", info, []);
  await client().updateTransaction("a", { ...info, annotation: "note" }, []);
  expect(JSON.parse(calls[0]!.body!).info).not.toHaveProperty("annotation");
  expect(JSON.parse(calls[1]!.body!).info.annotation).toBe("note");
});

test("exclusive flag pairs: one, the other, neither, both", () => {
  expect(exclusive({ verified: true }, "verified", "unverified")).toBe(true);
  expect(exclusive({ unverified: true }, "verified", "unverified")).toBe(false);
  expect(exclusive({}, "verified", "unverified")).toBeUndefined();
  expect(() => listParams({ income: true, expense: true })).toThrow(
    "mutually exclusive"
  );
  expect(listParams({ "no-receipt": true, unverified: true })).toEqual({
    hasReceipt: false,
    verified: "no",
  });
});

test("decryptValue rejects an unknown encryption version", () => {
  const keys = { v10: Buffer.alloc(16), v11: Buffer.alloc(16) };
  expect(() =>
    decryptValue(Buffer.from("v12xxxxxxxxxxxxxxxx"), keys, 24)
  ).toThrow('Unsupported cookie encryption "v12"');
  expect(decryptValue(Buffer.from("plain"), keys, 24)).toBe("plain");
});
