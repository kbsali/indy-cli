#!/usr/bin/env bun
import { basename } from "node:path";
import { parseArgs } from "node:util";

import { type Browser, browserCookie } from "./browser-cookie.ts";
import {
  type Credentials,
  IndyClient,
  IndyError,
  type ListParams,
  parseSubdivision,
  type SubdivisionInput,
  toCents,
} from "./client.ts";
import { transactionsToTable, transactionsToTsv } from "./format.ts";

const USAGE = `indy — CLI for the Indy web API

Usage: indy <command> [options]

Commands:
  list                          List / filter transactions
  get <transactionId>           Show one transaction (with its subdivisions)
  receipts <transactionId>      List receipts attached to a transaction
  upload <transactionId> <file...>   Upload receipt(s) and attach them
  attach <receiptId> <transactionId> Attach an existing receipt
  detach <receiptId> <transactionId> Detach a receipt from its transaction
  delete-receipt <receiptId>    Delete a receipt
  apply-receipt <receiptId>     Apply the receipt OCR data (amount/date/VAT)
  unpaired                      Receipts with no transaction
  vat <transactionId>           Set the VAT rate of one subdivision
  split <transactionId>         Rewrite the whole VAT split of a transaction
  filters                       Filter vocabulary (categories, accounts, ...)
  vat-config                    VAT configuration at a date

List filters:
  --search <text>          --category <account>   (repeatable)
  --from <YYYY-MM-DD>      --to <YYYY-MM-DD>
  --amount-from <euros>    --amount-to <euros>
  --no-receipt | --with-receipt
  --income | --expense     --verified | --unverified
  --deleted <yes|no|both>  --vat-rate <basis points>  (repeatable, 2000 = 20 %)
  --page <n>               --all
Output:
  --json | --tsv           (default: aligned text)

vat options:
  --rate <basis points>    2000 = 20 %, 0 = exonéré  (required)
  --subdivision <id>       default: the transaction's only modifiable subdivision
  --to-be-defined          set "TVA à définir"

split options:
  --line <amount:account[:rate]>   repeatable, amounts in euros, signed
  --description <text>  --date <YYYY-MM-DD>  --amount <euros>
  --annotation <text>   default: the current annotation is kept
  --verified | --unverified   set "transaction vérifiée" (default: unchanged)
  --force               skip the "subdivisions must sum to the amount" check

Auth: the __Http-sid cookie of the browser session logged in on app.indy.fr,
read from the Chromium cookie store (Linux, libsecret). Overrides:
  INDY_COOKIE    __Http-sid value — the bare value, "__Http-sid=<value>" or a
                 whole Cookie header all work
  INDY_BROWSER   chromium (default) | chrome
  INDY_PROFILE   browser profile directory, default: Default
  (last resort: keyring get indy-compta cookie)
  INDY_TOKEN     Firebase ID token — only works if enableClientInternalAuthSession is off
  INDY_ORG_ID    organisation id, sent as x-organisation-id (accountant impersonation only)
`;

const options = {
  search: { type: "string" },
  category: { type: "string", multiple: true },
  from: { type: "string" },
  to: { type: "string" },
  "amount-from": { type: "string" },
  "amount-to": { type: "string" },
  "no-receipt": { type: "boolean" },
  "with-receipt": { type: "boolean" },
  income: { type: "boolean" },
  expense: { type: "boolean" },
  verified: { type: "boolean" },
  unverified: { type: "boolean" },
  deleted: { type: "string" },
  "vat-rate": { type: "string", multiple: true },
  page: { type: "string" },
  all: { type: "boolean" },
  json: { type: "boolean" },
  tsv: { type: "boolean" },
  rate: { type: "string" },
  subdivision: { type: "string" },
  "to-be-defined": { type: "boolean" },
  line: { type: "string", multiple: true },
  description: { type: "string" },
  date: { type: "string" },
  amount: { type: "string" },
  annotation: { type: "string" },
  force: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export type Flags = Partial<{
  [K in keyof typeof options]: (typeof options)[K] extends { multiple: true }
    ? string[]
    : (typeof options)[K] extends { type: "boolean" }
      ? boolean
      : string;
}>;

function fromKeyring(key: string): string | undefined {
  try {
    const keyring = Bun.spawnSync(["keyring", "get", "indy-compta", key]);
    const value = new TextDecoder().decode(keyring.stdout).trim();
    if (keyring.exitCode === 0 && value) return value;
  } catch {
    // keyring not installed
  }
  return undefined;
}

/** A broken cookie store must not hide the keyring and INDY_TOKEN fallbacks. */
function fromBrowser(): string | undefined {
  try {
    return browserCookie(
      "app.indy.fr",
      "__Http-sid",
      (process.env.INDY_BROWSER ?? "chromium") as Browser,
      process.env.INDY_PROFILE
    );
  } catch (error) {
    console.error(
      `Browser cookie store skipped: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

function resolveCredentials(): Credentials {
  const cookie =
    process.env.INDY_COOKIE?.trim() || fromBrowser() || fromKeyring("cookie");
  const token = process.env.INDY_TOKEN?.trim() || fromKeyring("token");
  if (!cookie && !token) {
    throw new Error(
      "No credentials. Log in on app.indy.fr in Chromium, or set INDY_COOKIE to the\n" +
        "value of the __Http-sid cookie of a logged-in session.\n" +
        "INDY_TOKEN (Firebase ID token)\n" +
        "only works while the enableClientInternalAuthSession flag is off."
    );
  }
  return { cookie, token, organisationId: process.env.INDY_ORG_ID };
}

/** A tri-state stored as 2 flags: both given is a mistake, not "last one wins". */
export function exclusive(
  flags: Flags,
  yes: keyof Flags,
  no: keyof Flags
): boolean | undefined {
  if (flags[yes] && flags[no]) {
    throw new Error(`--${yes} and --${no} are mutually exclusive`);
  }
  if (flags[yes]) return true;
  if (flags[no]) return false;
  return undefined;
}

export function listParams(flags: Flags): ListParams {
  const params: ListParams = {};
  const hasReceipt = exclusive(flags, "with-receipt", "no-receipt");
  const income = exclusive(flags, "income", "expense");
  const verified = exclusive(flags, "verified", "unverified");
  if (flags.search) params.search = flags.search;
  if (flags.category?.length) params.categories = flags.category;
  if (flags.from) params.dateFrom = flags.from;
  if (flags.to) params.dateTo = flags.to;
  if (flags["amount-from"])
    params.amountFrom = Number.parseFloat(
      flags["amount-from"].replace(",", ".")
    );
  if (flags["amount-to"])
    params.amountTo = Number.parseFloat(flags["amount-to"].replace(",", "."));
  if (hasReceipt !== undefined) params.hasReceipt = hasReceipt;
  if (income !== undefined)
    params.displayIngressOutflow = income ? "ingress" : "outflow";
  if (verified !== undefined) params.verified = verified ? "yes" : "no";
  if (flags.deleted) params.deleted = flags.deleted as ListParams["deleted"];
  if (flags["vat-rate"]?.length)
    params.vatRate = flags["vat-rate"].map((r) => Number.parseInt(r, 10));
  return params;
}

function output(
  flags: Flags,
  data: unknown,
  transactions?: Parameters<typeof transactionsToTsv>[0]
) {
  if (flags.tsv && transactions)
    return console.log(transactionsToTsv(transactions));
  if (flags.json || !transactions)
    return console.log(JSON.stringify(data, null, 2));
  console.log(transactionsToTable(transactions));
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
  });
  const flags = values as Flags;
  const [command, ...args] = positionals;

  if (!command || flags.help) {
    console.log(USAGE);
    return;
  }

  if (flags.json && flags.tsv) {
    throw new Error("--json and --tsv are mutually exclusive");
  }
  if (flags.tsv && command !== "list" && command !== "get") {
    throw new Error(`--tsv only applies to list and get, not ${command}`);
  }

  const client = new IndyClient(resolveCredentials());

  switch (command) {
    case "list": {
      const params = listParams(flags);
      if (flags.all) {
        const transactions = await client.listAllTransactions(params);
        return output(flags, transactions, transactions);
      }
      const page = flags.page ? Number.parseInt(flags.page, 10) : 1;
      const result = await client.listTransactions(params, page);
      if (!flags.json && !flags.tsv) {
        console.error(
          `${result.transactions.length} shown / ${result.nbTransactions} matching`
        );
      }
      return output(flags, result, result.transactions);
    }

    case "get": {
      const [transactionId] = args;
      if (!transactionId) throw new Error("Usage: indy get <transactionId>");
      const transaction = await client.getTransaction(
        transactionId,
        listParams(flags)
      );
      return output(flags, transaction, flags.tsv ? [transaction] : undefined);
    }

    case "receipts": {
      const [transactionId] = args;
      if (!transactionId)
        throw new Error("Usage: indy receipts <transactionId>");
      return console.log(
        JSON.stringify(await client.receiptsFor(transactionId), null, 2)
      );
    }

    case "upload": {
      const [transactionId, ...paths] = args;
      if (!transactionId || paths.length === 0) {
        throw new Error("Usage: indy upload <transactionId> <file...>");
      }
      for (const path of paths) {
        const blob = Bun.file(path);
        if (!(await blob.exists())) throw new Error(`File not found: ${path}`);
      }
      for (const [index, path] of paths.entries()) {
        const blob = Bun.file(path);
        const file = new File([await blob.arrayBuffer()], basename(path), {
          type: blob.type || "application/octet-stream",
        });
        try {
          const result = await client.uploadReceipt(transactionId, file);
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          // Earlier files are attached already: say so, and what to rerun.
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `Upload of ${path} failed (${index}/${paths.length} uploaded): ${message}\n` +
              `Rerun with the remaining files: indy upload ${transactionId} ${paths.slice(index).join(" ")}`,
            { cause: error }
          );
        }
      }
      return;
    }

    case "attach": {
      const [receiptId, transactionId] = args;
      if (!receiptId || !transactionId)
        throw new Error("Usage: indy attach <receiptId> <transactionId>");
      return console.log(
        JSON.stringify(
          await client.attachReceipt(receiptId, transactionId),
          null,
          2
        )
      );
    }

    case "detach": {
      const [receiptId, transactionId] = args;
      if (!receiptId || !transactionId)
        throw new Error("Usage: indy detach <receiptId> <transactionId>");
      return console.log(
        JSON.stringify(
          await client.detachReceipt(receiptId, transactionId),
          null,
          2
        )
      );
    }

    case "delete-receipt": {
      const [receiptId] = args;
      if (!receiptId) throw new Error("Usage: indy delete-receipt <receiptId>");
      return console.log(
        JSON.stringify(await client.deleteReceipt(receiptId), null, 2)
      );
    }

    case "apply-receipt": {
      const [receiptId] = args;
      if (!receiptId) throw new Error("Usage: indy apply-receipt <receiptId>");
      return console.log(
        JSON.stringify(await client.applyReceiptData(receiptId), null, 2)
      );
    }

    case "unpaired":
      return console.log(
        JSON.stringify(await client.unpairedReceipts(), null, 2)
      );

    case "vat": {
      const [transactionId] = args;
      if (!transactionId || !flags.rate) {
        throw new Error(
          "Usage: indy vat <transactionId> --rate <basis points> [--subdivision <id>]"
        );
      }
      let subdivisionId = flags.subdivision;
      if (!subdivisionId) {
        const transaction = await client.getTransaction(transactionId, {
          deleted: "both",
        });
        const modifiable = transaction.subdivisions.filter(
          (s) => s.modifiable !== false
        );
        if (modifiable.length !== 1) {
          throw new Error(
            `Transaction has ${modifiable.length} modifiable subdivisions, pass --subdivision <id> (use \`indy get\`)`
          );
        }
        subdivisionId = modifiable[0]!.id;
      }
      const result = await client.setVat({
        transactionId,
        subdivisionId,
        tvaRate: Number.parseInt(flags.rate, 10),
        tvaToBeDefined: flags["to-be-defined"] ?? false,
      });
      return console.log(JSON.stringify(result, null, 2));
    }

    case "split": {
      const [transactionId] = args;
      if (!transactionId || !flags.line?.length) {
        throw new Error(
          "Usage: indy split <transactionId> --line <amount:account[:rate]> [--line ...]"
        );
      }
      const subdivisions: SubdivisionInput[] = flags.line.map(parseSubdivision);
      const isVerified = exclusive(flags, "verified", "unverified");
      const current = await client.getTransaction(transactionId, {
        deleted: "both",
      });
      const amountInCents = flags.amount
        ? toCents(flags.amount)
        : current.amountInCents;
      const total = subdivisions.reduce((sum, s) => sum + s.amountInCents, 0);
      if (total !== amountInCents && !flags.force) {
        throw new Error(
          `Subdivisions sum to ${total} cents but the transaction is ${amountInCents} cents. Fix the lines or pass --force.`
        );
      }
      const result = await client.updateTransaction(
        transactionId,
        {
          description: flags.description ?? current.description,
          amountInCents,
          date: (flags.date ?? current.date).slice(0, 10),
          // Unknown current annotation: omitted, so it is not erased.
          annotation: flags.annotation ?? current.annotation,
          isVerified: isVerified ?? current.isVerified,
        },
        subdivisions
      );
      return console.log(JSON.stringify(result, null, 2));
    }

    case "filters":
      return console.log(JSON.stringify(await client.filters(), null, 2));

    case "vat-config": {
      const date = flags.date ?? new Date().toISOString().slice(0, 10);
      return console.log(
        JSON.stringify(await client.vatConfiguration(date), null, 2)
      );
    }

    default:
      throw new Error(`Unknown command "${command}". Run \`indy --help\`.`);
  }
}

if (import.meta.main)
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof IndyError && error.status === 401) {
      console.error(
        "401 Unauthorized — log in again on app.indy.fr in the browser (see README)."
      );
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
