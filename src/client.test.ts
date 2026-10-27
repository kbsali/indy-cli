import { expect, test } from "bun:test";

import {
  buildQuery,
  normalizeCookie,
  parseSubdivision,
  toCents,
} from "./client.ts";
import type { Transaction } from "./client.ts";
import { csvRow, euros, rate, transactionsToCsv } from "./format.ts";

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

test("csv uses ; and decimal commas, quoting cells that contain the delimiter", () => {
  expect(euros(-2999)).toBe("-29,99");
  expect(rate(550)).toBe("5,50%");
  expect(csvRow(["a", "b;c", 'say "hi"'])).toBe('a;"b;c";"say ""hi"""');
});

test("transactionsToCsv emits a header plus one row per transaction", () => {
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
  const [header, row] = transactionsToCsv(transactions).split("\n");
  expect(header).toBe(
    "id;date;description;montant;categories;tva;justificatifs;verifiee"
  );
  expect(row).toBe(
    "abc;2025-10-06;Abonnement internet;-29,99;626100;20,00%;1;non"
  );
});
