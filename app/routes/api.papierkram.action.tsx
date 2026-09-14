import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { findLink } from "~/models/links.server";
import { logError } from "~/models/log.server";
import { PapierkramNotConfiguredError } from "~/papierkram/errors";
import type { DeliveryInput } from "~/papierkram/types";
import { authenticate } from "~/shopify.server";
import {
  buildContext,
  cancelDocument,
  createEstimateForDraftOrder,
  createInvoiceForOrder,
  deliverDocument,
  describeError,
  refreshDocument,
  syncCustomer,
} from "~/sync/service.server";

type ActionName =
  | "create_invoice"
  | "create_estimate"
  | "deliver"
  | "cancel"
  | "refresh"
  | "sync_customer";

interface RequestBody {
  action: ActionName;
  /** GID der Bestellung, des Entwurfs oder des Kunden. */
  id?: string;
  force?: boolean;
  kind?: "invoice" | "estimate";
  papierkramId?: number;
  sendVia?: "pdf" | "email";
  email?: { recipient: string; subject: string; body: string };
}

/** Schreibende Aktionen der Admin-Blocks und -Actions. */
export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  if (request.method !== "POST") {
    return json({ ok: false, error: "Nur POST erlaubt." }, { status: 405 });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return json({ ok: false, error: "Ungueltiger JSON-Body." }, { status: 400 });
  }

  try {
    const context = await buildContext(session.shop, admin);

    switch (body.action) {
      case "create_invoice": {
        requireId(body.id, "Bestellung");
        const result = await createInvoiceForOrder(context, body.id!, {
          force: body.force,
        });
        return json({
          ok: true,
          reused: result.reused,
          warnings: result.warnings,
          document: {
            kind: "invoice",
            papierkramId: result.invoice.id,
            documentNo: result.invoice.invoice_no,
            state: result.invoice.state,
            totalGross: result.invoice.total_gross,
            url: result.url,
          },
        });
      }

      case "create_estimate": {
        requireId(body.id, "Bestellentwurf");
        const result = await createEstimateForDraftOrder(context, body.id!, {
          force: body.force,
        });
        return json({
          ok: true,
          reused: result.reused,
          warnings: result.warnings,
          document: {
            kind: "estimate",
            papierkramId: result.estimate.id,
            documentNo: result.estimate.estimate_no,
            state: result.estimate.state,
            totalGross: result.estimate.total_gross,
            url: result.url,
          },
        });
      }

      case "deliver": {
        const { kind, papierkramId } = requireDocument(body);
        const delivery: DeliveryInput =
          body.sendVia === "email" && body.email
            ? { send_via: "email", email: body.email }
            : { send_via: "pdf" };
        await deliverDocument(context, kind, papierkramId, delivery);
        if (body.id) await refreshDocument(context, kind, body.id);
        return json({ ok: true });
      }

      case "cancel": {
        const { kind, papierkramId } = requireDocument(body);
        await cancelDocument(context, kind, papierkramId);
        if (body.id) await refreshDocument(context, kind, body.id);
        return json({ ok: true });
      }

      case "refresh": {
        requireId(body.id, "Objekt");
        const kind = body.kind ?? "invoice";
        const link = await findLink(session.shop, kind, body.id!);
        if (!link) {
          return json({ ok: false, error: "Kein verknuepfter Beleg gefunden." }, { status: 404 });
        }
        await refreshDocument(context, kind, body.id!);
        return json({ ok: true });
      }

      case "sync_customer": {
        requireId(body.id, "Kunde");
        const papierkramId = await syncCustomer(context, body.id!);
        return json({ ok: true, papierkramId });
      }

      default:
        return json({ ok: false, error: `Unbekannte Aktion: ${body.action}` }, { status: 400 });
    }
  } catch (error) {
    const message = describeError(error);
    const status = error instanceof PapierkramNotConfiguredError ? 409 : 500;
    await logError(session.shop, `action.${body.action}`, message, error);
    return json({ ok: false, error: message }, { status });
  }
}

function requireId(id: string | undefined, label: string): asserts id is string {
  if (!id) throw new Error(`Es wurde kein ${label} uebergeben.`);
}

function requireDocument(body: RequestBody) {
  if (!body.papierkramId || !body.kind) {
    throw new Error("papierkramId und kind sind erforderlich.");
  }
  return { kind: body.kind, papierkramId: body.papierkramId };
}
