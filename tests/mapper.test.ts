import { describe, expect, it } from "vitest";

import {
  CurrencyMismatchError,
  DEFAULT_MAPPING_SETTINGS,
  assertCurrency,
  buildLineItem,
  estimateDocumentTotals,
  mapCustomerToCompany,
  mapDraftOrderToEstimate,
  mapOrderToInvoice,
  renderDocumentName,
  resolveContactName,
  resolveGross,
  resolveVatRate,
  vatFraction,
} from "~/sync/mapper";

import { address, customer, draftOrder, grossOrder, netOrder } from "./fixtures";

const settings = { ...DEFAULT_MAPPING_SETTINGS, paymentTermId: 42 };

describe("resolveVatRate", () => {
  it("nimmt den Satz aus der Steuerzeile", () => {
    expect(
      resolveVatRate([{ title: "MwSt", rate: 0.19, ratePercentage: 19, priceSet: null }], {
        orderHasTax: true,
        defaultVatRate: 7,
      }),
    ).toBe(0.19);
  });

  it("faellt auf ratePercentage zurueck, wenn rate fehlt", () => {
    expect(
      resolveVatRate([{ title: "MwSt", rate: null, ratePercentage: 7, priceSet: null }], {
        orderHasTax: true,
        defaultVatRate: 19,
      }),
    ).toBe(0.07);
  });

  it("addiert mehrere Steuerzeilen zu einem Satz", () => {
    const rate = resolveVatRate(
      [
        { title: "State", rate: 0.06, ratePercentage: 6, priceSet: null },
        { title: "County", rate: 0.02, ratePercentage: 2, priceSet: null },
      ],
      { orderHasTax: true, defaultVatRate: 19 },
    );
    expect(rate).toBeCloseTo(0.08, 6);
  });

  it("liefert 0 % fuer steuerfreie Bestellungen statt des Standardsatzes", () => {
    expect(resolveVatRate([], { orderHasTax: false, defaultVatRate: 19 })).toBe(0);
  });

  it("nutzt den Standardsatz nur, wenn die Bestellung Steuern enthaelt", () => {
    expect(resolveVatRate([], { orderHasTax: true, defaultVatRate: 19 })).toBe(0.19);
  });
});

describe("vatFraction", () => {
  it("wandelt Prozent in den von Papierkram erwarteten Dezimalbruch", () => {
    expect(vatFraction(19)).toBe(0.19);
    expect(vatFraction(7)).toBe(0.07);
    expect(vatFraction(0)).toBe(0);
  });
});

describe("resolveGross", () => {
  it("folgt im Automatikmodus der Shop-Einstellung", () => {
    expect(resolveGross({ grossMode: "auto" }, true)).toBe(true);
    expect(resolveGross({ grossMode: "auto" }, false)).toBe(false);
  });

  it("erzwingt die konfigurierte Preisbasis", () => {
    expect(resolveGross({ grossMode: "gross" }, false)).toBe(true);
    expect(resolveGross({ grossMode: "net" }, true)).toBe(false);
  });
});

describe("buildLineItem", () => {
  it("uebernimmt Bruttopreise ohne Umrechnung", () => {
    const item = buildLineItem({
      name: "Test",
      quantity: 2,
      unitAmount: 119,
      discountTotal: 0,
      vatRate: 0.19,
      sourceBasis: "gross",
      targetBasis: "gross",
      applyDiscounts: true,
    });
    expect(item.price_gross).toBe(119);
    expect(item.price).toBeUndefined();
  });

  it("rechnet Brutto in Netto um, wenn der Beleg netto gefuehrt wird", () => {
    const item = buildLineItem({
      name: "Test",
      quantity: 1,
      unitAmount: 119,
      discountTotal: 0,
      vatRate: 0.19,
      sourceBasis: "gross",
      targetBasis: "net",
      applyDiscounts: true,
    });
    expect(item.price).toBe(100);
  });

  it("verteilt den Positionsrabatt auf die Einheit", () => {
    const item = buildLineItem({
      name: "Test",
      quantity: 4,
      unitAmount: 25,
      discountTotal: 20,
      vatRate: 0.19,
      sourceBasis: "net",
      targetBasis: "net",
      applyDiscounts: true,
    });
    expect(item.discount_calculated).toBe(5);
    expect(item.price).toBe(25);
  });

  it("rechnet den Rabatt in den Preis ein, wenn er nicht ausgewiesen werden soll", () => {
    const item = buildLineItem({
      name: "Test",
      quantity: 4,
      unitAmount: 25,
      discountTotal: 20,
      vatRate: 0.19,
      sourceBasis: "net",
      targetBasis: "net",
      applyDiscounts: false,
    });
    expect(item.price).toBe(20);
    expect(item.discount_calculated).toBeUndefined();
  });
});

describe("mapOrderToInvoice", () => {
  it("bildet eine Bruttobestellung 1:1 ab", () => {
    const { invoice } = mapOrderToInvoice({
      order: grossOrder(),
      settings,
      shopDomain: "demo.myshopify.com",
      customerId: 77,
    });

    expect(invoice.gross).toBe(true);
    expect(invoice.customer).toEqual({ id: 77 });
    expect(invoice.payment_term).toEqual({ id: 42 });
    expect(invoice.name).toBe("Shopify Bestellung #1001");
    expect(invoice.document_date).toBe("2026-03-04");

    expect(invoice.line_items).toHaveLength(2);
    const [item, shipping] = invoice.line_items;
    expect(item.price_gross).toBe(59.5);
    expect(item.quantity).toBe(2);
    expect(item.vat_rate).toBe(0.19);
    expect(item.description).toBe("1 kg | Art.-Nr. KB-1000");
    expect(shipping.name).toBe("Standardversand");
    expect(shipping.price_gross).toBe(4.95);
  });

  it("trifft die Shopify-Summe exakt", () => {
    const order = grossOrder();
    const { invoice } = mapOrderToInvoice({
      order,
      settings,
      shopDomain: "demo.myshopify.com",
    });
    const totals = estimateDocumentTotals(invoice.line_items, invoice.gross === true);
    expect(totals.gross).toBe(Number(order.totalPriceSet.shopMoney.amount));
  });

  it("uebernimmt Nettopreise ohne Aufschlag", () => {
    const { invoice } = mapOrderToInvoice({
      order: netOrder(),
      settings,
      shopDomain: "demo.myshopify.com",
    });
    expect(invoice.gross).toBe(false);
    expect(invoice.line_items[0].price).toBe(60);
    expect(invoice.line_items[0].price_gross).toBeUndefined();
  });

  it("uebernimmt Rabatte als Rabatt je Einheit", () => {
    const order = grossOrder();
    order.lineItems.nodes[0].discountAllocations = [
      { allocatedAmountSet: { shopMoney: { amount: "11.90", currencyCode: "EUR" } } },
    ];
    const { invoice } = mapOrderToInvoice({
      order,
      settings,
      shopDomain: "demo.myshopify.com",
    });
    expect(invoice.line_items[0].discount_calculated_gross).toBe(5.95);
  });

  it("laesst vollstaendig stornierte Positionen weg und warnt", () => {
    const order = grossOrder();
    order.lineItems.nodes[0].currentQuantity = 0;
    const { invoice, warnings } = mapOrderToInvoice({
      order,
      settings,
      shopDomain: "demo.myshopify.com",
    });
    expect(invoice.line_items.map((item) => item.name)).toEqual(["Standardversand"]);
    expect(warnings.join(" ")).toContain("storniert");
  });

  it("rechnet Teilstornos anteilig ab", () => {
    const order = grossOrder();
    order.lineItems.nodes[0].currentQuantity = 1;
    order.lineItems.nodes[0].discountAllocations = [
      { allocatedAmountSet: { shopMoney: { amount: "11.90", currencyCode: "EUR" } } },
    ];
    const { invoice, warnings } = mapOrderToInvoice({
      order,
      settings,
      shopDomain: "demo.myshopify.com",
    });
    expect(invoice.line_items[0].quantity).toBe(1);
    // Der Rabatt galt fuer 2 Stueck, je Einheit bleibt er gleich.
    expect(invoice.line_items[0].discount_calculated_gross).toBe(5.95);
    expect(warnings.join(" ")).toContain("Teilstorno");
  });

  it("setzt 0 % USt fuer steuerfreie Bestellungen", () => {
    const order = grossOrder();
    order.totalTaxSet = { shopMoney: { amount: "0.00", currencyCode: "EUR" } };
    order.lineItems.nodes[0].taxLines = [];
    order.shippingLines.nodes[0].taxLines = [];
    const { invoice } = mapOrderToInvoice({
      order,
      settings,
      shopDomain: "demo.myshopify.com",
    });
    expect(invoice.line_items.every((item) => item.vat_rate === 0)).toBe(true);
  });

  it("nimmt Versand und Trinkgeld nur bei aktivierter Einstellung auf", () => {
    const order = grossOrder();
    order.totalTipReceivedSet = { shopMoney: { amount: "5.00", currencyCode: "EUR" } };

    const withExtras = mapOrderToInvoice({
      order,
      settings,
      shopDomain: "demo.myshopify.com",
    });
    expect(withExtras.invoice.line_items.map((item) => item.name)).toContain("Trinkgeld");

    const without = mapOrderToInvoice({
      order,
      settings: { ...settings, includeShipping: false, includeTips: false },
      shopDomain: "demo.myshopify.com",
    });
    expect(without.invoice.line_items).toHaveLength(1);
  });

  it("verknuepft hinterlegte Papierkram-Positionen", () => {
    const { invoice } = mapOrderToInvoice({
      order: grossOrder(),
      settings,
      shopDomain: "demo.myshopify.com",
      propositions: new Map([["gid://shopify/ProductVariant/1", 909]]),
    });
    expect(invoice.line_items[0].proposition).toEqual({ id: 909 });
  });

  it("uebernimmt die Rechnungsanschrift", () => {
    const { invoice } = mapOrderToInvoice({
      order: grossOrder(),
      settings,
      shopDomain: "demo.myshopify.com",
    });
    expect(invoice.billing).toMatchObject({
      company: "Muster GmbH",
      contact_person: "Erika Mustermann",
      street: "Musterstrasse 1",
      zip: "12345",
      city: "Musterstadt",
      email: "erika@example.com",
    });
  });
});

describe("mapDraftOrderToEstimate", () => {
  it("bildet einen Entwurf als Angebot ab", () => {
    const { estimate } = mapDraftOrderToEstimate({
      draftOrder: draftOrder(),
      settings,
      shopDomain: "demo.myshopify.com",
      customerId: 5,
    });

    expect(estimate.gross).toBe(true);
    expect(estimate.customer).toEqual({ id: 5 });
    expect(estimate.description).toBe("Angebot fuer Grossbestellung");
    expect(estimate.line_items).toHaveLength(1);
    expect(estimate.line_items[0].quantity).toBe(4);
    expect(estimate.line_items[0].price_gross).toBe(59.5);
  });

  it("leitet den Rabatt aus dem reduzierten Stueckpreis ab", () => {
    const draft = draftOrder();
    draft.lineItems.nodes[0].discountedUnitPriceSet = {
      shopMoney: { amount: "50.00", currencyCode: "EUR" },
    };
    const { estimate } = mapDraftOrderToEstimate({
      draftOrder: draft,
      settings,
      shopDomain: "demo.myshopify.com",
    });
    expect(estimate.line_items[0].discount_calculated_gross).toBe(9.5);
  });
});

describe("renderDocumentName", () => {
  it("ersetzt alle bekannten Platzhalter", () => {
    expect(
      renderDocumentName("{{shop}} / {{order_number}} fuer {{customer}}", {
        shop: "demo.myshopify.com",
        order_number: "1001",
        customer: "Muster GmbH",
      }),
    ).toBe("demo.myshopify.com / 1001 fuer Muster GmbH");
  });

  it("entfernt unbekannte Platzhalter, ohne leeren Namen zu erzeugen", () => {
    expect(renderDocumentName("{{unbekannt}}", {})).toBe("Shopify Beleg");
  });
});

describe("Kontakte", () => {
  it("bevorzugt den Firmennamen", () => {
    expect(resolveContactName(customer, address, true)).toBe("Muster GmbH");
  });

  it("faellt auf den Personennamen zurueck", () => {
    expect(resolveContactName(customer, { ...address, company: null }, true)).toBe(
      "Erika Mustermann",
    );
  });

  it("liefert ohne Fallback null fuer Privatkunden", () => {
    expect(resolveContactName(customer, { ...address, company: null }, false)).toBeNull();
  });

  it("bildet den Kunden auf ein Papierkram-Unternehmen ab", () => {
    const company = mapCustomerToCompany(customer, { fallbackToPersonName: true });
    expect(company).toMatchObject({
      name: "Muster GmbH",
      contact_type: "customer",
      email: "erika@example.com",
      postal_zip: "12345",
    });
    expect(company?.people?.[0]).toMatchObject({
      first_name: "Erika",
      last_name: "Mustermann",
    });
  });

  it("legt ohne verwertbaren Namen keinen Kontakt an", () => {
    const anonymous = {
      ...customer,
      firstName: null,
      lastName: null,
      displayName: null,
      email: null,
      defaultAddress: { ...address, company: null, firstName: null, lastName: null },
    };
    expect(mapCustomerToCompany(anonymous, { fallbackToPersonName: true })).toBeNull();
  });
});

describe("Waehrungspruefung", () => {
  it("laesst die Bestellung durch, wenn die Waehrung passt", () => {
    expect(() =>
      assertCurrency("EUR", { documentCurrency: "EUR", allowForeignCurrency: false }),
    ).not.toThrow();
  });

  it("ignoriert Gross- und Kleinschreibung sowie Leerzeichen", () => {
    expect(() =>
      assertCurrency(" eur ", { documentCurrency: "EUR", allowForeignCurrency: false }),
    ).not.toThrow();
  });

  it("verweigert Fremdwaehrungen", () => {
    expect(() =>
      assertCurrency("CHF", { documentCurrency: "EUR", allowForeignCurrency: false }),
    ).toThrow(CurrencyMismatchError);
  });

  it("laesst Fremdwaehrungen nur nach ausdruecklicher Freigabe zu und warnt", () => {
    const warnings: string[] = [];
    expect(() =>
      assertCurrency(
        "CHF",
        { documentCurrency: "EUR", allowForeignCurrency: true },
        (message) => warnings.push(message),
      ),
    ).not.toThrow();
    expect(warnings.join(" ")).toContain("nicht umgerechnet");
  });

  it("bricht die Rechnungsabbildung bei fremder Waehrung ab", () => {
    const order = grossOrder({ currencyCode: "USD" });
    expect(() =>
      mapOrderToInvoice({ order, settings, shopDomain: "demo.myshopify.com" }),
    ).toThrow(CurrencyMismatchError);
  });

  it("bricht auch die Angebotsabbildung ab", () => {
    const draft = draftOrder({ currencyCode: "USD" });
    expect(() =>
      mapDraftOrderToEstimate({ draftOrder: draft, settings, shopDomain: "demo.myshopify.com" }),
    ).toThrow(CurrencyMismatchError);
  });
});
