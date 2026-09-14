import type { ActionFunctionArgs } from "@remix-run/node";

import { findLink } from "~/models/links.server";
import { logInfo, logWarning } from "~/models/log.server";
import { getSettings, hasCredentials } from "~/models/settings.server";
import { authenticate } from "~/shopify.server";
import { enqueue } from "~/sync/queue.server";
import { kickWorker } from "~/sync/worker.server";

/** Ordnet den Webhook-Topics den konfigurierbaren Ausloesern zu. */
const TRIGGER_TOPICS: Record<string, string> = {
  ORDERS_CREATE: "order_create",
  ORDERS_PAID: "order_paid",
  ORDERS_FULFILLED: "order_fulfilled",
};

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const orderGid = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
  const orderName = (payload as { name?: string }).name ?? orderGid ?? "unbekannt";
  if (!orderGid) return new Response();

  const settings = await getSettings(shop);
  if (!hasCredentials(settings)) {
    // Ohne Zugangsdaten waere jeder Job ein garantierter Fehlschlag.
    return new Response();
  }

  if (topic === "ORDERS_CANCELLED") {
    const link = await findLink(shop, "invoice", orderGid);
    if (link) {
      await logWarning(
        shop,
        "order.cancelled",
        `Bestellung ${orderName} wurde storniert. Die Papierkram-Rechnung ${link.documentNo ?? `#${link.papierkramId}`} bleibt bestehen - bitte dort stornieren, falls gewuenscht.`,
        { url: link.url },
      );
      await enqueue({
        shop,
        type: "refresh_document",
        payload: { kind: "invoice", shopifyGid: orderGid },
        dedupeKey: `refresh:invoice:${orderGid}`,
      });
      kickWorker();
    }
    return new Response();
  }

  if (topic === "ORDERS_UPDATED") {
    // Aenderungen interessieren nur, wenn es schon einen Beleg gibt.
    const link = await findLink(shop, "invoice", orderGid);
    if (link) {
      await enqueue({
        shop,
        type: "refresh_document",
        payload: { kind: "invoice", shopifyGid: orderGid },
        dedupeKey: `refresh:invoice:${orderGid}`,
        delaySeconds: 30,
      });
    }
    return new Response();
  }

  if (TRIGGER_TOPICS[topic] !== settings.invoiceTrigger) {
    return new Response();
  }

  const existing = await findLink(shop, "invoice", orderGid);
  if (existing) return new Response();

  await enqueue({
    shop,
    type: "order_invoice",
    payload: { orderGid },
    // Ein Schluessel je Bestellung: orders/paid nach orders/create erzeugt
    // keinen zweiten Beleg.
    dedupeKey: `invoice:${orderGid}`,
  });
  await logInfo(
    shop,
    "order.queued",
    `Bestellung ${orderName} zur Rechnungserstellung eingeplant (Ausloeser: ${settings.invoiceTrigger}).`,
  );
  kickWorker();

  return new Response();
}
