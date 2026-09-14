import type { BackfillRun } from "@prisma/client";

import prisma from "~/db.server";
import { logError, logInfo } from "~/models/log.server";

import { runGraphql, type AdminGraphqlClient } from "./admin-client";
import { queueInvoices } from "./bulk.server";
import {
  BULK_OPERATION_QUERY,
  BULK_ORDERS_QUERY,
  ORDERS_COUNT_QUERY,
} from "./queries";

export type { BackfillRun };

export interface BackfillFilters {
  from: Date;
  to: Date;
  onlyPaid: boolean;
  skipExisting: boolean;
}

/**
 * Suchausdruck fuer die Bestelluebersicht.
 *
 * Der Zeitraum bezieht sich auf created_at, weil danach auch die
 * Bestelluebersicht im Admin filtert - so kommt der Haendler auf dieselbe Zahl.
 */
export function buildOrderQuery(filters: BackfillFilters): string {
  const parts = [
    `created_at:>=${filters.from.toISOString()}`,
    `created_at:<=${filters.to.toISOString()}`,
  ];
  if (filters.onlyPaid) parts.push("financial_status:paid");
  return parts.join(" AND ");
}

/** Die Massenabfrage selbst. Nur Kennungen, mehr braucht die Warteschlange nicht. */
export function buildBulkQuery(filters: BackfillFilters): string {
  return `{ orders(query: "${buildOrderQuery(filters).replace(/"/g, '\\"')}") { edges { node { id name } } } }`;
}

export interface BackfillEstimate {
  orders: number;
  /** Ungefaehre Papierkram-Credits: ein Beleg plus etwas Kontaktpflege. */
  estimatedCredits: number;
  precise: boolean;
}

/**
 * Schaetzt Umfang und Kosten, bevor irgendetwas laeuft.
 *
 * Ein Nachtrag, der das Monatskontingent aufbraucht, gehoert angekuendigt
 * statt entdeckt.
 */
export async function estimateBackfill(
  admin: AdminGraphqlClient,
  filters: BackfillFilters,
): Promise<BackfillEstimate> {
  const data = await runGraphql<{
    ordersCount: { count: number; precision: string } | null;
  }>(admin, ORDERS_COUNT_QUERY, { query: buildOrderQuery(filters) });

  const orders = data.ordersCount?.count ?? 0;
  return {
    orders,
    // Je Bestellung: Beleg anlegen, plus gelegentlich Kontaktsuche und -anlage.
    estimatedCredits: orders * 3,
    precise: data.ordersCount?.precision === "EXACT",
  };
}

/** Startet die Massenabfrage. Das Ergebnis kommt per Webhook zurueck. */
export async function startBackfill(
  admin: AdminGraphqlClient,
  shop: string,
  filters: BackfillFilters,
  estimate?: BackfillEstimate,
): Promise<BackfillRun> {
  const running = await prisma.backfillRun.findFirst({
    where: { shop, status: { in: ["pending", "running"] } },
  });
  if (running) {
    throw new Error("Es laeuft bereits ein Nachtrag. Bitte abwarten.");
  }

  const data = await runGraphql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, BULK_ORDERS_QUERY, { query: buildBulkQuery(filters) });

  const errors = data.bulkOperationRunQuery.userErrors;
  if (errors.length > 0 || !data.bulkOperationRunQuery.bulkOperation) {
    throw new Error(
      `Shopify hat die Massenabfrage abgelehnt: ${errors.map((e) => e.message).join("; ") || "unbekannter Grund"}`,
    );
  }

  const run = await prisma.backfillRun.create({
    data: {
      shop,
      status: "running",
      fromDate: filters.from,
      toDate: filters.to,
      onlyPaid: filters.onlyPaid,
      skipExisting: filters.skipExisting,
      bulkOperationId: data.bulkOperationRunQuery.bulkOperation.id,
      estimatedOrders: estimate?.orders ?? null,
    },
  });

  await logInfo(
    shop,
    "backfill.start",
    `Nachtrag gestartet fuer ${filters.from.toISOString().slice(0, 10)} bis ${filters.to.toISOString().slice(0, 10)}.`,
  );
  return run;
}

/**
 * Wertet eine fertige Massenabfrage aus.
 *
 * Wird vom Webhook bulk_operations/finish aufgerufen. Shopify liefert das
 * Ergebnis als JSONL hinter einer Signatur-URL; die Datei wird zeilenweise
 * gelesen, damit auch zehntausend Bestellungen nicht den Speicher sprengen.
 */
export async function finishBackfill(
  admin: AdminGraphqlClient,
  shop: string,
  bulkOperationId: string,
): Promise<BackfillRun | null> {
  const run = await prisma.backfillRun.findFirst({
    where: { shop, bulkOperationId },
  });
  if (!run) return null;

  try {
    const data = await runGraphql<{
      node: {
        id: string;
        status: string;
        errorCode: string | null;
        objectCount: string;
        url: string | null;
      } | null;
    }>(admin, BULK_OPERATION_QUERY, { id: bulkOperationId });

    const operation = data.node;
    if (!operation || operation.status !== "COMPLETED") {
      throw new Error(
        `Die Massenabfrage endete mit Status ${operation?.status ?? "unbekannt"}${
          operation?.errorCode ? ` (${operation.errorCode})` : ""
        }.`,
      );
    }

    // Ohne Treffer liefert Shopify gar keine Datei.
    const orderGids = operation.url ? await readOrderGids(operation.url) : [];

    const result = await queueInvoices(shop, orderGids, {
      // Gestaffelt starten, damit ein Nachtrag nicht die laufende
      // Tagesarbeit verdraengt.
      delaySeconds: 30,
    });

    const finished = await prisma.backfillRun.update({
      where: { id: run.id },
      data: {
        status: "done",
        foundOrders: orderGids.length,
        queuedOrders: result.queued,
      },
    });

    await logInfo(
      shop,
      "backfill.done",
      `Nachtrag abgeschlossen: ${orderGids.length} Bestellungen gefunden, ${result.queued} eingeplant, ${result.skipped} uebersprungen.`,
    );
    return finished;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logError(shop, "backfill.failed", message, error);
    return prisma.backfillRun.update({
      where: { id: run.id },
      data: { status: "failed", error: message },
    });
  }
}

/** Liest die JSONL-Datei zeilenweise und sammelt die Bestell-GIDs. */
async function readOrderGids(url: string): Promise<string[]> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Das Ergebnis der Massenabfrage war nicht abrufbar (HTTP ${response.status}).`);
  }

  const gids: string[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const take = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const record = JSON.parse(trimmed) as { id?: string };
      if (record.id?.includes("/Order/")) gids.push(record.id);
    } catch {
      // Eine unlesbare Zeile darf den ganzen Nachtrag nicht kippen.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) take(line);
  }
  take(buffer);

  return gids;
}

export async function listBackfillRuns(shop: string, limit = 10) {
  return prisma.backfillRun.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
