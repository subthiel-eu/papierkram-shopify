import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "~/shopify.server";
import { topicFromEvent } from "~/sync/business-cases";
import { dispatchWebhook } from "~/sync/dispatch.server";
import { kickWorker } from "~/sync/worker.server";

/**
 * Sammelstelle fuer alle fachlichen Webhooks.
 *
 * Die App abonniert die Topics fest - Shopify kennt keine shop-spezifischen
 * Abos in der App-Konfiguration. Was ein Topic ausloest, entscheidet die
 * Regeltabelle des Shops, deshalb reicht hier eine Route fuer alle.
 *
 * Es wird nur eingeplant, nicht gearbeitet: Shopify erwartet die Quittung
 * innerhalb von fuenf Sekunden.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { topic: event, shop, payload } = await authenticate.webhook(request);

  const topic = topicFromEvent(event);
  if (!topic) {
    console.warn(`[papierkram] Unbekanntes Webhook-Topic ${event} fuer ${shop}`);
    return new Response();
  }

  try {
    const result = await dispatchWebhook({ shop, topic, payload });
    if (result.dispatched.length > 0) kickWorker();
  } catch (error) {
    // Ein 500 laesst Shopify erneut zustellen; bei einem dauerhaften Fehler
    // waere das eine Endlosschleife. Deshalb quittieren und protokollieren.
    console.error(`[papierkram] Webhook ${topic} fuer ${shop} fehlgeschlagen`, error);
  }

  return new Response();
}
