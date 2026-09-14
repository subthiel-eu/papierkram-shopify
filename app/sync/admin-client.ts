/**
 * Minimaler Typ des Admin-GraphQL-Clients aus @shopify/shopify-app-remix.
 * So laesst sich derselbe Code sowohl aus einem Request (authenticate.admin)
 * als auch aus dem Hintergrund-Worker (unauthenticated.admin) verwenden.
 */
export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export class ShopifyGraphqlError extends Error {
  readonly errors: unknown;

  constructor(message: string, errors: unknown) {
    super(message);
    this.name = "ShopifyGraphqlError";
    this.errors = errors;
  }
}

/**
 * Shopify hat die Zugangsberechtigung entzogen oder das Token ist abgelaufen.
 * Kein voruebergehender Fehler - Wiederholen waere reine Zeitverschwendung.
 */
export class ShopifyAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      `Shopify verweigert den Zugriff (HTTP ${status}). Die App muss im Shop neu autorisiert werden.`,
    );
    this.name = "ShopifyAuthError";
    this.status = status;
  }
}

/** Shopify hat gedrosselt. Nach kurzem Warten geht es weiter. */
export class ShopifyThrottledError extends Error {
  constructor() {
    super("Shopify hat die Anfrage gedrosselt.");
    this.name = "ShopifyThrottledError";
  }
}

interface GraphqlPayload<T> {
  data?: T;
  errors?: unknown;
  extensions?: {
    cost?: {
      throttleStatus?: { currentlyAvailable: number; maximumAvailable: number };
    };
  };
}

const MAX_ATTEMPTS = 4;

/**
 * Fuehrt eine Abfrage aus und wirft bei GraphQL-Fehlern.
 *
 * Die Admin-API ist kostenbasiert gedrosselt: eine grosse Bestellung oder
 * mehrere gleichzeitige Jobs reichen, um an das Limit zu stossen. Solche
 * Antworten werden hier mit wachsendem Abstand wiederholt, statt den Job
 * scheitern zu lassen.
 */
export async function runGraphql<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(Math.min(500 * 2 ** (attempt - 2), 8000));

    const response = await admin.graphql(query, variables ? { variables } : undefined);

    if (response.status === 401 || response.status === 403) {
      throw new ShopifyAuthError(response.status);
    }
    if (response.status === 429) {
      if (attempt === MAX_ATTEMPTS) throw new ShopifyThrottledError();
      continue;
    }

    const payload = (await response.json()) as GraphqlPayload<T>;

    if (payload.errors) {
      if (isThrottled(payload.errors)) {
        if (attempt === MAX_ATTEMPTS) throw new ShopifyThrottledError();
        continue;
      }
      throw new ShopifyGraphqlError(
        `Shopify GraphQL Fehler: ${summarize(payload.errors)}`,
        payload.errors,
      );
    }
    if (!payload.data) {
      throw new ShopifyGraphqlError("Shopify lieferte keine Daten.", null);
    }
    return payload.data;
  }

  throw new ShopifyThrottledError();
}

/** Drosselung meldet Shopify als Fehler mit extensions.code THROTTLED. */
function isThrottled(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((error) => {
    if (typeof error !== "object" || error === null) return false;
    const code = (error as { extensions?: { code?: unknown } }).extensions?.code;
    return code === "THROTTLED";
  });
}

function summarize(errors: unknown): string {
  if (Array.isArray(errors)) {
    return errors
      .map((error) =>
        typeof error === "object" && error && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error),
      )
      .join("; ");
  }
  return String(errors);
}
