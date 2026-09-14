import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";

import { login } from "~/shopify.server";

interface LoginFormErrors {
  shop?: string;
}

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ errors: loginErrorMessage(await login(request)) });
}

export async function action({ request }: ActionFunctionArgs) {
  return json({ errors: loginErrorMessage(await login(request)) });
}

function loginErrorMessage(loginErrors: { shop?: string }): LoginFormErrors {
  if (loginErrors?.shop === "MISSING_SHOP") {
    return { shop: "Bitte die myshopify.com-Domain angeben." };
  }
  if (loginErrors?.shop === "INVALID_SHOP") {
    return { shop: "Das sieht nicht nach einer gueltigen Shop-Domain aus." };
  }
  return {};
}

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: LoginFormErrors = actionData?.errors ?? loaderData.errors;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: "28rem", margin: "6rem auto", padding: "0 1rem" }}>
      <h1>Papierkram fuer Shopify</h1>
      <p>Melde dich mit deiner Shop-Domain an, um die Integration zu oeffnen.</p>
      <Form method="post">
        <label htmlFor="shop" style={{ display: "block", marginBottom: ".25rem" }}>
          Shop-Domain
        </label>
        <input
          id="shop"
          type="text"
          name="shop"
          placeholder="meinshop.myshopify.com"
          autoComplete="on"
          style={{ width: "100%", padding: ".5rem", fontSize: "1rem" }}
        />
        {errors.shop ? (
          <p style={{ color: "#b91c1c" }} role="alert">
            {errors.shop}
          </p>
        ) : null}
        <button type="submit" style={{ marginTop: "1rem", padding: ".6rem 1.2rem", fontSize: "1rem" }}>
          Anmelden
        </button>
      </Form>
    </main>
  );
}
