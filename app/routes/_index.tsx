import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import { login } from "~/shopify.server";

/**
 * Einstieg ausserhalb des Shopify-Admins. Mit ?shop=... leiten wir direkt in
 * den OAuth-Fluss, sonst zur Anmeldeseite.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/auth/login?${url.searchParams.toString()}`);
  }
  await login(request);
  return redirect("/auth/login");
}
