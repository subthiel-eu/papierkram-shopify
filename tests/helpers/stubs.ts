import { vi } from "vitest";

import type { AdminGraphqlClient } from "~/sync/admin-client";

/** Antwort im Format, das admin.graphql() liefert. */
export function graphqlResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface AdminStub extends AdminGraphqlClient {
  calls: Array<{ query: string; variables?: Record<string, unknown> }>;
}

/**
 * Admin-Client, der Antworten anhand eines Textausschnitts der Abfrage
 * zuordnet. Das haelt die Tests lesbar, ohne die Abfragen zu duplizieren.
 */
export function adminStub(
  routes: Array<{ match: string; respond: () => Response }>,
): AdminStub {
  const calls: AdminStub["calls"] = [];

  const graphql = vi.fn(
    async (query: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: options?.variables });
      const route = routes.find((entry) => query.includes(entry.match));
      if (!route) {
        throw new Error(`Keine Stub-Antwort fuer Abfrage hinterlegt: ${query.slice(0, 80)}`);
      }
      return route.respond();
    },
  );

  return { graphql, calls };
}

/** Erfolgreiche metafieldsSet-Antwort ohne Fehler. */
export const metafieldsOk = () =>
  graphqlResponse({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });

export interface PapierkramStub {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; path: string; body: unknown }>;
}

/**
 * Papierkram-Server als Stub. Der echte Client laeuft darueber, damit
 * Serialisierung, Fehlerbehandlung und Wiederholungen mitgetestet werden.
 */
export function papierkramStub(
  handlers: Array<{
    method: string;
    path: RegExp;
    respond: (body: unknown) => { status?: number; body: unknown };
  }>,
): PapierkramStub {
  const calls: PapierkramStub["calls"] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body });

    const handler = handlers.find(
      (entry) => entry.method === method && entry.path.test(path),
    );
    if (!handler) {
      throw new Error(`Keine Stub-Antwort fuer ${method} ${path}`);
    }
    const result = handler.respond(body);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json", "X-Remaining-Quota": "9000" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/** Antwort, wie Papierkram sie nach dem Anlegen einer Rechnung liefert. */
export function invoiceResponse(overrides: Record<string, unknown> = {}) {
  return {
    type: "invoice",
    id: 501,
    name: "Shopify Bestellung #1001",
    description: null,
    document_date: "2026-03-04",
    customer_no: "K-00010",
    invoice_no: null,
    sent_on: null,
    sent_via: null,
    sent_to: null,
    paid_at_date: null,
    gross: true,
    state: "draft",
    record_state: "active",
    total_net: 104.16,
    total_vat: 19.79,
    total_gross: 123.95,
    outstanding_amount: "123.95",
    down_payment_total_gross: 0,
    billing: null,
    ...overrides,
  };
}

export function estimateResponse(overrides: Record<string, unknown> = {}) {
  return {
    type: "estimate",
    id: 601,
    name: "Shopify Bestellung #D5",
    description: null,
    document_date: "2026-03-01",
    customer_no: null,
    estimate_no: null,
    sent_on: null,
    sent_via: null,
    sent_to: null,
    gross: true,
    state: "draft",
    record_state: "active",
    total_net: 200,
    total_vat: 38,
    total_gross: 238,
    billing: null,
    ...overrides,
  };
}
