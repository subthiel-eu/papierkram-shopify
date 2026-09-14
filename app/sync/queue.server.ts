import type { SyncJob } from "@prisma/client";

import prisma from "~/db.server";
import { reportError } from "~/lib/report.server";
import { logError, logWarning } from "~/models/log.server";
import { getSettings, hasCredentials } from "~/models/settings.server";
import {
  PapierkramApiError,
  PapierkramNetworkError,
  PapierkramNotConfiguredError,
} from "~/papierkram/errors";
import { unauthenticated } from "~/shopify.server";

import type { DocumentMode } from "./business-cases";
import { LinkInProgressError } from "~/models/links.server";

import { ShopifyAuthError } from "./admin-client";

import { CurrencyMismatchError } from "./mapper";

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
  order_invoice: { orderGid: string; force?: boolean; mode?: DocumentMode };
  draft_order_estimate: { draftOrderGid: string; force?: boolean; mode?: DocumentMode };
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

/**
 * Wie lange ein Job laufen darf, bevor er als verwaist gilt.
 *
 * Stirbt der Prozess mitten in einem Job (Deploy, Neustart, OOM), bliebe er
 * sonst fuer immer auf "running" stehen - der Beleg entstuende nie und
 * niemand wuerde es merken.
 */
const STALE_AFTER_MINUTES = Number(process.env.SYNC_JOB_STALE_MINUTES || 15);

/**
 * Unterhalb dieser Grenze werden keine Jobs mehr gestartet.
 *
 * Papierkram misst den Zugriff in Credits je Monat (10.000 im Tarif M). Ist
 * das Kontingent aufgebraucht, laeuft jeder Job stumpf in fuenf Fehlversuche
 * und die Warteschlange raeumt sich selbst ab. Besser: warten, bis das
 * Kontingent zurueckgesetzt ist.
 */
const QUOTA_FLOOR = Number(process.env.PAPIERKRAM_QUOTA_FLOOR || 25);

/** Wie lange bei erschoepftem Kontingent pausiert wird. */
const QUOTA_PAUSE_HOURS = 6;

/** Holt verwaiste Jobs zurueck in die Warteschlange. */
export async function recoverStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60_000);

  const stale = await prisma.syncJob.findMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    select: { id: true, shop: true, type: true, attempts: true, maxAttempts: true },
  });
  if (stale.length === 0) return 0;

  for (const job of stale) {
    // Der Versuch wurde beim Greifen bereits gezaehlt; ein abgestuerzter
    // Prozess darf das Budget nicht unbemerkt aufbrauchen, aber auch nicht
    // endlos ignoriert werden.
    const exhausted = job.attempts >= job.maxAttempts;
    await prisma.syncJob.update({
      where: { id: job.id },
      data: exhausted
        ? { status: "failed", lastError: "Abgebrochen: Vorgang wurde unterbrochen." }
        : { status: "pending", runAfter: new Date(), startedAt: null },
    });
    await logWarning(
      job.shop,
      `job.${job.type}`,
      exhausted
        ? `Der Vorgang wurde mehrfach unterbrochen und wird nicht weiter versucht.`
        : `Der Vorgang wurde unterbrochen (Versuch ${job.attempts}/${job.maxAttempts}) und laeuft erneut.`,
    );
  }

  return stale.length;
}

/** Faellige Jobs holen und der Reihe nach abarbeiten. */
export async function processDueJobs(limit = 5): Promise<number> {
  await recoverStaleJobs();

  const due = await prisma.syncJob.findMany({
    where: { status: "pending", runAfter: { lte: new Date() } },
    orderBy: { runAfter: "asc" },
    take: limit,
  });

  let processed = 0;
  // Ein Shop pro Durchlauf hoechstens einmal pruefen.
  const quotaChecked = new Map<string, boolean>();

  for (const job of due) {
    if (!quotaChecked.has(job.shop)) {
      quotaChecked.set(job.shop, await hasQuota(job.shop));
    }
    if (!quotaChecked.get(job.shop)) {
      await postponeForQuota(job);
      continue;
    }

    // Zwischen Auswahl und Start kann ein anderer Worker den Job genommen
    // haben; updateMany mit Statusfilter macht das Greifen atomar.
    const claimed = await prisma.syncJob.updateMany({
      where: { id: job.id, status: "pending" },
      data: { status: "running", attempts: { increment: 1 }, startedAt: new Date() },
    });
    if (claimed.count === 0) continue;

    await runJob(job);
    processed++;
  }
  return processed;
}

/** Ist noch genug Monatskontingent da, um einen Job zu starten? */
async function hasQuota(shop: string): Promise<boolean> {
  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
    select: { remainingQuota: true },
  });
  // Ohne bekannten Stand einfach laufen lassen - der erste Aufruf meldet ihn.
  if (!settings || settings.remainingQuota === null) return true;
  return settings.remainingQuota > QUOTA_FLOOR;
}

/** Schiebt einen Job, ohne einen Versuch zu verbrauchen. */
async function postponeForQuota(job: SyncJob) {
  await prisma.syncJob.update({
    where: { id: job.id },
    data: { runAfter: new Date(Date.now() + QUOTA_PAUSE_HOURS * 3_600_000) },
  });
  await logWarning(
    job.shop,
    `job.${job.type}`,
    `Das Papierkram-Monatskontingent ist aufgebraucht. Der Vorgang wird in ${QUOTA_PAUSE_HOURS} Stunden erneut versucht.`,
  );
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
          // Automatisch erzeugte Belege folgen der ausloesenden Regel bzw.
          // der Voreinstellung des Shops.
          deliverFromSettings: true,
          mode: payload.mode,
        });
        break;
      case "draft_order_estimate":
        await createEstimateForDraftOrder(context, payload.draftOrderGid, {
          force: payload.force,
          deliverFromSettings: true,
          mode: payload.mode,
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
      data: { status: "done", lastError: null, startedAt: null },
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
        startedAt: null,
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
    data: { status: "failed", lastError: message, startedAt: null },
  });
  await logError(
    job.shop,
    `job.${job.type}`,
    `Endgueltig fehlgeschlagen nach ${attempts} Versuchen: ${message}`,
    error,
  );
  // Aufgegebene Vorgaenge sind das, was jemand sehen muss.
  await reportError({
    shop: job.shop,
    scope: `job.${job.type}`,
    message: `Endgueltig fehlgeschlagen nach ${attempts} Versuchen: ${message}`,
    error,
    context: { jobId: job.id, payload: job.payload },
  });
}

function isRetryable(error: unknown): boolean {
  if (error instanceof PapierkramNotConfiguredError) return false;
  // Eine falsche Waehrung behebt sich nicht durch Warten.
  if (error instanceof CurrencyMismatchError) return false;
  // Entzogene Berechtigung ebenfalls nicht - die App muss neu autorisiert werden.
  if (error instanceof ShopifyAuthError) return false;
  if (error instanceof PapierkramNetworkError) return true;
  // Ein paralleler Vorgang ist gleich fertig - spaeter nochmal nachsehen.
  if (error instanceof LinkInProgressError) return true;
  if (error instanceof PapierkramApiError) return error.isRetryable;
  // Unbekannte Fehler einmal wiederholen zu lassen ist guenstiger als
  // einen Beleg wegen eines Aussetzers zu verlieren.
  return true;
}

/** Setzt einen fehlgeschlagenen Job manuell zurueck. */
export async function retryJob(shop: string, id: string) {
  await prisma.syncJob.updateMany({
    where: { shop, id },
    data: { status: "pending", attempts: 0, runAfter: new Date(), lastError: null, startedAt: null },
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
