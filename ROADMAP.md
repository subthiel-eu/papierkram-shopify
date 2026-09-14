# Roadmap

Stand: September 2026.

**Sprint 1 bis 4 sind umgesetzt** — Vorschau, Versandtexte, PDF, Tag-Steuerung,
Sammelaktion, Nachtrag, Steuerfälle, Flow-Aktion und Statusabgleich. Was unten
unter „Sprint" steht, ist damit Beschreibung des Gebauten; offen ist der
Abschnitt „Später".

Eine Abweichung vom ursprünglichen Plan: die Flow-Aktion gibt es nur für
Rechnungen. Flow bietet Referenzfeldtypen für Bestellung, Kunde, Produkt und
Unternehmen an — für Bestellentwürfe keinen. Eine Aktion, in die man die
Entwurfs-Kennung von Hand einträgt, wäre schlechter als keine.

## Leitplanken

Vier Eigenschaften der Papierkram-API bestimmen, was sich überhaupt lohnt.
Jede geplante Funktion muss mit ihnen leben:

1. **Keine Gutschriften.** Es gibt keinen Endpunkt dafür. Erstattungen können
   nur gemeldet, nicht gebucht werden.
2. **Rechnungen lassen sich nicht als bezahlt markieren.** `/pay` gibt es nur
   für Ausgabenbelege. Ein Zahlungsabgleich kann deshalb nur in eine Richtung
   laufen: Papierkram → Shopify.
3. **Keine Webhooks.** Jede Statusänderung erfährt die App durch Nachfragen.
   Alles, was „live" wirken soll, ist in Wahrheit ein geplanter Abgleich.
4. **Monatliches Credit-Kontingent** (10.000 im Tarif M, 20.000 in L). Jede
   Funktion, die über viele Belege läuft, muss mit Listenabfragen statt
   Einzelabrufen auskommen.

Aufwandsangaben sind grob: **klein** = ein bis zwei Tage, **mittel** = etwa
eine Woche, **groß** = mehr.

---

## Sprint 1 — Vertrauen (alles klein)

Das Ziel dieser Runde ist nicht Funktionsumfang, sondern dass ein Händler der
Abbildung glaubt, bevor etwas in seiner Buchhaltung landet.

### 1.1 Belegvorschau ohne Papierkram-Aufruf

**Problem.** Die heikelste Stelle der App ist die Abbildung von Steuern,
Rabatten und Rundung. Heute sieht man das Ergebnis erst, wenn der Beleg in
Papierkram steht — und dann ist er da.

**Lösung.** Eine Route `/api/papierkram/preview`, die dieselbe Abbildung
ausführt, aber nichts sendet: Positionen, Steuersätze, Rabatte, Summen und der
Abgleich gegen die Shopify-Summe. Im Bestell-Block als „Vorschau", im
Anlege-Dialog als Zwischenschritt vor dem Bestätigen.

**Warum billig.** Der Mapper ist bereits rein und getestet; es fehlen nur Route
und Darstellung. Kostet außerdem kein Papierkram-Kontingent.

### 1.2 E-Mail-Texte konfigurierbar

**Problem.** Betreff und Text des Belegversands stehen hartkodiert in drei
Dateien. Wer anders formuliert oder nicht auf Deutsch schreibt, kann sie nicht
ändern.

**Lösung.** Vorlagen in den Einstellungen, je eine für Rechnung und Angebot,
mit Platzhaltern (`{{beleg_nr}}`, `{{kunde}}`, `{{summe}}`, `{{shop}}`). Die
Liquid-Variablen von Papierkram bleiben zusätzlich nutzbar.

### 1.3 PDF-Download

**Problem.** `documentPdf()` liegt fertig im Client, aber es gibt keine Route,
die es anbietet.

**Lösung.** Download aus der Belegliste und aus dem Block. Optional das PDF als
Shopify-Datei an die Bestellung hängen, damit es auch ohne Papierkram-Zugang
auffindbar ist.

### 1.4 Steuerung über Tags

**Problem.** Es gibt keinen Weg, einzelne Bestellungen von der Übertragung
auszunehmen — etwa Testbestellungen oder Umtausch.

**Lösung.** Zwei Tags: `papierkram:skip` überspringt, `papierkram:invoice`
erzwingt. Wird im Dispatcher vor dem Einplanen ausgewertet.

---

## Sprint 2 — Masse

### 2.1 Sammelaktion in der Bestellübersicht (klein)

Mehrere Bestellungen markieren und Rechnungen einplanen, über das Ziel
`admin.order-index.selection-action.render`. Das Extension-Muster und die
API-Route stehen bereits; es ist im Wesentlichen eine weitere Extension.

Deckt den Alltag zwischen Einzelklick und großem Nachtrag ab.

### 2.2 Nachtrag historischer Bestellungen (mittel bis groß)

**Problem.** Nach der Installation fehlen die zurückliegenden Monate.

**Lösung.** Zeitraum und Filter wählen (nur bezahlte, nur ohne vorhandenen
Beleg), dann `bulkOperationRunQuery` die Bestellungen holen lassen, per
`bulk_operations/finish`-Webhook einsammeln, JSONL einlesen und in die
Warteschlange geben.

**Was dabei wichtig ist.** Vor dem Start eine Schätzung zeigen: „412
Bestellungen, rund 900 Credits, verbleibend 8.400." Der Kontingentschutz in der
Warteschlange greift bereits, aber ein Nachtrag, der das Monatsbudget
aufbraucht, gehört angekündigt statt entdeckt.

**Hängt ab von** 1.1 (dieselbe Abbildung für die Schätzung).

---

## Sprint 3 — Steuerliche Korrektheit

### 3.1 Reverse Charge, OSS und Kleinunternehmerregelung (mittel)

**Problem.** Für innergemeinschaftliche B2B-Lieferungen braucht der Beleg nicht
nur 0 %, sondern den Pflichthinweis und die USt-IdNr. des Empfängers. Für
§ 19 UStG gilt dasselbe mit anderem Text. Heute setzt die App bei fehlender
Steuerzeile lediglich 0 % — rechnerisch richtig, als Beleg unvollständig.

**Lösung.** Ein kleines Regelwerk „Steuerfall": Bedingung (Zielland, B2B mit
geprüfter USt-IdNr., `taxExempt`) ergibt Steuersatz plus Hinweistext, der als
Belegtext mitgeht. Die USt-IdNr. wandert nach `billing.ust_idnr`.

**Offene Frage vor dem Bau.** Woher kommt die USt-IdNr. im jeweiligen Shop?
Shopify legt sie je nach Aufbau in `purchasingCompany`, in einem Metafeld oder
in einem Bestellattribut ab. Das gehört geklärt, bevor Code entsteht — sonst
baut man drei Wege und trifft keinen.

---

## Sprint 4 — Ökosystem

### 4.1 Shopify-Flow-Aktion (mittel)

Eine Flow-Aktion „Papierkram-Rechnung erstellen" (und eine für Angebote). Damit
bauen Händler Bedingungen, die eine Regel-Oberfläche nie vollständig abbildet:
nur ab 500 €, nur für ein bestimmtes Land, nur mit einem Tag, erst drei Tage
nach Versand.

Das ist die ehrlichere Antwort auf „kann man das nicht auch bei X auslösen?"
als eine immer weiter wachsende Auswahlliste. Nebeneffekt: „Works with
Flow"-Kennzeichnung im App Store.

### 4.2 Status- und Zahlungsabgleich (mittel)

**Grenze zuerst.** Papierkram kann eine Rechnung über die API nicht als bezahlt
markieren. Der Abgleich läuft deshalb nur von Papierkram nach Shopify.

**Lösung.** Ein geplanter Lauf holt die Belege eines Zeitraums mit **einer**
Listenabfrage statt einzeln, schreibt den Status an die Verknüpfung und setzt
Tags an der Bestellung (`papierkram:bezahlt`, `papierkram:überfällig`). Offene
Posten werden damit in Shopify sichtbar, ohne den Mandanten zu öffnen.

---

## Später

* **Positionen aus Produkten anlegen** (klein–mittel). `POST
  /income/propositions` erlaubt, Shopify-Produkte als Papierkram-Positionen
  anzulegen, statt sie nur von Hand zuzuordnen.
* **Shopify-Gebühren als Ausgabenbelege** (groß). `POST /expense/vouchers` mit
  Dokumentanhang gibt es; die Arbeit steckt in der Auswertung der
  Shopify-Payments-Auszahlungen. Eigenes Vorhaben, hoher Buchhaltungsnutzen.
* **B2B**: Shopify-Companies auf Papierkram-Unternehmen abbilden, Projekte je
  Vertriebskanal.
* **Abo-Bestellungen** als wiederkehrende Rechnungen.
* **Anzahlungen** (`down_payment_total_gross`).
* **Mehrsprachige Oberfläche** — bisher durchgehend deutsch.

## Bewusst nicht geplant

* **Gutschriften automatisch buchen.** Solange die API keine anbietet, bliebe
  nur, eine negative Rechnung zu schreiben. Das ist keine Gutschrift, sieht
  aber in der Buchhaltung so aus. Es bleibt beim Hinweis.
* **Rechnungen automatisch stornieren, wenn eine Bestellung storniert wird.**
  Ein festgeschriebener Beleg ist ein steuerliches Dokument; ihn ohne Rückfrage
  zu stornieren wäre ein zu weitreichender Eingriff.
* **Eigene Zahlungszuordnung über die Bankumsätze.** Lesbar wären sie, aber
  ohne die Möglichkeit, die Rechnung als bezahlt zu markieren, endet das in
  einem Zustand, den nur die App kennt und Papierkram nicht.

---

## Was vor allem anderen kommt

Ein Lauf gegen einen echten Shop und einen Papierkram-Testmandanten. Alles
oben Stehende ist gegen die API-Beschreibung entworfen und durch Tests
abgesichert, aber noch nie gegen echte Daten gelaufen. Der erste Durchlauf
verschiebt erfahrungsgemäß mehr Prioritäten als jede Planung.
