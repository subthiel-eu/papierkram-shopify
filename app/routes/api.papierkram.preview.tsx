import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "~/shopify.server";
import {
  buildContext,
  describeError,
  previewEstimateForDraftOrder,
  previewInvoiceForOrder,
} from "~/sync/service.server";

/**
 * Rechnet die Abbildung durch, ohne etwas an Papierkram zu senden.
 * Aufruf aus den Admin-Blocks:
 *   fetch("/api/papierkram/preview?id=gid://shopify/Order/1")
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return json({ ok: false, error: "Es wurde kein Objekt uebergeben." }, { status: 400 });
  }

  try {
    const context = await buildContext(session.shop, admin);
    const preview = id.includes("/DraftOrder/")
      ? await previewEstimateForDraftOrder(context, id)
      : await previewInvoiceForOrder(context, id);

    return json({ ok: true, preview });
  } catch (error) {
    // Auch ein Fehler ist ein Ergebnis der Vorschau - etwa eine Fremdwaehrung.
    return json({ ok: false, error: describeError(error) }, { status: 200 });
  }
}
