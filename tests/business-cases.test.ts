import { describe, expect, it } from "vitest";

import {
  BUSINESS_CASES,
  DEFAULT_ENABLED,
  allTopics,
  findBusinessCase,
  isKnownPair,
  subjectGid,
  subjectOf,
  topicFromEvent,
} from "~/sync/business-cases";

describe("Katalog", () => {
  it("kennt jeden Geschaeftsfall genau einmal", () => {
    const keys = BUSINESS_CASES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gibt jedem Fall mindestens einen moeglichen Ausloeser", () => {
    for (const businessCase of BUSINESS_CASES) {
      expect(businessCase.topics.length).toBeGreaterThan(0);
    }
  });

  it("listet jedes Topic nur einmal auf", () => {
    const topics = allTopics();
    expect(new Set(topics).size).toBe(topics.length);
  });

  it("verweist in den Voreinstellungen nur auf gueltige Kombinationen", () => {
    for (const preset of DEFAULT_ENABLED) {
      expect(isKnownPair(preset.businessCase, preset.topic)).toBe(true);
    }
  });

  it("aktiviert ab Werk nichts, was Belege erzeugt", () => {
    const creating = DEFAULT_ENABLED.filter((preset) =>
      ["invoice_create", "estimate_create"].includes(preset.businessCase),
    );
    expect(creating).toEqual([]);
  });

  it("weist nur Belegfaellen eine Nachbehandlung zu", () => {
    expect(findBusinessCase("invoice_create")?.supportsMode).toBe(true);
    expect(findBusinessCase("estimate_create")?.supportsMode).toBe(true);
    expect(findBusinessCase("customer_sync")?.supportsMode).toBe(false);
    expect(findBusinessCase("document_refresh")?.supportsMode).toBe(false);
  });
});

describe("topicFromEvent", () => {
  it("uebersetzt die Schreibweise von authenticate.webhook()", () => {
    expect(topicFromEvent("ORDERS_CREATE")).toBe("orders/create");
    expect(topicFromEvent("ORDERS_PARTIALLY_FULFILLED")).toBe("orders/partially_fulfilled");
    expect(topicFromEvent("FULFILLMENTS_CREATE")).toBe("fulfillments/create");
  });

  it("teilt zusammengesetzte Ressourcennamen korrekt auf", () => {
    // Eine naive Ersetzung des ersten Unterstrichs ergaebe "draft/orders_create".
    expect(topicFromEvent("DRAFT_ORDERS_CREATE")).toBe("draft_orders/create");
    expect(topicFromEvent("DRAFT_ORDERS_UPDATE")).toBe("draft_orders/update");
  });

  it("liefert null fuer unbekannte Topics", () => {
    expect(topicFromEvent("PRODUCTS_CREATE")).toBeNull();
  });

  it("deckt jedes Topic des Katalogs ab", () => {
    for (const businessCase of BUSINESS_CASES) {
      for (const topic of businessCase.topics) {
        expect(topicFromEvent(topic.event)).toBe(topic.topic);
      }
    }
  });
});

describe("isKnownPair", () => {
  it("erkennt gueltige Kombinationen", () => {
    expect(isKnownPair("invoice_create", "orders/paid")).toBe(true);
  });

  it("weist unsinnige Kombinationen ab", () => {
    expect(isKnownPair("invoice_create", "customers/create")).toBe(false);
    expect(isKnownPair("erfunden", "orders/paid")).toBe(false);
  });
});

describe("subjectOf und subjectGid", () => {
  it("ordnet Topics dem richtigen Objekttyp zu", () => {
    expect(subjectOf("orders/paid")).toBe("order");
    expect(subjectOf("fulfillments/create")).toBe("order");
    expect(subjectOf("draft_orders/create")).toBe("draft_order");
    expect(subjectOf("customers/update")).toBe("customer");
    expect(subjectOf("products/create")).toBeNull();
  });

  it("liest die GID aus admin_graphql_api_id", () => {
    expect(
      subjectGid("orders/paid", { admin_graphql_api_id: "gid://shopify/Order/7" }),
    ).toBe("gid://shopify/Order/7");
  });

  it("baut die Bestell-GID fuer Erstattungen und Lieferungen", () => {
    // Diese Webhooks tragen die ID der Bestellung, nicht ihre eigene GID.
    expect(subjectGid("refunds/create", { order_id: 7, admin_graphql_api_id: "gid://shopify/Refund/9" }))
      .toBe("gid://shopify/Order/7");
    expect(subjectGid("fulfillments/create", { order_id: 7 })).toBe("gid://shopify/Order/7");
  });

  it("liefert null, wenn nichts Verwertbares im Rumpf steht", () => {
    expect(subjectGid("orders/paid", {})).toBeNull();
    expect(subjectGid("refunds/create", {})).toBeNull();
    expect(subjectGid("orders/paid", null)).toBeNull();
  });
});
