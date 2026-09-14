import { useNavigate } from "@remix-run/react";
import { useEffect, type ReactNode } from "react";

const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
// Kanal-URL: liefert immer die neueste stabile Polaris-1-Version.
const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";

/**
 * Laedt App Bridge und die Polaris Web Components und verdrahtet die
 * Navigation der App-Bridge-Elemente mit dem Remix-Router.
 *
 * Bewusst ohne den AppProvider aus @shopify/shopify-app-remix/react: der
 * bringt Polaris React mit, das Shopify zugunsten der Web Components
 * eingestellt hat.
 */
export function PolarisProvider({
  apiKey,
  children,
}: {
  apiKey: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();

  useEffect(() => {
    // Links in <ui-nav-menu> feuern shopify:navigate statt die Seite neu zu laden.
    const handleNavigate = (event: Event) => {
      const href = (event.target as HTMLElement | null)?.getAttribute("href");
      if (href) navigate(href);
    };

    addEventListener("shopify:navigate", handleNavigate);
    return () => removeEventListener("shopify:navigate", handleNavigate);
  }, [navigate]);

  return (
    <>
      <script src={APP_BRIDGE_URL} data-api-key={apiKey} />
      <script src={POLARIS_URL} />
      {children}
    </>
  );
}
