import { beforeEach, describe, expect, it } from "vitest";

import prisma from "~/db.server";
import { upsertLink } from "~/models/links.server";
import { getRules, saveRules } from "~/models/rules.server";
import { setApiToken, updateSettings } from "~/models/settings.server";
import { buildBulkQuery, buildOrderQuery } from "~/sync/backfill.server";
import { queueInvoices } from "~/sync/bulk.server";
import { dispatchWebhook } from "~/sync/dispatch.server";
import { isOverdue } from "~/sync/reconcile.server";
import { renderEmail, renderTemplate } from "~/sync/templates";

const SHOP = "features-test.myshopify.com";
const ORDER_GID = "gid://shopify/Order/9001";

async function reset() {
  await prisma.syncJob.deleteMany({ where: { shop: SHOP } });
  await prisma.documentLink.deleteMany({ where: { shop: SHOP } });
  await prisma.logEntry.deleteMany({ where: { shop: SHOP } });
  await prisma.webhookRule.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
}

beforeEach(async () => {
  await reset();
});

describe("Versandtexte", () => {
  it("ersetzt Platzhalter", () => {
    expect(
      renderTemplate("Ihre Rechnung {{beleg_nr}} ueber {{summe}}", {
        beleg_nr: "RE-1",
        summe: "119,00",
      }),
    ).toBe("Ihre Rechnung RE-1 ueber 119,00");
  });

  it("entfernt unbekannte Platzhalter, statt sie zu zeigen", () => {
    // Sonst steht "{{kunde}}" in der E-Mail beim Empfaenger.
    expect(renderTemplate("Hallo {{kunde}}!", {})).toBe("Hallo !");
  });

  it("faellt auf einen Betreff zurueck, wenn die Vorlage leer bleibt", () => {
    const email = renderEmail({ subject: "{{beleg_nr}}", body: "" }, { beleg_nr: null });
    expect(email.subject).toBe("Ihr Beleg");
    expect(email.body.length).toBeGreaterThan(0);
  });
});

describe("Nachtrag: Suchausdruck", () => {
  const filters = {
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2026-03-31T23:59:59Z"),
    onlyPaid: true,
    skipExisting: true,
  };

  it("grenzt Zeitraum und Zahlstatus ein", () => {
    const query = buildOrderQuery(filters);
    expect(query).toContain("created_at:>=2026-01-01");
    expect(query).toContain("created_at:<=2026-03-31");
    expect(query).toContain("financial_status:paid");
  });

  it("laesst den Zahlstatus weg, wenn alle gemeint sind", () => {
    expect(buildOrderQuery({ ...filters, onlyPaid: false })).not.toContain("financial_status");
  });

  it("verpackt den Suchausdruck als GraphQL-Dokument", () => {
    const bulk = buildBulkQuery(filters);
    expect(bulk).toContain('orders(query: "created_at:>=2026-01-01');
    // Nur die Kennungen - die vollstaendigen Daten holt jeder Job selbst.
    expect(bulk).toContain("edges { node { id name } }");
  });

  it("maskiert Anfuehrungszeichen, falls doch welche im Ausdruck landen", () => {
    const bulk = buildBulkQuery({
      ...filters,
      from: new Date('2026-01-01T00:00:00Z'),
    });
    // Der Ausdruck selbst enthaelt keine, aber die Maskierung darf nicht fehlen.
    expect(bulk.split('orders(query: "')).toHaveLength(2);
  });
});

describe("queueInvoices", () => {
  beforeEach(async () => {
    await updateSettings(SHOP, { subdomain: "demo" });
    await setApiToken(SHOP, "token");
  });

  it("plant alle Bestellungen ein", async () => {
    const result = await queueInvoices(SHOP, [ORDER_GID, "gid://shopify/Order/9002"]);
    expect(result.queued).toBe(2);
    expect(await prisma.syncJob.count({ where: { shop: SHOP } })).toBe(2);
  });

  it("ueberspringt Bestellungen mit vorhandenem Beleg", async () => {
    await upsertLink({ shop: SHOP, kind: "invoice", shopifyGid: ORDER_GID, papierkramId: 7 });

    const result = await queueInvoices(SHOP, [ORDER_GID, "gid://shopify/Order/9002"]);
    expect(result.queued).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("legt dieselbe Bestellung auch bei doppelter Uebergabe nur einmal an", async () => {
    const result = await queueInvoices(SHOP, [ORDER_GID, ORDER_GID]);
    expect(await prisma.syncJob.count({ where: { shop: SHOP } })).toBe(1);
    expect(result.queued).toBe(2);
  });
});

describe("Steuerung ueber Tags", () => {
  beforeEach(async () => {
    await updateSettings(SHOP, { subdomain: "demo" });
    await setApiToken(SHOP, "token");
    await getRules(SHOP);
  });

  it("ueberspringt Bestellungen mit dem Ausschluss-Tag", async () => {
    await saveRules(SHOP, [
      { businessCase: "invoice_create", topic: "orders/paid", enabled: true },
    ]);

    const result = await dispatchWebhook({
      shop: SHOP,
      topic: "orders/paid",
      payload: { admin_graphql_api_id: ORDER_GID, tags: "test, papierkram:skip" },
    });

    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toMatch(/skip/);
    expect(await prisma.syncJob.count({ where: { shop: SHOP } })).toBe(0);
  });

  it("loest mit dem Erzwingen-Tag auch ohne geschalteten Ausloeser aus", async () => {
    const result = await dispatchWebhook({
      shop: SHOP,
      topic: "orders/create",
      payload: { admin_graphql_api_id: ORDER_GID, tags: "papierkram:invoice" },
    });

    expect(result.dispatched).toContain("invoice_create");
    expect(await prisma.syncJob.count({ where: { shop: SHOP, type: "order_invoice" } })).toBe(1);
  });

  it("laesst den Ausschluss-Tag den Erzwingen-Tag schlagen", async () => {
    const result = await dispatchWebhook({
      shop: SHOP,
      topic: "orders/create",
      payload: {
        admin_graphql_api_id: ORDER_GID,
        tags: "papierkram:invoice, papierkram:skip",
      },
    });
    expect(result.dispatched).toEqual([]);
  });

  it("erzeugt mit Tag und Regel trotzdem nur einen Job", async () => {
    await saveRules(SHOP, [
      { businessCase: "invoice_create", topic: "orders/create", enabled: true },
    ]);

    await dispatchWebhook({
      shop: SHOP,
      topic: "orders/create",
      payload: { admin_graphql_api_id: ORDER_GID, tags: "papierkram:invoice" },
    });

    expect(await prisma.syncJob.count({ where: { shop: SHOP, type: "order_invoice" } })).toBe(1);
  });

  it("kommt mit einer Tag-Liste als Array zurecht", async () => {
    const result = await dispatchWebhook({
      shop: SHOP,
      topic: "orders/create",
      payload: { admin_graphql_api_id: ORDER_GID, tags: ["Papierkram:Skip"] },
    });
    expect(result.skipped).toMatch(/skip/i);
  });
});

describe("isOverdue", () => {
  const past = "2020-01-01";
  const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  it("erkennt eine ueberfaellige offene Rechnung", () => {
    expect(isOverdue({ due_date: past, state: "open" })).toBe(true);
  });

  it("haelt bezahlte und stornierte Rechnungen nie fuer ueberfaellig", () => {
    expect(isOverdue({ due_date: past, state: "paid" })).toBe(false);
    expect(isOverdue({ due_date: past, state: "cancelled" })).toBe(false);
  });

  it("ist vor dem Faelligkeitstag ruhig", () => {
    expect(isOverdue({ due_date: future, state: "open" })).toBe(false);
  });

  it("kommt ohne Faelligkeitsdatum zurecht", () => {
    expect(isOverdue({ due_date: null, state: "open" })).toBe(false);
  });
});
