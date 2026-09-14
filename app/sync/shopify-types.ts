/**
 * Ausschnitte der Shopify Admin GraphQL Typen, genau so wie sie von den
 * Abfragen in queries.ts geliefert werden. Bewusst handgeschrieben, damit der
 * Mapper ohne Codegen getestet werden kann.
 */

export interface MoneySet {
  shopMoney: { amount: string; currencyCode: string };
}

export interface TaxLine {
  title: string | null;
  /** Anteil als Dezimalbruch, z.B. 0.19 fuer 19 %. */
  rate: number | null;
  ratePercentage: number | null;
  priceSet: MoneySet | null;
}

export interface DiscountAllocation {
  allocatedAmountSet: MoneySet;
}

export interface Address {
  company: string | null;
  firstName: string | null;
  lastName: string | null;
  address1: string | null;
  address2: string | null;
  zip: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  countryCodeV2: string | null;
  phone: string | null;
}

export interface Customer {
  id: string;
  legacyResourceId?: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  taxExempt?: boolean | null;
  defaultAddress: Address | null;
}

export interface OrderLineItem {
  id: string;
  name: string;
  title: string | null;
  sku: string | null;
  quantity: number;
  variantTitle: string | null;
  currentQuantity?: number | null;
  originalUnitPriceSet: MoneySet;
  discountAllocations: DiscountAllocation[];
  taxLines: TaxLine[];
  product: { id: string; title: string } | null;
  variant: { id: string; title: string | null; sku: string | null } | null;
}

export interface ShippingLine {
  id: string;
  title: string | null;
  originalPriceSet: MoneySet;
  discountAllocations: DiscountAllocation[];
  taxLines: TaxLine[];
}

export interface Order {
  id: string;
  legacyResourceId: string;
  name: string;
  note: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string;
  processedAt: string | null;
  currencyCode: string;
  taxesIncluded: boolean;
  taxExempt?: boolean | null;
  displayFinancialStatus: string | null;
  cancelledAt: string | null;
  customer: Customer | null;
  billingAddress: Address | null;
  shippingAddress: Address | null;
  totalPriceSet: MoneySet;
  subtotalPriceSet: MoneySet | null;
  totalTaxSet: MoneySet | null;
  totalDiscountsSet: MoneySet | null;
  totalTipReceivedSet: MoneySet | null;
  lineItems: { nodes: OrderLineItem[] };
  shippingLines: { nodes: ShippingLine[] };
}

export interface DraftOrderLineItem {
  id: string;
  name: string;
  title: string | null;
  sku: string | null;
  quantity: number;
  variantTitle: string | null;
  originalUnitPriceSet: MoneySet;
  discountedUnitPriceSet: MoneySet | null;
  taxLines: TaxLine[];
  product: { id: string; title: string } | null;
  variant: { id: string; title: string | null; sku: string | null } | null;
}

export interface DraftOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  note2: string | null;
  email: string | null;
  createdAt: string;
  currencyCode: string;
  taxesIncluded: boolean;
  status: string;
  order: { id: string } | null;
  customer: Customer | null;
  billingAddress: Address | null;
  shippingAddress: Address | null;
  totalPriceSet: MoneySet;
  totalTaxSet: MoneySet | null;
  shippingLine: {
    title: string | null;
    originalPriceSet: MoneySet;
    taxLines: TaxLine[];
  } | null;
  lineItems: { nodes: DraftOrderLineItem[] };
}
