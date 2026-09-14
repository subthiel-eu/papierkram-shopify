import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";

import { PolarisProvider } from "~/components/PolarisProvider";
import { authenticate } from "~/shopify.server";
import { ensureMetafieldDefinitions } from "~/sync/metafields.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  // Beim ersten Oeffnen die Metafeld-Definitionen anlegen, damit die
  // Papierkram-Felder im Shopify-Admin sichtbar sind. Fehler sind unkritisch.
  ensureMetafieldDefinitions(admin).catch((error) =>
    console.warn("[papierkram] Metafeld-Definitionen:", error),
  );

  return json({
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shop: session.shop,
  });
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <PolarisProvider apiKey={apiKey}>
      <ui-nav-menu>
        <Link to="/app" rel="home">
          Uebersicht
        </Link>
        <Link to="/app/documents">Belege</Link>
        <Link to="/app/backfill">Nachtragen</Link>
        <Link to="/app/propositions">Positionen</Link>
        <Link to="/app/logs">Protokoll</Link>
        <Link to="/app/settings">Einstellungen</Link>
      </ui-nav-menu>
      <Outlet />
    </PolarisProvider>
  );
}

// Shopify braucht die Fehler- und Header-Behandlung, damit die App im
// eingebetteten Kontext korrekt neu authentifiziert.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
