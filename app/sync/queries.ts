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
  query PapierkramOrder($id: ID!, $vatNamespace: String!, $vatKey: String!) {
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
      customer {
        ${CUSTOMER_FIELDS}
        metafield(namespace: $vatNamespace, key: $vatKey) { value }
      }
      billingAddress { ${ADDRESS_FIELDS} }
      shippingAddress { ${ADDRESS_FIELDS} }
      customAttributes { key value }
      metafield(namespace: $vatNamespace, key: $vatKey) { value }
      purchasingEntity {
        ... on PurchasingCompany {
          company { id name externalId }
        }
      }
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

export const ORDERS_COUNT_QUERY = `#graphql
  query PapierkramOrdersCount($query: String) {
    ordersCount(query: $query, limit: 10000) {
      count
      precision
    }
  }
`;

/**
 * Die Massenabfrage liefert nur die Kennungen; die vollstaendigen Daten holt
 * sich jeder Job spaeter selbst. Das haelt die JSONL-Datei klein und die
 * Abfragekosten niedrig.
 */
export const BULK_ORDERS_QUERY = `#graphql
  mutation PapierkramBulkOrders($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

export const BULK_OPERATION_QUERY = `#graphql
  query PapierkramBulkOperation($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        url
      }
    }
  }
`;

export const ORDER_TAGS_ADD_MUTATION = `#graphql
  mutation PapierkramTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

export const ORDER_TAGS_REMOVE_MUTATION = `#graphql
  mutation PapierkramTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;
