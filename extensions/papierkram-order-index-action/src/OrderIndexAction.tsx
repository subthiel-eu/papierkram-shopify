import "@shopify/ui-extensions/preact";
import type { Api } from "@shopify/ui-extensions/admin.order-index.selection-action.render";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import { loadContext, runAction, SETTINGS_URL, type PapierkramContext } from "./papierkram";

declare global {
  const shopify: Api;
}

export default async function extension() {
  render(<OrderIndexAction />, document.body);
}

interface BulkResult {
  queued: number;
  skipped: number;
  failed: number;
}

function OrderIndexAction() {
  const selected = shopify.data?.selected ?? [];

  const [context, setContext] = useState<PapierkramContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);

  useEffect(() => {
    // Ohne ID liefert die Route nur den Einrichtungsstand - genau das brauchen wir.
    loadContext(selected[0]?.id ?? "")
      .then(setContext)
      .catch((loadError: unknown) =>
        setError(loadError instanceof Error ? loadError.message : String(loadError)),
      );
    // Die Auswahl aendert sich nicht mehr, waehrend der Dialog offen ist.
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);

    const response = await runAction({
      action: "queue_invoices",
      ids: selected.map((entry) => entry.id),
    });

    if (response.ok && response.bulk) {
      setResult(response.bulk);
    } else {
      setError(response.error ?? "Die Bestellungen konnten nicht eingeplant werden.");
    }
    setBusy(false);
  }

  return (
    <s-admin-action heading="Rechnungen in Papierkram anlegen" loading={busy}>
      {result ? (
        <s-button slot="primary-action" variant="primary" onClick={() => shopify.close()}>
          Schliessen
        </s-button>
      ) : (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={busy || selected.length === 0 || !context?.configured}
          onClick={submit}
        >
          {selected.length} Bestellungen einplanen
        </s-button>
      )}
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Abbrechen
      </s-button>

      <s-stack direction="block" gap="base">
        {error ? (
          <s-banner tone="critical">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        ) : null}

        {context && !context.configured ? (
          <s-banner tone="warning" heading="Papierkram ist nicht verbunden">
            <s-link href={SETTINGS_URL}>Einstellungen oeffnen</s-link>
          </s-banner>
        ) : null}

        {context?.configured && !context.paymentTermConfigured ? (
          <s-banner tone="warning" heading="Zahlungsbedingung fehlt">
            <s-paragraph>Papierkram legt ohne sie keine Rechnung an.</s-paragraph>
            <s-link href={SETTINGS_URL}>Jetzt auswaehlen</s-link>
          </s-banner>
        ) : null}

        {result ? (
          <s-banner tone="success">
            <s-paragraph>
              {result.queued} eingeplant
              {result.skipped > 0 ? `, ${result.skipped} uebersprungen (schon vorhanden)` : ""}
              {result.failed > 0 ? `, ${result.failed} fehlgeschlagen` : ""}.
            </s-paragraph>
          </s-banner>
        ) : (
          <s-paragraph>
            Die Bestellungen werden in die Warteschlange gelegt und nacheinander
            abgearbeitet. Bestellungen mit vorhandener Rechnung werden
            uebersprungen. Den Fortschritt siehst du im Protokoll der App.
          </s-paragraph>
        )}
      </s-stack>
    </s-admin-action>
  );
}
