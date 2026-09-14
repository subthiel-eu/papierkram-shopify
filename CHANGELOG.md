# Changelog

## 1.0.0

Erste Fassung.

- Typisierter Client für die Papierkram API v1 (Rechnungen, Angebote, Kontakte,
  Positionen, Zahlungsbedingungen, Projekte, PDF, Versand, Storno) mit
  Wiederholungen, Retry-After und Auswertung des Monatskontingents.
- Übertragung von Bestellungen als Rechnungen und von Bestellentwürfen als
  Angebote, inklusive Steuer-, Rabatt-, Versand-, Trinkgeld- und
  Teilstorno-Behandlung.
- Anlage und Abgleich von Kontakten mit Dublettenschutz über die E-Mail-Adresse.
- Fünf Admin-UI-Extensions für Bestellung, Entwurf und Kunde.
- Admin-Oberfläche mit Übersicht, Einstellungen, Belegliste, Positionszuordnung
  und Protokoll.
- Warteschlange mit Wiederholungen, Metafeld-Rückschreibung und DSGVO-Webhooks.
