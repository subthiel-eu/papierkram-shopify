import prisma from "~/db.server";

export type LogLevel = "info" | "warning" | "error";

/** Schreibt einen Protokolleintrag fuer die Admin-Oberflaeche. */
export async function log(args: {
  shop: string;
  level: LogLevel;
  action: string;
  message: string;
  context?: unknown;
}) {
  try {
    await prisma.logEntry.create({
      data: {
        shop: args.shop,
        level: args.level,
        action: args.action,
        message: args.message.slice(0, 2000),
        context: args.context ? safeJson(args.context) : null,
      },
    });
  } catch (error) {
    // Protokollieren darf den eigentlichen Vorgang nie zum Scheitern bringen.
    console.error("[papierkram] Protokolleintrag fehlgeschlagen", error);
  }
}

export const logInfo = (shop: string, action: string, message: string, context?: unknown) =>
  log({ shop, level: "info", action, message, context });

export const logWarning = (shop: string, action: string, message: string, context?: unknown) =>
  log({ shop, level: "warning", action, message, context });

export const logError = (shop: string, action: string, message: string, context?: unknown) =>
  log({ shop, level: "error", action, message, context });

export async function recentLogs(shop: string, options: { limit?: number; level?: LogLevel } = {}) {
  return prisma.logEntry.findMany({
    where: { shop, ...(options.level ? { level: options.level } : {}) },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 100,
  });
}

/** Haelt das Protokoll klein: alles aelter als 30 Tage entfernen. */
export async function pruneLogs(shop: string, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await prisma.logEntry.deleteMany({ where: { shop, createdAt: { lt: cutoff } } });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, replacer).slice(0, 8000);
  } catch {
    return String(value).slice(0, 8000);
  }
}

/** Fehlerobjekte sind sonst leer im JSON. */
function replacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.slice(0, 2000) };
  }
  return value;
}
