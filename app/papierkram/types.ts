/**
 * Typen der Papierkram API v1.
 * Abgeleitet aus der offiziellen OpenAPI-Beschreibung (https://api.papierkram.de).
 */

export interface PapierkramList<T> {
  type: "list";
  page: number;
  page_size: number;
  total_pages: number;
  total_entries: number;
  has_more: boolean;
  entries: T[];
}

export interface ListParams {
  page?: number;
  page_size?: number;
  order_by?: string;
  order_direction?: "asc" | "desc";
}

export interface DocumentListParams extends ListParams {
  company_id?: number;
  project_id?: number;
  document_date_range_start?: string;
  document_date_range_end?: string;
}

export type ContactType = "customer" | "supplier";

export interface Company {
  type: "company";
  id: number;
  name: string;
  contact_type: ContactType | null;
  customer_no: string | null;
  supplier_no: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  fax: string | null;
  postal_street: string | null;
  postal_zip: string | null;
  postal_city: string | null;
  postal_country: string | null;
  physical_street: string | null;
  physical_zip: string | null;
  physical_city: string | null;
  physical_country: string | null;
  ust_idnr: string | null;
  notes: string | null;
  record_state: string;
  delivery_method: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyPersonInput {
  first_name: string;
  last_name: string;
  title?: string;
  salutation?: string;
  position?: string;
  department?: string;
  phone?: string;
  mobile?: string;
  fax?: string;
  email?: string;
  comment?: string;
  default?: string;
}

export interface ContactPerson {
  type: "person";
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  department: string | null;
}

export interface CompanyInput {
  name: string;
  contact_type: ContactType;
  email?: string;
  phone?: string;
  fax?: string;
  website?: string;
  ust_idnr?: string;
  delivery_method?: string;
  postal_street?: string;
  postal_zip?: string;
  postal_city?: string;
  postal_country?: string;
  physical_street?: string;
  physical_zip?: string;
  physical_city?: string;
  physical_country?: string;
  notes?: string;
  people?: CompanyPersonInput[];
}

export interface BillingAddress {
  company?: string | null;
  department?: string | null;
  contact_person?: string | null;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  ust_idnr?: string | null;
  email?: string | null;
}

export interface LineItemInput {
  name: string;
  description?: string;
  quantity: number;
  unit: string;
  /** Zahl (19) oder String ("19%"). Papierkram akzeptiert beides. */
  vat_rate: number | string;
  /** Nettopreis je Einheit. Bei gross=true stattdessen price_gross setzen. */
  price?: number;
  price_gross?: number;
  discount_calculated?: number;
  discount_calculated_gross?: number;
  discount_percentage?: number;
  type_of?: string;
  start_new_item_group?: boolean;
  proposition?: { id: number };
}

export interface LineItem extends Omit<LineItemInput, "proposition"> {
  total_net: number;
  total_vat: number;
  total_gross: number;
  position_in_group?: string;
  proposition?: {
    type: "proposition";
    id: number;
    name: string;
    article_no: string | null;
    proposition_type: string | null;
  } | null;
}

interface DocumentBaseInput {
  name: string;
  description?: string;
  document_date?: string;
  flagged?: boolean;
  gross?: boolean;
  customer?: {
    id: number;
    contact_person?: { id: number };
    project?: { id: number };
  };
  custom_template?: { id: number };
  billing?: BillingAddress;
  line_items: LineItemInput[];
}

export interface InvoiceInput extends DocumentBaseInput {
  /** Pflichtfeld beim Anlegen einer Rechnung. */
  payment_term: { id: number };
  supply_date?: string;
}

export interface EstimateInput extends DocumentBaseInput {
  sent_on?: string;
  sent_to?: string;
  inbound_address?: string;
  greetings_text?: string;
  thanks_text?: string;
  reminder_date?: string;
}

interface DocumentBase {
  id: number;
  name: string | null;
  description: string | null;
  document_date: string | null;
  customer_no: string | null;
  sent_on: string | null;
  sent_via: string | null;
  sent_to: string | null;
  gross: boolean;
  state: string;
  record_state: string;
  total_net: number;
  total_vat: number;
  total_gross: number;
  billing: BillingAddress | null;
  customer?: Pick<Company, "type" | "id" | "name" | "contact_type"> | null;
  contact_person?: ContactPerson | null;
  project?: { type: "project"; id: number; name: string } | null;
  line_items?: LineItem[];
}

export interface Invoice extends DocumentBase {
  type: "invoice";
  invoice_no: string | null;
  due_date: string | null;
  supply_date: string | null;
  paid_at_date: string | null;
  outstanding_amount: string | number | null;
  down_payment_total_gross: number | null;
  payment_term?: { type: "payment_term"; id: number; name: string } | null;
}

export interface Estimate extends DocumentBase {
  type: "estimate";
  estimate_no: string | null;
}

export interface PaymentTerm {
  type: "payment_term";
  id: number;
  name: string;
  template: boolean;
  default_template: boolean;
  due_time: number | null;
  due_time_unit: string | null;
  payment_required: boolean;
}

export interface Proposition {
  type: "proposition";
  id: number;
  name: string;
  article_no: string | null;
  proposition_type: string | null;
  price: number | null;
  unit: string | null;
  vat_rate: number | string | null;
}

export interface Project {
  type: "project";
  id: number;
  name: string;
  record_state: string;
  company?: { id: number; name: string } | null;
}

export interface ApiInfo {
  api: { version: string };
  settings?: {
    custom_templates?: {
      invoices?: Array<{ type: "template"; id: number; name: string }>;
      estimates?: Array<{ type: "template"; id: number; name: string }>;
    };
  };
}

export type DeliveryInput =
  | { send_via: "pdf" }
  | {
      send_via: "email";
      email: { recipient: string; subject: string; body: string };
    };
