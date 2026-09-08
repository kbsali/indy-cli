import type { Transaction } from "./client.ts";

/** Amounts are printed with a decimal comma, so CSV is `;`-separated. */
export const CSV_DELIMITER = ";";

export function euros(amountInCents: number): string {
  return (amountInCents / 100).toFixed(2).replace(".", ",");
}

export function csvCell(value: string): string {
  return /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(CSV_DELIMITER);
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

export function transactionsToCsv(transactions: Transaction[]): string {
  const rows = transactions.map((transaction) =>
    csvRow([
      transaction._id,
      transaction.date?.slice(0, 10) ?? "",
      transaction.description ?? "",
      euros(transaction.amountInCents),
      transaction.subdivisions.map((s) => s.accounting_account?.number ?? "").join("|"),
      transaction.subdivisions.map((s) => rate(s.tva_rate)).join("|"),
      String(transaction.receiptIds?.length ?? 0),
      transaction.isVerified ? "oui" : "non",
    ]),
  );
  return [csvRow(HEADERS), ...rows].join("\n");
}

export function rate(tvaRate: number | null | undefined): string {
  return tvaRate === null || tvaRate === undefined ? "" : `${(tvaRate / 100).toFixed(2).replace(".", ",")}%`;
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
        transaction.subdivisions.map((s) => `${s.accounting_account?.number ?? "?"} ${rate(s.tva_rate)}`).join(" | "),
      ].join("  "),
    )
    .join("\n");
}
