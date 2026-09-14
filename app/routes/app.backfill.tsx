import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import { getSettings, hasCredentials } from "~/models/settings.server";
import { authenticate } from "~/shopify.server";
import {
  estimateBackfill,
  listBackfillRuns,
  startBackfill,
  type BackfillFilters,
} from "~/sync/backfill.server";
import { describeError } from "~/sync/service.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const runs = await listBackfillRuns(session.shop);

  return json({
    configured: hasCredentials(settings),
    paymentTermConfigured: settings.paymentTermId !== null,
    remainingQuota: settings.remainingQuota,
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      from: run.fromDate.toISOString().slice(0, 10),
      to: run.toDate.toISOString().slice(0, 10),
      estimatedOrders: run.estimatedOrders,
      foundOrders: run.foundOrders,
      queuedOrders: run.queuedOrders,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "estimate");

  const filters = readFilters(form);
  if ("error" in filters) {
    return json(
      { ok: false, message: filters.error, estimate: null, echo: null },
      { status: 400 },
    );
  }

  try {
    const echo = {
      from: filters.from.toISOString().slice(0, 10),
      to: filters.to.toISOString().slice(0, 10),
      onlyPaid: filters.onlyPaid,
    };

    if (intent === "estimate") {
      const estimate = await estimateBackfill(admin, filters);
      return json({
        ok: true,
        message:
          estimate.orders === 0
            ? "In diesem Zeitraum gibt es keine passenden Bestellungen."
            : `${estimate.precise ? "" : "Rund "}${estimate.orders} Bestellungen, geschaetzt etwa ${estimate.estimatedCredits} Papierkram-Credits.`,
        estimate,
        echo,
      });
    }

    const estimate = await estimateBackfill(admin, filters);
    await startBackfill(admin, session.shop, filters, estimate);
    return json({
      ok: true,
      message:
        "Der Nachtrag laeuft. Shopify stellt das Ergebnis zu, danach werden die Bestellungen nacheinander abgearbeitet.",
      estimate: null,
      echo: null,
    });
  } catch (error) {
    return json(
      { ok: false, message: describeError(error), estimate: null, echo: null },
      { status: 400 },
    );
  }
}

function readFilters(form: FormData): BackfillFilters | { error: string } {
  const from = new Date(String(form.get("from") ?? ""));
  const to = new Date(String(form.get("to") ?? ""));

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: "Bitte einen gueltigen Zeitraum angeben." };
  }
  if (from > to) {
    return { error: "Das Startdatum liegt nach dem Enddatum." };
  }

  // Bis zum Ende des gewaehlten Tages, sonst fehlt der letzte Tag.
  to.setUTCHours(23, 59, 59, 999);

  return {
    from,
    to,
    onlyPaid: form.get("onlyPaid") !== null,
    skipExisting: true,
  };
}

export default function Backfill() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const estimate = actionData && "estimate" in actionData ? actionData.estimate : null;
  const echo = actionData && "echo" in actionData ? actionData.echo : null;

  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 90 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);

  return (
    <s-page heading="Bestellungen nachtragen">
      {actionData ? (
        <s-banner tone={actionData.ok ? "success" : "critical"}>
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-banner>
      ) : null}

      {!data.configured ? (
        <s-banner tone="warning" heading="Papierkram ist nicht verbunden">
          <s-button slot="secondary-actions" href="/app/settings">
            Einstellungen
          </s-button>
        </s-banner>
      ) : null}

      {data.configured && !data.paymentTermConfigured ? (
        <s-banner tone="warning" heading="Zahlungsbedingung fehlt">
          <s-paragraph>Ohne sie schlaegt jede Rechnung fehl.</s-paragraph>
          <s-button slot="secondary-actions" href="/app/settings">
            Auswaehlen
          </s-button>
        </s-banner>
      ) : null}

      <s-section heading="Zeitraum">
        <s-paragraph>
          Shopify liefert die Bestellungen des Zeitraums als Massenabfrage; die
          Belege entstehen danach nacheinander in der Warteschlange. Bestellungen
          mit vorhandenem Beleg werden uebersprungen.
        </s-paragraph>
        {data.remainingQuota !== null ? (
          <s-text tone="neutral">
            Verbleibendes Papierkram-Kontingent: {data.remainingQuota}
          </s-text>
        ) : null}

        <Form method="post">
          <input type="hidden" name="intent" value="estimate" />
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-date-field label="Von" name="from" value={defaultFrom} />
              <s-date-field label="Bis" name="to" value={today} />
            </s-stack>
            <s-checkbox
              label="Nur bezahlte Bestellungen"
              name="onlyPaid"
              checked
              details="Empfohlen. Unbezahlte Bestellungen sind meist noch nicht abrechnungsreif."
            />
            <s-button type="submit" loading={busy} disabled={!data.configured}>
              Umfang schaetzen
            </s-button>
          </s-stack>
        </Form>

        {estimate && echo && estimate.orders > 0 ? (
          <>
            <s-divider />
            {/* Zweiter Schritt mit denselben Werten - so steht die Zahl fest,
                die der Haendler bestaetigt. */}
            <Form method="post">
              <input type="hidden" name="intent" value="start" />
              <input type="hidden" name="from" value={echo.from} />
              <input type="hidden" name="to" value={echo.to} />
              {echo.onlyPaid ? (
                <input type="hidden" name="onlyPaid" value="on" />
              ) : null}
              <s-stack direction="block" gap="base">
                <s-text type="strong">
                  {estimate.orders} Bestellungen von {echo.from} bis {echo.to}
                </s-text>
                {data.remainingQuota !== null &&
                estimate.estimatedCredits > data.remainingQuota ? (
                  <s-banner tone="critical" heading="Das Kontingent reicht voraussichtlich nicht">
                    <s-paragraph>
                      Geschaetzt {estimate.estimatedCredits} Credits bei{" "}
                      {data.remainingQuota} verbleibenden. Der Nachtrag pausiert
                      dann automatisch bis zum Zuruecksetzen des Kontingents.
                    </s-paragraph>
                  </s-banner>
                ) : null}
                <s-button type="submit" variant="primary" loading={busy}>
                  Nachtrag jetzt starten
                </s-button>
              </s-stack>
            </Form>
          </>
        ) : null}
      </s-section>

      <s-section heading="Bisherige Laeufe">
        {data.runs.length === 0 ? (
          <s-paragraph>Noch kein Nachtrag gelaufen.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Zeitraum</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Gefunden</s-table-header>
              <s-table-header>Eingeplant</s-table-header>
              <s-table-header>Gestartet</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.runs.map((run) => (
                <s-table-row key={run.id}>
                  <s-table-cell>
                    {run.from} bis {run.to}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        run.status === "done"
                          ? "success"
                          : run.status === "failed"
                            ? "critical"
                            : "warning"
                      }
                    >
                      {run.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{run.foundOrders ?? run.estimatedOrders ?? "-"}</s-table-cell>
                  <s-table-cell>{run.queuedOrders ?? "-"}</s-table-cell>
                  <s-table-cell>
                    {new Date(run.createdAt).toLocaleString("de-DE")}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
