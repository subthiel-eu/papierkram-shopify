import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { linksForShopifyObject } from "~/models/links.server";
import { getSettings, hasCredentials, readApiToken } from "~/models/settings.server";
import { authenticate } from "~/shopify.server";

/**
 * Datenquelle der Admin-Blocks.
 *
 * Aufruf aus einer Admin-UI-Extension:
 *   fetch("/api/papierkram/context?id=gid://shopify/Order/123")
 * Der Session-Token wird von Shopify automatisch mitgeschickt.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shopifyGid = url.searchParams.get("id");

  const settings = await getSettings(session.shop);
  const configured = hasCredentials(settings) && readApiToken(settings) !== null;

  const base = {
    configured,
    subdomain: settings.subdomain,
    invoiceTrigger: settings.invoiceTrigger,
    estimateFromDraftOrders: settings.estimateFromDraftOrders,
    /** Ohne Zahlungsbedingung lehnt Papierkram jede Rechnung ab. */
    paymentTermConfigured: settings.paymentTermId !== null,
    appUrl: process.env.SHOPIFY_APP_URL ?? null,
  };

  if (!shopifyGid) {
    return json({ ...base, documents: [], customerLink: null });
  }

  const links = await linksForShopifyObject(session.shop, shopifyGid);

  return json({
    ...base,
    documents: links
      .filter((link) => link.kind !== "company")
      .map((link) => ({
        id: link.id,
        kind: link.kind,
        papierkramId: link.papierkramId,
        documentNo: link.documentNo,
        state: link.state,
        totalGross: link.totalGross,
        url: link.url,
        updatedAt: link.updatedAt.toISOString(),
      })),
    customerLink: links
      .filter((link) => link.kind === "company")
      .map((link) => ({
        papierkramId: link.papierkramId,
        documentNo: link.documentNo,
        url: link.url,
      }))[0] ?? null,
  });
}
