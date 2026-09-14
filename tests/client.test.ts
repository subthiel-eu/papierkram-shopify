import { describe, expect, it, vi } from "vitest";

import { PapierkramClient } from "~/papierkram/client.server";
import {
  PapierkramApiError,
  PapierkramNetworkError,
  PapierkramNotConfiguredError,
  extractMessage,
} from "~/papierkram/errors";

type FetchArgs = [url: string, init?: RequestInit];

/** Typisierter fetch-Ersatz, damit mock.calls korrekt typisiert ist. */
const mockFetch = (impl: (...args: FetchArgs) => Promise<Response>) => vi.fn(impl);

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeClient(fetchImpl: typeof fetch, overrides = {}) {
  return new PapierkramClient({
    subdomain: "demo",
    apiToken: "geheim",
    fetchImpl,
    // Tests sollen nicht wirklich warten.
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

describe("Konfiguration", () => {
  it("verlangt Subdomain und Token", () => {
    expect(() => new PapierkramClient({ subdomain: "", apiToken: "x" })).toThrow(
      PapierkramNotConfiguredError,
    );
    expect(() => new PapierkramClient({ subdomain: "demo", apiToken: "  " })).toThrow(
      PapierkramNotConfiguredError,
    );
  });

  it("baut die mandantenspezifische Basis-URL", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ api: { version: "1.0.0" } }));
    await makeClient(fetchImpl as unknown as typeof fetch).info();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://demo.papierkram.de/api/v1/info");
  });

  it("erzeugt Deep-Links in die Oberflaeche", () => {
    const client = makeClient((async () => jsonResponse({})) as unknown as typeof fetch);
    expect(client.documentUrl("invoice", 7)).toBe(
      "https://demo.papierkram.de/income/invoices/7",
    );
    expect(client.documentUrl("estimate", 7)).toBe(
      "https://demo.papierkram.de/income/estimates/7",
    );
    expect(client.documentUrl("company", 7)).toBe(
      "https://demo.papierkram.de/contacts/companies/7",
    );
  });
});

describe("Anfragen", () => {
  it("sendet den Bearer-Token", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ api: { version: "1.0.0" } }));
    await makeClient(fetchImpl as unknown as typeof fetch).info();
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer geheim");
  });

  it("haengt Listenparameter an, laesst leere aber weg", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ entries: [], has_more: false }));
    await makeClient(fetchImpl as unknown as typeof fetch).listInvoices({
      page: 2,
      page_size: 50,
      company_id: undefined,
    });
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("page_size")).toBe("50");
    expect(url.searchParams.has("company_id")).toBe(false);
  });

  it("sendet den Rumpf als JSON", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ id: 1 }, { status: 201 }));
    await makeClient(fetchImpl as unknown as typeof fetch).createInvoice({
      name: "Test",
      payment_term: { id: 1 },
      line_items: [],
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "Test" });
  });

  it("liest das Monatskontingent aus dem Header", async () => {
    const seen: number[] = [];
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ api: { version: "1.0.0" } }, { headers: { "X-Remaining-Quota": "9876" } }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      onQuota: (value: number) => seen.push(value),
    });
    await client.info();
    expect(client.remainingQuota).toBe(9876);
    expect(seen).toEqual([9876]);
  });
});

describe("Fehler und Wiederholungen", () => {
  it("wirft einen API-Fehler mit Meldung aus dem Rumpf", async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ errors: { name: ["muss ausgefuellt werden"] } }, { status: 422 }),
    );
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).getInvoice(1),
    ).rejects.toThrowError(/name: muss ausgefuellt werden/);
  });

  it("wiederholt 429 und liefert danach das Ergebnis", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({ error: "zu viele Anfragen" }, {
          status: 429,
          headers: { "Retry-After": "1" },
        });
      }
      return jsonResponse({ id: 5, type: "invoice" });
    });

    const invoice = await makeClient(fetchImpl as unknown as typeof fetch).getInvoice(5);
    expect(calls).toBe(2);
    expect(invoice.id).toBe(5);
  });

  it("wiederholt 4xx ausser 429 nicht", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ error: "weg" }, { status: 404 }));
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).getInvoice(1),
    ).rejects.toSatisfy((error: unknown) => error instanceof PapierkramApiError && error.isNotFound);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gibt nach erschoepften Versuchen auf", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ error: "kaputt" }, { status: 500 }));
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch, { maxRetries: 2 }).getInvoice(1),
    ).rejects.toThrow(PapierkramApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("verpackt Netzwerkfehler", async () => {
    const fetchImpl = mockFetch(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch, { maxRetries: 0 }).info(),
    ).rejects.toThrow(PapierkramNetworkError);
  });

  it("erkennt Authentifizierungsfehler", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ error: "unauthorized" }, { status: 401 }));
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).info(),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof PapierkramApiError && error.isAuthError,
    );
  });
});

describe("extractMessage", () => {
  it("liest die gaengigen Fehlerformate", () => {
    expect(extractMessage({ error: "kaputt" })).toBe("kaputt");
    expect(extractMessage({ message: "kaputt" })).toBe("kaputt");
    expect(extractMessage({ errors: ["a", "b"] })).toBe("a; b");
    expect(extractMessage({ errors: { name: ["fehlt"] } })).toBe("name: fehlt");
    expect(extractMessage("Textfehler")).toBe("Textfehler");
    expect(extractMessage(null)).toBeNull();
  });
});

describe("Seitenweises Lesen", () => {
  it("folgt has_more ueber mehrere Seiten", async () => {
    const pages = [
      { entries: [{ id: 1 }], has_more: true },
      { entries: [{ id: 2 }], has_more: false },
    ];
    let call = 0;
    const fetchImpl = mockFetch(async () => jsonResponse(pages[call++]));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const all = await client.listAll((params) => client.listProjects(params));
    expect(all.map((entry) => (entry as { id: number }).id)).toEqual([1, 2]);
  });

  it("findet ein Unternehmen anhand der E-Mail", async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({
        entries: [
          { id: 1, email: "andere@example.com" },
          { id: 2, email: "Erika@Example.com" },
        ],
        has_more: false,
      }),
    );
    const found = await makeClient(fetchImpl as unknown as typeof fetch).findCompanyByEmail(
      "erika@example.com",
    );
    expect(found?.id).toBe(2);
  });

  it("liefert null, wenn nichts passt", async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ entries: [], has_more: false }));
    expect(
      await makeClient(fetchImpl as unknown as typeof fetch).findCompanyByEmail("x@y.de"),
    ).toBeNull();
  });
});
