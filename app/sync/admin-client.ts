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

/** Fuehrt eine Abfrage aus und wirft bei GraphQL- oder userErrors. */
export async function runGraphql<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const payload = (await response.json()) as {
    data?: T;
    errors?: unknown;
  };

  if (payload.errors) {
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
