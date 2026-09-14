import type { ActionFunctionArgs } from "@remix-run/node";

import { getSettings, hasCredentials } from "~/models/settings.server";
import { authenticate } from "~/shopify.server";
import { enqueue } from "~/sync/queue.server";
import { kickWorker } from "~/sync/worker.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);

  const customerGid = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
  if (!customerGid) return new Response();

  const settings = await getSettings(shop);
  if (!settings.syncCustomers || !hasCredentials(settings)) {
    return new Response();
  }

  await enqueue({
    shop,
    type: "customer_upsert",
    payload: { customerGid },
    dedupeKey: `customer:${customerGid}`,
    delaySeconds: 10,
  });
  kickWorker();

  return new Response();
}
