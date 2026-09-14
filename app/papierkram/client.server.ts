import {
  PapierkramApiError,
  PapierkramNetworkError,
  PapierkramNotConfiguredError,
} from "./errors";
import type {
  ApiInfo,
  Company,
  CompanyInput,
  CompanyPersonInput,
  ContactPerson,
  DeliveryInput,
  DocumentListParams,
  Estimate,
  EstimateInput,
  Invoice,
  InvoiceInput,
  ListParams,
  PapierkramList,
  PaymentTerm,
  Project,
  Proposition,
} from "./types";

export interface PapierkramClientOptions {
  subdomain: string;
  apiToken: string;
  /** Standard: https://{subdomain}.papierkram.de */
  baseUrlTemplate?: string;
  /** Anzahl zusaetzlicher Versuche bei 429/5xx/Netzwerkfehlern. */
  maxRetries?: number;
  /** Timeout je Anfrage in Millisekunden. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Wird nach jeder Antwort mit dem X-Remaining-Quota Header aufgerufen. */
  onQuota?: (remaining: number) => void;
  /** Wartefunktion - in Tests ueberschreibbar. */
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** PDF-Endpunkte liefern binaer statt JSON. */
  raw?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_TEMPLATE = "https://{subdomain}.papierkram.de";

/**
 * Schlanker Client fuer die Papierkram API v1.
 *
 * Besonderheiten der API, die hier abgefangen werden:
 * - Authentifizierung per Bearer-Token, Basis-URL ist mandantenspezifisch.
 * - Jede Antwort traegt X-Remaining-Quota (Monatskontingent), das wir melden.
 * - Es gibt keine Webhooks; Aktualisierungen laufen ueber Polling.
 * - Listen sind seitenweise (page/page_size) mit has_more.
 */
export class PapierkramClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onQuota?: (remaining: number) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Letzter gemeldeter Stand des Monatskontingents. */
  remainingQuota: number | null = null;

  constructor(options: PapierkramClientOptions) {
    const subdomain = options.subdomain?.trim();
    const apiToken = options.apiToken?.trim();
    if (!subdomain || !apiToken) {
      throw new PapierkramNotConfiguredError();
    }
    const template =
      options.baseUrlTemplate ||
      process.env.PAPIERKRAM_BASE_URL_TEMPLATE ||
      DEFAULT_TEMPLATE;

    this.baseUrl = `${template.replace("{subdomain}", subdomain).replace(/\/+$/, "")}/api/v1`;
    this.token = apiToken;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onQuota = options.onQuota;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Oberflaechen-URL des Mandanten, z.B. fuer Deep-Links in der Admin-UI. */
  get webBaseUrl(): string {
    return this.baseUrl.replace(/\/api\/v1$/, "");
  }

  /** Direktlink auf einen Beleg in der Papierkram-Oberflaeche. */
  documentUrl(kind: "invoice" | "estimate" | "company", id: number): string {
    const segment =
      kind === "invoice"
        ? "income/invoices"
        : kind === "estimate"
          ? "income/estimates"
          : "contacts/companies";
    return `${this.webBaseUrl}/${segment}/${id}`;
  }

  // ---------------------------------------------------------------- Info

  info() {
    return this.request<ApiInfo>("/info");
  }

  /** Prueft Subdomain + Token, ohne Daten zu veraendern. */
  async testConnection(): Promise<{ ok: true; version: string }> {
    const info = await this.info();
    return { ok: true, version: info.api?.version ?? "unbekannt" };
  }

  // ------------------------------------------------------------ Kontakte

  listCompanies(params: ListParams = {}) {
    return this.request<PapierkramList<Company>>("/contact/companies", {
      query: { ...params },
    });
  }

  getCompany(id: number) {
    return this.request<Company>(`/contact/companies/${id}`);
  }

  createCompany(input: CompanyInput) {
    return this.request<Company>("/contact/companies", {
      method: "POST",
      body: input,
    });
  }

  updateCompany(id: number, input: Partial<CompanyInput>) {
    return this.request<Company>(`/contact/companies/${id}`, {
      method: "PUT",
      body: input,
    });
  }

  listPersons(companyId: number, params: ListParams = {}) {
    return this.request<PapierkramList<ContactPerson>>(
      `/contact/companies/${companyId}/persons`,
      { query: { ...params } },
    );
  }

  createPerson(companyId: number, input: CompanyPersonInput) {
    return this.request<ContactPerson>(
      `/contact/companies/${companyId}/persons`,
      { method: "POST", body: input },
    );
  }

  /**
   * Sucht ein Unternehmen anhand der E-Mail-Adresse. Die API bietet keinen
   * Suchparameter, daher blaettern wir durch die Liste. Das Ergebnis wird von
   * den Aufrufern in DocumentLink zwischengespeichert, damit das hoechstens
   * einmal pro Kunde passiert.
   */
  async findCompanyByEmail(
    email: string,
    options: { maxPages?: number } = {},
  ): Promise<Company | null> {
    const needle = email.trim().toLowerCase();
    if (!needle) return null;

    const maxPages = options.maxPages ?? 20;
    for (let page = 1; page <= maxPages; page++) {
      const result = await this.listCompanies({ page, page_size: 100 });
      const hit = result.entries.find(
        (company) => company.email?.trim().toLowerCase() === needle,
      );
      if (hit) return hit;
      if (!result.has_more) break;
    }
    return null;
  }

  // ----------------------------------------------------------- Rechnungen

  listInvoices(params: DocumentListParams = {}) {
    return this.request<PapierkramList<Invoice>>("/income/invoices", {
      query: { ...params },
    });
  }

  getInvoice(id: number) {
    return this.request<Invoice>(`/income/invoices/${id}`);
  }

  createInvoice(input: InvoiceInput) {
    return this.request<Invoice>("/income/invoices", {
      method: "POST",
      body: input,
    });
  }

  updateInvoice(id: number, input: Partial<InvoiceInput>) {
    return this.request<Invoice>(`/income/invoices/${id}`, {
      method: "PUT",
      body: input,
    });
  }

  deleteInvoice(id: number) {
    return this.request<void>(`/income/invoices/${id}`, { method: "DELETE" });
  }

  /** Finalisiert die Rechnung: per E-Mail versenden oder als PDF festschreiben. */
  deliverInvoice(id: number, input: DeliveryInput) {
    return this.request<Invoice>(`/income/invoices/${id}/deliver`, {
      method: "POST",
      body: input,
    });
  }

  cancelInvoice(id: number) {
    return this.request<Invoice>(`/income/invoices/${id}/cancel`, {
      method: "POST",
    });
  }

  archiveInvoice(id: number) {
    return this.request<Invoice>(`/income/invoices/${id}/archive`, {
      method: "POST",
    });
  }

  invoicePdf(id: number) {
    return this.request<ArrayBuffer>(`/income/invoices/${id}/pdf`, {
      raw: true,
    });
  }

  // ------------------------------------------------------------- Angebote

  listEstimates(params: DocumentListParams = {}) {
    return this.request<PapierkramList<Estimate>>("/income/estimates", {
      query: { ...params },
    });
  }

  getEstimate(id: number) {
    return this.request<Estimate>(`/income/estimates/${id}`);
  }

  createEstimate(input: EstimateInput) {
    return this.request<Estimate>("/income/estimates", {
      method: "POST",
      body: input,
    });
  }

  updateEstimate(id: number, input: Partial<EstimateInput>) {
    return this.request<Estimate>(`/income/estimates/${id}`, {
      method: "PUT",
      body: input,
    });
  }

  deleteEstimate(id: number) {
    return this.request<void>(`/income/estimates/${id}`, { method: "DELETE" });
  }

  deliverEstimate(id: number, input: DeliveryInput) {
    return this.request<Estimate>(`/income/estimates/${id}/deliver`, {
      method: "POST",
      body: input,
    });
  }

  cancelEstimate(id: number) {
    return this.request<Estimate>(`/income/estimates/${id}/cancel`, {
      method: "POST",
    });
  }

  archiveEstimate(id: number) {
    return this.request<Estimate>(`/income/estimates/${id}/archive`, {
      method: "POST",
    });
  }

  estimatePdf(id: number) {
    return this.request<ArrayBuffer>(`/income/estimates/${id}/pdf`, {
      raw: true,
    });
  }

  // ------------------------------------------------- Stammdaten / Auswahl

  listPaymentTerms(params: ListParams = {}) {
    return this.request<PapierkramList<PaymentTerm>>("/income/payment_terms", {
      query: { ...params },
    });
  }

  listPropositions(params: ListParams = {}) {
    return this.request<PapierkramList<Proposition>>("/income/propositions", {
      query: { ...params },
    });
  }

  listProjects(params: ListParams = {}) {
    return this.request<PapierkramList<Project>>("/projects", {
      query: { ...params },
    });
  }

  /** Holt alle Seiten einer Liste ein. Nur fuer kleine Datenmengen gedacht. */
  async listAll<T>(
    fetchPage: (params: ListParams) => Promise<PapierkramList<T>>,
    options: { maxPages?: number; pageSize?: number } = {},
  ): Promise<T[]> {
    const maxPages = options.maxPages ?? 10;
    const pageSize = options.pageSize ?? 100;
    const all: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const result = await fetchPage({ page, page_size: pageSize });
      all.push(...result.entries);
      if (!result.has_more) break;
    }
    return all;
  }

  // ----------------------------------------------------------- HTTP-Kern

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const url = new URL(`${this.baseUrl}${path}`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.sleep(backoffMs(attempt, lastError));
      }

      try {
        return await this.execute<T>(method, url, path, options);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof PapierkramNetworkError ||
          (error instanceof PapierkramApiError && error.isRetryable);
        if (!retryable || attempt === this.maxRetries) throw error;
      }
    }

    throw lastError;
  }

  private async execute<T>(
    method: string,
    url: URL,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Ein von aussen uebergebenes Signal soll den Request ebenfalls abbrechen.
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: options.raw ? "application/pdf" : "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      throw new PapierkramNetworkError(
        `Papierkram nicht erreichbar (${method} ${path}).`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }

    this.trackQuota(response);

    if (!response.ok) {
      throw new PapierkramApiError({
        status: response.status,
        body: await safeBody(response),
        method,
        path,
        retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
      });
    }

    if (options.raw) {
      return (await response.arrayBuffer()) as T;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PapierkramApiError({
        status: response.status,
        body: text,
        method,
        path,
        message: `Papierkram lieferte keine gueltige JSON-Antwort bei ${path}.`,
      });
    }
  }

  private trackQuota(response: Response) {
    const header = response.headers.get("X-Remaining-Quota");
    if (header === null) return;
    const value = Number(header);
    if (Number.isFinite(value)) {
      this.remainingQuota = value;
      this.onQuota?.(value);
    }
  }
}

/** Exponentielles Backoff, respektiert Retry-After bei 429. */
export function backoffMs(attempt: number, lastError: unknown): number {
  if (
    lastError instanceof PapierkramApiError &&
    lastError.retryAfterSeconds !== null &&
    lastError.retryAfterSeconds > 0
  ) {
    return Math.min(lastError.retryAfterSeconds * 1000, 60_000);
  }
  const base = 500 * 2 ** (attempt - 1);
  return Math.min(base, 8000) + Math.floor(Math.random() * 250);
}

/** Retry-After kann Sekunden oder ein HTTP-Datum enthalten. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

async function safeBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
