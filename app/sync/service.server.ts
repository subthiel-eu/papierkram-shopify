import type { ShopSettings } from "@prisma/client";

import { money } from "~/lib/money";
import {
  findLink,
  propositionMap,
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
import type { DeliveryInput, Estimate, Invoice } from "~/papierkram/types";

import { runGraphql, type AdminGraphqlClient } from "./admin-client";
import {
  mapCustomerToCompany,
  mapDraftOrderToEstimate,
  mapOrderToInvoice,
} from "./mapper";
import { setMetafields } from "./metafields.server";
import { CUSTOMER_QUERY, DRAFT_ORDER_QUERY, ORDER_QUERY } from "./queries";
import type { Address, Customer, DraftOrder, Order } from "./shopify-types";

export interface SyncContext {
  shop: string;
  admin: AdminGraphqlClient;
  settings: ShopSettings;
  client: PapierkramClient;
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

  const data = await runGraphql<{ order: Order | null }>(
    context.admin,
    ORDER_QUERY,
    { id: orderGid },
  );
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

  const { invoice: payload, warnings } = mapOrderToInvoice({
    order,
    settings: toMappingSettings(context.settings),
    shopDomain: context.shop,
    customerId,
    propositions: await propositionMap(context.shop),
  });

  if (!payload.payment_term) {
    payload.payment_term = { id: context.settings.paymentTermId };
  }

  let invoice = await context.client.createInvoice({
    ...payload,
    payment_term: payload.payment_term,
  });

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
      ? resolveAutomaticDelivery(context.settings.invoiceMode, {
          recipient: order.email ?? order.customer?.email ?? null,
          documentNo: invoice.invoice_no,
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
    `Rechnung ${invoice.invoice_no ?? `#${invoice.id}`} fuer Bestellung ${order.name} angelegt.`,
    { warnings },
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
  const url = context.client.documentUrl("invoice", invoice.id);
  await upsertLink({
    shop: context.shop,
    kind: "invoice",
    shopifyGid: orderGid,
    papierkramId: invoice.id,
    shopifyLabel: label ?? null,
    documentNo: invoice.invoice_no,
    state: invoice.state,
    totalGross: invoice.total_gross,
    url,
  });

  if (!context.settings.writeMetafields) return;
  try {
    await setMetafields(context.admin, orderGid, {
      invoice_id: invoice.id,
      invoice_no: invoice.invoice_no ?? `Entwurf #${invoice.id}`,
      invoice_state: invoice.state,
      invoice_url: url,
      invoice_total: invoice.total_gross.toFixed(2),
    });
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
  options: { force?: boolean; deliver?: DeliveryInput | null } = {},
): Promise<CreateEstimateResult> {
  const existing = await findLink(context.shop, "estimate", draftOrderGid);
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

  let estimate = await context.client.createEstimate(payload);

  if (options.deliver) {
    estimate = (await deliverDocument(
      context,
      "estimate",
      estimate.id,
      options.deliver,
    )) as Estimate;
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
  await upsertLink({
    shop: context.shop,
    kind: "estimate",
    shopifyGid: draftOrderGid,
    papierkramId: estimate.id,
    shopifyLabel: label ?? null,
    documentNo: estimate.estimate_no,
    state: estimate.state,
    totalGross: estimate.total_gross,
    url,
  });

  if (!context.settings.writeMetafields) return;
  try {
    await setMetafields(context.admin, draftOrderGid, {
      estimate_id: estimate.id,
      estimate_no: estimate.estimate_no ?? `Entwurf #${estimate.id}`,
      estimate_url: url,
    });
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
    onFallback?: (reason: string) => void;
  },
): DeliveryInput | null {
  if (invoiceMode === "pdf") return { send_via: "pdf" };

  if (invoiceMode === "email") {
    const recipient = context.recipient?.trim();
    if (!recipient) {
      context.onFallback?.(
        "Die Bestellung hat keine E-Mail-Adresse. Die Rechnung wurde nur festgeschrieben, nicht versendet.",
      );
      return { send_via: "pdf" };
    }
    return {
      send_via: "email",
      email: {
        recipient,
        subject: `Ihre Rechnung ${context.documentNo ?? ""}`.trim(),
        body:
          "Guten Tag,\n\nim Anhang finden Sie Ihre Rechnung. " +
          "Bitte beachten Sie die Zahlungsmodalitaeten im Dokument.\n\n" +
          "Vielen Dank fuer Ihren Auftrag!",
      },
    };
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
