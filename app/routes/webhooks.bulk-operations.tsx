import type { ActionFunctionArgs } from "@remix-run/node";

import { reportError } from "~/lib/report.server";
import { authenticate, unauthenticated } from "~/shopify.server";
import { finishBackfill } from "~/sync/backfill.server";

/**
 * Shopify meldet hier, dass eine Massenabfrage fertig ist.
 *
 * Der Rumpf traegt nur die Kennung der Operation; Status und Ergebnis-URL
 * holt finishBackfill selbst, damit nichts aus dem Webhook geglaubt werden
 * muss, was sich auch nachfragen laesst.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);

  const bulkOperationId = (payload as { admin_graphql_api_id?: string })
    .admin_graphql_api_id;
  if (!bulkOperationId) return new Response();

  try {
    const { admin } = await unauthenticated.admin(shop);
    await finishBackfill(admin, shop, bulkOperationId);
  } catch (error) {
    await reportError({
      shop,
      scope: "webhook.bulk_operations",
      message: "Das Ergebnis der Massenabfrage konnte nicht ausgewertet werden.",
      error,
    });
  }

  return new Response();
}
