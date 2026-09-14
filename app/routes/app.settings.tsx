import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import {
  buildClient,
  getSettings,
  hasCredentials,
  setApiToken,
  updateSettings,
} from "~/models/settings.server";
import type { PaymentTerm, Project } from "~/papierkram/types";
import { authenticate } from "~/shopify.server";
import { ensureMetafieldDefinitions } from "~/sync/metafields.server";
import { describeError } from "~/sync/service.server";

interface Choice {
  id: number;
  name: string;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);

  let paymentTerms: Choice[] = [];
  let projects: Choice[] = [];
  let invoiceTemplates: Choice[] = [];
  let estimateTemplates: Choice[] = [];
  let loadError: string | null = null;

  if (hasCredentials(settings)) {
    try {
      const client = buildClient(settings);
      const [terms, projectList, info] = await Promise.all([
        client.listAll<PaymentTerm>((params) => client.listPaymentTerms(params), {
          maxPages: 3,
        }),
        client.listAll<Project>((params) => client.listProjects(params), { maxPages: 3 }),
        client.info(),
      ]);
      paymentTerms = terms.map((term) => ({ id: term.id, name: term.name }));
      projects = projectList
        .filter((project) => project.record_state === "active")
        .map((project) => ({ id: project.id, name: project.name }));
      invoiceTemplates = (info.settings?.custom_templates?.invoices ?? []).map((t) => ({
        id: t.id,
        name: t.name,
      }));
      estimateTemplates = (info.settings?.custom_templates?.estimates ?? []).map((t) => ({
        id: t.id,
        name: t.name,
      }));
    } catch (error) {
      loadError = describeError(error);
    }
  }

  return json({
    settings: {
      ...settings,
      createdAt: settings.createdAt.toISOString(),
      updatedAt: settings.updatedAt.toISOString(),
      connectionOkAt: settings.connectionOkAt?.toISOString() ?? null,
    },
    hasToken: Boolean(settings.apiTokenCipher),
    paymentTerms,
    projects,
    invoiceTemplates,
    estimateTemplates,
    loadError,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  if (intent === "test") {
    try {
      const settings = await getSettings(shop);
      const result = await buildClient(settings).testConnection();
      await updateSettings(shop, { connectionOkAt: new Date() });
      return json({
        ok: true,
        message: `Verbindung erfolgreich (Papierkram API ${result.version}).`,
      });
    } catch (error) {
      return json({ ok: false, message: describeError(error) }, { status: 400 });
    }
  }

  if (intent === "metafields") {
    try {
      const result = await ensureMetafieldDefinitions(admin);
      return json({
        ok: true,
        message: `Metafeld-Definitionen geprueft: ${result.created.length} neu, ${result.skipped.length} bereits vorhanden.`,
      });
    } catch (error) {
      return json({ ok: false, message: describeError(error) }, { status: 400 });
    }
  }

  try {
    const token = String(form.get("apiToken") ?? "").trim();
    if (token) await setApiToken(shop, token);
    if (form.get("clearToken") === "on") await setApiToken(shop, null);

    await updateSettings(shop, {
      subdomain: text(form, "subdomain"),
      invoiceTrigger: String(form.get("invoiceTrigger") ?? "manual"),
      invoiceMode: String(form.get("invoiceMode") ?? "draft"),
      estimateFromDraftOrders: checkbox(form, "estimateFromDraftOrders"),
      paymentTermId: numberOrNull(form, "paymentTermId"),
      invoiceTemplateId: numberOrNull(form, "invoiceTemplateId"),
      estimateTemplateId: numberOrNull(form, "estimateTemplateId"),
      projectId: numberOrNull(form, "projectId"),
      grossMode: String(form.get("grossMode") ?? "auto"),
      defaultVatRate: numberOr(form, "defaultVatRate", 19),
      includeShipping: checkbox(form, "includeShipping"),
      shippingLabel: text(form, "shippingLabel") ?? "Versandkosten",
      includeTips: checkbox(form, "includeTips"),
      applyDiscounts: checkbox(form, "applyDiscounts"),
      syncCustomers: checkbox(form, "syncCustomers"),
      updateCustomers: checkbox(form, "updateCustomers"),
      fallbackToPersonName: checkbox(form, "fallbackToPersonName"),
      documentNameTemplate:
        text(form, "documentNameTemplate") ?? "Shopify Bestellung {{order_name}}",
      writeMetafields: checkbox(form, "writeMetafields"),
    });

    return json({ ok: true, message: "Einstellungen gespeichert." });
  } catch (error) {
    return json({ ok: false, message: describeError(error) }, { status: 400 });
  }
}

function text(form: FormData, key: string): string | null {
  const value = String(form.get(key) ?? "").trim();
  return value === "" ? null : value;
}

function checkbox(form: FormData, key: string): boolean {
  return form.get(key) !== null;
}

function numberOrNull(form: FormData, key: string): number | null {
  const value = String(form.get(key) ?? "").trim();
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOr(form: FormData, key: string, fallback: number): number {
  return numberOrNull(form, key) ?? fallback;
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const settings = data.settings;

  return (
    <s-page heading="Einstellungen">
      {actionData ? (
        <s-banner tone={actionData.ok ? "success" : "critical"}>
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-banner>
      ) : null}

      {data.loadError ? (
        <s-banner tone="warning" heading="Papierkram-Stammdaten nicht geladen">
          <s-paragraph>{data.loadError}</s-paragraph>
        </s-banner>
      ) : null}

      <Form method="post">
        <input type="hidden" name="intent" value="save" />
        <s-section heading="Zugang">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Papierkram-Subdomain"
              name="subdomain"
              value={settings.subdomain ?? ""}
              placeholder="meinefirma"
              details="Der Teil vor .papierkram.de in der Adresszeile."
            />
            <s-password-field
              label={data.hasToken ? "Neuer API-Token (leer lassen = unveraendert)" : "API-Token"}
              name="apiToken"
              placeholder={data.hasToken ? "********" : "Token aus Papierkram einfuegen"}
              details="Papierkram: Einstellungen -> API. Der Token wird verschluesselt gespeichert."
            />
            {data.hasToken ? (
              <s-checkbox
                label="Gespeicherten Token loeschen"
                name="clearToken"
                details="Trennt die Verbindung, bis ein neuer Token hinterlegt wird."
              />
            ) : null}
            {settings.connectionOkAt ? (
              <s-text tone="neutral">
                Zuletzt erfolgreich geprueft:{" "}
                {new Date(settings.connectionOkAt).toLocaleString("de-DE")}
              </s-text>
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="Rechnungen">
          <s-stack direction="block" gap="base">
            <s-select
              label="Wann soll eine Rechnung entstehen?"
              name="invoiceTrigger"
              value={settings.invoiceTrigger}
            >
              <s-option value="manual">Nur manuell aus der Bestellung heraus</s-option>
              <s-option value="order_create">Sobald die Bestellung eingeht</s-option>
              <s-option value="order_paid">Sobald die Bestellung bezahlt ist</s-option>
              <s-option value="order_fulfilled">Sobald die Bestellung versendet ist</s-option>
            </s-select>

            <s-select
              label="Was soll mit automatisch erzeugten Rechnungen passieren?"
              name="invoiceMode"
              value={settings.invoiceMode}
              details="Gilt nur fuer den automatischen Ablauf. Beim manuellen Anlegen waehlst du es jedes Mal im Dialog."
            >
              <s-option value="draft">Als Entwurf in Papierkram liegen lassen</s-option>
              <s-option value="pdf">Festschreiben (Belegnummer wird vergeben)</s-option>
              <s-option value="email">Festschreiben und an den Kunden senden</s-option>
            </s-select>

            <s-select
              label="Zahlungsbedingung"
              name="paymentTermId"
              value={settings.paymentTermId ? String(settings.paymentTermId) : ""}
              details="Pflichtfeld: Papierkram legt ohne Zahlungsbedingung keine Rechnung an."
            >
              <s-option value="">Bitte waehlen</s-option>
              {data.paymentTerms.map((term) => (
                <s-option key={term.id} value={String(term.id)}>
                  {term.name}
                </s-option>
              ))}
            </s-select>

            <s-select
              label="Rechnungsvorlage"
              name="invoiceTemplateId"
              value={settings.invoiceTemplateId ? String(settings.invoiceTemplateId) : ""}
            >
              <s-option value="">Standardvorlage</s-option>
              {data.invoiceTemplates.map((template) => (
                <s-option key={template.id} value={String(template.id)}>
                  {template.name}
                </s-option>
              ))}
            </s-select>

            <s-text-field
              label="Belegbezeichnung"
              name="documentNameTemplate"
              value={settings.documentNameTemplate}
              details="Platzhalter: {{order_name}}, {{order_number}}, {{customer}}, {{shop}}, {{date}}"
            />
          </s-stack>
        </s-section>

        <s-section heading="Angebote">
          <s-stack direction="block" gap="base">
            <s-checkbox
              label="Aus Shopify-Bestellentwuerfen automatisch Angebote erzeugen"
              name="estimateFromDraftOrders"
              checked={settings.estimateFromDraftOrders}
              details="Unabhaengig davon kannst du Angebote jederzeit manuell aus einem Entwurf erzeugen."
            />
            <s-select
              label="Angebotsvorlage"
              name="estimateTemplateId"
              value={settings.estimateTemplateId ? String(settings.estimateTemplateId) : ""}
            >
              <s-option value="">Standardvorlage</s-option>
              {data.estimateTemplates.map((template) => (
                <s-option key={template.id} value={String(template.id)}>
                  {template.name}
                </s-option>
              ))}
            </s-select>
          </s-stack>
        </s-section>

        <s-section heading="Betraege und Steuern">
          <s-stack direction="block" gap="base">
            <s-select label="Preisbasis" name="grossMode" value={settings.grossMode}>
              <s-option value="auto">Wie im Shop eingestellt (empfohlen)</s-option>
              <s-option value="net">Immer netto ausweisen</s-option>
              <s-option value="gross">Immer brutto ausweisen</s-option>
            </s-select>
            <s-text tone="neutral">
              &quot;Wie im Shop&quot; vermeidet Rundungsdifferenzen, weil dann keine
              Umrechnung zwischen Netto und Brutto noetig ist.
            </s-text>

            <s-number-field
              label="Standard-Steuersatz in Prozent"
              name="defaultVatRate"
              value={String(settings.defaultVatRate)}
              details="Wird nur verwendet, wenn Shopify fuer eine Position keinen Steuersatz liefert, die Bestellung aber Steuern enthaelt."
            />

            <s-checkbox
              label="Versandkosten als eigene Position uebernehmen"
              name="includeShipping"
              checked={settings.includeShipping}
            />
            <s-text-field
              label="Bezeichnung der Versandposition"
              name="shippingLabel"
              value={settings.shippingLabel}
            />
            <s-checkbox
              label="Trinkgeld als eigene Position uebernehmen"
              name="includeTips"
              checked={settings.includeTips}
            />
            <s-checkbox
              label="Rabatte separat auf dem Beleg ausweisen"
              name="applyDiscounts"
              checked={settings.applyDiscounts}
              details="Ohne Haken wird der Rabatt still in den Stueckpreis eingerechnet."
            />
          </s-stack>
        </s-section>

        <s-section heading="Kunden">
          <s-stack direction="block" gap="base">
            <s-checkbox
              label="Shopify-Kunden als Papierkram-Kontakte anlegen"
              name="syncCustomers"
              checked={settings.syncCustomers}
            />
            <s-checkbox
              label="Bestehende Kontakte bei Aenderungen aktualisieren"
              name="updateCustomers"
              checked={settings.updateCustomers}
              details="Vorsicht: ueberschreibt in Papierkram gepflegte Adressdaten."
            />
            <s-checkbox
              label="Privatkunden unter ihrem Namen anlegen"
              name="fallbackToPersonName"
              checked={settings.fallbackToPersonName}
              details="Ohne Haken werden nur Bestellungen mit Firmenname als Kontakt angelegt."
            />
            <s-select
              label="Papierkram-Projekt"
              name="projectId"
              value={settings.projectId ? String(settings.projectId) : ""}
              details="Optional. Ordnet alle Belege einem Projekt zu."
            >
              <s-option value="">Kein Projekt</s-option>
              {data.projects.map((project) => (
                <s-option key={project.id} value={String(project.id)}>
                  {project.name}
                </s-option>
              ))}
            </s-select>
          </s-stack>
        </s-section>

        <s-section heading="Shopify">
          <s-stack direction="block" gap="base">
            <s-checkbox
              label="Papierkram-Daten als Metafelder an Bestellung und Kunde schreiben"
              name="writeMetafields"
              checked={settings.writeMetafields}
              details="Macht Belegnummer und Link in Shopify, Flow und Exporten nutzbar."
            />
          </s-stack>
        </s-section>

        <s-section>
          <s-button type="submit" variant="primary" loading={busy}>
            Speichern
          </s-button>
        </s-section>
      </Form>

      <s-section heading="Werkzeuge">
        <s-stack direction="inline" gap="base">
          {/* Eigene Formulare: <s-button> kennt kein name/value, mit dem sich
              mehrere Aktionen an einem Formular unterscheiden liessen. */}
          <Form method="post">
            <input type="hidden" name="intent" value="test" />
            <s-button type="submit" loading={busy}>
              Verbindung testen
            </s-button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="metafields" />
            <s-button type="submit" loading={busy}>
              Metafelder anlegen
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}
