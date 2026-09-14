/**
 * Weiterleitung unerwarteter Fehler an eine externe Stelle.
 *
 * Bewusst ohne SDK: ein Sentry-Paket waere eine schwergewichtige Abhaengigkeit
 * fuer eine Entscheidung, die jeder Betreiber selbst trifft. Stattdessen ein
 * JSON-POST an ERROR_WEBHOOK_URL - das nehmen Sentry (via Relay), Slack,
 * Discord, Better Stack und ein eigener Endpunkt gleichermassen entgegen.
 * Wer ein SDK will, ersetzt reportError() durch dessen Aufruf.
 */

export interface ErrorReport {
  shop?: string;
  /** Kurzer Vorgang, z.B. "job.order_invoice". */
  scope: string;
  message: string;
  error?: unknown;
  context?: Record<string, unknown>;
}

const WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const ENVIRONMENT = process.env.NODE_ENV ?? "development";

/**
 * Protokolliert strukturiert und schickt den Bericht weiter, falls
 * konfiguriert. Wirft nie - ein kaputter Melder darf den Vorgang, um den es
 * eigentlich geht, nicht zusaetzlich zum Scheitern bringen.
 */
export async function reportError(report: ErrorReport): Promise<void> {
  const payload = {
    source: "papierkram-shopify",
    environment: ENVIRONMENT,
    timestamp: new Date().toISOString(),
    shop: report.shop ?? null,
    scope: report.scope,
    message: report.message,
    error: describe(report.error),
    context: report.context ?? null,
  };

  // Immer auf stdout, damit der Bericht auch ohne Webhook im Logdienst landet.
  console.error(`[papierkram] ${report.scope}: ${report.message}`, payload.error ?? "");

  if (!WEBHOOK_URL) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (deliveryError) {
    console.error("[papierkram] Fehlerbericht konnte nicht zugestellt werden", deliveryError);
  }
}

function describe(error: unknown) {
  if (error === undefined || error === null) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 12).join("\n"),
      cause: error.cause instanceof Error ? error.cause.message : undefined,
    };
  }
  return { name: "unknown", message: String(error).slice(0, 1000) };
}
