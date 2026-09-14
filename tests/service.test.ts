import { beforeEach, describe, expect, it } from "vitest";

import prisma from "~/db.server";
import { LinkInProgressError, findLink, reserveLink } from "~/models/links.server";
import { getSettings, updateSettings, setApiToken } from "~/models/settings.server";
import { PapierkramClient } from "~/papierkram/client.server";
import { CurrencyMismatchError } from "~/sync/mapper";
import {
  createEstimateForDraftOrder,
  createInvoiceForOrder,
  type SyncContext,
} from "~/sync/service.server";

import { draftOrder, grossOrder } from "./fixtures";
import {
  adminStub,
  estimateResponse,
  graphqlResponse,
  invoiceResponse,
  metafieldsOk,
  papierkramStub,
  type AdminStub,
  type PapierkramStub,
} from "./helpers/stubs";

const SHOP = "service-test.myshopify.com";
const ORDER_GID = "gid://shopify/Order/1001";
const DRAFT_GID = "gid://shopify/DraftOrder/500";

async function reset() {
  await prisma.syncJob.deleteMany({ where: { shop: SHOP } });
  await prisma.documentLink.deleteMany({ where: { shop: SHOP } });
  await prisma.logEntry.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
}

/** Baut einen Kontext mit echtem Client ueber einem Papierkram-Stub. */
async function buildTestContext(options: {
  admin: AdminStub;
  papierkram: PapierkramStub;
}): Promise<SyncContext> {
  const settings = await getSettings(SHOP);
  const client = new PapierkramClient({
    subdomain: "demo",
    apiToken: "token",
    fetchImpl: options.papierkram.fetchImpl,
    sleep: () => Promise.resolve(),
  });
  return { shop: SHOP, admin: options.admin, settings, client };
}

/** Standard-Stubs: Bestellung laden, Metafelder schreiben, Rechnung anlegen. */
function defaultStubs(order = grossOrder()) {
  const admin = adminStub([
    { match: "PapierkramOrder", respond: () => graphqlResponse({ data: { order } }) },
    { match: "PapierkramDraftOrder", respond: () => graphqlResponse({ data: { draftOrder: draftOrder() } }) },
    { match: "PapierkramMetafieldsSet", respond: metafieldsOk },
  ]);
  const papierkram = papierkramStub([
    { method: "POST", path: /^\/income\/invoices$/, respond: () => ({ status: 201, body: invoiceResponse() }) },
    { method: "POST", path: /^\/income\/estimates$/, respond: () => ({ status: 201, body: estimateResponse() }) },
    { method: "GET", path: /^\/income\/invoices\/\d+$/, respond: () => ({ body: invoiceResponse() }) },
    { method: "GET", path: /^\/contact\/companies$/, respond: () => ({ body: { entries: [], has_more: false } }) },
    { method: "POST", path: /^\/contact\/companies$/, respond: () => ({ status: 201, body: { type: "company", id: 900, name: "Muster GmbH", customer_no: "K-1" } }) },
  ]);
  return { admin, papierkram };
}

beforeEach(async () => {
  await reset();
  await updateSettings(SHOP, { subdomain: "demo", paymentTermId: 42 });
  await setApiToken(SHOP, "token");
});

describe("createInvoiceForOrder", () => {
  it("legt die Rechnung an und verknuepft sie mit der Bestellung", async () => {
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    const result = await createInvoiceForOrder(context, ORDER_GID);

    expect(result.reused).toBe(false);
    expect(result.invoice.id).toBe(501);

    const link = await findLink(SHOP, "invoice", ORDER_GID);
    expect(link?.papierkramId).toBe(501);
    expect(link?.state).toBe("draft");
    expect(link?.currency).toBe("EUR");
  });

  it("uebergibt Zahlungsbedingung und Positionen an Papierkram", async () => {
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    await createInvoiceForOrder(context, ORDER_GID);

    const call = papierkram.calls.find((entry) => entry.path === "/income/invoices");
    const body = call!.body as Record<string, unknown>;
    expect(body.payment_term).toEqual({ id: 42 });
    expect(body.gross).toBe(true);
    expect((body.line_items as unknown[]).length).toBe(2);
  });

  it("bricht ohne Zahlungsbedingung mit klarer Meldung ab", async () => {
    await updateSettings(SHOP, { paymentTermId: null });
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    await expect(createInvoiceForOrder(context, ORDER_GID)).rejects.toThrow(
      /Zahlungsbedingung/,
    );
    // Ohne Zahlungsbedingung darf kein Beleg entstehen.
    expect(papierkram.calls.some((entry) => entry.path === "/income/invoices")).toBe(false);
  });

  it("verweigert Bestellungen in fremder Waehrung", async () => {
    const { admin, papierkram } = defaultStubs(grossOrder({ currencyCode: "USD" }));
    const context = await buildTestContext({ admin, papierkram });

    await expect(createInvoiceForOrder(context, ORDER_GID)).rejects.toThrow(
      CurrencyMismatchError,
    );
    expect(papierkram.calls.some((entry) => entry.path === "/income/invoices")).toBe(false);
  });

  it("legt bei fremder Waehrung nach Freigabe an und warnt", async () => {
    await updateSettings(SHOP, { allowForeignCurrency: true });
    const { admin, papierkram } = defaultStubs(grossOrder({ currencyCode: "USD" }));
    const context = await buildTestContext({ admin, papierkram });

    const result = await createInvoiceForOrder(context, ORDER_GID);
    expect(result.warnings.join(" ")).toContain("nicht umgerechnet");
  });

  it("erzeugt beim zweiten Aufruf keinen zweiten Beleg", async () => {
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    await createInvoiceForOrder(context, ORDER_GID);
    const second = await createInvoiceForOrder(context, ORDER_GID);

    expect(second.reused).toBe(true);
    const created = papierkram.calls.filter((entry) => entry.path === "/income/invoices");
    expect(created).toHaveLength(1);
  });

  it("weist einen parallelen Versuch ab, statt doppelt anzulegen", async () => {
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    // So sieht es aus, wenn ein anderer Vorgang gerade mittendrin ist.
    await reserveLink({ shop: SHOP, kind: "invoice", shopifyGid: ORDER_GID });

    await expect(createInvoiceForOrder(context, ORDER_GID)).rejects.toThrow(
      LinkInProgressError,
    );
    expect(papierkram.calls.some((entry) => entry.path === "/income/invoices")).toBe(false);
  });

  it("gibt die Reservierung frei, wenn Papierkram ablehnt", async () => {
    const admin = adminStub([
      { match: "PapierkramOrder", respond: () => graphqlResponse({ data: { order: grossOrder() } }) },
      { match: "PapierkramMetafieldsSet", respond: metafieldsOk },
    ]);
    const papierkram = papierkramStub([
      { method: "GET", path: /^\/contact\/companies$/, respond: () => ({ body: { entries: [], has_more: false } }) },
      { method: "POST", path: /^\/contact\/companies$/, respond: () => ({ status: 201, body: { type: "company", id: 900, name: "X", customer_no: null } }) },
      {
        method: "POST",
        path: /^\/income\/invoices$/,
        respond: () => ({ status: 422, body: { errors: { name: ["ist erforderlich"] } } }),
      },
    ]);
    const context = await buildTestContext({ admin, papierkram });

    await expect(createInvoiceForOrder(context, ORDER_GID)).rejects.toThrow(/name/);

    // Sonst bliebe die Bestellung dauerhaft blockiert.
    expect(await findLink(SHOP, "invoice", ORDER_GID)).toBeNull();
  });

  it("warnt, wenn die Belegsumme von Shopify abweicht", async () => {
    const admin = adminStub([
      { match: "PapierkramOrder", respond: () => graphqlResponse({ data: { order: grossOrder() } }) },
      { match: "PapierkramMetafieldsSet", respond: metafieldsOk },
    ]);
    const papierkram = papierkramStub([
      { method: "GET", path: /^\/contact\/companies$/, respond: () => ({ body: { entries: [], has_more: false } }) },
      { method: "POST", path: /^\/contact\/companies$/, respond: () => ({ status: 201, body: { type: "company", id: 900, name: "X", customer_no: null } }) },
      {
        method: "POST",
        path: /^\/income\/invoices$/,
        respond: () => ({ status: 201, body: invoiceResponse({ total_gross: 99.0 }) }),
      },
    ]);
    const context = await buildTestContext({ admin, papierkram });

    const result = await createInvoiceForOrder(context, ORDER_GID);
    expect(result.warnings.join(" ")).toMatch(/weicht von der Shopify-Summe/);
  });

  it("legt den Kontakt an und haengt ihn an die Rechnung", async () => {
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    await createInvoiceForOrder(context, ORDER_GID);

    const body = papierkram.calls.find((entry) => entry.path === "/income/invoices")!
      .body as Record<string, unknown>;
    expect(body.customer).toMatchObject({ id: 900 });
    expect(await findLink(SHOP, "company", "gid://shopify/Customer/1")).not.toBeNull();
  });
});

describe("Metafelder", () => {
  it("schreibt sie beim Anlegen", async () => {
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    await createInvoiceForOrder(context, ORDER_GID);

    const writes = admin.calls.filter((call) => call.query.includes("PapierkramMetafieldsSet"));
    expect(writes.length).toBeGreaterThan(0);
  });

  it("schreibt sie nicht erneut, wenn sich nichts geaendert hat", async () => {
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    await createInvoiceForOrder(context, ORDER_GID);
    const afterFirst = admin.calls.filter((call) =>
      call.query.includes("PapierkramMetafieldsSet"),
    ).length;

    // Zweiter Aufruf liest den Beleg nur erneut - gleiche Werte, kein Schreiben.
    await createInvoiceForOrder(context, ORDER_GID);
    const afterSecond = admin.calls.filter((call) =>
      call.query.includes("PapierkramMetafieldsSet"),
    ).length;

    // Sonst loest jeder Statusabgleich orders/updated aus und damit den naechsten.
    expect(afterSecond).toBe(afterFirst);
  });

  it("laesst sich abschalten", async () => {
    await updateSettings(SHOP, { writeMetafields: false });
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    await createInvoiceForOrder(context, ORDER_GID);

    expect(
      admin.calls.filter((call) => call.query.includes("PapierkramMetafieldsSet")),
    ).toHaveLength(0);
  });
});

describe("createEstimateForDraftOrder", () => {
  it("legt das Angebot an und verknuepft es", async () => {
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    const result = await createEstimateForDraftOrder(context, DRAFT_GID);

    expect(result.estimate.id).toBe(601);
    const link = await findLink(SHOP, "estimate", DRAFT_GID);
    expect(link?.papierkramId).toBe(601);
  });

  it("braucht keine Zahlungsbedingung", async () => {
    await updateSettings(SHOP, { paymentTermId: null });
    const { admin, papierkram } = defaultStubs();
    const context = await buildTestContext({ admin, papierkram });

    await expect(createEstimateForDraftOrder(context, DRAFT_GID)).resolves.toBeTruthy();
  });
});
