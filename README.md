# 3DTS Webshop Dashboard

Dagelijkse data-opslag voor het 3DTS ochtendrapport: advertenties, kosten, verzendtarieven en later Shopify/Bol/Moneybird omzet zodat winst per verkoop berekend kan worden.

## Structuur

- `scripts/` scripts die data ophalen
- `data/` dagelijkse JSON-output
- `config/` vaste instellingen, zoals verzendtarieven en kostprijsbestand
- `reports/` plek voor ochtendrapporten en analyses

## Lokaal draaien

1. Installeer Node.js 20 of nieuwer.
2. Kopieer `.env.example` naar `.env`.
3. Vul je eigen Google Ads waarden in `.env`.
4. Laad de env vars en draai het script:

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match "^[^#].+=") {
    $name, $value = $_ -split "=", 2
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}
npm run google-ads
```

Het script schrijft:

- `data/google_ads_daily.json`
- `data/google_ads_last_7_days.json`
- `data/google_ads_last_30_days.json`

## Benodigde `.env` variabelen

```text
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_REFRESH_TOKEN=
GOOGLE_ADS_CUSTOMER_ID=5233371293
GOOGLE_ADS_LOGIN_CUSTOMER_ID=3221449798
```

Zet echte tokens nooit in GitHub. Gebruik lokaal `.env` en in GitHub Actions alleen repository secrets.

## Dagelijks automatisch draaien

De workflow `.github/workflows/daily-google-ads.yml` draait dagelijks rond 07:15 Nederlandse tijd en commit de nieuwe JSON-bestanden terug naar de repository.

Zet hiervoor in GitHub bij `Settings -> Secrets and variables -> Actions` deze secrets:

- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_CLIENT_ID`
- `GOOGLE_ADS_CLIENT_SECRET`
- `GOOGLE_ADS_REFRESH_TOKEN`
- `GOOGLE_ADS_CUSTOMER_ID`
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID`

## Kostprijzen en verzendtarieven

Het bestand `config/prijsberekening 2026.xlsx` bevat de kostprijsbasis. De vaste verzendtarieven staan in `config/shipping_rates.json`:

- NL brievenbus: EUR 3,70
- NL pakket: EUR 5,60
- Belgie pakket: EUR 8,09
- Frankrijk pakket 0-2 kg: EUR 11,85
- Overige EU: 0-2 kg tarief plus EUR 0,25

## Later toevoegen

### Shopify

Voeg een script toe zoals `scripts/shopify_orders.mjs` dat orders ophaalt en opslaat in `data/shopify_orders_daily.json`. Nodig: Shopify Admin API token, store URL en eventueel location IDs.

### Bol.com

Voeg `scripts/bol_orders.mjs` toe voor bestellingen, commissies en uitbetalingen. Nodig: Bol Retailer API client ID/secret. Sponsored Products data kan apart zodra de Bol Advertising API endpoints toegang geven.

### Moneybird

Voeg `scripts/moneybird_payments.mjs` toe voor banktransacties, inkomende facturen en koppeling met Bol/Shopify/Etsy uitbetalingen. Nodig: Moneybird API token en administratie-ID.

## Ochtendrapport doel

Uiteindelijk combineert het rapport:

- verkoopprijs per order
- kostprijs uit Excel
- verzendkosten uit `shipping_rates.json`
- advertentiekosten per kanaal/product
- marketplace fees en betaalproviderkosten

Daarmee kan ChatGPT per verkoop aangeven: omzet, kosten, winst, marge en concrete actiepunten.

