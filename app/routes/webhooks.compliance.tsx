import type { ActionFunctionArgs } from "@remix-run/node";

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";

/**
 * Die von Shopify vorgeschriebenen DSGVO-Webhooks.
 * Sie muessen auch dann mit 200 antworten, wenn es nichts zu tun gibt.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_REDACT": {
      const customerId = (payload as { customer?: { id?: number } }).customer?.id;
      if (customerId) {
        const gid = `gid://shopify/Customer/${customerId}`;
        // Die Verknuepfung enthaelt den Kundennamen - die loeschen wir.
        // Der Beleg in Papierkram bleibt: dafuer gelten steuerliche
        // Aufbewahrungsfristen, und er gehoert dem Haendler, nicht uns.
        await prisma.documentLink.deleteMany({ where: { shop, shopifyGid: gid } });
        await prisma.syncJob.deleteMany({ where: { shop, payload: { contains: gid } } });
      }
      break;
    }
    case "SHOP_REDACT": {
      await prisma.documentLink.deleteMany({ where: { shop } });
      await prisma.syncJob.deleteMany({ where: { shop } });
      await prisma.logEntry.deleteMany({ where: { shop } });
      await prisma.propositionMapping.deleteMany({ where: { shop } });
      await prisma.shopSettings.deleteMany({ where: { shop } });
      await prisma.session.deleteMany({ where: { shop } });
      break;
    }
    case "CUSTOMERS_DATA_REQUEST":
      // Wir speichern zu Kunden nur die Papierkram-Referenz; der Haendler
      // beantwortet die Auskunft aus Shopify und Papierkram heraus.
      break;
    default:
      break;
  }

  return new Response();
}
