import type { ActionFunctionArgs } from "@remix-run/node";

import { findLink } from "~/models/links.server";
import { getSettings, hasCredentials } from "~/models/settings.server";
import { authenticate } from "~/shopify.server";
import { enqueue } from "~/sync/queue.server";
import { kickWorker } from "~/sync/worker.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);

  const draftOrderGid = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
  const status = (payload as { status?: string }).status;
  const orderId = (payload as { order_id?: number | null }).order_id;
  if (!draftOrderGid) return new Response();

  const settings = await getSettings(shop);
  if (!settings.estimateFromDraftOrders || !hasCredentials(settings)) {
    return new Response();
  }

  // Abgeschlossene Entwuerfe sind bereits Bestellungen - dafuer gibt es eine
  // Rechnung, kein Angebot.
  if (orderId || (status && status.toLowerCase() === "completed")) {
    return new Response();
  }

  const existing = await findLink(shop, "estimate", draftOrderGid);
  if (existing) return new Response();

  await enqueue({
    shop,
    type: "draft_order_estimate",
    payload: { draftOrderGid },
    dedupeKey: `estimate:${draftOrderGid}`,
    // Kurz warten, damit im Admin zusammengeklickte Entwuerfe vollstaendig sind.
    delaySeconds: 60,
  });
  kickWorker();

  return new Response();
}
