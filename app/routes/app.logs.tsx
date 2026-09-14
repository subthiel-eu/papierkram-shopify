import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import { pruneLogs, recentLogs, type LogLevel } from "~/models/log.server";
import { authenticate } from "~/shopify.server";
import { listJobs, retryJob } from "~/sync/queue.server";
import { kickWorker } from "~/sync/worker.server";

import { levelTone } from "./app._index";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const levelParam = url.searchParams.get("level");
  const level: LogLevel | undefined =
    levelParam === "info" || levelParam === "warning" || levelParam === "error"
      ? levelParam
      : undefined;

  const [logs, jobs] = await Promise.all([
    recentLogs(session.shop, { limit: 150, level }),
    listJobs(session.shop, { limit: 50 }),
  ]);

  return json({
    level: level ?? "",
    logs: logs.map((entry) => ({
      id: entry.id,
      level: entry.level,
      action: entry.action,
      message: entry.message,
      context: entry.context,
      createdAt: entry.createdAt.toISOString(),
    })),
    jobs: jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastError: job.lastError,
      runAfter: job.runAfter.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "retry") {
    const id = String(form.get("jobId") ?? "");
    if (!id) return json({ ok: false, message: "Kein Job angegeben." }, { status: 400 });
    await retryJob(session.shop, id);
    kickWorker();
    return json({ ok: true, message: "Job erneut eingeplant." });
  }

  if (intent === "prune") {
    await pruneLogs(session.shop, 0);
    return json({ ok: true, message: "Protokoll geleert." });
  }

  return json({ ok: false, message: "Unbekannte Aktion." }, { status: 400 });
}

const JOB_LABELS: Record<string, string> = {
  order_invoice: "Rechnung aus Bestellung",
  draft_order_estimate: "Angebot aus Entwurf",
  customer_upsert: "Kontakt abgleichen",
  refresh_document: "Belegstatus holen",
};

export default function Logs() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <s-page heading="Protokoll">
      {actionData ? (
        <s-banner tone={actionData.ok ? "success" : "critical"}>
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Warteschlange">
        {data.jobs.length === 0 ? (
          <s-paragraph>Keine Auftraege vorhanden.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>Aufgabe</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Versuche</s-table-header>
              <s-table-header>Fehler</s-table-header>
              <s-table-header>Aktion</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.jobs.map((job) => (
                <s-table-row key={job.id}>
                  <s-table-cell>{JOB_LABELS[job.type] ?? job.type}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={jobTone(job.status)}>{job.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {job.attempts}/{job.maxAttempts}
                  </s-table-cell>
                  <s-table-cell>{job.lastError ?? "-"}</s-table-cell>
                  <s-table-cell>
                    {job.status === "failed" || job.status === "pending" ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="retry" />
                        <input type="hidden" name="jobId" value={job.id} />
                        <s-button type="submit" variant="tertiary" loading={busy}>
                          Erneut versuchen
                        </s-button>
                      </Form>
                    ) : (
                      "-"
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Ereignisse">
        <Form method="get">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-select label="Stufe" name="level" value={data.level}>
              <s-option value="">Alle</s-option>
              <s-option value="info">Info</s-option>
              <s-option value="warning">Warnung</s-option>
              <s-option value="error">Fehler</s-option>
            </s-select>
            <s-button type="submit">Filtern</s-button>
          </s-stack>
        </Form>

        <s-divider />

        {data.logs.length === 0 ? (
          <s-paragraph>Keine Eintraege.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-200">
            {data.logs.map((entry) => (
              <s-box key={entry.id} padding="small" background="subdued" borderRadius="base">
                <s-stack direction="block" gap="small-500">
                  <s-stack direction="inline" gap="small">
                    <s-badge tone={levelTone(entry.level)}>{entry.level}</s-badge>
                    <s-text type="strong">{entry.action}</s-text>
                    <s-text tone="neutral">
                      {new Date(entry.createdAt).toLocaleString("de-DE")}
                    </s-text>
                  </s-stack>
                  <s-text>{entry.message}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section>
        <Form method="post">
          <input type="hidden" name="intent" value="prune" />
          <s-button type="submit" tone="critical" loading={busy}>
            Protokoll leeren
          </s-button>
        </Form>
      </s-section>
    </s-page>
  );
}

function jobTone(status: string): "success" | "warning" | "critical" | "neutral" {
  if (status === "done") return "success";
  if (status === "failed") return "critical";
  if (status === "running") return "warning";
  return "neutral";
}
