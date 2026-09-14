import "@shopify/ui-extensions/preact";
import type { Api } from "@shopify/ui-extensions/admin.draft-order-details.block.render";
import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

import {
  documentTitle,
  formatMoney,
  loadContext,
  loadPreview,
  runAction,
  stateTone,
  SETTINGS_URL,
  type DocumentPreview,
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
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
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

  async function showPreview() {
    if (!draftOrderId) return;
    setBusy(true);
    setError(null);
    const result = await loadPreview(draftOrderId);
    if (result.ok && result.preview) {
      setPreview(result.preview);
    } else {
      setError(result.error ?? "Die Vorschau konnte nicht erstellt werden.");
    }
    setBusy(false);
  }

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

        {preview ? (
          <PreviewPanel preview={preview} onClose={() => setPreview(null)} />
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

        <s-stack direction="inline" gap="small">
          <s-button
            variant="primary"
            disabled={busy || !context?.configured}
            loading={busy}
            onClick={createEstimate}
          >
            {estimates.length > 0 ? "Weiteres Angebot" : "Angebot erstellen"}
          </s-button>
          <s-button disabled={busy} onClick={showPreview}>
            Vorschau
          </s-button>
        </s-stack>
      </s-stack>
    </s-admin-block>
  );
}

/** Stellt das Ergebnis der Vorschau dar. */
function PreviewPanel({
  preview,
  onClose,
}: {
  preview: DocumentPreview;
  onClose: () => void;
}) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text type="strong">Vorschau</s-text>
          <s-badge tone="neutral">{preview.gross ? "brutto" : "netto"}</s-badge>
          <s-button variant="tertiary" onClick={onClose}>
            Schliessen
          </s-button>
        </s-stack>

        {preview.blockers.map((blocker) => (
          <s-banner key={blocker} tone="critical">
            <s-paragraph>{blocker}</s-paragraph>
          </s-banner>
        ))}
        {preview.warnings.map((warning) => (
          <s-banner key={warning} tone="warning">
            <s-paragraph>{warning}</s-paragraph>
          </s-banner>
        ))}

        {preview.lineItems.map((line, index) => (
          <s-stack key={`${line.name}-${index}`} direction="block" gap="small-500">
            <s-text type="strong">{line.name}</s-text>
            <s-text tone="neutral">
              {line.quantity} {line.unit} x {formatMoney(line.unitPrice, preview.currency)}
              {line.discountPerUnit > 0
                ? ` abzgl. ${formatMoney(line.discountPerUnit, preview.currency)}`
                : ""}
              {` | ${line.vatPercent.toString().replace(".", ",")} % USt`}
              {` | ${formatMoney(line.lineTotal, preview.currency)}`}
            </s-text>
          </s-stack>
        ))}

        <s-divider />
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text tone="neutral">Steuerfall:</s-text>
          <s-badge tone={preview.taxNote ? "info" : "neutral"}>{preview.taxCase}</s-badge>
          {preview.vatId ? <s-text tone="neutral">{preview.vatId}</s-text> : null}
        </s-stack>
        {preview.taxNote ? (
          <s-text tone="neutral">Hinweis auf dem Beleg: {preview.taxNote}</s-text>
        ) : null}
        <s-text tone="neutral">
          Netto {formatMoney(preview.totals.net, preview.currency)} | USt{" "}
          {formatMoney(preview.totals.vat, preview.currency)}
        </s-text>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text type="strong">
            Summe {formatMoney(preview.totals.gross, preview.currency)}
          </s-text>
          <s-badge tone={Math.abs(preview.difference) > 0.02 ? "warning" : "success"}>
            {Math.abs(preview.difference) > 0.02
              ? `${preview.difference > 0 ? "+" : ""}${preview.difference.toFixed(2)} ggue. Shopify`
              : "stimmt mit Shopify ueberein"}
          </s-badge>
        </s-stack>
      </s-stack>
    </s-box>
  );
}
