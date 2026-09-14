import { processDueJobs, pruneJobs } from "./queue.server";

declare global {
  var papierkramWorker: NodeJS.Timeout | undefined;
}

const INTERVAL_SECONDS = Number(process.env.SYNC_WORKER_INTERVAL || 15);

/**
 * Einfacher In-Process-Worker.
 *
 * Bewusst ohne externe Queue: die Last einer Shopify-Bestellung ist klein und
 * ein zusaetzlicher Redis-Dienst waere fuer die meisten Shops Overhead. Bei
 * mehreren App-Instanzen greift das atomare Claiming in processDueJobs.
 */
export function startWorker() {
  if (global.papierkramWorker) return;
  if (process.env.SYNC_WORKER_DISABLED === "true") return;

  let running = false;

  global.papierkramWorker = setInterval(() => {
    if (running) return;
    running = true;
    processDueJobs()
      .catch((error) => console.error("[papierkram] Worker-Durchlauf fehlgeschlagen", error))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_SECONDS * 1000);

  // Aufraeumen einmal pro Stunde.
  setInterval(
    () => {
      pruneJobs().catch(() => {
        /* unkritisch */
      });
    },
    60 * 60 * 1000,
  ).unref();

  global.papierkramWorker.unref();
}

/** Stoesst die Warteschlange sofort an, ohne den Aufrufer zu blockieren. */
export function kickWorker() {
  processDueJobs().catch((error) =>
    console.error("[papierkram] Sofortlauf fehlgeschlagen", error),
  );
}
