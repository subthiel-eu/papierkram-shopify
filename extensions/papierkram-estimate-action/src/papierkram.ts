/**
 * Aufrufe an das App-Backend.
 *
 * Relative URLs werden vom Admin an die App weitergereicht; den ID-Token
 * haengen wir explizit an, damit authenticate.admin() auf Serverseite greift.
 */

export interface PapierkramDocument {
  id: string;
  kind: "invoice" | "estimate";
  papierkramId: number;
  documentNo: string | null;
  state: string | null;
  totalGross: number | null;
  url: string | null;
  updatedAt: string;
}

export interface PapierkramContext {
  configured: boolean;
  subdomain: string | null;
  /** Aktive Ausloeser als Shopify-Topics; leer bedeutet: nur manuell. */
  invoiceTriggers: string[];
  estimateTriggers: string[];
  paymentTermConfigured: boolean;
  documents: PapierkramDocument[];
  customerLink: {
    papierkramId: number;
    documentNo: string | null;
    url: string | null;
  } | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
  reused?: boolean;
  document?: {
    kind: "invoice" | "estimate";
    papierkramId: number;
    documentNo: string | null;
    state: string | null;
    totalGross: number | null;
    url: string;
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await shopify.auth.idToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function loadContext(id: string): Promise<PapierkramContext> {
  const response = await fetch(
    `/api/papierkram/context?id=${encodeURIComponent(id)}`,
    { headers: await authHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Die App antwortet nicht (HTTP ${response.status}).`);
  }
  return (await response.json()) as PapierkramContext;
}

export async function runAction(
  body: Record<string, unknown>,
): Promise<ActionResult> {
  const response = await fetch("/api/papierkram/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });

  let payload: ActionResult;
  try {
    payload = (await response.json()) as ActionResult;
  } catch {
    return { ok: false, error: `Unerwartete Antwort (HTTP ${response.status}).` };
  }
  if (!response.ok && payload.ok !== false) {
    return { ok: false, error: `HTTP ${response.status}` };
  }
  return payload;
}

/** Menschenlesbarer Titel eines Belegs. */
export function documentTitle(document: PapierkramDocument): string {
  const label = document.kind === "invoice" ? "Rechnung" : "Angebot";
  return document.documentNo ? `${label} ${document.documentNo}` : `${label} (Entwurf)`;
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

/** Link in die App-Einstellungen im Shopify-Admin. */
export const SETTINGS_URL = "shopify://admin/apps/papierkram/app/settings";
