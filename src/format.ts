import type { Transaction } from "./client.ts";

/** Tab-separated: never collides with the decimal comma of amounts. */
export const TSV_DELIMITER = "\t";

export function euros(amountInCents: number): string {
  return (amountInCents / 100).toFixed(2).replace(".", ",");
}

export function tsvCell(value: string): string {
  return /["\t\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function tsvRow(cells: string[]): string {
  return cells.map(tsvCell).join(TSV_DELIMITER);
}

const HEADERS = [
  "id",
  "date",
  "description",
  "montant",
  "categories",
  "tva",
  "justificatifs",
  "verifiee",
];

export function transactionsToTsv(transactions: Transaction[]): string {
  const rows = transactions.map((transaction) =>
    tsvRow([
      transaction._id,
      transaction.date?.slice(0, 10) ?? "",
      transaction.description ?? "",
      euros(transaction.amountInCents),
      transaction.subdivisions
        .map((s) => s.accounting_account?.number ?? "")
        .join("|"),
      transaction.subdivisions.map((s) => rate(s.tva_rate)).join("|"),
      String(transaction.receiptIds?.length ?? 0),
      transaction.isVerified ? "oui" : "non",
    ])
  );
  return [tsvRow(HEADERS), ...rows].join("\n");
}

export function rate(tvaRate: number | null | undefined): string {
  return tvaRate === null || tvaRate === undefined
    ? ""
    : `${(tvaRate / 100).toFixed(2).replace(".", ",")}%`;
}

export function transactionsToTable(transactions: Transaction[]): string {
  return transactions
    .map((transaction) =>
      [
        transaction._id,
        transaction.date?.slice(0, 10) ?? "",
        euros(transaction.amountInCents).padStart(10),
        (transaction.receiptIds?.length ? "📎" : "  ") +
          " " +
          (transaction.description ?? "").slice(0, 40).padEnd(40),
        transaction.subdivisions
          .map(
            (s) => `${s.accounting_account?.number ?? "?"} ${rate(s.tva_rate)}`
          )
          .join(" | "),
      ].join("  ")
    )
    .join("\n");
}
