/** Wiederverwendete Fragmente und Abfragen der Shopify Admin GraphQL API. */

const ADDRESS_FIELDS = `
  company
  firstName
  lastName
  address1
  address2
  zip
  city
  province
  country
  countryCodeV2
  phone
`;

const CUSTOMER_FIELDS = `
  id
  legacyResourceId
  firstName
  lastName
  displayName
  email
  phone
  note
  taxExempt
  defaultAddress { ${ADDRESS_FIELDS} }
`;

const TAX_LINE_FIELDS = `
  title
  rate
  ratePercentage
  priceSet { shopMoney { amount currencyCode } }
`;

export const ORDER_QUERY = `#graphql
  query PapierkramOrder($id: ID!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      note
      email
      phone
      createdAt
      processedAt
      currencyCode
      taxesIncluded
      taxExempt
      displayFinancialStatus
      cancelledAt
      customer { ${CUSTOMER_FIELDS} }
      billingAddress { ${ADDRESS_FIELDS} }
      shippingAddress { ${ADDRESS_FIELDS} }
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      totalTipReceivedSet { shopMoney { amount currencyCode } }
      lineItems(first: 250) {
        nodes {
          id
          name
          title
          sku
          quantity
          currentQuantity
          variantTitle
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountAllocations {
            allocatedAmountSet { shopMoney { amount currencyCode } }
          }
          taxLines { ${TAX_LINE_FIELDS} }
          product { id title }
          variant { id title sku }
        }
      }
      shippingLines(first: 20) {
        nodes {
          id
          title
          originalPriceSet { shopMoney { amount currencyCode } }
          discountAllocations {
            allocatedAmountSet { shopMoney { amount currencyCode } }
          }
          taxLines { ${TAX_LINE_FIELDS} }
        }
      }
    }
  }
`;

export const DRAFT_ORDER_QUERY = `#graphql
  query PapierkramDraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      legacyResourceId
      name
      note2
      email
      createdAt
      currencyCode
      taxesIncluded
      status
      order { id }
      customer { ${CUSTOMER_FIELDS} }
      billingAddress { ${ADDRESS_FIELDS} }
      shippingAddress { ${ADDRESS_FIELDS} }
      totalPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      shippingLine {
        title
        originalPriceSet { shopMoney { amount currencyCode } }
        taxLines { ${TAX_LINE_FIELDS} }
      }
      lineItems(first: 250) {
        nodes {
          id
          name
          title
          sku
          quantity
          variantTitle
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountedUnitPriceSet { shopMoney { amount currencyCode } }
          taxLines { ${TAX_LINE_FIELDS} }
          product { id title }
          variant { id title sku }
        }
      }
    }
  }
`;

export const CUSTOMER_QUERY = `#graphql
  query PapierkramCustomer($id: ID!) {
    customer(id: $id) { ${CUSTOMER_FIELDS} }
  }
`;

export const METAFIELDS_SET_MUTATION = `#graphql
  mutation PapierkramMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace }
      userErrors { field message }
    }
  }
`;

export const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation PapierkramMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message code }
    }
  }
`;

export const SHOP_QUERY = `#graphql
  query PapierkramShop {
    shop {
      id
      name
      myshopifyDomain
      email
      currencyCode
      billingAddress {
        company
        address1
        address2
        zip
        city
        country
        countryCodeV2
      }
    }
  }
`;

export const PRODUCT_VARIANTS_QUERY = `#graphql
  query PapierkramVariants($first: Int!, $after: String, $query: String) {
    productVariants(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        displayName
        price
        product { id title }
      }
    }
  }
`;
