/**
 * Minimal client for the (unofficial) Indy web API.
 * Endpoints documented in ../../indy-web-api.md
 */

export const BASE_URL = "https://app.indy.fr/api";
export const PAGE_SIZE = 30;

export type Primitive = string | number | boolean;

export type ListParams = {
  search?: string;
  categories?: string[];
  bankAccountIds?: string[];
  transactionTypes?: string[];
  dateFrom?: string;
  dateTo?: string;
  amountFrom?: number;
  amountTo?: number;
  hasReceipt?: boolean;
  displayIngressOutflow?: "ingress" | "outflow";
  deleted?: "yes" | "no" | "both";
  verified?: "yes" | "no";
  vatType?: string[];
  vatRate?: number[];
};

export type Subdivision = {
  id: string;
  amount_in_cents: number;
  accounting_account: { number: string; category_name?: string };
  tva_rate: number | null;
  tva_amount_in_cents?: number | null;
  modifiable?: boolean;
};

export type Transaction = {
  _id: string;
  date: string;
  description: string;
  amountInCents: number;
  isVerified: boolean;
  isDeleted: boolean;
  receiptIds?: string[];
  subdivisions: Subdivision[];
};

export type TransactionList = {
  transactions: Transaction[];
  nbTransactions: number;
  toCategorizeCount: number;
};

export type SubdivisionInput = {
  amountInCents: number;
  accountingAccountNumber: string;
  tvaRate: number;
  // Omitted for French VAT: the API now rejects null ("must be object").
  tvaIntracom?: { type: string; rate: number };
  tvaToBeDefined?: boolean;
  resourceLinks?: unknown[];
  editDisplay?: { amountType: "TTC" | "HT" | "TVA" };
};

/** qs `arrayFormat: "brackets"`, as the SPA serializes list filters. */
export function buildQuery(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) continue;
    const name = Array.isArray(value) ? `${key}[]` : key;
    for (const item of values) {
      parts.push(
        `${encodeURIComponent(name)}=${encodeURIComponent(String(item))}`
      );
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** Euros (as typed by a human: "25,33" or "-25.33") to signed cents. */
export function toCents(amount: string | number): number {
  const value =
    typeof amount === "number"
      ? amount
      : Number.parseFloat(amount.replace(",", "."));
  if (Number.isNaN(value)) throw new Error(`Invalid amount: ${amount}`);
  return Math.round(value * 100);
}

/** "-25,33:626100:2000" -> subdivision payload. Rate is in basis points (2000 = 20 %). */
export function parseSubdivision(spec: string): SubdivisionInput {
  const [amount, account, rate] = spec.split(":");
  if (!amount || !account) {
    throw new Error(
      `Invalid --line "${spec}", expected amount:accountingAccount[:tvaRate]`
    );
  }
  const tvaRate =
    rate === undefined || rate === "" ? 0 : Number.parseInt(rate, 10);
  if (Number.isNaN(tvaRate)) throw new Error(`Invalid tvaRate in "${spec}"`);
  return {
    amountInCents: toCents(amount),
    accountingAccountNumber: account,
    tvaRate,
    tvaToBeDefined: false,
    resourceLinks: [],
    editDisplay: { amountType: "TTC" },
  };
}

export class IndyError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string
  ) {
    super(`${method} ${path} -> ${status} ${body.slice(0, 300)}`);
    this.name = "IndyError";
  }
}

type RequestOptions = {
  query?: Record<string, unknown>;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
};

/** Name of Indy's HttpOnly session cookie. */
export const SESSION_COOKIE = "__Http-sid";

/**
 * Accepts what is easiest to paste: the bare session value, `__Http-sid=<value>`,
 * or a whole `Cookie:` header copied from DevTools.
 */
export function normalizeCookie(raw: string): string {
  const value = raw.trim().replace(/^cookie:\s*/i, "");
  return value.includes("=") ? value : `${SESSION_COOKIE}=${value}`;
}

export type Credentials = {
  /** Session cookie header value, e.g. "indy_session=…". Preferred: this is what the SPA uses. */
  cookie?: string;
  /** Firebase ID token. Only accepted while `enableClientInternalAuthSession` is off. */
  token?: string;
  /** Sent as x-organisation-id; only needed when an accountant impersonates an organisation. */
  organisationId?: string;
};

export class IndyClient {
  private readonly cookie?: string;
  private readonly token?: string;
  private readonly organisationId?: string;

  constructor(
    credentials: Credentials,
    private readonly baseUrl: string = BASE_URL
  ) {
    if (!credentials.cookie && !credentials.token) {
      throw new Error(
        "Missing credentials: pass a session cookie or a Firebase ID token"
      );
    }
    this.cookie = credentials.cookie
      ? normalizeCookie(credentials.cookie)
      : undefined;
    this.token = credentials.token;
    this.organisationId = credentials.organisationId;
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(options.query ?? {})}`;
    const headers: Record<string, string> = {
      "x-client-app-type": "web",
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...options.headers,
    };
    if (this.organisationId) {
      headers["x-organisation-id"] = this.organisationId;
      headers["x-active-organisation-id"] = this.organisationId;
    }
    let body: BodyInit | undefined;
    if (options.form) {
      body = options.form;
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    if (!response.ok) throw new IndyError(response.status, method, path, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // --- transactions -------------------------------------------------------

  listTransactions(
    params: ListParams = {},
    page = 1
  ): Promise<TransactionList> {
    return this.request<TransactionList>(
      "GET",
      "/transactions/transactions-list",
      {
        query: { ...params, page },
      }
    );
  }

  /** Walks every page (30 per page) of a filtered list. */
  async listAllTransactions(params: ListParams = {}): Promise<Transaction[]> {
    const all: Transaction[] = [];
    for (let page = 1; ; page++) {
      const { transactions, nbTransactions } = await this.listTransactions(
        params,
        page
      );
      all.push(...transactions);
      if (transactions.length < PAGE_SIZE || all.length >= nbTransactions)
        return all;
    }
  }

  /** No id-filtered endpoint exists: try the accounting route, else scan the list. */
  async getTransaction(
    transactionId: string,
    params: ListParams = {}
  ): Promise<Transaction> {
    try {
      const result = await this.request<
        { transaction?: Transaction } | Transaction
      >("GET", `/accounting/transactions/${transactionId}`);
      const transaction =
        "transaction" in result ? result.transaction : (result as Transaction);
      if (transaction?._id) return transaction;
    } catch (error) {
      if (!(error instanceof IndyError)) throw error;
    }
    for (let page = 1; ; page++) {
      const { transactions } = await this.listTransactions(params, page);
      const found = transactions.find(
        (transaction) => transaction._id === transactionId
      );
      if (found) return found;
      if (transactions.length < PAGE_SIZE) {
        throw new Error(`Transaction ${transactionId} not found`);
      }
    }
  }

  filters(): Promise<unknown> {
    return this.request("GET", "/transactions/transactions-list-filters");
  }

  summary(body: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/accounting/transactions/summary", { body });
  }

  vatConfiguration(
    date: string
  ): Promise<{ isLiable: boolean; tvaFrequency: string }> {
    return this.request("GET", "/vat/configuration", { query: { date } });
  }

  // --- receipts -----------------------------------------------------------

  receiptsFor(transactionId: string): Promise<{ receipts: unknown[] }> {
    return this.request("GET", "/receipts/transaction", {
      query: { transactionId },
    });
  }

  async uploadReceipt(transactionId: string, file: File): Promise<unknown> {
    const form = new FormData();
    form.append("file", file, file.name);
    return this.request("POST", "/receipts", {
      query: { transactionId },
      form,
      headers: { "x-request-id": crypto.randomUUID() },
    });
  }

  attachReceipt(
    receiptId: string,
    transactionId: string,
    applyReceiptData = false
  ): Promise<unknown> {
    return this.request("PUT", `/receipts/${receiptId}/transaction`, {
      body: { transactionId, applyReceiptData },
    });
  }

  detachReceipt(receiptId: string): Promise<unknown> {
    return this.request("POST", `/receipts/${receiptId}/detach`);
  }

  deleteReceipt(receiptId: string): Promise<unknown> {
    return this.request("DELETE", `/receipts/${receiptId}`);
  }

  applyReceiptData(receiptId: string): Promise<unknown> {
    return this.request(
      "PUT",
      `/receipts/${receiptId}/apply-receipt-data-to-transaction`
    );
  }

  unpairedReceipts(): Promise<unknown> {
    return this.request("GET", "/receipts/unpaired");
  }

  // --- VAT ----------------------------------------------------------------

  setVat(input: {
    transactionId: string;
    subdivisionId: string;
    tvaRate: number;
    tvaIntracom?: unknown;
    tvaToBeDefined?: boolean;
  }): Promise<unknown> {
    const {
      transactionId,
      subdivisionId,
      tvaRate,
      tvaIntracom,
      tvaToBeDefined = false,
    } = input;
    return this.request("POST", `/transactions/${transactionId}/vat`, {
      body: { subdivisionId, tvaRate, tvaIntracom, tvaToBeDefined },
    });
  }

  /** Full edit: description/date/amount/annotation plus the whole VAT split. */
  updateTransaction(
    transactionId: string,
    info: {
      description: string;
      amountInCents: number;
      date: string;
      annotation?: string;
      isVerified?: boolean;
    },
    subdivisions: SubdivisionInput[]
  ): Promise<unknown> {
    return this.request("POST", `/transactions/manual/${transactionId}`, {
      body: {
        info: { annotation: "", isVerified: false, ...info },
        subdivisions,
      },
    });
  }
}
