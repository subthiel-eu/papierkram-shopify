import "@shopify/ui-extensions/preact";
import type { Api } from "@shopify/ui-extensions/admin.draft-order-details.action.render";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import {
  documentTitle,
  loadContext,
  runAction,
  SETTINGS_URL,
  type PapierkramContext,
} from "./papierkram";

declare global {
  const shopify: Api;
}

export default async function extension() {
  render(<EstimateAction />, document.body);
}

type Delivery = "draft" | "pdf" | "email";

function EstimateAction() {
  const draftOrderId = shopify.data?.selected?.[0]?.id;

  const [context, setContext] = useState<PapierkramContext | null>(null);
  const [delivery, setDelivery] = useState<Delivery>("draft");
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!draftOrderId) return;
    loadContext(draftOrderId)
      .then(setContext)
      .catch((loadError: unknown) =>
        setError(loadError instanceof Error ? loadError.message : String(loadError)),
      );
  }, [draftOrderId]);

  const existing = context?.documents.filter((doc) => doc.kind === "estimate") ?? [];

  async function submit() {
    if (!draftOrderId) return;
    if (delivery === "email" && !recipient.trim()) {
      setError("Bitte eine Empfaengeradresse angeben.");
      return;
    }

    setBusy(true);
    setError(null);

    const created = await runAction({
      action: "create_estimate",
      id: draftOrderId,
      force: existing.length > 0,
    });

    if (!created.ok || !created.document) {
      setError(created.error ?? "Das Angebot konnte nicht angelegt werden.");
      setBusy(false);
      return;
    }

    if (delivery !== "draft") {
      const delivered = await runAction({
        action: "deliver",
        id: draftOrderId,
        kind: "estimate",
        papierkramId: created.document.papierkramId,
        sendVia: delivery,
        ...(delivery === "email"
          ? {
              email: {
                recipient: recipient.trim(),
                subject: `Ihr Angebot ${created.document.documentNo ?? ""}`.trim(),
                body:
                  "Guten Tag,\n\nim Anhang finden Sie unser Angebot. " +
                  "Bei Rueckfragen melden Sie sich gerne.\n\n" +
                  "Mit freundlichen Gruessen",
              },
            }
          : {}),
      });

      if (!delivered.ok) {
        setError(
          `Das Angebot wurde angelegt, der Versand schlug jedoch fehl: ${delivered.error ?? "unbekannter Fehler"}`,
        );
        setBusy(false);
        return;
      }
    }

    setDone(
      created.document.documentNo
        ? `Angebot ${created.document.documentNo} angelegt.`
        : "Angebot als Entwurf angelegt.",
    );
    setBusy(false);
  }

  return (
    <s-admin-action heading="Angebot in Papierkram anlegen" loading={busy}>
      {/* Die Aktionsleiste wird ueber benannte Slots befuellt. */}
      {done ? (
        <s-button slot="primary-action" variant="primary" onClick={() => shopify.close()}>
          Schliessen
        </s-button>
      ) : (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={busy || !context?.configured}
          onClick={submit}
        >
          Anlegen
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

        {done ? (
          <s-banner tone="success">
            <s-paragraph>{done}</s-paragraph>
          </s-banner>
        ) : null}

        {context && !context.configured ? (
          <s-banner tone="warning" heading="Papierkram ist nicht verbunden">
            <s-link href={SETTINGS_URL}>Einstellungen oeffnen</s-link>
          </s-banner>
        ) : null}

        {existing.length > 0 && !done ? (
          <s-banner tone="warning" heading="Es gibt bereits ein Angebot">
            <s-paragraph>
              {existing.map(documentTitle).join(", ")}. Wenn du fortfaehrst,
              entsteht ein weiterer Beleg in Papierkram.
            </s-paragraph>
          </s-banner>
        ) : null}

        {!done ? (
          <s-select
            label="Was soll danach passieren?"
            name="delivery"
            value={delivery}
            onChange={(event) => setDelivery(event.currentTarget.value as Delivery)}
          >
            <s-option value="draft">Als Entwurf belassen</s-option>
            <s-option value="pdf">Festschreiben (PDF)</s-option>
            <s-option value="email">Festschreiben und per E-Mail senden</s-option>
          </s-select>
        ) : null}

        {delivery === "email" && !done ? (
          <s-email-field
            label="Empfaenger"
            name="recipient"
            value={recipient}
            onChange={(event) => setRecipient(event.currentTarget.value)}
          />
        ) : null}
      </s-stack>
    </s-admin-action>
  );
}
