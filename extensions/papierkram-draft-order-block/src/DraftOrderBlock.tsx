import "@shopify/ui-extensions/preact";
import type { Api } from "@shopify/ui-extensions/admin.draft-order-details.block.render";
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
  render(<DraftOrderBlock />, document.body);
}

function DraftOrderBlock() {
  const draftOrderId = shopify.data?.selected?.[0]?.id;

  const [context, setContext] = useState<PapierkramContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!draftOrderId) return;
    try {
      setContext(await loadContext(draftOrderId));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [draftOrderId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createEstimate() {
    if (!draftOrderId) return;
    setBusy(true);
    setNotice(null);
    setError(null);

    const result = await runAction({ action: "create_estimate", id: draftOrderId });
    if (result.ok) {
      setNotice(
        result.reused
          ? "Zu diesem Entwurf gab es bereits ein Angebot."
          : `Angebot ${result.document?.documentNo ?? "angelegt"}.`,
      );
      await refresh();
    } else {
      setError(result.error ?? "Das Angebot konnte nicht angelegt werden.");
    }
    setBusy(false);
  }

  if (!draftOrderId) {
    return (
      <s-admin-block heading="Papierkram">
        <s-paragraph>Kein Entwurf ausgewaehlt.</s-paragraph>
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

  const estimates = context?.documents.filter((doc) => doc.kind === "estimate") ?? [];

  return (
    <s-admin-block
      heading="Papierkram"
      collapsedSummary={
        estimates.length > 0 ? documentTitle(estimates[0]) : "Noch kein Angebot"
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

        {context && !context.configured ? (
          <s-banner tone="warning" heading="Papierkram ist nicht verbunden">
            <s-link href={SETTINGS_URL}>Einstellungen oeffnen</s-link>
          </s-banner>
        ) : null}

        {estimates.length === 0 ? (
          <s-paragraph>
            Fuer diesen Entwurf gibt es noch kein Angebot in Papierkram.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="small">
            {estimates.map((document) => (
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

        <s-button
          variant="primary"
          disabled={busy || !context?.configured}
          loading={busy}
          onClick={createEstimate}
        >
          {estimates.length > 0 ? "Weiteres Angebot" : "Angebot erstellen"}
        </s-button>
      </s-stack>
    </s-admin-block>
  );
}
