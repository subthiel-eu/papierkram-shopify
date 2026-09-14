import { money, toNumber, unitPrice } from "~/lib/money";
import type {
  CompanyInput,
  CompanyPersonInput,
  EstimateInput,
  InvoiceInput,
  LineItemInput,
  BillingAddress,
} from "~/papierkram/types";

import type {
  Address,
  Customer,
  DiscountAllocation,
  DraftOrder,
  Order,
  TaxLine,
} from "./shopify-types";
import { resolveTaxCase, type TaxCaseResult } from "./tax-cases";

/**
 * Die Einstellungen, die den Mapper steuern. Entspricht einem Ausschnitt aus
 * ShopSettings, ist aber bewusst entkoppelt, damit der Mapper ohne Datenbank
 * getestet werden kann.
 */
export interface MappingSettings {
  /** Waehrung des Papierkram-Mandanten, z.B. "EUR". */
  documentCurrency: string;
  /** Bestellungen in abweichender Waehrung trotzdem uebertragen. */
  allowForeignCurrency: boolean;
  /** "auto" folgt der Shopify-Einstellung, sonst erzwungen. */
  grossMode: "auto" | "gross" | "net";
  /** USt-Satz in Prozent (19 = 19 %), wenn Shopify keinen Satz liefert. */
  defaultVatRate: number;
  includeShipping: boolean;
  shippingLabel: string;
  includeTips: boolean;
  applyDiscounts: boolean;
  documentNameTemplate: string;
  fallbackToPersonName: boolean;
  /** Sitzland des Haendlers, entscheidet ueber Inland und EU-Ausland. */
  homeCountry: string;
  taxScheme: string;
  reverseChargeEnabled: boolean;
  reverseChargeNote: string;
  kleinunternehmerNote: string;
  vatIdSource: string;
  vatIdKey: string;
  paymentTermId?: number | null;
  invoiceTemplateId?: number | null;
  estimateTemplateId?: number | null;
  projectId?: number | null;
}

export const DEFAULT_MAPPING_SETTINGS: MappingSettings = {
  documentCurrency: "EUR",
  allowForeignCurrency: false,
  homeCountry: "DE",
  taxScheme: "standard",
  reverseChargeEnabled: true,
  reverseChargeNote:
    "Steuerschuldnerschaft des Leistungsempfaengers (Reverse Charge) gemaess Art. 196 MwStSystRL.",
  kleinunternehmerNote: "Gemaess § 19 UStG wird keine Umsatzsteuer berechnet.",
  vatIdSource: "auto",
  vatIdKey: "vat_id",
  grossMode: "auto",
  defaultVatRate: 19,
  includeShipping: true,
  shippingLabel: "Versandkosten",
  includeTips: true,
  applyDiscounts: true,
  documentNameTemplate: "Shopify Bestellung {{order_name}}",
  fallbackToPersonName: true,
};

/** Papierkram erwartet Steuersaetze als Dezimalbruch (0.19 fuer 19 %). */
export function vatFraction(percent: number): number {
  return Math.round(percent * 10000) / 1000000;
}

/**
 * Ermittelt den Steuersatz einer Position als Dezimalbruch.
 *
 * Mehrere Steuerzeilen (z.B. US-amerikanische State/County-Kombinationen)
 * werden addiert, weil Papierkram nur einen Satz je Position kennt.
 */
export function resolveVatRate(
  taxLines: TaxLine[],
  options: { orderHasTax: boolean; defaultVatRate: number },
): number {
  const rates = taxLines
    .map((line) =>
      line.rate !== null && line.rate !== undefined
        ? line.rate
        : line.ratePercentage !== null && line.ratePercentage !== undefined
          ? line.ratePercentage / 100
          : null,
    )
    .filter((rate): rate is number => rate !== null);

  if (rates.length > 0) {
    return Math.round(rates.reduce((sum, rate) => sum + rate, 0) * 1000000) / 1000000;
  }
  // Keine Steuerzeile und die Bestellung ist insgesamt steuerfrei
  // (Kleinunternehmer, Reverse Charge, Export) -> 0 % ist korrekt.
  if (!options.orderHasTax) return 0;
  return vatFraction(options.defaultVatRate);
}

/** Rechnet Brutto in Netto um bzw. umgekehrt. */
export function convertPrice(
  amount: number,
  vatRate: number,
  from: "gross" | "net",
  to: "gross" | "net",
): number {
  if (from === to) return amount;
  if (to === "net") return amount / (1 + vatRate);
  return amount * (1 + vatRate);
}

function sumAllocations(allocations: DiscountAllocation[] | null | undefined) {
  return (allocations ?? []).reduce(
    (sum, allocation) => sum + toNumber(allocation.allocatedAmountSet?.shopMoney?.amount),
    0,
  );
}

/**
 * Entscheidet, ob der Beleg brutto oder netto gefuehrt wird.
 *
 * "auto" uebernimmt die Preisbasis des Shops. Das ist der genaueste Weg, weil
 * dann keine Umrechnung noetig ist und die Summen exakt zu Shopify passen.
 */
export function resolveGross(
  settings: Pick<MappingSettings, "grossMode">,
  taxesIncluded: boolean,
): boolean {
  if (settings.grossMode === "gross") return true;
  if (settings.grossMode === "net") return false;
  return taxesIncluded;
}

interface BuildLineItemArgs {
  name: string;
  description?: string;
  quantity: number;
  unit?: string;
  /** Stueckpreis in der Preisbasis des Shops. */
  unitAmount: number;
  /** Gesamtrabatt der Position in der Preisbasis des Shops. */
  discountTotal: number;
  vatRate: number;
  /** Preisbasis der uebergebenen Betraege. */
  sourceBasis: "gross" | "net";
  /** Zielbasis des Belegs. */
  targetBasis: "gross" | "net";
  applyDiscounts: boolean;
  propositionId?: number | null;
}

/** Baut eine einzelne Papierkram-Position. */
export function buildLineItem(args: BuildLineItemArgs): LineItemInput {
  const quantity = args.quantity > 0 ? args.quantity : 1;
  const price = unitPrice(
    convertPrice(args.unitAmount, args.vatRate, args.sourceBasis, args.targetBasis),
  );

  const item: LineItemInput = {
    name: args.name,
    quantity,
    unit: args.unit || "Stk.",
    vat_rate: args.vatRate,
    ...(args.targetBasis === "gross" ? { price_gross: price } : { price }),
  };

  if (args.description) item.description = args.description;
  if (args.propositionId) item.proposition = { id: args.propositionId };

  if (args.applyDiscounts && args.discountTotal > 0) {
    // Papierkram rechnet den Rabatt je Einheit, passend zur Preisbasis.
    const perUnit = unitPrice(
      convertPrice(
        args.discountTotal / quantity,
        args.vatRate,
        args.sourceBasis,
        args.targetBasis,
      ),
    );
    if (args.targetBasis === "gross") {
      item.discount_calculated_gross = perUnit;
    } else {
      item.discount_calculated = perUnit;
    }
  } else if (!args.applyDiscounts && args.discountTotal > 0) {
    // Rabatt still einrechnen, damit die Belegsumme trotzdem stimmt.
    const discounted = unitPrice(
      convertPrice(
        args.unitAmount - args.discountTotal / quantity,
        args.vatRate,
        args.sourceBasis,
        args.targetBasis,
      ),
    );
    if (args.targetBasis === "gross") {
      item.price_gross = discounted;
    } else {
      item.price = discounted;
    }
  }

  return item;
}

/** Ersetzt Platzhalter im Belegnamen. */
export function renderDocumentName(
  template: string,
  context: Record<string, string | null | undefined>,
): string {
  const rendered = template.replace(
    /\{\{\s*([a-z_]+)\s*\}\}/gi,
    (_match, key: string) => context[key.toLowerCase()] ?? "",
  );
  return rendered.replace(/\s+/g, " ").trim() || "Shopify Beleg";
}

function personName(address: Address | null, customer: Customer | null): string | null {
  const first = address?.firstName || customer?.firstName;
  const last = address?.lastName || customer?.lastName;
  const full = [first, last].filter(Boolean).join(" ").trim();
  return full || customer?.displayName || null;
}

function streetOf(address: Address | null): string | null {
  if (!address) return null;
  return [address.address1, address.address2].filter(Boolean).join(", ") || null;
}

/** Baut die Rechnungsanschrift des Belegs aus der Shopify-Adresse. */
export function buildBillingAddress(
  address: Address | null,
  customer: Customer | null,
  email: string | null,
): BillingAddress {
  return {
    company: address?.company || null,
    contact_person: personName(address, customer),
    street: streetOf(address),
    zip: address?.zip || null,
    city: address?.city || null,
    country: address?.country || null,
    email: email || customer?.email || null,
  };
}

/**
 * Der Kontaktname in Papierkram. Privatkunden haben keine Firma, deshalb
 * optional der Personenname als Ersatz.
 */
export function resolveContactName(
  customer: Customer | null,
  address: Address | null,
  fallbackToPersonName: boolean,
): string | null {
  const company = address?.company?.trim();
  if (company) return company;
  if (!fallbackToPersonName) return null;
  const person = personName(address, customer)?.trim();
  if (person) return person;
  return customer?.email?.trim() || null;
}

/** Shopify-Kunde -> Papierkram-Unternehmen (contact_type "customer"). */
export function mapCustomerToCompany(
  customer: Customer,
  options: { fallbackToPersonName: boolean; address?: Address | null } = {
    fallbackToPersonName: true,
  },
): CompanyInput | null {
  const address = options.address ?? customer.defaultAddress;
  const name = resolveContactName(customer, address, options.fallbackToPersonName);
  if (!name) return null;

  const people: CompanyPersonInput[] = [];
  const first = address?.firstName || customer.firstName;
  const last = address?.lastName || customer.lastName;
  if (first || last) {
    people.push({
      first_name: first || "-",
      last_name: last || "-",
      email: customer.email || undefined,
      phone: customer.phone || address?.phone || undefined,
      default: "true",
    });
  }

  const input: CompanyInput = {
    name,
    contact_type: "customer",
    email: customer.email || undefined,
    phone: customer.phone || address?.phone || undefined,
    postal_street: streetOf(address) || undefined,
    postal_zip: address?.zip || undefined,
    postal_city: address?.city || undefined,
    postal_country: address?.country || undefined,
    notes: [customer.note, `Shopify-Kunde: ${customer.id}`]
      .filter(Boolean)
      .join("\n"),
  };

  if (people.length > 0) input.people = people;
  return input;
}

/**
 * Die Papierkram-API nimmt je Beleg keine Waehrung entgegen - Betraege werden
 * in der Waehrung des Mandanten verbucht. Eine Bestellung in einer anderen
 * Waehrung wuerde also mit falschem Wert in der Buchhaltung landen, ohne dass
 * es jemandem auffaellt.
 */
export class CurrencyMismatchError extends Error {
  readonly orderCurrency: string;
  readonly documentCurrency: string;

  constructor(orderCurrency: string, documentCurrency: string) {
    super(
      `Die Bestellung ist in ${orderCurrency} ausgezeichnet, der Papierkram-Mandant rechnet in ${documentCurrency}. ` +
        `Papierkram uebernimmt keine Waehrung je Beleg, die Betraege wuerden also als ${documentCurrency} verbucht. ` +
        `Bitte die Belegwaehrung in den Einstellungen korrigieren oder Fremdwaehrungen dort ausdruecklich zulassen.`,
    );
    this.name = "CurrencyMismatchError";
    this.orderCurrency = orderCurrency;
    this.documentCurrency = documentCurrency;
  }
}

/** Wirft, wenn Beleg- und Bestellwaehrung nicht zusammenpassen. */
export function assertCurrency(
  orderCurrency: string | null | undefined,
  settings: Pick<MappingSettings, "documentCurrency" | "allowForeignCurrency">,
  onWarning?: (message: string) => void,
): void {
  const order = (orderCurrency ?? "").trim().toUpperCase();
  const document = settings.documentCurrency.trim().toUpperCase();
  if (!order || order === document) return;

  if (!settings.allowForeignCurrency) {
    throw new CurrencyMismatchError(order, document);
  }
  onWarning?.(
    `Die Bestellung ist in ${order} ausgezeichnet, der Beleg wird als ${document} gefuehrt. ` +
      `Die Betraege wurden nicht umgerechnet.`,
  );
}

export interface OrderMappingResult {
  invoice: Omit<InvoiceInput, "payment_term"> & {
    payment_term?: { id: number };
  };
  /** Hinweise fuer das Protokoll, z.B. teilweise erstattete Positionen. */
  warnings: string[];
  /** Ermittelter Steuerfall, fuer Vorschau und Protokoll. */
  taxCase: TaxCaseResult;
}

/**
 * Shopify-Bestellung -> Papierkram-Rechnung.
 *
 * `customerId` ist die Papierkram-Unternehmens-ID; ohne sie legt Papierkram
 * den Beleg nur mit der Rechnungsanschrift an.
 */
export function mapOrderToInvoice(args: {
  order: Order;
  settings: MappingSettings;
  shopDomain: string;
  customerId?: number | null;
  /** Zuordnung Shopify-GID -> Papierkram-Position (Proposition). */
  propositions?: Map<string, number>;
}): OrderMappingResult {
  const { order, settings } = args;
  const warnings: string[] = [];

  assertCurrency(order.currencyCode, settings, (message) => warnings.push(message));

  const gross = resolveGross(settings, order.taxesIncluded);
  const targetBasis = gross ? "gross" : "net";
  const sourceBasis = order.taxesIncluded ? "gross" : "net";
  const orderHasTax = toNumber(order.totalTaxSet?.shopMoney?.amount) > 0;

  const billingForTax = order.billingAddress ?? order.shippingAddress;
  const taxCase = resolveTaxCase({
    settings,
    homeCountry: settings.homeCountry,
    destination: billingForTax,
    orderHasTax,
    order,
  });

  const lineItems: LineItemInput[] = [];

  for (const line of order.lineItems.nodes) {
    // currentQuantity beruecksichtigt stornierte/erstattete Stueckzahlen.
    const quantity =
      typeof line.currentQuantity === "number" && line.currentQuantity >= 0
        ? line.currentQuantity
        : line.quantity;

    if (quantity === 0) {
      warnings.push(`Position "${line.name}" wurde vollstaendig storniert und ausgelassen.`);
      continue;
    }
    if (quantity !== line.quantity) {
      warnings.push(
        `Position "${line.name}": ${line.quantity} bestellt, ${quantity} berechnet (Teilstorno).`,
      );
    }

    const vatRate = taxCase.zeroRated
      ? 0
      : resolveVatRate(line.taxLines, {
          orderHasTax,
          defaultVatRate: settings.defaultVatRate,
        });

    // Rabattzuweisungen gelten fuer die urspruengliche Menge.
    const discountTotal =
      line.quantity > 0
        ? (sumAllocations(line.discountAllocations) / line.quantity) * quantity
        : 0;

    const propositionId =
      args.propositions?.get(line.variant?.id ?? "") ??
      args.propositions?.get(line.product?.id ?? "") ??
      null;

    lineItems.push(
      buildLineItem({
        name: line.name || line.title || "Position",
        description: describeLine(line.sku, line.variantTitle),
        quantity,
        unit: "Stk.",
        unitAmount: toNumber(line.originalUnitPriceSet?.shopMoney?.amount),
        discountTotal,
        vatRate,
        sourceBasis,
        targetBasis,
        applyDiscounts: settings.applyDiscounts,
        propositionId,
      }),
    );
  }

  if (settings.includeShipping) {
    for (const shipping of order.shippingLines.nodes) {
      const amount = toNumber(shipping.originalPriceSet?.shopMoney?.amount);
      if (amount <= 0) continue;
      const vatRate = taxCase.zeroRated
        ? 0
        : resolveVatRate(shipping.taxLines, {
            orderHasTax,
            defaultVatRate: settings.defaultVatRate,
          });
      lineItems.push(
        buildLineItem({
          name: shipping.title || settings.shippingLabel,
          description: shipping.title ? settings.shippingLabel : undefined,
          quantity: 1,
          unit: "Pauschale",
          unitAmount: amount,
          discountTotal: sumAllocations(shipping.discountAllocations),
          vatRate,
          sourceBasis,
          targetBasis,
          applyDiscounts: settings.applyDiscounts,
        }),
      );
    }
  }

  const tip = toNumber(order.totalTipReceivedSet?.shopMoney?.amount);
  if (settings.includeTips && tip > 0) {
    // Trinkgeld ist in Shopify nicht steuerbar erfasst.
    lineItems.push(
      buildLineItem({
        name: "Trinkgeld",
        quantity: 1,
        unit: "Pauschale",
        unitAmount: tip,
        discountTotal: 0,
        vatRate: 0,
        sourceBasis,
        targetBasis,
        applyDiscounts: false,
      }),
    );
  }

  if (lineItems.length === 0) {
    warnings.push("Die Bestellung enthaelt keine berechenbaren Positionen.");
  }

  const billingAddress = order.billingAddress ?? order.shippingAddress;
  const name = renderDocumentName(settings.documentNameTemplate, {
    order_name: order.name,
    order_number: order.name.replace(/^#/, ""),
    shop: args.shopDomain,
    customer:
      resolveContactName(order.customer, billingAddress, true) ?? "",
    date: (order.processedAt ?? order.createdAt).slice(0, 10),
  });

  // Der Pflichthinweis gehoert auf den Beleg, nicht nur in die Zahlen.
  const description = [taxCase.note, order.note].filter(Boolean).join("\n\n") || undefined;

  const invoice: OrderMappingResult["invoice"] = {
    name,
    description,
    document_date: (order.processedAt ?? order.createdAt).slice(0, 10),
    gross,
    line_items: lineItems,
    billing: {
      ...buildBillingAddress(billingAddress, order.customer, order.email),
      ...(taxCase.vatId ? { ust_idnr: taxCase.vatId } : {}),
    },
  };

  if (taxCase.taxCase === "reverse_charge" && !taxCase.vatId) {
    warnings.push("Reverse Charge ohne USt-IdNr. - bitte pruefen.");
  }

  if (args.customerId) {
    invoice.customer = { id: args.customerId };
    if (settings.projectId) {
      invoice.customer.project = { id: settings.projectId };
    }
  }
  if (settings.invoiceTemplateId) {
    invoice.custom_template = { id: settings.invoiceTemplateId };
  }
  if (settings.paymentTermId) {
    invoice.payment_term = { id: settings.paymentTermId };
  }

  return { invoice, warnings, taxCase };
}

export interface DraftOrderMappingResult {
  estimate: EstimateInput;
  warnings: string[];
}

/** Shopify-Bestellentwurf -> Papierkram-Angebot. */
export function mapDraftOrderToEstimate(args: {
  draftOrder: DraftOrder;
  settings: MappingSettings;
  shopDomain: string;
  customerId?: number | null;
  propositions?: Map<string, number>;
}): DraftOrderMappingResult {
  const { draftOrder, settings } = args;
  const warnings: string[] = [];

  assertCurrency(draftOrder.currencyCode, settings, (message) => warnings.push(message));

  const gross = resolveGross(settings, draftOrder.taxesIncluded);
  const targetBasis = gross ? "gross" : "net";
  const sourceBasis = draftOrder.taxesIncluded ? "gross" : "net";
  const orderHasTax = toNumber(draftOrder.totalTaxSet?.shopMoney?.amount) > 0;

  // Ein Entwurf traegt noch keine USt-IdNr. aus dem Checkout; Reverse Charge
  // laesst sich also erst an der Bestellung entscheiden. Die
  // Kleinunternehmerregelung gilt dagegen unabhaengig davon.
  const zeroRated = settings.taxScheme === "kleinunternehmer";
  const taxNote = zeroRated ? settings.kleinunternehmerNote : "";

  const lineItems: LineItemInput[] = draftOrder.lineItems.nodes.map((line) => {
    const vatRate = zeroRated
      ? 0
      : resolveVatRate(line.taxLines, {
          orderHasTax,
          defaultVatRate: settings.defaultVatRate,
        });
    const original = toNumber(line.originalUnitPriceSet?.shopMoney?.amount);
    const discounted = line.discountedUnitPriceSet
      ? toNumber(line.discountedUnitPriceSet.shopMoney.amount)
      : original;
    const discountTotal = Math.max(0, original - discounted) * line.quantity;

    return buildLineItem({
      name: line.name || line.title || "Position",
      description: describeLine(line.sku, line.variantTitle),
      quantity: line.quantity,
      unit: "Stk.",
      unitAmount: original,
      discountTotal,
      vatRate,
      sourceBasis,
      targetBasis,
      applyDiscounts: settings.applyDiscounts,
      propositionId:
        args.propositions?.get(line.variant?.id ?? "") ??
        args.propositions?.get(line.product?.id ?? "") ??
        null,
    });
  });

  if (settings.includeShipping && draftOrder.shippingLine) {
    const amount = toNumber(draftOrder.shippingLine.originalPriceSet?.shopMoney?.amount);
    if (amount > 0) {
      lineItems.push(
        buildLineItem({
          name: draftOrder.shippingLine.title || settings.shippingLabel,
          quantity: 1,
          unit: "Pauschale",
          unitAmount: amount,
          discountTotal: 0,
          vatRate: zeroRated
            ? 0
            : resolveVatRate(draftOrder.shippingLine.taxLines, {
                orderHasTax,
                defaultVatRate: settings.defaultVatRate,
              }),
          sourceBasis,
          targetBasis,
          applyDiscounts: false,
        }),
      );
    }
  }

  if (lineItems.length === 0) {
    warnings.push("Der Entwurf enthaelt keine Positionen.");
  }

  const billingAddress = draftOrder.billingAddress ?? draftOrder.shippingAddress;
  const estimate: EstimateInput = {
    name: renderDocumentName(settings.documentNameTemplate, {
      order_name: draftOrder.name,
      order_number: draftOrder.name.replace(/^#/, ""),
      shop: args.shopDomain,
      customer: resolveContactName(draftOrder.customer, billingAddress, true) ?? "",
      date: draftOrder.createdAt.slice(0, 10),
    }),
    description: [taxNote, draftOrder.note2].filter(Boolean).join("\n\n") || undefined,
    document_date: draftOrder.createdAt.slice(0, 10),
    gross,
    line_items: lineItems,
    billing: buildBillingAddress(billingAddress, draftOrder.customer, draftOrder.email),
  };

  if (args.customerId) {
    estimate.customer = { id: args.customerId };
    if (settings.projectId) estimate.customer.project = { id: settings.projectId };
  }
  if (settings.estimateTemplateId) {
    estimate.custom_template = { id: settings.estimateTemplateId };
  }

  return { estimate, warnings };
}

function describeLine(sku: string | null, variantTitle: string | null): string | undefined {
  const parts: string[] = [];
  if (variantTitle && variantTitle !== "Default Title") parts.push(variantTitle);
  if (sku) parts.push(`Art.-Nr. ${sku}`);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/** Rechnerische Belegsumme, um sie gegen Shopify pruefen zu koennen. */
export function estimateDocumentTotals(
  lineItems: LineItemInput[],
  gross: boolean,
): { net: number; vat: number; gross: number } {
  let net = 0;
  let vat = 0;

  for (const item of lineItems) {
    const rate = typeof item.vat_rate === "number" ? item.vat_rate : 0;
    const base = gross ? (item.price_gross ?? 0) : (item.price ?? 0);
    const discount = gross
      ? (item.discount_calculated_gross ?? 0)
      : (item.discount_calculated ?? 0);
    const percentage = item.discount_percentage ?? 0;

    const effective = (base - discount) * (1 - percentage);
    const lineTotal = effective * item.quantity;

    const lineNet = gross ? lineTotal / (1 + rate) : lineTotal;
    net += lineNet;
    vat += lineNet * rate;
  }

  return {
    net: money(net),
    vat: money(vat),
    gross: money(net + vat),
  };
}
