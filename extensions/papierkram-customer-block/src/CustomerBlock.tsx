import "@shopify/ui-extensions/preact";
import type { Api } from "@shopify/ui-extensions/admin.customer-details.block.render";
import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

import {
  loadContext,
  runAction,
  SETTINGS_URL,
  type PapierkramContext,
} from "./papierkram";

declare global {
  const shopify: Api;
}

export default async function extension() {
  render(<CustomerBlock />, document.body);
}

function CustomerBlock() {
  const customerId = shopify.data?.selected?.[0]?.id;

  const [context, setContext] = useState<PapierkramContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!customerId) return;
    try {
      setContext(await loadContext(customerId));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [customerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function syncContact() {
    if (!customerId) return;
    setBusy(true);
    setNotice(null);
    setError(null);

    const result = await runAction({ action: "sync_customer", id: customerId });
    if (result.ok) {
      setNotice("Kontakt in Papierkram abgeglichen.");
      await refresh();
    } else {
      setError(result.error ?? "Der Kontakt konnte nicht abgeglichen werden.");
    }
    setBusy(false);
  }

  if (!customerId) {
    return (
      <s-admin-block heading="Papierkram">
        <s-paragraph>Kein Kunde ausgewaehlt.</s-paragraph>
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

  const link = context?.customerLink ?? null;

  return (
    <s-admin-block
      heading="Papierkram"
      collapsedSummary={link ? (link.documentNo ?? "Kontakt verknuepft") : "Kein Kontakt"}
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

        {context && !context.configured ? (
          <s-banner tone="warning" heading="Papierkram ist nicht verbunden">
            <s-link href={SETTINGS_URL}>Einstellungen oeffnen</s-link>
          </s-banner>
        ) : null}

        {link ? (
          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small">
              <s-text type="strong">Kundennummer:</s-text>
              <s-text>{link.documentNo ?? "noch nicht vergeben"}</s-text>
            </s-stack>
            {link.url ? (
              <s-link href={link.url} target="_blank">
                Kontakt in Papierkram oeffnen
              </s-link>
            ) : null}
          </s-stack>
        ) : (
          <s-paragraph>
            Dieser Kunde ist noch nicht mit einem Papierkram-Kontakt verknuepft.
            Beim Anlegen wird zuerst nach der E-Mail-Adresse gesucht, damit keine
            Dubletten entstehen.
          </s-paragraph>
        )}

        <s-button
          variant={link ? "secondary" : "primary"}
          disabled={busy || !context?.configured}
          loading={busy}
          onClick={syncContact}
        >
          {link ? "Kontakt abgleichen" : "Kontakt anlegen"}
        </s-button>
      </s-stack>
    </s-admin-block>
  );
}
