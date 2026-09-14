import type { ActionFunctionArgs } from "@remix-run/node";

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`[papierkram] Webhook ${topic} fuer ${shop}`);

  // Die Zugangsdaten sind nach der Deinstallation wertlos. Einstellungen und
  // Verknuepfungen bleiben erhalten, damit eine Neuinstallation nahtlos
  // weiterarbeitet; nur der API-Token wird sicherheitshalber entfernt.
  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }
  await prisma.shopSettings.updateMany({
    where: { shop },
    data: { apiTokenCipher: null, connectionOkAt: null },
  });
  await prisma.syncJob.deleteMany({ where: { shop, status: "pending" } });

  return new Response();
}
