/** Fehler einer Papierkram-API-Antwort mit Statuscode und Rohtext. */
export class PapierkramApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  /** Wert des Retry-After Headers in Sekunden, falls vorhanden. */
  readonly retryAfterSeconds: number | null;

  constructor(args: {
    status: number;
    body: unknown;
    method: string;
    path: string;
    message?: string;
    retryAfterSeconds?: number | null;
  }) {
    super(args.message ?? describe(args.status, args.body, args.path));
    this.name = "PapierkramApiError";
    this.status = args.status;
    this.body = args.body;
    this.method = args.method;
    this.path = args.path;
    this.retryAfterSeconds = args.retryAfterSeconds ?? null;
  }

  /** 401/403 bedeuten fast immer: Token falsch oder API-Paket nicht gebucht. */
  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound() {
    return this.status === 404;
  }

  get isRateLimited() {
    return this.status === 429;
  }

  /** 5xx und 429 duerfen wiederholt werden, 4xx nicht. */
  get isRetryable() {
    return this.status === 429 || this.status >= 500;
  }
}

/** Netzwerkfehler (DNS, Timeout, Abbruch) - immer wiederholbar. */
export class PapierkramNetworkError extends Error {
  readonly isRetryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PapierkramNetworkError";
  }
}

/** Konfiguration unvollstaendig (Subdomain/Token fehlt). */
export class PapierkramNotConfiguredError extends Error {
  constructor(message = "Papierkram ist fuer diesen Shop noch nicht eingerichtet.") {
    super(message);
    this.name = "PapierkramNotConfiguredError";
  }
}

function describe(status: number, body: unknown, path: string): string {
  const detail = extractMessage(body);
  const base = `Papierkram API ${status} bei ${path}`;
  return detail ? `${base}: ${detail}` : base;
}

/**
 * Papierkram liefert Validierungsfehler in unterschiedlichen Formen:
 * {"error": "..."} , {"errors": {"name": ["ist erforderlich"]}} oder {"message": "..."}.
 */
export function extractMessage(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === "string") return body.slice(0, 500) || null;
  if (typeof body !== "object") return null;

  const record = body as Record<string, unknown>;

  for (const field of ["error", "message", "detail"] as const) {
    if (typeof record[field] === "string") return record[field] as string;
  }

  const errors = record.errors;
  if (Array.isArray(errors)) {
    return errors.map((e) => String(e)).join("; ");
  }
  if (errors && typeof errors === "object") {
    return Object.entries(errors as Record<string, unknown>)
      .map(([field, messages]) => {
        const text = Array.isArray(messages)
          ? messages.join(", ")
          : String(messages);
        return `${field}: ${text}`;
      })
      .join("; ");
  }
  return null;
}
