import type { Order, DraftOrder, Address, Customer } from "~/sync/shopify-types";

export const address: Address = {
  company: "Muster GmbH",
  firstName: "Erika",
  lastName: "Mustermann",
  address1: "Musterstrasse 1",
  address2: null,
  zip: "12345",
  city: "Musterstadt",
  province: null,
  country: "Deutschland",
  countryCodeV2: "DE",
  phone: "+49 30 123456",
};

export const customer: Customer = {
  id: "gid://shopify/Customer/1",
  legacyResourceId: "1",
  firstName: "Erika",
  lastName: "Mustermann",
  displayName: "Erika Mustermann",
  email: "erika@example.com",
  phone: null,
  note: null,
  taxExempt: false,
  defaultAddress: address,
};

const money = (amount: string) => ({
  shopMoney: { amount, currencyCode: "EUR" },
});

/**
 * Bestellung eines Shops mit Bruttopreisen (taxesIncluded), wie in DE ueblich:
 * 2 x 59,50 EUR brutto inkl. 19 % = 119,00 EUR, Versand 4,95 EUR.
 */
export function grossOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "gid://shopify/Order/1001",
    legacyResourceId: "1001",
    name: "#1001",
    note: null,
    email: "erika@example.com",
    phone: null,
    createdAt: "2026-03-04T10:00:00Z",
    processedAt: "2026-03-04T10:00:00Z",
    currencyCode: "EUR",
    taxesIncluded: true,
    taxExempt: false,
    displayFinancialStatus: "PAID",
    cancelledAt: null,
    customer,
    billingAddress: address,
    shippingAddress: address,
    totalPriceSet: money("123.95"),
    subtotalPriceSet: money("119.00"),
    totalTaxSet: money("19.79"),
    totalDiscountsSet: money("0.00"),
    totalTipReceivedSet: money("0.00"),
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          name: "Kaffeebohnen 1kg",
          title: "Kaffeebohnen",
          sku: "KB-1000",
          quantity: 2,
          currentQuantity: 2,
          variantTitle: "1 kg",
          originalUnitPriceSet: money("59.50"),
          discountAllocations: [],
          taxLines: [
            {
              title: "MwSt",
              rate: 0.19,
              ratePercentage: 19,
              priceSet: money("19.00"),
            },
          ],
          product: { id: "gid://shopify/Product/1", title: "Kaffeebohnen" },
          variant: { id: "gid://shopify/ProductVariant/1", title: "1 kg", sku: "KB-1000" },
        },
      ],
    },
    shippingLines: {
      nodes: [
        {
          id: "gid://shopify/ShippingLine/1",
          title: "Standardversand",
          originalPriceSet: money("4.95"),
          discountAllocations: [],
          taxLines: [
            { title: "MwSt", rate: 0.19, ratePercentage: 19, priceSet: money("0.79") },
          ],
        },
      ],
    },
    ...overrides,
  };
}

/** Bestellung eines Shops mit Nettopreisen (B2B). */
export function netOrder(overrides: Partial<Order> = {}): Order {
  const base = grossOrder();
  return {
    ...base,
    taxesIncluded: false,
    totalPriceSet: money("147.50"),
    lineItems: {
      nodes: [
        {
          ...base.lineItems.nodes[0],
          originalUnitPriceSet: money("60.00"),
        },
      ],
    },
    ...overrides,
  };
}

export function draftOrder(overrides: Partial<DraftOrder> = {}): DraftOrder {
  return {
    id: "gid://shopify/DraftOrder/500",
    legacyResourceId: "500",
    name: "#D5",
    note2: "Angebot fuer Grossbestellung",
    email: "erika@example.com",
    createdAt: "2026-03-01T09:00:00Z",
    currencyCode: "EUR",
    taxesIncluded: true,
    status: "OPEN",
    order: null,
    customer,
    billingAddress: address,
    shippingAddress: address,
    totalPriceSet: money("238.00"),
    totalTaxSet: money("38.00"),
    shippingLine: null,
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/DraftOrderLineItem/1",
          name: "Kaffeebohnen 1kg",
          title: "Kaffeebohnen",
          sku: "KB-1000",
          quantity: 4,
          variantTitle: "1 kg",
          originalUnitPriceSet: money("59.50"),
          discountedUnitPriceSet: money("59.50"),
          taxLines: [
            { title: "MwSt", rate: 0.19, ratePercentage: 19, priceSet: money("38.00") },
          ],
          product: { id: "gid://shopify/Product/1", title: "Kaffeebohnen" },
          variant: { id: "gid://shopify/ProductVariant/1", title: "1 kg", sku: "KB-1000" },
        },
      ],
    },
    ...overrides,
  };
}
