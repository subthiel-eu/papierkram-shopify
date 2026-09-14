import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";

import prisma from "~/db.server";
import { listLinks } from "~/models/links.server";
import { getRules, summarizeTriggers } from "~/models/rules.server";
import { recentLogs } from "~/models/log.server";
import {
  buildClient,
  getSettings,
  hasCredentials,
} from "~/models/settings.server";
import { authenticate } from "~/shopify.server";
import { jobCounts } from "~/sync/queue.server";
import { describeError } from "~/sync/service.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await getSettings(shop);
  const configured = hasCredentials(settings);

  let connection: { ok: boolean; message: string } = {
    ok: false,
    message: "Noch nicht eingerichtet.",
  };

  if (configured) {
    try {
      const result = await buildClient(settings).testConnection();
      connection = { ok: true, message: `Verbunden (API ${result.version}).` };
      await prisma.shopSettings.update({
        where: { shop },
        data: { connectionOkAt: new Date() },
      });
    } catch (error) {
      connection = { ok: false, message: describeError(error) };
    }
  }

  const rules = await getRules(shop);

  const [documents, logs, jobs, invoiceCount, estimateCount, contactCount] =
    await Promise.all([
      listLinks(shop, { limit: 8 }),
      recentLogs(shop, { limit: 6 }),
      jobCounts(shop),
      prisma.documentLink.count({ where: { shop, kind: "invoice" } }),
      prisma.documentLink.count({ where: { shop, kind: "estimate" } }),
      prisma.documentLink.count({ where: { shop, kind: "company" } }),
    ]);

  return json({
    configured,
    connection,
    subdomain: settings.subdomain,
    remainingQuota: settings.remainingQuota,
    paymentTermId: settings.paymentTermId,
    invoiceTriggers: summarizeTriggers(rules, "invoice_create"),
    estimateTriggers: summarizeTriggers(rules, "estimate_create"),
    counts: { invoiceCount, estimateCount, contactCount },
    jobs,
    documents: documents.items.map((link) => ({
      id: link.id,
      kind: link.kind,
      documentNo: link.documentNo,
      state: link.state,
      label: link.shopifyLabel,
      url: link.url,
      totalGross: link.totalGross,
    })),
    logs: logs.map((entry) => ({
      id: entry.id,
      level: entry.level,
      action: entry.action,
      message: entry.message,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
}

/** Leere Ausloeserliste heisst: der Fall laeuft nur auf Knopfdruck. */
function describeTriggers(topics: string[]): string {
  return topics.length === 0 ? "nur manuell" : topics.join(", ");
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Papierkram">
      <s-button slot="primary-action" href="/app/settings">
        Einstellungen
      </s-button>

      {!data.configured ? (
        <s-banner tone="warning" heading="Papierkram ist noch nicht verbunden">
          <s-paragraph>
            Hinterlege deine Papierkram-Subdomain und einen API-Token, damit aus
            Bestellungen Rechnungen werden koennen.
          </s-paragraph>
          <s-button slot="secondary-actions" href="/app/settings">
            Jetzt einrichten
          </s-button>
        </s-banner>
      ) : !data.connection.ok ? (
        <s-banner tone="critical" heading="Verbindung zu Papierkram fehlgeschlagen">
          <s-paragraph>{data.connection.message}</s-paragraph>
        </s-banner>
      ) : null}

      {data.configured && data.paymentTermId === null ? (
        <s-banner tone="warning" heading="Zahlungsbedingung fehlt">
          <s-paragraph>
            Papierkram verlangt beim Anlegen einer Rechnung eine
            Zahlungsbedingung. Ohne sie schlaegt jede Rechnung fehl.
          </s-paragraph>
          <s-button slot="secondary-actions" href="/app/settings">
            Auswaehlen
          </s-button>
        </s-banner>
      ) : null}

      <s-section heading="Status">
        <s-stack direction="inline" gap="large">
          <StatTile label="Rechnungen" value={data.counts.invoiceCount} />
          <StatTile label="Angebote" value={data.counts.estimateCount} />
          <StatTile label="Kontakte" value={data.counts.contactCount} />
          <StatTile label="Offene Jobs" value={data.jobs.pending ?? 0} />
          <StatTile
            label="Fehlgeschlagen"
            value={data.jobs.failed ?? 0}
            tone={data.jobs.failed > 0 ? "critical" : "neutral"}
          />
        </s-stack>

        <s-divider />

        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small">
            <s-text type="strong">Verbindung:</s-text>
            <s-badge tone={data.connection.ok ? "success" : "critical"}>
              {data.connection.ok ? "aktiv" : "getrennt"}
            </s-badge>
            <s-text tone="neutral">{data.connection.message}</s-text>
          </s-stack>
          {data.subdomain ? (
            <s-text tone="neutral">
              Mandant: {data.subdomain}.papierkram.de
            </s-text>
          ) : null}
          <s-text tone="neutral">
            Rechnungen: {describeTriggers(data.invoiceTriggers)}
          </s-text>
          <s-text tone="neutral">
            Angebote: {describeTriggers(data.estimateTriggers)}
          </s-text>
          {data.remainingQuota !== null ? (
            <s-text tone={data.remainingQuota < 500 ? "critical" : "neutral"}>
              Verbleibendes API-Kontingent diesen Monat: {data.remainingQuota}
            </s-text>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Zuletzt uebertragen">
        {data.documents.length === 0 ? (
          <s-paragraph>
            Noch keine Belege. Sobald eine Bestellung uebertragen wurde, taucht
            sie hier auf.
          </s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Beleg</s-table-header>
              <s-table-header>Shopify</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Betrag</s-table-header>
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
                      ? `${document.totalGross.toFixed(2)} EUR`
                      : "-"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-stack direction="inline" gap="small">
          <Link to="/app/documents">Alle Belege ansehen</Link>
        </s-stack>
      </s-section>

      <s-section heading="Letzte Meldungen">
        {data.logs.length === 0 ? (
          <s-paragraph>Noch keine Ereignisse.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-200">
            {data.logs.map((entry) => (
              <s-stack key={entry.id} direction="inline" gap="small">
                <s-badge tone={levelTone(entry.level)}>{entry.level}</s-badge>
                <s-text tone="neutral">
                  {new Date(entry.createdAt).toLocaleString("de-DE")}
                </s-text>
                <s-text>{entry.message}</s-text>
              </s-stack>
            ))}
          </s-stack>
        )}
        <s-stack direction="inline" gap="small">
          <Link to="/app/logs">Vollstaendiges Protokoll</Link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function StatTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "critical";
}) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-500">
        <s-text tone="neutral">{label}</s-text>
        <s-heading>
          <s-text tone={tone === "critical" ? "critical" : "auto"}>{value}</s-text>
        </s-heading>
      </s-stack>
    </s-box>
  );
}

export function documentTitle(kind: string, documentNo: string | null) {
  const label = kind === "invoice" ? "Rechnung" : kind === "estimate" ? "Angebot" : "Kontakt";
  return documentNo ? `${label} ${documentNo}` : `${label} (Entwurf)`;
}

export function stateTone(
  state: string | null,
): "success" | "warning" | "critical" | "neutral" {
  switch (state) {
    case "paid":
      return "success";
    case "open":
    case "sent":
      return "warning";
    case "cancelled":
    case "deleted":
      return "critical";
    default:
      return "neutral";
  }
}

export function levelTone(level: string): "critical" | "warning" | "neutral" {
  if (level === "error") return "critical";
  if (level === "warning") return "warning";
  return "neutral";
}
