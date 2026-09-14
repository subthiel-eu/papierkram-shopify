import prisma from "~/db.server";
import { logInfo, logWarning } from "~/models/log.server";
import type { Invoice } from "~/papierkram/types";

import { runGraphql } from "./admin-client";
import { ORDER_TAGS_ADD_MUTATION, ORDER_TAGS_REMOVE_MUTATION } from "./queries";
import type { SyncContext } from "./service.server";

export interface ReconcileResult {
  checked: number;
  updated: number;
  tagged: number;
}

/**
 * Holt den Stand der Belege und spiegelt ihn nach Shopify.
 *
 * Zwei Grenzen bestimmen den Aufbau:
 * - Papierkram bietet keine Webhooks, der Abgleich laeuft also nach Plan.
 * - Eine Rechnung laesst sich ueber die API nicht als bezahlt markieren. Der
 *   Abgleich ist deshalb einseitig: Papierkram ist die Quelle, Shopify bekommt
 *   Tags. Andersherum waere es ein Zustand, den nur diese App kennt.
 *
 * Gelesen wird seitenweise ueber die Belegliste statt Beleg fuer Beleg -
 * sonst kostet ein Abgleich so viele Credits wie er Belege hat.
 */
export async function reconcileDocuments(
  context: SyncContext,
  options: { days?: number; maxPages?: number } = {},
): Promise<ReconcileResult> {
  const days = options.days ?? 120;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);

  const links = await prisma.documentLink.findMany({
    where: {
      shop: context.shop,
      kind: "invoice",
      papierkramId: { gt: 0 },
      // Bezahlte und stornierte Belege aendern sich nicht mehr.
      state: { notIn: ["paid", "cancelled", "deleted"] },
    },
  });

  const result: ReconcileResult = { checked: links.length, updated: 0, tagged: 0 };
  if (links.length === 0) return result;

  const byId = new Map(links.map((link) => [link.papierkramId, link]));

  const invoices = await context.client.listAll<Invoice>(
    (params) =>
      context.client.listInvoices({
        ...params,
        document_date_range_start: since.toISOString().slice(0, 10),
      }),
    { maxPages: options.maxPages ?? 10 },
  );

  for (const invoice of invoices) {
    const link = byId.get(invoice.id);
    if (!link || link.state === invoice.state) continue;

    await prisma.documentLink.update({
      where: { id: link.id },
      data: {
        state: invoice.state,
        documentNo: invoice.invoice_no,
        totalGross: invoice.total_gross,
      },
    });
    result.updated++;

    const tagged = await applyTags(context, link.shopifyGid, invoice);
    if (tagged) result.tagged++;
  }

  if (result.updated > 0) {
    await logInfo(
      context.shop,
      "reconcile",
      `${result.updated} von ${result.checked} Belegen aktualisiert, ${result.tagged} Bestellungen neu getaggt.`,
    );
  }

  return result;
}

/** Setzt bzw. entfernt die Status-Tags an der Bestellung. */
async function applyTags(
  context: SyncContext,
  orderGid: string,
  invoice: Invoice,
): Promise<boolean> {
  const paidTag = context.settings.paidTag.trim();
  const overdueTag = context.settings.overdueTag.trim();
  if (!paidTag && !overdueTag) return false;

  const paid = invoice.state === "paid";
  const overdue = !paid && isOverdue(invoice);

  const add: string[] = [];
  const remove: string[] = [];

  if (paidTag) (paid ? add : remove).push(paidTag);
  if (overdueTag) (overdue ? add : remove).push(overdueTag);

  try {
    if (add.length > 0) {
      await runGraphql(context.admin, ORDER_TAGS_ADD_MUTATION, { id: orderGid, tags: add });
    }
    if (remove.length > 0) {
      await runGraphql(context.admin, ORDER_TAGS_REMOVE_MUTATION, {
        id: orderGid,
        tags: remove,
      });
    }
    return add.length > 0;
  } catch (error) {
    await logWarning(
      context.shop,
      "reconcile.tags",
      `Tags an ${orderGid} konnten nicht gesetzt werden: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
    return false;
  }
}

/** Faellig laut Papierkram und noch offen. */
export function isOverdue(invoice: Pick<Invoice, "due_date" | "state">): boolean {
  if (!invoice.due_date) return false;
  if (invoice.state === "paid" || invoice.state === "cancelled") return false;

  const due = new Date(`${invoice.due_date}T23:59:59Z`);
  return !Number.isNaN(due.getTime()) && due.getTime() < Date.now();
}

/**
 * Plant den naechsten Abgleich, wenn das Intervall abgelaufen ist.
 * Wird vom Worker bei jedem Durchlauf aufgerufen.
 */
export async function scheduleReconciliation(): Promise<number> {
  const shops = await prisma.shopSettings.findMany({
    where: { reconcileEnabled: true, subdomain: { not: null }, apiTokenCipher: { not: null } },
    select: { shop: true, reconcileIntervalHours: true, reconcileLastRunAt: true },
  });

  let scheduled = 0;
  for (const shop of shops) {
    const due =
      !shop.reconcileLastRunAt ||
      Date.now() - shop.reconcileLastRunAt.getTime() >=
        Math.max(1, shop.reconcileIntervalHours) * 3_600_000;
    if (!due) continue;

    // Zeitstempel sofort setzen, damit nicht jeder Worker-Durchlauf erneut plant.
    await prisma.shopSettings.update({
      where: { shop: shop.shop },
      data: { reconcileLastRunAt: new Date() },
    });

    await prisma.syncJob.upsert({
      where: { shop_dedupeKey: { shop: shop.shop, dedupeKey: "reconcile" } },
      create: {
        shop: shop.shop,
        type: "reconcile_documents",
        payload: "{}",
        dedupeKey: "reconcile",
        status: "pending",
      },
      update: { status: "pending", attempts: 0, runAfter: new Date(), lastError: null },
    });
    scheduled++;
  }

  return scheduled;
}
