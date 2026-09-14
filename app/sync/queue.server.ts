import type { SyncJob } from "@prisma/client";

import prisma from "~/db.server";
import { logError, logWarning } from "~/models/log.server";
import { getSettings, hasCredentials } from "~/models/settings.server";
import {
  PapierkramApiError,
  PapierkramNetworkError,
  PapierkramNotConfiguredError,
} from "~/papierkram/errors";
import { unauthenticated } from "~/shopify.server";

import {
  buildContext,
  createEstimateForDraftOrder,
  createInvoiceForOrder,
  describeError,
  refreshDocument,
  syncCustomer,
} from "./service.server";

export type JobType =
  | "order_invoice"
  | "draft_order_estimate"
  | "customer_upsert"
  | "refresh_document";

export interface JobPayloads {
  order_invoice: { orderGid: string; force?: boolean };
  draft_order_estimate: { draftOrderGid: string; force?: boolean };
  customer_upsert: { customerGid: string };
  refresh_document: { kind: "invoice" | "estimate"; shopifyGid: string };
}

/**
 * Webhooks muessen innerhalb von 5 Sekunden quittiert werden. Deshalb landet
 * die eigentliche Arbeit hier und wird vom Worker abgearbeitet.
 */
export async function enqueue<T extends JobType>(args: {
  shop: string;
  type: T;
  payload: JobPayloads[T];
  /** Verhindert Doppelarbeit, z.B. wenn orders/updated mehrfach feuert. */
  dedupeKey?: string;
  delaySeconds?: number;
  maxAttempts?: number;
}): Promise<SyncJob | null> {
  const runAfter = new Date(Date.now() + (args.delaySeconds ?? 0) * 1000);
  const data = {
    shop: args.shop,
    type: args.type,
    payload: JSON.stringify(args.payload),
    dedupeKey: args.dedupeKey ?? null,
    runAfter,
    maxAttempts: args.maxAttempts ?? 5,
    status: "pending",
    attempts: 0,
    lastError: null,
  };

  if (!args.dedupeKey) {
    return prisma.syncJob.create({ data });
  }

  const existing = await prisma.syncJob.findUnique({
    where: { shop_dedupeKey: { shop: args.shop, dedupeKey: args.dedupeKey } },
  });

  // Ein noch offener Job deckt den neuen Anlass bereits ab.
  if (existing && (existing.status === "pending" || existing.status === "running")) {
    return existing;
  }

  if (existing) {
    return prisma.syncJob.update({ where: { id: existing.id }, data });
  }

  return prisma.syncJob.create({ data });
}

/** Faellige Jobs holen und der Reihe nach abarbeiten. */
export async function processDueJobs(limit = 5): Promise<number> {
  const due = await prisma.syncJob.findMany({
    where: { status: "pending", runAfter: { lte: new Date() } },
    orderBy: { runAfter: "asc" },
    take: limit,
  });

  let processed = 0;
  for (const job of due) {
    // Zwischen Auswahl und Start kann ein anderer Worker den Job genommen
    // haben; updateMany mit Statusfilter macht das Greifen atomar.
    const claimed = await prisma.syncJob.updateMany({
      where: { id: job.id, status: "pending" },
      data: { status: "running", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    await runJob(job);
    processed++;
  }
  return processed;
}

async function runJob(job: SyncJob) {
  try {
    const settings = await getSettings(job.shop);
    if (!hasCredentials(settings)) {
      throw new PapierkramNotConfiguredError(
        `Shop ${job.shop} hat keine Papierkram-Zugangsdaten hinterlegt.`,
      );
    }

    const { admin } = await unauthenticated.admin(job.shop);
    const context = await buildContext(job.shop, admin);
    const payload = JSON.parse(job.payload);

    switch (job.type as JobType) {
      case "order_invoice":
        await createInvoiceForOrder(context, payload.orderGid, {
          force: payload.force,
          // Automatisch erzeugte Rechnungen folgen der Einstellung invoiceMode.
          deliverFromSettings: true,
        });
        break;
      case "draft_order_estimate":
        await createEstimateForDraftOrder(context, payload.draftOrderGid, {
          force: payload.force,
        });
        break;
      case "customer_upsert":
        await syncCustomer(context, payload.customerGid);
        break;
      case "refresh_document":
        await refreshDocument(context, payload.kind, payload.shopifyGid);
        break;
      default:
        throw new Error(`Unbekannter Job-Typ: ${job.type}`);
    }

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "done", lastError: null },
    });
  } catch (error) {
    await handleJobFailure(job, error);
  }
}

async function handleJobFailure(job: SyncJob, error: unknown) {
  const message = describeError(error);
  const attempts = job.attempts + 1;
  const retryable = isRetryable(error) && attempts < job.maxAttempts;

  if (retryable) {
    // Exponentiell zurueckhalten: 1 min, 2 min, 4 min, ...
    const delayMinutes = Math.min(2 ** (attempts - 1), 60);
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: "pending",
        lastError: message,
        runAfter: new Date(Date.now() + delayMinutes * 60_000),
      },
    });
    await logWarning(
      job.shop,
      `job.${job.type}`,
      `Versuch ${attempts}/${job.maxAttempts} fehlgeschlagen, naechster Versuch in ${delayMinutes} min: ${message}`,
      error,
    );
    return;
  }

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { status: "failed", lastError: message },
  });
  await logError(
    job.shop,
    `job.${job.type}`,
    `Endgueltig fehlgeschlagen nach ${attempts} Versuchen: ${message}`,
    error,
  );
}

function isRetryable(error: unknown): boolean {
  if (error instanceof PapierkramNotConfiguredError) return false;
  if (error instanceof PapierkramNetworkError) return true;
  if (error instanceof PapierkramApiError) return error.isRetryable;
  // Unbekannte Fehler einmal wiederholen zu lassen ist guenstiger als
  // einen Beleg wegen eines Aussetzers zu verlieren.
  return true;
}

/** Setzt einen fehlgeschlagenen Job manuell zurueck. */
export async function retryJob(shop: string, id: string) {
  await prisma.syncJob.updateMany({
    where: { shop, id },
    data: { status: "pending", attempts: 0, runAfter: new Date(), lastError: null },
  });
}

export async function listJobs(
  shop: string,
  options: { status?: string; limit?: number } = {},
) {
  return prisma.syncJob.findMany({
    where: { shop, ...(options.status ? { status: options.status } : {}) },
    orderBy: { updatedAt: "desc" },
    take: options.limit ?? 50,
  });
}

export async function jobCounts(shop: string) {
  const rows = await prisma.syncJob.groupBy({
    by: ["status"],
    where: { shop },
    _count: { _all: true },
  });
  const counts: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

/** Entfernt erledigte Jobs, damit die Tabelle nicht unbegrenzt waechst. */
export async function pruneJobs(days = 7) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await prisma.syncJob.deleteMany({
    where: { status: "done", updatedAt: { lt: cutoff } },
  });
}
