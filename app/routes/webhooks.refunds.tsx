import type { ActionFunctionArgs } from "@remix-run/node";

import { findLink } from "~/models/links.server";
import { logWarning } from "~/models/log.server";
import { authenticate } from "~/shopify.server";

/**
 * Papierkram kennt ueber die API keine Gutschriften. Eine Erstattung wird
 * deshalb nicht automatisch gebucht, sondern deutlich protokolliert - eine
 * stillschweigend falsche Buchhaltung waere schlimmer als ein Hinweis.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);

  const orderGid = (payload as { order_id?: number }).order_id
    ? `gid://shopify/Order/${(payload as { order_id: number }).order_id}`
    : null;
  if (!orderGid) return new Response();

  const link = await findLink(shop, "invoice", orderGid);
  if (!link) return new Response();

  const amount =
    (payload as { transactions?: Array<{ amount?: string; currency?: string }> })
      .transactions?.reduce((sum, tx) => sum + Number(tx.amount ?? 0), 0) ?? 0;

  await logWarning(
    shop,
    "refund.received",
    `Erstattung ueber ${amount.toFixed(2)} zu Bestellung ${link.shopifyLabel ?? orderGid}. Bitte die Rechnung ${link.documentNo ?? `#${link.papierkramId}`} in Papierkram stornieren oder eine Gutschrift anlegen.`,
    { url: link.url, amount },
  );

  return new Response();
}
