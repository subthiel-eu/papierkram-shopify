import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { reportError } from "~/lib/report.server";
import { findLink } from "~/models/links.server";
import { logInfo } from "~/models/log.server";
import { getSettings, hasCredentials } from "~/models/settings.server";
import { authenticate } from "~/shopify.server";
import type { DocumentMode } from "~/sync/business-cases";
import { enqueue } from "~/sync/queue.server";
import { kickWorker } from "~/sync/worker.server";

/**
 * Endpunkt der Shopify-Flow-Aktion "Papierkram Rechnung erstellen".
 *
 * Der Workflow entscheidet ueber die Bedingungen - Betragsgrenzen, Laender,
 * Tags, Wartezeiten. Das ist ehrlicher als eine immer laenger werdende
 * Auswahlliste in den Einstellungen.
 *
 * Rueckgabecodes sind fuer Flow bedeutungstragend: 4xx gilt als endgueltiger
 * Fehler, 5xx laesst Flow erneut zustellen.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session, payload } = await authenticate.flow(request);

  const properties = (payload?.properties ?? {}) as Record<string, unknown>;
  const orderGid = toOrderGid(properties.order_id);

  if (!orderGid) {
    return json({ ok: false, error: "Es wurde keine Bestellung uebergeben." }, { status: 400 });
  }

  try {
    const settings = await getSettings(session.shop);
    if (!hasCredentials(settings)) {
      // Dauerhaft, solange nichts eingerichtet ist - also kein erneuter Versuch.
      return json(
        { ok: false, error: "Papierkram ist fuer diesen Shop nicht eingerichtet." },
        { status: 400 },
      );
    }

    if (await findLink(session.shop, "invoice", orderGid)) {
      // Kein Fehler: der Workflow hat sein Ziel bereits erreicht.
      return json({ ok: true, skipped: "Zu dieser Bestellung gibt es bereits eine Rechnung." });
    }

    await enqueue({
      shop: session.shop,
      type: "order_invoice",
      payload: { orderGid, mode: toMode(properties.mode) },
      dedupeKey: `invoice:${orderGid}`,
    });
    await logInfo(
      session.shop,
      "flow.invoice",
      `Bestellung ${orderGid} ueber Shopify Flow zur Rechnungserstellung eingeplant.`,
    );
    kickWorker();

    return json({ ok: true });
  } catch (error) {
    await reportError({
      shop: session.shop,
      scope: "flow.invoice",
      message: "Die Flow-Aktion konnte nicht ausgefuehrt werden.",
      error,
    });
    // 5xx: Flow stellt erneut zu.
    return json({ ok: false }, { status: 500 });
  }
}

/** Flow liefert je nach Version eine GID oder eine nackte Zahl. */
function toOrderGid(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `gid://shopify/Order/${value}`;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("gid://")) {
    return trimmed.includes("/Order/") ? trimmed : null;
  }
  return /^\d+$/.test(trimmed) ? `gid://shopify/Order/${trimmed}` : null;
}

function toMode(value: unknown): DocumentMode | undefined {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "draft" || mode === "pdf" || mode === "email" ? mode : undefined;
}
