import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import { listLinks, type DocumentKind } from "~/models/links.server";
import { authenticate } from "~/shopify.server";
import {
  buildContext,
  describeError,
  documentPdf,
  refreshDocument,
} from "~/sync/service.server";

import { documentTitle, stateTone } from "./app._index";

const PAGE_SIZE = 25;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const kindParam = url.searchParams.get("kind");
  const kind: DocumentKind | undefined =
    kindParam === "invoice" || kindParam === "estimate" || kindParam === "company"
      ? kindParam
      : undefined;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  const { items, total } = await listLinks(session.shop, {
    kind,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  return json({
    kind: kind ?? "",
    page,
    total,
    hasNext: page * PAGE_SIZE < total,
    hasPrevious: page > 1,
    documents: items.map((link) => ({
      id: link.id,
      kind: link.kind,
      shopifyGid: link.shopifyGid,
      label: link.shopifyLabel,
      documentNo: link.documentNo,
      state: link.state,
      totalGross: link.totalGross,
      currency: link.currency,
      url: link.url,
      papierkramId: link.papierkramId,
      updatedAt: link.updatedAt.toISOString(),
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "refresh");
  const shopifyGid = String(form.get("shopifyGid") ?? "");
  const kind = String(form.get("kind") ?? "invoice") as DocumentKind;

  if (!shopifyGid) {
    return json({ ok: false, message: "Kein Beleg angegeben." }, { status: 400 });
  }

  try {
    const context = await buildContext(session.shop, admin);

    if (intent === "pdf") {
      const papierkramId = Number(form.get("papierkramId"));
      if (!Number.isFinite(papierkramId) || papierkramId <= 0) {
        return json({ ok: false, message: "Kein Beleg angegeben." }, { status: 400 });
      }
      if (kind === "company") {
        return json({ ok: false, message: "Kontakte haben kein PDF." }, { status: 400 });
      }

      const pdf = await documentPdf(context, kind, papierkramId);
      const label = String(form.get("documentNo") ?? papierkramId).replace(/[^\w.-]+/g, "-");

      // Der Browser laedt die Antwort des Formulars direkt herunter; ein
      // einfacher Link wuerde den Session-Token nicht mitfuehren.
      return new Response(pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${kind === "invoice" ? "Rechnung" : "Angebot"}-${label}.pdf"`,
        },
      });
    }

    await refreshDocument(context, kind, shopifyGid);
    return json({ ok: true, message: "Status aus Papierkram aktualisiert." });
  } catch (error) {
    return json({ ok: false, message: describeError(error) }, { status: 400 });
  }
}

export default function Documents() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <s-page heading="Belege">
      {actionData ? (
        <s-banner tone={actionData.ok ? "success" : "critical"}>
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Filter">
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-select label="Art" name="kind" value={data.kind}>
              <s-option value="">Alle</s-option>
              <s-option value="invoice">Rechnungen</s-option>
              <s-option value="estimate">Angebote</s-option>
              <s-option value="company">Kontakte</s-option>
            </s-select>
            <s-button type="submit">Anwenden</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`${data.total} Eintraege`}>
        {data.documents.length === 0 ? (
          <s-paragraph>Keine Belege gefunden.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Beleg</s-table-header>
              <s-table-header>Shopify</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Betrag</s-table-header>
              <s-table-header>Aktualisiert</s-table-header>
              <s-table-header>Aktion</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.documents.map((document) => (
                <s-table-row key={document.id}>
                  <s-table-cell>
                    {document.url ? (
                      <s-link href={document.url} target="_blank">
                        {documentTitle(document.kind, document.documentNo)}
                      </s-link>
                    ) : (
                      documentTitle(document.kind, document.documentNo)
                    )}
                  </s-table-cell>
                  <s-table-cell>{document.label ?? "-"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={stateTone(document.state)}>
                      {document.state ?? "unbekannt"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {document.totalGross !== null
                      ? `${document.totalGross.toFixed(2)} ${document.currency ?? ""}`.trim()
                      : "-"}
                  </s-table-cell>
                  <s-table-cell>
                    {new Date(document.updatedAt).toLocaleString("de-DE")}
                  </s-table-cell>
                  <s-table-cell>
                    {document.kind === "company" ? (
                      "-"
                    ) : (
                      <s-stack direction="inline" gap="small">
                        <Form method="post">
                          <input type="hidden" name="intent" value="refresh" />
                          <input type="hidden" name="shopifyGid" value={document.shopifyGid} />
                          <input type="hidden" name="kind" value={document.kind} />
                          <s-button type="submit" variant="tertiary" loading={busy}>
                            Status holen
                          </s-button>
                        </Form>
                        {document.papierkramId > 0 ? (
                          <Form method="post" reloadDocument>
                            <input type="hidden" name="intent" value="pdf" />
                            <input type="hidden" name="shopifyGid" value={document.shopifyGid} />
                            <input type="hidden" name="kind" value={document.kind} />
                            <input type="hidden" name="papierkramId" value={document.papierkramId} />
                            <input type="hidden" name="documentNo" value={document.documentNo ?? ""} />
                            <s-button type="submit" variant="tertiary">
                              PDF
                            </s-button>
                          </Form>
                        ) : null}
                      </s-stack>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        <s-stack direction="inline" gap="base">
          {data.hasPrevious ? (
            <s-link href={`/app/documents?kind=${data.kind}&page=${data.page - 1}`}>
              Vorherige Seite
            </s-link>
          ) : null}
          {data.hasNext ? (
            <s-link href={`/app/documents?kind=${data.kind}&page=${data.page + 1}`}>
              Naechste Seite
            </s-link>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}
