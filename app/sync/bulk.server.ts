import { findLink } from "~/models/links.server";
import { logInfo } from "~/models/log.server";

import { enqueue } from "./queue.server";
import { kickWorker } from "./worker.server";

export interface BulkQueueResult {
  queued: number;
  /** Bestellungen mit bereits vorhandenem Beleg. */
  skipped: number;
  failed: number;
}

/**
 * Plant Rechnungen fuer mehrere Bestellungen ein.
 *
 * Bewusst nur einplanen, nicht anlegen: Papierkram nimmt die Belege einzeln
 * entgegen, und ein Aufruf der Oberflaeche darf nicht minutenlang haengen.
 * Die Warteschlange arbeitet sie mit Kontingentschutz und Wiederholungen ab.
 */
export async function queueInvoices(
  shop: string,
  orderGids: string[],
  options: { delaySeconds?: number } = {},
): Promise<BulkQueueResult> {
  const result: BulkQueueResult = { queued: 0, skipped: 0, failed: 0 };

  for (const orderGid of orderGids) {
    try {
      if (await findLink(shop, "invoice", orderGid)) {
        result.skipped++;
        continue;
      }
      await enqueue({
        shop,
        type: "order_invoice",
        payload: { orderGid },
        dedupeKey: `invoice:${orderGid}`,
        delaySeconds: options.delaySeconds,
      });
      result.queued++;
    } catch {
      result.failed++;
    }
  }

  if (result.queued > 0) {
    await logInfo(
      shop,
      "bulk.queued",
      `${result.queued} Bestellungen zur Rechnungserstellung eingeplant` +
        (result.skipped > 0 ? `, ${result.skipped} uebersprungen (Beleg vorhanden)` : "") +
        ".",
    );
    kickWorker();
  }

  return result;
}
