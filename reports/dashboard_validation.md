# Dashboard Validation

Gegenereerd: 2026-06-28

Validatiebasis: GitHub Actions run #15, commit `b79d9a6`, data-commit `669436a`.
Tijdzone voor kalenderdagen: Europe/Amsterdam.

## Status

| Onderdeel | Status | Conclusie |
| --- | --- | --- |
| Datumselectie | OK | Daily-bestanden staan op kalenderdag 2026-06-27. Shopify telt nu 0 orders voor die dag. |
| Google Ads | OK | 11 campagnes opgehaald. Campagnetotaal EUR 4.66 is gelijk aan Google Ads totaal EUR 4.66. |
| Bol Ads | OK | Bol Ads API geeft totaalniveau terug voor 2026-06-27: EUR 1.51, 155 impressies, 10 klikken. |
| Shopify orders | OK | Shopify daily gebruikt Europe/Amsterdam daggrenzen en bevat 0 orders voor 2026-06-27. |
| Bol matching | OK | Daily: 0 Bol-orders, 0 unmatched. Laatste 7 dagen: 11 Bol-orders, 11 gematcht, 0 missing. |

## Bevindingen

- Er zat een datumfout in Shopify: orders van 2026-06-26 UTC werden in daily 2026-06-27 meegeteld. Daardoor leek het rapport orders voor gisteren te tonen terwijl gisteren geen orders had.
- Shopify is aangepast naar expliciete Europe/Amsterdam kalenderdaggrenzen met een extra lokale filter achteraf.
- Google Ads had eerder geen expliciete `date_from` / `date_to` in de output en gebruikte relatieve datumfilters. Dat is aangepast naar expliciete datums.
- Google Ads gebruikte eerder een query-limiet. Die is verwijderd, zodat alle opgehaalde campagnes meetellen.
- De EUR 2.03 uit het eerdere rapport klopt niet meer als actuele validatie voor 2026-06-27. Na verse import is Google Ads voor 2026-06-27 EUR 4.66.
- Bol Ads is gecontroleerd op totaalniveau. De huidige Bol endpoint geeft advertiser performance totalen terug, geen campagne-uitsplitsing per campagne.

## Gecontroleerde waarden

### Google Ads daily

- Datum: 2026-06-27 t/m 2026-06-27
- Tijdzone-label: Europe/Amsterdam
- Campagnes opgehaald: 11
- Campagnes met kosten: Beugels
- Impressies: 480
- Klikken: 9
- Kosten: EUR 4.66
- Som campagneregels: EUR 4.66

### Bol Ads daily

- Datum: 2026-06-27 t/m 2026-06-27
- API ondersteund: ja
- Impressies: 155
- Klikken: 10
- Conversies: 0
- Kosten: EUR 1.51
- ROAS: 0

### Shopify daily

- Datum: 2026-06-27 t/m 2026-06-28 exclusief
- Tijdzone-label: Europe/Amsterdam
- Orders: 0
- Omzet: EUR 0.00

### Bol matching

- Daily Bol-orders: 0
- Daily gematcht: 0
- Daily missing in Shopify: 0
- Laatste 7 dagen Bol-orders: 11
- Laatste 7 dagen gematcht: 11
- Laatste 7 dagen missing in Shopify: 0

## Eindoordeel

Validatie groen. De gevonden datumfouten zijn hersteld en de huidige dashboarddata is consistent voor de gecontroleerde bronnen.
