/** Platzhalter in Versandtexten und Belegbezeichnungen. */
export type TemplateContext = Record<string, string | number | null | undefined>;

/**
 * Ersetzt {{platzhalter}} case-insensitiv. Unbekannte Platzhalter werden
 * entfernt, damit kein "{{kunde}}" beim Empfaenger landet.
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key: string) => {
    const value = context[key.toLowerCase()];
    return value === null || value === undefined ? "" : String(value);
  });
}

export interface EmailTemplate {
  subject: string;
  body: string;
}

/** Baut Betreff und Text fuer den Belegversand. */
export function renderEmail(
  template: EmailTemplate,
  context: TemplateContext,
): EmailTemplate {
  return {
    // Papierkram lehnt leere Betreffs ab; ein Fallback ist billiger als ein Fehler.
    subject: collapse(renderTemplate(template.subject, context)) || "Ihr Beleg",
    body: renderTemplate(template.body, context).trim() || "Guten Tag,",
  };
}

function collapse(value: string): string {
  return value.replace(/[ \t]+/g, " ").trim();
}
