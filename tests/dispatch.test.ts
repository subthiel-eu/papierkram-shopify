import { beforeEach, describe, expect, it } from "vitest";

import prisma from "~/db.server";
import { upsertLink } from "~/models/links.server";
import { getRules, saveRules, summarizeTriggers } from "~/models/rules.server";
import { setApiToken, updateSettings } from "~/models/settings.server";
import { BUSINESS_CASES } from "~/sync/business-cases";
import { dispatchWebhook } from "~/sync/dispatch.server";

const SHOP = "dispatch-test.myshopify.com";
const ORDER_GID = "gid://shopify/Order/4242";
const DRAFT_GID = "gid://shopify/DraftOrder/77";

async function reset() {
  for (const shop of [SHOP]) {
    await prisma.syncJob.deleteMany({ where: { shop } });
    await prisma.documentLink.deleteMany({ where: { shop } });
    await prisma.logEntry.deleteMany({ where: { shop } });
    await prisma.webhookRule.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
  }
}

async function connect() {
  await updateSettings(SHOP, { subdomain: "demo" });
  await setApiToken(SHOP, "test-token");
}

/** Schaltet genau eine Regel scharf. */
async function enable(
  businessCase: string,
  topic: string,
  extra: { delaySeconds?: number; mode?: "draft" | "pdf" | "email" | null } = {},
) {
  await getRules(SHOP);
  await saveRules(SHOP, [
    { businessCase, topic, enabled: true, delaySeconds: extra.delaySeconds ?? 0, mode: extra.mode ?? null },
  ]);
}

const orderPayload = { admin_graphql_api_id: ORDER_GID, name: "#4242" };

beforeEach(async () => {
  await reset();
});

describe("Voreinstellung", () => {
  it("legt fuer jede Kombination des Katalogs eine Regel an", async () => {
    const rules = await getRules(SHOP);
    const expected = BUSINESS_CASES.reduce((sum, entry) => sum + entry.topics.length, 0);
    expect(rules).toHaveLength(expected);
  });

  it("ist beim zweiten Aufruf stabil", async () => {
    const first = await getRules(SHOP);
    const second = await getRules(SHOP);
    expect(second).toHaveLength(first.length);
  });

  it("schaltet ab Werk keine Belegerzeugung scharf", async () => {
    const rules = await getRules(SHOP);
    expect(summarizeTriggers(rules, "invoice_create")).toEqual([]);
    expect(summarizeTriggers(rules, "estimate_create")).toEqual([]);
  });
});

describe("dispatchWebhook", () => {
  it("tut nichts, solange Papierkram nicht eingerichtet ist", async () => {
    await enable("invoice_create", "orders/paid");
    const result = await dispatchWebhook({ shop: SHOP, topic: "orders/paid", payload: orderPayload });

    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toMatch(/nicht eingerichtet/);
    expect(await prisma.syncJob.count({ where: { shop: SHOP } })).toBe(0);
  });

  it("ignoriert Topics, auf die kein Geschaeftsfall geschaltet ist", async () => {
    await connect();
    await getRules(SHOP);

    const result = await dispatchWebhook({ shop: SHOP, topic: "orders/paid", payload: orderPayload });
    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toMatch(/Kein Geschaeftsfall/);
  });

  it("plant die Rechnung ein, sobald der Ausloeser aktiv ist", async () => {
    await connect();
    await enable("invoice_create", "orders/paid");

    const result = await dispatchWebhook({ shop: SHOP, topic: "orders/paid", payload: orderPayload });
    expect(result.dispatched).toContain("invoice_create");

    const job = await prisma.syncJob.findFirst({ where: { shop: SHOP, type: "order_invoice" } });
    expect(job).not.toBeNull();
    expect(JSON.parse(job!.payload)).toMatchObject({ orderGid: ORDER_GID });
  });

  it("laesst dieselbe Bestellung ueber mehrere Ausloeser nur einen Beleg erzeugen", async () => {
    await connect();
    await enable("invoice_create", "orders/create");
    await enable("invoice_create", "orders/paid");

    await dispatchWebhook({ shop: SHOP, topic: "orders/create", payload: orderPayload });
    await dispatchWebhook({ shop: SHOP, topic: "orders/paid", payload: orderPayload });

    expect(await prisma.syncJob.count({ where: { shop: SHOP, type: "order_invoice" } })).toBe(1);
  });

  it("plant nichts ein, wenn die Bestellung schon einen Beleg hat", async () => {
    await connect();
    await enable("invoice_create", "orders/paid");
    await upsertLink({
      shop: SHOP,
      kind: "invoice",
      shopifyGid: ORDER_GID,
      papierkramId: 1,
    });

    const result = await dispatchWebhook({ shop: SHOP, topic: "orders/paid", payload: orderPayload });
    expect(result.dispatched).toEqual([]);
    expect(await prisma.syncJob.count({ where: { shop: SHOP, type: "order_invoice" } })).toBe(0);
  });

  it("reicht Verzoegerung und Nachbehandlung der Regel an den Job weiter", async () => {
    await connect();
    await enable("invoice_create", "orders/fulfilled", { delaySeconds: 120, mode: "email" });

    const before = Date.now();
    await dispatchWebhook({ shop: SHOP, topic: "orders/fulfilled", payload: orderPayload });

    const job = await prisma.syncJob.findFirst({ where: { shop: SHOP, type: "order_invoice" } });
    expect(JSON.parse(job!.payload).mode).toBe("email");
    expect(job!.runAfter.getTime()).toBeGreaterThanOrEqual(before + 119_000);
  });

  it("erkennt die Bestellung auch, wenn der Webhook nur ihre ID fuehrt", async () => {
    await connect();
    await enable("invoice_create", "fulfillments/create");

    await dispatchWebhook({
      shop: SHOP,
      topic: "fulfillments/create",
      // fulfillments/create traegt die eigene GID, gemeint ist die Bestellung.
      payload: { admin_graphql_api_id: "gid://shopify/Fulfillment/9", order_id: 4242 },
    });

    const job = await prisma.syncJob.findFirst({ where: { shop: SHOP, type: "order_invoice" } });
    expect(JSON.parse(job!.payload).orderGid).toBe(ORDER_GID);
  });

  it("bedient mehrere Geschaeftsfaelle am selben Topic", async () => {
    await connect();
    await enable("refund_notice", "refunds/create");
    await enable("document_refresh", "refunds/create");
    await upsertLink({
      shop: SHOP,
      kind: "invoice",
      shopifyGid: ORDER_GID,
      papierkramId: 5,
      documentNo: "RE-5",
    });

    const result = await dispatchWebhook({
      shop: SHOP,
      topic: "refunds/create",
      payload: { order_id: 4242, transactions: [{ amount: "12.50" }] },
    });

    expect(result.dispatched.sort()).toEqual(["document_refresh", "refund_notice"]);
    const warning = await prisma.logEntry.findFirst({
      where: { shop: SHOP, action: "refund.received" },
    });
    expect(warning?.message).toContain("12.50");
    expect(warning?.message).toContain("RE-5");
  });

  it("meldet eine Erstattung nur, wenn es dazu einen Beleg gibt", async () => {
    await connect();
    await enable("refund_notice", "refunds/create");

    const result = await dispatchWebhook({
      shop: SHOP,
      topic: "refunds/create",
      payload: { order_id: 4242, transactions: [{ amount: "12.50" }] },
    });
    expect(result.dispatched).toEqual([]);
    expect(await prisma.logEntry.count({ where: { shop: SHOP, action: "refund.received" } })).toBe(0);
  });

  it("erzeugt kein Angebot fuer abgeschlossene Entwuerfe", async () => {
    await connect();
    await enable("estimate_create", "draft_orders/update");

    const completed = await dispatchWebhook({
      shop: SHOP,
      topic: "draft_orders/update",
      payload: { admin_graphql_api_id: DRAFT_GID, status: "COMPLETED" },
    });
    expect(completed.dispatched).toEqual([]);

    const converted = await dispatchWebhook({
      shop: SHOP,
      topic: "draft_orders/update",
      payload: { admin_graphql_api_id: DRAFT_GID, order_id: 999 },
    });
    expect(converted.dispatched).toEqual([]);

    const open = await dispatchWebhook({
      shop: SHOP,
      topic: "draft_orders/update",
      payload: { admin_graphql_api_id: DRAFT_GID, status: "OPEN" },
    });
    expect(open.dispatched).toContain("estimate_create");
  });

  it("holt den Belegstatus nur fuer verknuepfte Objekte", async () => {
    await connect();
    await enable("document_refresh", "orders/updated");

    const withoutLink = await dispatchWebhook({
      shop: SHOP,
      topic: "orders/updated",
      payload: orderPayload,
    });
    expect(withoutLink.dispatched).toEqual([]);

    await upsertLink({ shop: SHOP, kind: "invoice", shopifyGid: ORDER_GID, papierkramId: 3 });

    const withLink = await dispatchWebhook({
      shop: SHOP,
      topic: "orders/updated",
      payload: orderPayload,
    });
    expect(withLink.dispatched).toContain("document_refresh");
  });

  it("ignoriert Webhooks ohne verwertbares Objekt", async () => {
    await connect();
    await enable("invoice_create", "orders/paid");

    const result = await dispatchWebhook({ shop: SHOP, topic: "orders/paid", payload: {} });
    expect(result.skipped).toMatch(/Kein Shopify-Objekt/);
  });
});

describe("saveRules", () => {
  it("verwirft Kombinationen, die der Katalog nicht vorsieht", async () => {
    await getRules(SHOP);
    const count = await saveRules(SHOP, [
      { businessCase: "invoice_create", topic: "customers/create", enabled: true },
      { businessCase: "erfunden", topic: "orders/paid", enabled: true },
    ]);
    expect(count).toBe(0);
  });

  it("begrenzt unsinnige Verzoegerungen", async () => {
    await getRules(SHOP);
    await saveRules(SHOP, [
      { businessCase: "invoice_create", topic: "orders/paid", enabled: true, delaySeconds: -5 },
      { businessCase: "invoice_create", topic: "orders/create", enabled: true, delaySeconds: 999_999 },
    ]);
    const rules = await getRules(SHOP);
    const paid = rules.find((rule) => rule.topic === "orders/paid" && rule.businessCase === "invoice_create");
    const created = rules.find((rule) => rule.topic === "orders/create" && rule.businessCase === "invoice_create");
    expect(paid?.delaySeconds).toBe(0);
    expect(created?.delaySeconds).toBe(86_400);
  });
});
