# Papierkram für Shopify

Eine eingebettete Shopify-App, die Bestellungen und Bestellentwürfe nach
[Papierkram.de](https://www.papierkram.de) überträgt – als **Rechnungen** und
**Angebote**, inklusive **Kontakten**, und mit **Admin-Blocks**, damit der
Belegstatus direkt in der Bestellung und beim Kunden sichtbar ist.

---

## Was die App kann

| Bereich | Funktion |
| --- | --- |
| **Rechnungen** | Aus jeder Bestellung – manuell oder automatisch bei Eingang, Zahlung oder Versand. Festschreiben und Versand per E-Mail direkt aus Shopify. |
| **Angebote** | Aus Shopify-Bestellentwürfen, manuell oder automatisch. |
| **Kontakte** | Shopify-Kunden werden als Papierkram-Unternehmen angelegt. Vor der Neuanlage wird per E-Mail nach einem bestehenden Kontakt gesucht, damit keine Dubletten entstehen. |
| **Blocks** | Eigene Abschnitte auf der Bestell-, Entwurfs- und Kundenseite im Shopify-Admin mit Belegnummer, Status, Betrag, Direktlink und Aktionen. |
| **Actions** | Modale Dialoge „Rechnung erstellen“ / „Angebot erstellen“ mit Auswahl: Entwurf lassen, festschreiben oder per E-Mail senden. |
| **Metafelder** | Belegnummer, Status, Betrag und Link landen als Metafelder an Bestellung, Entwurf und Kunde – nutzbar in Shopify Flow, Liquid und Exporten. |
| **Positionen** | Optionale Zuordnung Shopify-Variante → Papierkram-Position, damit Belege die Artikelnummern aus Papierkram tragen. |
| **Betrieb** | Warteschlange mit automatischen Wiederholungen, Protokoll und Statusabgleich in der App-Oberfläche. |

## Voraussetzungen

* **Papierkram-Tarif M oder L** – die API ist in kleineren Tarifen nicht
  freigeschaltet. Den Token gibt es unter *Papierkram → Einstellungen → API*.
* **Node.js ≥ 20.10** und die [Shopify CLI](https://shopify.dev/docs/api/shopify-cli).
* Einen Shopify-Partner-Account mit einem Entwicklungsshop.

## Einrichtung

```bash
git clone https://github.com/Disane87/papierkram-shopify.git
cd papierkram-shopify
npm install

cp .env.example .env
# Schlüssel für die Token-Verschlüsselung erzeugen:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Ausgabe als PAPIERKRAM_ENCRYPTION_KEY in .env eintragen.

npx prisma migrate deploy
npm run config:link   # verknüpft die App mit deinem Partner-Account
npm run dev
```

Danach im Shopify-Admin die App öffnen → **Einstellungen** → Subdomain und
API-Token eintragen → **Verbindung testen**.

> Ohne ausgewählte **Zahlungsbedingung** lehnt Papierkram jede Rechnung ab.
> Die App weist an mehreren Stellen darauf hin.

### Umgebungsvariablen

| Variable | Zweck |
| --- | --- |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Von der Shopify CLI gesetzt. |
| `SHOPIFY_APP_URL` | Öffentliche URL der App (Tunnel bzw. Produktion). |
| `SCOPES` | Siehe `shopify.app.toml`. |
| `DATABASE_URL` | Standard: SQLite unter `prisma/dev.sqlite`. |
| `PAPIERKRAM_ENCRYPTION_KEY` | **Pflicht.** 32 Byte, base64 – verschlüsselt den API-Token in der Datenbank. |
| `PAPIERKRAM_BASE_URL_TEMPLATE` | Optional, Standard `https://{subdomain}.papierkram.de`. |
| `SYNC_WORKER_INTERVAL` | Optional, Sekunden zwischen zwei Worker-Läufen (Standard 15). |
| `SYNC_WORKER_DISABLED` | Auf `true` setzen, wenn der Worker in einem separaten Prozess läuft. |

## Wie die Beträge abgebildet werden

Buchhaltung verzeiht keine Rundungsfehler, deshalb hier die Regeln im Klartext:

* **Preisbasis.** Standard ist „wie im Shop eingestellt“: Rechnet der Shop mit
  Bruttopreisen (`taxesIncluded`), wird auch der Papierkram-Beleg brutto
  geführt. So ist keine Umrechnung nötig und die Belegsumme trifft die
  Shopify-Summe auf den Cent. Netto oder Brutto lässt sich erzwingen – dann
  rechnet die App mit dem Steuersatz der jeweiligen Position um.
* **Steuersatz.** Kommt aus der Steuerzeile der Position. Mehrere Steuerzeilen
  (z. B. US-Bundesstaat + County) werden addiert, weil Papierkram je Position
  nur einen Satz kennt. Hat eine Bestellung insgesamt keine Steuer
  (Kleinunternehmer, Reverse Charge, Export), werden **0 %** gesetzt – nicht der
  Standardsatz. Der eingestellte Standardsatz greift nur, wenn Shopify für eine
  Position keinen Satz liefert, die Bestellung aber Steuern enthält.
* **Rabatte.** Alle Rabattzuweisungen einer Position – auch anteilige
  Bestellrabatte – werden summiert und als Rabatt je Einheit übergeben, damit sie
  auf dem Beleg sichtbar bleiben. Wer das nicht will, lässt sie in den
  Stückpreis einrechnen.
* **Teilstornos.** Es wird `currentQuantity` abgerechnet, nicht die ursprünglich
  bestellte Menge. Vollständig stornierte Positionen entfallen, im Protokoll
  steht ein Hinweis.
* **Versand und Trinkgeld** werden als eigene Positionen geführt (abschaltbar).
* **Kontrolle.** Nach dem Anlegen vergleicht die App die Papierkram-Summe mit der
  Shopify-Summe und protokolliert Abweichungen über 2 Cent.

## Architektur

```
app/
  papierkram/      Typisierter Client für die Papierkram API v1 (+ Fehlertypen)
  sync/            Mapping, Warteschlange, Worker, Webhooks-Logik, Metafelder
  models/          Einstellungen, Verknüpfungen, Protokoll (Prisma)
  routes/          Admin-Oberfläche, Webhooks, API für die Extensions
extensions/        Fünf Admin-UI-Extensions (Preact + Polaris Web Components)
prisma/            Datenmodell und Migrationen
tests/             Vitest: Mapping, Client, Verschlüsselung, Rundung
```

**Warum eine Warteschlange?** Shopify erwartet auf Webhooks binnen fünf Sekunden
eine Antwort. Die Webhook-Routen legen deshalb nur einen Job an; der
In-Process-Worker arbeitet ihn ab und wiederholt bei Fehlern mit wachsendem
Abstand (1, 2, 4 … Minuten, maximal fünf Versuche). Ein `dedupeKey` je
Shopify-Objekt verhindert, dass `orders/create` und `orders/paid` zwei Belege
erzeugen. Läuft die App auf mehreren Instanzen, sorgt ein atomares
`updateMany` dafür, dass jeder Job nur einmal gegriffen wird.

**Warum kein Redis?** Das Volumen eines typischen Shops rechtfertigt keinen
zusätzlichen Dienst. Wer will, setzt `SYNC_WORKER_DISABLED=true` und ruft
`processDueJobs()` aus einem eigenen Prozess auf.

## Extensions

| Verzeichnis | Target | Zweck |
| --- | --- | --- |
| `papierkram-order-block` | `admin.order-details.block.render` | Rechnungen zur Bestellung, Anlegen, Status holen |
| `papierkram-draft-order-block` | `admin.draft-order-details.block.render` | Angebote zum Entwurf |
| `papierkram-customer-block` | `admin.customer-details.block.render` | Verknüpfter Kontakt, Abgleich |
| `papierkram-invoice-action` | `admin.order-details.action.render` | Dialog „Rechnung erstellen“ inkl. Versand |
| `papierkram-estimate-action` | `admin.draft-order-details.action.render` | Dialog „Angebot erstellen“ inkl. Versand |

Die Extensions laufen auf API-Version `2026-07` mit Preact und Polaris Web
Components. Sie sprechen das App-Backend über `/api/papierkram/context` und
`/api/papierkram/action` an; der ID-Token aus `shopify.auth.idToken()` wird
mitgeschickt und serverseitig von `authenticate.admin()` geprüft.

## Metafelder

Namespace `papierkram`:

| Objekt | Schlüssel |
| --- | --- |
| Order | `invoice_id`, `invoice_no`, `invoice_state`, `invoice_url`, `invoice_total` |
| DraftOrder | `estimate_id`, `estimate_no`, `estimate_url` |
| Customer | `contact_id`, `contact_no`, `contact_url` |

Die Definitionen werden beim ersten Öffnen der App angelegt und lassen sich
unter *Einstellungen → Werkzeuge* erneut prüfen.

## Bekannte Grenzen

Diese Grenzen liegen an der Papierkram-API, nicht an der App:

* **Keine Gutschriften über die API.** Bei einer Erstattung in Shopify legt die
  App deshalb nichts still um, sondern schreibt eine Warnung ins Protokoll mit
  Link zum betroffenen Beleg. Stornieren bzw. Gutschrift erfolgt in Papierkram.
* **Keine Webhooks von Papierkram.** Statusänderungen (bezahlt, storniert)
  erfährt die App nur durch Nachfragen – über „Status holen“ im Block, in der
  Belegliste oder beim Aktualisieren einer Bestellung.
* **Monatskontingent.** Jede Antwort trägt `X-Remaining-Quota` (10.000 im Tarif
  M, 20.000 in L). Der aktuelle Stand steht auf der Übersichtsseite.
* **Kontaktsuche.** Die API kennt keinen Suchparameter, deshalb wird für die
  E-Mail-Suche seitenweise gelesen. Das Ergebnis wird verknüpft gespeichert, die
  Suche läuft also höchstens einmal je Kunde.
* **Bestellung storniert.** Die App storniert die Rechnung nicht automatisch –
  eine festgeschriebene Rechnung ohne Rückfrage zu stornieren wäre ein zu
  weitreichender Eingriff. Es gibt einen Protokolleintrag.

## Entwicklung

```bash
npm run dev          # Shopify CLI mit Tunnel und Extensions
npm run typecheck    # App und alle Extensions
npm test             # Vitest
npm run build
npm run deploy       # App und Extensions veröffentlichen
```

Die Datenbank ist standardmäßig SQLite. Für den Produktivbetrieb den `provider`
in `prisma/schema.prisma` auf `postgresql` umstellen und `DATABASE_URL` setzen.

## Lizenz

MIT
