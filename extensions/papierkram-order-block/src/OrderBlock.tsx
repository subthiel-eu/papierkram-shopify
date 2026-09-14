import "@shopify/ui-extensions/preact";
import type { Api } from "@shopify/ui-extensions/admin.order-details.block.render";
import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

import {
  documentTitle,
  loadContext,
  runAction,
  stateTone,
  SETTINGS_URL,
  type PapierkramContext,
} from "./papierkram";

declare global {
  const shopify: Api;
}

export default async function extension() {
  render(<OrderBlock />, document.body);
}

function OrderBlock() {
  const orderId = shopify.data?.selected?.[0]?.id;

  const [context, setContext] = useState<PapierkramContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!orderId) return;
    try {
      setContext(await loadContext(orderId));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [orderId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createInvoice() {
    if (!orderId) return;
    setBusy(true);
    setNotice(null);
    setWarnings([]);
    setError(null);

    const result = await runAction({ action: "create_invoice", id: orderId });

    if (result.ok) {
      setNotice(
        result.reused
          ? "Zu dieser Bestellung gab es bereits eine Rechnung."
          : `Rechnung ${result.document?.documentNo ?? "angelegt"}.`,
      );
      setWarnings(result.warnings ?? []);
      await refresh();
    } else {
      setError(result.error ?? "Die Rechnung konnte nicht angelegt werden.");
    }
    setBusy(false);
  }

  async function refreshStates() {
    if (!orderId || !context) return;
    setBusy(true);
    setError(null);
    for (const document of context.documents) {
      await runAction({ action: "refresh", id: orderId, kind: document.kind });
    }
    await refresh();
    setBusy(false);
  }

  if (!orderId) {
    return (
      <s-admin-block heading="Papierkram">
        <s-paragraph>Keine Bestellung ausgewaehlt.</s-paragraph>
      </s-admin-block>
    );
  }

  if (!context && !error) {
    return (
      <s-admin-block heading="Papierkram">
        <s-spinner accessibilityLabel="Daten werden geladen" />
      </s-admin-block>
    );
  }

  const invoices = context?.documents.filter((doc) => doc.kind === "invoice") ?? [];

  return (
    <s-admin-block
      heading="Papierkram"
      collapsedSummary={
        invoices.length > 0
          ? documentTitle(invoices[0])
          : "Noch keine Rechnung"
      }
    >
      <s-stack direction="block" gap="base">
        {error ? (
          <s-banner tone="critical">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        ) : null}

        {notice ? (
          <s-banner tone="success">
            <s-paragraph>{notice}</s-paragraph>
          </s-banner>
        ) : null}

        {warnings.map((warning) => (
          <s-banner key={warning} tone="warning">
            <s-paragraph>{warning}</s-paragraph>
          </s-banner>
        ))}

        {context && !context.configured ? (
          <s-banner tone="warning" heading="Papierkram ist nicht verbunden">
            <s-paragraph>
              Hinterlege Subdomain und API-Token in den App-Einstellungen.
            </s-paragraph>
            <s-link href={SETTINGS_URL}>Einstellungen oeffnen</s-link>
          </s-banner>
        ) : null}

        {context?.configured && !context.paymentTermConfigured ? (
          <s-banner tone="warning" heading="Zahlungsbedingung fehlt">
            <s-paragraph>
              Papierkram legt ohne Zahlungsbedingung keine Rechnung an.
            </s-paragraph>
            <s-link href={SETTINGS_URL}>Jetzt auswaehlen</s-link>
          </s-banner>
        ) : null}

        {invoices.length === 0 ? (
          <s-paragraph>
            Fuer diese Bestellung gibt es noch keine Rechnung in Papierkram.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="small">
            {invoices.map((document) => (
              <s-stack key={document.id} direction="inline" gap="small" alignItems="center">
                {document.url ? (
                  <s-link href={document.url} target="_blank">
                    {documentTitle(document)}
                  </s-link>
                ) : (
                  <s-text type="strong">{documentTitle(document)}</s-text>
                )}
                <s-badge tone={stateTone(document.state)}>
                  {document.state ?? "unbekannt"}
                </s-badge>
                {document.totalGross !== null ? (
                  <s-text tone="neutral">{document.totalGross.toFixed(2)} EUR</s-text>
                ) : null}
              </s-stack>
            ))}
          </s-stack>
        )}

        {context?.customerLink?.url ? (
          <s-stack direction="inline" gap="small">
            <s-text tone="neutral">Kontakt:</s-text>
            <s-link href={context.customerLink.url} target="_blank">
              {context.customerLink.documentNo ?? "in Papierkram oeffnen"}
            </s-link>
          </s-stack>
        ) : null}

        <s-stack direction="inline" gap="small">
          <s-button
            variant="primary"
            disabled={busy || !context?.configured}
            loading={busy}
            onClick={createInvoice}
          >
            {invoices.length > 0 ? "Weitere Rechnung" : "Rechnung erstellen"}
          </s-button>
          {invoices.length > 0 ? (
            <s-button disabled={busy} onClick={refreshStates}>
              Status aktualisieren
            </s-button>
          ) : null}
        </s-stack>
      </s-stack>
    </s-admin-block>
  );
}
