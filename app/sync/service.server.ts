import type { ShopSettings } from "@prisma/client";

import { money } from "~/lib/money";
import {
  LinkInProgressError,
  RESERVED_STATE,
  findLink,
  propositionMap,
  releaseReservation,
  reserveLink,
  upsertLink,
  type DocumentKind,
} from "~/models/links.server";
import { logInfo, logWarning } from "~/models/log.server";
import {
  buildClient,
  getSettings,
  toMappingSettings,
} from "~/models/settings.server";
import type { PapierkramClient } from "~/papierkram/client.server";
import { PapierkramApiError } from "~/papierkram/errors";
import type {
  DeliveryInput,
  Estimate,
  Invoice,
  LineItemInput,
} from "~/papierkram/types";

import type { DocumentMode } from "./business-cases";

import { runGraphql, type AdminGraphqlClient } from "./admin-client";
import {
  estimateDocumentTotals,
  mapCustomerToCompany,
  mapDraftOrderToEstimate,
  mapOrderToInvoice,
} from "./mapper";
import { metafieldsFingerprint, setMetafields } from "./metafields.server";
import { taxCaseLabel } from "./tax-cases";
import { renderEmail } from "./templates";
import { CUSTOMER_QUERY, DRAFT_ORDER_QUERY, ORDER_QUERY } from "./queries";
import type { Address, Customer, DraftOrder, Order } from "./shopify-types";

export interface SyncContext {
  shop: string;
  admin: AdminGraphqlClient;
  settings: ShopSettings;
  client: PapierkramClient;
}

/**
 * Zerlegt den konfigurierten Schluessel in Namespace und Key.
 * "custom.vat_id" -> {namespace: "custom", key: "vat_id"}; ohne Punkt gilt
 * "custom" als Namespace, weil Shopify das fuer eigene Felder vorsieht.
 */
export function vatMetafieldVariables(vatIdKey: string) {
  const raw = (vatIdKey || "vat_id").trim();
  const [namespace, key] = raw.includes(".")
    ? [raw.slice(0, raw.indexOf(".")), raw.slice(raw.indexOf(".") + 1)]
    : ["custom", raw];
  return { vatNamespace: namespace || "custom", vatKey: key || "vat_id" };
}

/** Baut den Kontext (Einstellungen + Papierkram-Client) fuer einen Shop. */
export async function buildContext(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<SyncContext> {
  const settings = await getSettings(shop);
  return { shop, admin, settings, client: buildClient(settings) };
}

// ---------------------------------------------------------------- Kontakte

/**
 * Stellt sicher, dass es zum Shopify-Kunden ein Papierkram-Unternehmen gibt.
 *
 * Reihenfolge: gespeicherte Verknuepfung -> Suche per E-Mail -> Neuanlage.
 * Die gefundene ID wird als DocumentLink gespeichert, damit die teure Suche
 * hoechstens einmal je Kunde laeuft.
 */
export async function ensureCompany(
  context: SyncContext,
  customer: Customer | null,
  address: Address | null,
): Promise<number | null> {
  if (!customer || !context.settings.syncCustomers) return null;

  const existing = await findLink(context.shop, "company", customer.id);
  if (existing) {
    if (context.settings.updateCustomers) {
      await updateCompanyFromCustomer(context, existing.papierkramId, customer, address);
    }
    return existing.papierkramId;
  }

  const input = mapCustomerToCompany(customer, {
    fallbackToPersonName: context.settings.fallbackToPersonName,
    address,
  });
  if (!input) {
    await logWarning(
      context.shop,
      "contact.sync",
      `Kunde ${customer.id} hat weder Firma, Name noch E-Mail - kein Papierkram-Kontakt angelegt.`,
    );
    return null;
  }

  // Doppelte Kontakte vermeiden: erst nach der E-Mail suchen.
  if (customer.email) {
    const found = await context.client.findCompanyByEmail(customer.email);
    if (found) {
      await upsertLink({
        shop: context.shop,
        kind: "company",
        shopifyGid: customer.id,
        papierkramId: found.id,
        shopifyLabel: customer.displayName ?? customer.email,
        documentNo: found.customer_no,
        url: context.client.documentUrl("company", found.id),
      });
      await writeCustomerMetafields(context, customer.id, found.id, found.customer_no);
      return found.id;
    }
  }

  const created = await context.client.createCompany(input);
  await upsertLink({
    shop: context.shop,
    kind: "company",
    shopifyGid: customer.id,
    papierkramId: created.id,
    shopifyLabel: customer.displayName ?? customer.email,
    documentNo: created.customer_no,
    url: context.client.documentUrl("company", created.id),
  });
  await writeCustomerMetafields(context, customer.id, created.id, created.customer_no);
  await logInfo(
    context.shop,
    "contact.create",
    `Papierkram-Kontakt "${created.name}" (#${created.id}) fuer Shopify-Kunde ${customer.displayName ?? customer.id} angelegt.`,
  );
  return created.id;
}

async function updateCompanyFromCustomer(
  context: SyncContext,
  papierkramId: number,
  customer: Customer,
  address: Address | null,
) {
  const input = mapCustomerToCompany(customer, {
    fallbackToPersonName: context.settings.fallbackToPersonName,
    address,
  });
  if (!input) return;
  try {
    // people nur bei der Neuanlage mitschicken, sonst entstehen Dubletten.
    const { people: _people, ...rest } = input;
    await context.client.updateCompany(papierkramId, rest);
  } catch (error) {
    await logWarning(
      context.shop,
      "contact.update",
      `Kontakt #${papierkramId} konnte nicht aktualisiert werden: ${describeError(error)}`,
      error,
    );
  }
}

/** Synchronisiert einen Shopify-Kunden (Webhook oder manueller Aufruf). */
export async function syncCustomer(
  context: SyncContext,
  customerGid: string,
): Promise<number | null> {
  const data = await runGraphql<{ customer: Customer | null }>(
    context.admin,
    CUSTOMER_QUERY,
    { id: customerGid },
  );
  if (!data.customer) return null;
  return ensureCompany(context, data.customer, data.customer.defaultAddress);
}

async function writeCustomerMetafields(
  context: SyncContext,
  customerGid: string,
  papierkramId: number,
  customerNo: string | null | undefined,
) {
  if (!context.settings.writeMetafields) return;
  try {
    await setMetafields(context.admin, customerGid, {
      contact_id: papierkramId,
      contact_no: customerNo ?? null,
      contact_url: context.client.documentUrl("company", papierkramId),
    });
  } catch (error) {
    await logWarning(
      context.shop,
      "metafields.customer",
      `Metafelder am Kunden konnten nicht gesetzt werden: ${describeError(error)}`,
      error,
    );
  }
}

// ---------------------------------------------------------------- Vorschau

export interface PreviewLine {
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  /** Steuersatz in Prozent, wie ihn ein Mensch liest. */
  vatPercent: number;
  unitPrice: number;
  discountPerUnit: number;
  lineTotal: number;
}

export interface DocumentPreview {
  kind: "invoice" | "estimate";
  name: string;
  documentDate: string | null;
  /** true = Positionen sind Bruttopreise. */
  gross: boolean;
  currency: string;
  lineItems: PreviewLine[];
  totals: { net: number; vat: number; gross: number };
  /** Summe laut Shopify, zum Abgleich. */
  shopifyTotal: number;
  difference: number;
  warnings: string[];
  billingCompany: string | null;
  /** Ermittelter Steuerfall, im Klartext. */
  taxCase: string;
  /** Pflichthinweis, der auf den Beleg wandert. */
  taxNote: string | null;
  /** Uebernommene USt-IdNr. des Empfaengers. */
  vatId: string | null;
  /** Fehlt etwas, das die Erstellung verhindern wuerde? */
  blockers: string[];
}

/**
 * Rechnet die Abbildung durch, ohne etwas zu senden.
 *
 * Der heikelste Teil der App ist die Abbildung von Steuern, Rabatten und
 * Rundung. Wer sie erst am fertigen Beleg in Papierkram sieht, kann nur noch
 * stornieren. Die Vorschau kostet ausserdem kein Papierkram-Kontingent, weil
 * sie ausschliesslich Shopify-Daten und den reinen Mapper benutzt.
 */
export async function previewInvoiceForOrder(
  context: SyncContext,
  orderGid: string,
): Promise<DocumentPreview> {
  const data = await runGraphql<{ order: Order | null }>(context.admin, ORDER_QUERY, {
    id: orderGid,
    ...vatMetafieldVariables(context.settings.vatIdKey),
  });
  const order = data.order;
  if (!order) throw new Error(`Bestellung ${orderGid} wurde in Shopify nicht gefunden.`);

  const { invoice, warnings, taxCase } = mapOrderToInvoice({
    order,
    settings: toMappingSettings(context.settings),
    shopDomain: context.shop,
    // Bewusst ohne Kontakt: die Vorschau darf in Papierkram nichts anlegen.
    customerId: null,
    propositions: await propositionMap(context.shop),
  });

  const blockers: string[] = [];
  if (!context.settings.paymentTermId) {
    blockers.push(
      "Es ist keine Zahlungsbedingung ausgewaehlt. Papierkram lehnt die Rechnung sonst ab.",
    );
  }
  if (invoice.line_items.length === 0) {
    blockers.push("Die Bestellung enthaelt keine berechenbaren Positionen.");
  }

  return buildPreview({
    kind: "invoice",
    name: invoice.name,
    documentDate: invoice.document_date ?? null,
    gross: invoice.gross === true,
    currency: context.settings.documentCurrency,
    lineItems: invoice.line_items,
    billingCompany: invoice.billing?.company ?? null,
    taxCase: taxCaseLabel(taxCase.taxCase),
    taxNote: taxCase.note || null,
    vatId: taxCase.vatId,
    shopifyTotal: money(Number(order.totalPriceSet.shopMoney.amount)),
    warnings,
    blockers,
  });
}

/** Gegenstueck fuer Bestellentwuerfe. */
export async function previewEstimateForDraftOrder(
  context: SyncContext,
  draftOrderGid: string,
): Promise<DocumentPreview> {
  const data = await runGraphql<{ draftOrder: DraftOrder | null }>(
    context.admin,
    DRAFT_ORDER_QUERY,
    { id: draftOrderGid },
  );
  const draftOrder = data.draftOrder;
  if (!draftOrder) {
    throw new Error(`Bestellentwurf ${draftOrderGid} wurde in Shopify nicht gefunden.`);
  }

  const { estimate, warnings } = mapDraftOrderToEstimate({
    draftOrder,
    settings: toMappingSettings(context.settings),
    shopDomain: context.shop,
    customerId: null,
    propositions: await propositionMap(context.shop),
  });

  return buildPreview({
    kind: "estimate",
    name: estimate.name,
    documentDate: estimate.document_date ?? null,
    gross: estimate.gross === true,
    currency: context.settings.documentCurrency,
    lineItems: estimate.line_items,
    billingCompany: estimate.billing?.company ?? null,
    taxCase: taxCaseLabel(
      context.settings.taxScheme === "kleinunternehmer" ? "kleinunternehmer" : "standard",
    ),
    taxNote:
      context.settings.taxScheme === "kleinunternehmer"
        ? context.settings.kleinunternehmerNote
        : null,
    vatId: null,
    shopifyTotal: money(Number(draftOrder.totalPriceSet.shopMoney.amount)),
    warnings,
    blockers: estimate.line_items.length === 0 ? ["Der Entwurf enthaelt keine Positionen."] : [],
  });
}

function buildPreview(args: {
  kind: "invoice" | "estimate";
  name: string;
  documentDate: string | null;
  gross: boolean;
  currency: string;
  lineItems: LineItemInput[];
  billingCompany: string | null;
  taxCase: string;
  taxNote: string | null;
  vatId: string | null;
  shopifyTotal: number;
  warnings: string[];
  blockers: string[];
}): DocumentPreview {
  const totals = estimateDocumentTotals(args.lineItems, args.gross);
  const difference = money(totals.gross - args.shopifyTotal);

  const lineItems: PreviewLine[] = args.lineItems.map((item) => {
    const unitPrice = (args.gross ? item.price_gross : item.price) ?? 0;
    const discount =
      (args.gross ? item.discount_calculated_gross : item.discount_calculated) ?? 0;
    const rate = typeof item.vat_rate === "number" ? item.vat_rate : 0;

    return {
      name: item.name,
      description: item.description ?? null,
      quantity: item.quantity,
      unit: item.unit,
      vatPercent: Math.round(rate * 10000) / 100,
      unitPrice,
      discountPerUnit: discount,
      lineTotal: money((unitPrice - discount) * item.quantity),
    };
  });

  const warnings = [...args.warnings];
  if (Math.abs(difference) > 0.02) {
    warnings.push(
      `Die errechnete Belegsumme weicht um ${difference.toFixed(2)} ${args.currency} von der Shopify-Summe ab.`,
    );
  }

  return {
    kind: args.kind,
    name: args.name,
    documentDate: args.documentDate,
    gross: args.gross,
    currency: args.currency,
    lineItems,
    totals,
    shopifyTotal: args.shopifyTotal,
    difference,
    warnings,
    billingCompany: args.billingCompany,
    taxCase: args.taxCase,
    taxNote: args.taxNote,
    vatId: args.vatId,
    blockers: args.blockers,
  };
}

// -------------------------------------------------------------- Rechnungen

export interface CreateInvoiceOptions {
  /** Bereits vorhandene Rechnung ueberschreiben statt abzubrechen. */
  force?: boolean;
  /** Nach dem Anlegen finalisieren (festschreiben oder per Mail senden). */
  deliver?: DeliveryInput | null;
  /**
   * Statt eines festen Werts die Einstellung invoiceMode anwenden. Wird vom
   * automatischen Ablauf genutzt, der die Empfaengeradresse erst kennt,
   * nachdem die Bestellung geladen wurde.
   */
  deliverFromSettings?: boolean;
  /** Ueberschreibt invoiceMode - kommt aus der ausloesenden Webhook-Regel. */
  mode?: DocumentMode;
}

export interface CreateInvoiceResult {
  invoice: Invoice;
  url: string;
  warnings: string[];
  reused: boolean;
}

/** Erzeugt aus einer Shopify-Bestellung eine Papierkram-Rechnung. */
export async function createInvoiceForOrder(
  context: SyncContext,
  orderGid: string,
  options: CreateInvoiceOptions = {},
): Promise<CreateInvoiceResult> {
  const existing = await findLink(context.shop, "invoice", orderGid);
  if (existing?.state === RESERVED_STATE) {
    // Eine andere Anfrage legt den Beleg gerade an.
    throw new LinkInProgressError("invoice");
  }
  if (existing && !options.force) {
    const invoice = await context.client.getInvoice(existing.papierkramId);
    await persistInvoiceLink(context, orderGid, invoice, existing.shopifyLabel);
    return {
      invoice,
      url: context.client.documentUrl("invoice", invoice.id),
      warnings: ["Fuer diese Bestellung existiert bereits eine Rechnung."],
      reused: true,
    };
  }

  const data = await runGraphql<{ order: Order | null }>(context.admin, ORDER_QUERY, {
    id: orderGid,
    ...vatMetafieldVariables(context.settings.vatIdKey),
  });
  const order = data.order;
  if (!order) {
    throw new Error(`Bestellung ${orderGid} wurde in Shopify nicht gefunden.`);
  }

  if (!context.settings.paymentTermId) {
    throw new Error(
      "Es ist keine Zahlungsbedingung ausgewaehlt. Papierkram verlangt sie beim Anlegen einer Rechnung - bitte in den Einstellungen setzen.",
    );
  }

  const customerId = await ensureCompany(
    context,
    order.customer,
    order.billingAddress ?? order.shippingAddress,
  );

  const { invoice: payload, warnings, taxCase } = mapOrderToInvoice({
    order,
    settings: toMappingSettings(context.settings),
    shopDomain: context.shop,
    customerId,
    propositions: await propositionMap(context.shop),
  });

  if (!payload.payment_term) {
    payload.payment_term = { id: context.settings.paymentTermId };
  }

  if (!existing) {
    // Ab hier ist der Platz belegt; ein paralleler Versuch scheitert sofort,
    // statt einen zweiten Beleg in Papierkram anzulegen.
    await reserveLink({
      shop: context.shop,
      kind: "invoice",
      shopifyGid: orderGid,
      shopifyLabel: order.name,
    });
  }

  let invoice: Invoice;
  try {
    invoice = await context.client.createInvoice({
      ...payload,
      payment_term: payload.payment_term,
    });
  } catch (error) {
    // Ohne Freigabe bliebe die Bestellung dauerhaft blockiert.
    if (!existing) await releaseReservation(context.shop, "invoice", orderGid);
    throw error;
  }

  // Summenabgleich: Abweichungen deuten auf Steuer-/Rundungsfragen hin.
  const shopifyTotal = money(Number(order.totalPriceSet.shopMoney.amount));
  if (Math.abs(money(invoice.total_gross) - shopifyTotal) > 0.02) {
    warnings.push(
      `Belegsumme ${invoice.total_gross.toFixed(2)} weicht von der Shopify-Summe ${shopifyTotal.toFixed(2)} ab. Bitte Steuereinstellungen pruefen.`,
    );
  }

  const delivery =
    options.deliver ??
    (options.deliverFromSettings
      ? resolveAutomaticDelivery(options.mode ?? context.settings.invoiceMode, {
          recipient: order.email ?? order.customer?.email ?? null,
          documentNo: invoice.invoice_no,
          template: {
            subject: context.settings.invoiceEmailSubject,
            body: context.settings.invoiceEmailBody,
          },
          templateContext: {
            kunde: invoice.billing?.company ?? order.customer?.displayName ?? "",
            summe: invoice.total_gross.toFixed(2),
            shop: context.shop,
            bestellung: order.name,
          },
          onFallback: (reason) => warnings.push(reason),
        })
      : null);

  if (delivery) {
    invoice = (await deliverDocument(context, "invoice", invoice.id, delivery)) as Invoice;
  }

  await persistInvoiceLink(context, orderGid, invoice, order.name);

  await logInfo(
    context.shop,
    "invoice.create",
    `Rechnung ${invoice.invoice_no ?? `#${invoice.id}`} fuer Bestellung ${order.name} angelegt (${taxCaseLabel(taxCase.taxCase)}).`,
    { warnings, taxCase: taxCase.taxCase, vatId: taxCase.vatId },
  );
  for (const warning of warnings) {
    await logWarning(context.shop, "invoice.create", warning, { order: order.name });
  }

  return {
    invoice,
    url: context.client.documentUrl("invoice", invoice.id),
    warnings,
    reused: false,
  };
}

async function persistInvoiceLink(
  context: SyncContext,
  orderGid: string,
  invoice: Invoice,
  label?: string | null,
) {
  const currency = context.settings.documentCurrency;
  const url = context.client.documentUrl("invoice", invoice.id);

  const values = {
    invoice_id: invoice.id,
    invoice_no: invoice.invoice_no ?? `Entwurf #${invoice.id}`,
    invoice_state: invoice.state,
    invoice_url: url,
    invoice_total: invoice.total_gross.toFixed(2),
  };
  const fingerprint = metafieldsFingerprint(values);
  const previous = await findLink(context.shop, "invoice", orderGid);
  const unchanged = previous?.metafieldsHash === fingerprint;

  await upsertLink({
    shop: context.shop,
    kind: "invoice",
    shopifyGid: orderGid,
    papierkramId: invoice.id,
    shopifyLabel: label ?? null,
    documentNo: invoice.invoice_no,
    state: invoice.state,
    totalGross: invoice.total_gross,
    currency,
    url,
    metafieldsHash: fingerprint,
  });

  if (!context.settings.writeMetafields || unchanged) return;
  try {
    await setMetafields(context.admin, orderGid, values);
  } catch (error) {
    await logWarning(
      context.shop,
      "metafields.order",
      `Metafelder an der Bestellung konnten nicht gesetzt werden: ${describeError(error)}`,
      error,
    );
  }
}

// ---------------------------------------------------------------- Angebote

export interface CreateEstimateResult {
  estimate: Estimate;
  url: string;
  warnings: string[];
  reused: boolean;
}

/** Erzeugt aus einem Shopify-Bestellentwurf ein Papierkram-Angebot. */
export async function createEstimateForDraftOrder(
  context: SyncContext,
  draftOrderGid: string,
  options: {
    force?: boolean;
    deliver?: DeliveryInput | null;
    deliverFromSettings?: boolean;
    mode?: DocumentMode;
  } = {},
): Promise<CreateEstimateResult> {
  const existing = await findLink(context.shop, "estimate", draftOrderGid);
  if (existing?.state === RESERVED_STATE) {
    throw new LinkInProgressError("estimate");
  }
  if (existing && !options.force) {
    const estimate = await context.client.getEstimate(existing.papierkramId);
    await persistEstimateLink(context, draftOrderGid, estimate, existing.shopifyLabel);
    return {
      estimate,
      url: context.client.documentUrl("estimate", estimate.id),
      warnings: ["Fuer diesen Entwurf existiert bereits ein Angebot."],
      reused: true,
    };
  }

  const data = await runGraphql<{ draftOrder: DraftOrder | null }>(
    context.admin,
    DRAFT_ORDER_QUERY,
    { id: draftOrderGid },
  );
  const draftOrder = data.draftOrder;
  if (!draftOrder) {
    throw new Error(`Bestellentwurf ${draftOrderGid} wurde in Shopify nicht gefunden.`);
  }

  const customerId = await ensureCompany(
    context,
    draftOrder.customer,
    draftOrder.billingAddress ?? draftOrder.shippingAddress,
  );

  const { estimate: payload, warnings } = mapDraftOrderToEstimate({
    draftOrder,
    settings: toMappingSettings(context.settings),
    shopDomain: context.shop,
    customerId,
    propositions: await propositionMap(context.shop),
  });

  if (!existing) {
    await reserveLink({
      shop: context.shop,
      kind: "estimate",
      shopifyGid: draftOrderGid,
      shopifyLabel: draftOrder.name,
    });
  }

  let estimate: Estimate;
  try {
    estimate = await context.client.createEstimate(payload);
  } catch (error) {
    if (!existing) await releaseReservation(context.shop, "estimate", draftOrderGid);
    throw error;
  }

  const delivery =
    options.deliver ??
    (options.deliverFromSettings
      ? resolveAutomaticDelivery(options.mode ?? context.settings.invoiceMode, {
          recipient: draftOrder.email ?? draftOrder.customer?.email ?? null,
          documentNo: estimate.estimate_no,
          documentLabel: "Angebot",
          template: {
            subject: context.settings.estimateEmailSubject,
            body: context.settings.estimateEmailBody,
          },
          templateContext: {
            kunde: estimate.billing?.company ?? draftOrder.customer?.displayName ?? "",
            summe: estimate.total_gross.toFixed(2),
            shop: context.shop,
            bestellung: draftOrder.name,
          },
          onFallback: (reason) => warnings.push(reason),
        })
      : null);

  if (delivery) {
    estimate = (await deliverDocument(context, "estimate", estimate.id, delivery)) as Estimate;
  }

  await persistEstimateLink(context, draftOrderGid, estimate, draftOrder.name);
  await logInfo(
    context.shop,
    "estimate.create",
    `Angebot ${estimate.estimate_no ?? `#${estimate.id}`} fuer Entwurf ${draftOrder.name} angelegt.`,
  );

  return {
    estimate,
    url: context.client.documentUrl("estimate", estimate.id),
    warnings,
    reused: false,
  };
}

async function persistEstimateLink(
  context: SyncContext,
  draftOrderGid: string,
  estimate: Estimate,
  label?: string | null,
) {
  const url = context.client.documentUrl("estimate", estimate.id);

  const values = {
    estimate_id: estimate.id,
    estimate_no: estimate.estimate_no ?? `Entwurf #${estimate.id}`,
    estimate_url: url,
  };
  const fingerprint = metafieldsFingerprint(values);
  const previous = await findLink(context.shop, "estimate", draftOrderGid);
  const unchanged = previous?.metafieldsHash === fingerprint;

  await upsertLink({
    shop: context.shop,
    kind: "estimate",
    shopifyGid: draftOrderGid,
    papierkramId: estimate.id,
    shopifyLabel: label ?? null,
    documentNo: estimate.estimate_no,
    state: estimate.state,
    totalGross: estimate.total_gross,
    currency: context.settings.documentCurrency,
    url,
    metafieldsHash: fingerprint,
  });

  if (!context.settings.writeMetafields || unchanged) return;
  try {
    await setMetafields(context.admin, draftOrderGid, values);
  } catch (error) {
    await logWarning(
      context.shop,
      "metafields.draft_order",
      `Metafelder am Entwurf konnten nicht gesetzt werden: ${describeError(error)}`,
      error,
    );
  }
}

/**
 * Uebersetzt die Einstellung invoiceMode in eine Zustellung.
 *
 * "email" ohne Empfaengeradresse wuerde die Rechnung verlieren, deshalb wird
 * in dem Fall nur festgeschrieben und der Grund vermerkt.
 */
export function resolveAutomaticDelivery(
  invoiceMode: string,
  context: {
    recipient: string | null;
    documentNo: string | null;
    /** "Rechnung" (Standard) oder "Angebot" - steuert Betreff und Text. */
    documentLabel?: "Rechnung" | "Angebot";
    /** Vorlage aus den Einstellungen. */
    template?: { subject: string; body: string };
    /** Zusaetzliche Platzhalterwerte. */
    templateContext?: Record<string, string | number | null | undefined>;
    onFallback?: (reason: string) => void;
  },
): DeliveryInput | null {
  const label = context.documentLabel ?? "Rechnung";
  if (invoiceMode === "pdf") return { send_via: "pdf" };

  if (invoiceMode === "email") {
    const recipient = context.recipient?.trim();
    if (!recipient) {
      context.onFallback?.(
        `Es ist keine E-Mail-Adresse hinterlegt. Das Dokument (${label}) wurde nur festgeschrieben, nicht versendet.`,
      );
      return { send_via: "pdf" };
    }
    const template = context.template ?? {
      subject: label === "Angebot" ? "Ihr Angebot {{beleg_nr}}" : "Ihre Rechnung {{beleg_nr}}",
      body: "Guten Tag,\n\nim Anhang finden Sie Ihren Beleg {{beleg_nr}}.",
    };

    const email = renderEmail(template, {
      beleg_nr: context.documentNo ?? "",
      ...context.templateContext,
    });

    return { send_via: "email", email: { recipient, ...email } };
  }

  // "draft" (Standard) und alles Unbekannte: nichts weiter tun.
  return null;
}

// ------------------------------------------------------- Belegoperationen

/** Schreibt einen Beleg fest bzw. versendet ihn per E-Mail. */
export async function deliverDocument(
  context: SyncContext,
  kind: "invoice" | "estimate",
  papierkramId: number,
  delivery: DeliveryInput,
): Promise<Invoice | Estimate> {
  const document =
    kind === "invoice"
      ? await context.client.deliverInvoice(papierkramId, delivery)
      : await context.client.deliverEstimate(papierkramId, delivery);

  await logInfo(
    context.shop,
    `${kind}.deliver`,
    delivery.send_via === "email"
      ? `${labelOf(kind)} #${papierkramId} an ${delivery.email.recipient} versendet.`
      : `${labelOf(kind)} #${papierkramId} festgeschrieben.`,
  );
  return document;
}

/** Storniert einen Beleg in Papierkram. */
export async function cancelDocument(
  context: SyncContext,
  kind: "invoice" | "estimate",
  papierkramId: number,
) {
  const document =
    kind === "invoice"
      ? await context.client.cancelInvoice(papierkramId)
      : await context.client.cancelEstimate(papierkramId);

  await logInfo(context.shop, `${kind}.cancel`, `${labelOf(kind)} #${papierkramId} storniert.`);
  return document;
}

/**
 * Holt den aktuellen Stand eines Belegs aus Papierkram. Noetig, weil Papierkram
 * keine Webhooks anbietet - Statusaenderungen (bezahlt, storniert) erfahren
 * wir nur durch Nachfragen.
 */
export async function refreshDocument(
  context: SyncContext,
  kind: DocumentKind,
  shopifyGid: string,
): Promise<Invoice | Estimate | null> {
  const link = await findLink(context.shop, kind, shopifyGid);
  if (!link) return null;
  // Eine Reservierung hat noch keinen Beleg, den man abfragen koennte.
  if (link.state === RESERVED_STATE || link.papierkramId === 0) return null;

  try {
    if (kind === "invoice") {
      const invoice = await context.client.getInvoice(link.papierkramId);
      await persistInvoiceLink(context, shopifyGid, invoice, link.shopifyLabel);
      return invoice;
    }
    if (kind === "estimate") {
      const estimate = await context.client.getEstimate(link.papierkramId);
      await persistEstimateLink(context, shopifyGid, estimate, link.shopifyLabel);
      return estimate;
    }
    return null;
  } catch (error) {
    if (error instanceof PapierkramApiError && error.isNotFound) {
      // Beleg wurde in Papierkram geloescht - Verknuepfung als verwaist markieren.
      await upsertLink({
        shop: context.shop,
        kind,
        shopifyGid,
        papierkramId: link.papierkramId,
        state: "deleted",
      });
      await logWarning(
        context.shop,
        `${kind}.refresh`,
        `${labelOf(kind)} #${link.papierkramId} existiert in Papierkram nicht mehr.`,
      );
      return null;
    }
    throw error;
  }
}

/** Laedt das PDF eines Belegs. */
export async function documentPdf(
  context: SyncContext,
  kind: "invoice" | "estimate",
  papierkramId: number,
): Promise<ArrayBuffer> {
  return kind === "invoice"
    ? context.client.invoicePdf(papierkramId)
    : context.client.estimatePdf(papierkramId);
}

// ------------------------------------------------------------- Hilfsmittel

export function labelOf(kind: DocumentKind): string {
  if (kind === "invoice") return "Rechnung";
  if (kind === "estimate") return "Angebot";
  return "Kontakt";
}

export function describeError(error: unknown): string {
  if (error instanceof PapierkramApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
