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
3. Vul je eigen Google Ads, Shopify en bol.com waarden in `.env`.
4. Laad de env vars en draai de scripts:

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match "^[^#].+=") {
    $name, $value = $_ -split "=", 2
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}
npm run google-ads
npm run shopify-orders
npm run shopify-products
npm run bol-enrichment
npm run profit
```

De scripts schrijven:

- `data/google_ads_daily.json`
- `data/google_ads_last_7_days.json`
- `data/google_ads_last_30_days.json`
- `data/shopify_orders_daily.json`
- `data/shopify_orders_last_7_days.json`
- `data/shopify_orders_last_30_days.json`
- `data/shopify_products.json`
- `data/bol_orders_raw_daily.json`
- `data/bol_orders_raw_last_7_days.json`
- `data/bol_enriched_daily.json`
- `data/bol_enriched_last_7_days.json`
- `data/bol_ads_daily.json`
- `data/bol_ads_last_7_days.json`
- `data/profit_daily.json`
- `data/profit_last_7_days.json`
- `reports/morning_report.md`
- `reports/action_items.json`
- `reports/missing_product_costs.md`
- `reports/cost_price_quality.md`

## Benodigde `.env` variabelen

```text
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_REFRESH_TOKEN=
GOOGLE_ADS_CUSTOMER_ID=5233371293
GOOGLE_ADS_LOGIN_CUSTOMER_ID=3221449798

SHOPIFY_SHOP_DOMAIN=
SHOPIFY_ADMIN_ACCESS_TOKEN=

BOL_CLIENT_ID=
BOL_CLIENT_SECRET=
BOL_ADS_CLIENT_ID=
BOL_ADS_CLIENT_SECRET=
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
- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `BOL_CLIENT_ID`
- `BOL_CLIENT_SECRET`
- `BOL_ADS_CLIENT_ID`
- `BOL_ADS_CLIENT_SECRET`

## Shopify orders

Het script `scripts/shopify_orders_report.mjs` haalt orders op via de Shopify Admin GraphQL API en schrijft drie bestanden:

- `data/shopify_orders_daily.json`
- `data/shopify_orders_last_7_days.json`
- `data/shopify_orders_last_30_days.json`

Per order worden onder andere ordernummer, datum, kanaal/source, klantland, verzendkosten, korting, ordertotaal, betaalstatus, fulfillmentstatus, tags, landing site, referring site en line items met productnaam, SKU, aantal en verkoopprijs opgeslagen.

De Shopify Admin token heeft minimaal order-leestoegang nodig, bijvoorbeeld `read_orders`.

## Shopify productkostprijzen

Het script `scripts/shopify_products_report.mjs` haalt alle productvarianten op en schrijft:

- `data/shopify_products.json`

Per variant worden product-id, variant-id, SKU, barcode/EAN, producttitel, varianttitel, verkoopprijs en `inventoryItem.unitCost` opgeslagen. Dit is de Shopify waarde `Cost per item`.

De Shopify Admin token heeft hiervoor deze extra scopes nodig:

- `read_products`
- `read_inventory`

Als Shopify `Cost per item` leeg is, wijzigt het dashboard niets automatisch. Het rapporteert alleen welke producten nog een kostprijs missen.

## Winstcalculator

Het script `scripts/profit_report.mjs` combineert Shopify orders, Shopify productkostprijzen, Google Ads kosten, bol.com verrijking, Bol Ads kosten, verzendtarieven en fallback-kostprijzen.

Het rekent per order:

- omzet
- verzendkosten betaald door klant
- werkelijke verzendkosten
- productkostprijs uit Shopify `Cost per item`, met fallback naar `config/product_costs.json`
- bruto winst
- bol.com commissie
- advertentiekosten
- Bol Ads kosten
- nettowinst
- nettowinstpercentage

Shopify blijft de primaire orderbron. Bol.com-orders die via Market Sync al in Shopify staan, worden verrijkt met bol-data en tellen niet dubbel mee. Bol-orders die niet in Shopify gematcht worden, krijgen de waarschuwing `bol_order_missing_in_shopify` en worden niet automatisch bij omzet/winst opgeteld.

Output:

- `data/profit_daily.json`
- `data/profit_last_7_days.json`
- `reports/morning_report.md`
- `reports/action_items.json`
- `reports/missing_product_costs.md`
- `reports/cost_price_quality.md`

Kostprijsvolgorde:

1. Shopify variant-id via `inventoryItem.unitCost`
2. Shopify SKU via `inventoryItem.unitCost`
3. Shopify EAN/barcode via `inventoryItem.unitCost`
4. Shopify productnaam via `inventoryItem.unitCost`
5. `config/product_costs.json` als fallback
6. Als beide ontbreken of 0 zijn: `product_cost_missing`

Orders met ontbrekende kostprijs tellen niet mee in de betrouwbare nettowinst. Ze blijven wel zichtbaar als geschatte/onvolledige winst, zodat je ziet hoeveel omzet nog niet hard doorgerekend kan worden.

## Kostprijzen en verzendtarieven

Shopify `Cost per item` is de primaire kostprijsbron. Het bestand `config/product_costs.json` is alleen fallback voor producten waar Shopify nog geen kostprijs heeft. `config/prijsberekening 2026.xlsx` blijft in de repo als bron/calculator, maar wordt niet meer gebruikt als betrouwbare hoofdbron voor orderwinst.

De vaste verzendtarieven staan in `config/shipping_rates.json`:

- NL brievenbus: EUR 3,70
- NL pakket: EUR 5,60
- Belgie pakket: EUR 8,09
- Frankrijk pakket 0-2 kg: EUR 11,85
- Overige EU: 0-2 kg tarief plus EUR 0,25

## Later toevoegen

### Shopify

Shopify orders en productkostprijzen zijn toegevoegd via `scripts/shopify_orders_report.mjs` en `scripts/shopify_products_report.mjs`. Een volgende stap is Shopify refunds en betaalproviderkosten toevoegen voor nauwkeurigere marge per orderregel.

### Bol.com

Bol.com is toegevoegd via `scripts/bol_enrichment_report.mjs`.

Het script doet drie dingen:

- haalt bol-orders op via de Retailer API
- matcht bol-orders met bestaande Shopify-orders
- haalt, waar mogelijk, Sponsored Products advertiser performance op via de Advertising API

Output:

- `data/bol_orders_raw_daily.json`
- `data/bol_orders_raw_last_7_days.json`
- `data/bol_enriched_daily.json`
- `data/bol_enriched_last_7_days.json`
- `data/bol_ads_daily.json`
- `data/bol_ads_last_7_days.json`

Matching gebeurt eerst op bol order-id, offer reference, EAN, SKU, tags en source. Als dat niet lukt, probeert het script datum + totaalbedrag + klantland + productmatch. Als er geen match is, blijft Shopify leidend en telt de bol-order niet dubbel mee.

Benodigd:

- `BOL_CLIENT_ID`
- `BOL_CLIENT_SECRET`

Voor Bol Ads kan een aparte Advertising API credential nodig zijn:

- `BOL_ADS_CLIENT_ID`
- `BOL_ADS_CLIENT_SECRET`

Als deze ontbreken, probeert het script de gewone bol credentials. Als de API geen advertiser-rechten geeft, schrijft het script `supported: false` en blijft de rest van het dashboard draaien.

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
