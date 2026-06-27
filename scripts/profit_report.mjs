import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const reportsDir = path.join(rootDir, "reports");
const costWorkbookPath = path.join(rootDir, "config", "prijsberekening 2026.xlsx");
const shippingRatesPath = path.join(rootDir, "config", "shipping_rates.json");

await mkdir(dataDir, { recursive: true });
await mkdir(reportsDir, { recursive: true });

const costIndex = readCostIndex(costWorkbookPath);
const shippingRates = await readJson(shippingRatesPath, { rates: {} });

const daily = await buildProfitPeriod({
  label: "daily",
  shopifyFile: "shopify_orders_daily.json",
  googleAdsFile: "google_ads_daily.json",
  bolEnrichedFile: "bol_enriched_daily.json",
  bolAdsFile: "bol_ads_daily.json",
  outputFile: "profit_daily.json",
});

const last7 = await buildProfitPeriod({
  label: "last_7_days",
  shopifyFile: "shopify_orders_last_7_days.json",
  googleAdsFile: "google_ads_last_7_days.json",
  bolEnrichedFile: "bol_enriched_last_7_days.json",
  bolAdsFile: "bol_ads_last_7_days.json",
  outputFile: "profit_last_7_days.json",
});

await writeMorningReport(daily, last7);
await writeActionItems(daily, last7);

console.log(`profit_daily.json: ${daily.orders.length} orders, net EUR ${daily.totals.nettowinst.toFixed(2)}`);
console.log(`profit_last_7_days.json: ${last7.orders.length} orders, net EUR ${last7.totals.nettowinst.toFixed(2)}`);

async function buildProfitPeriod({ label, shopifyFile, googleAdsFile, bolEnrichedFile, bolAdsFile, outputFile }) {
  const warnings = [];
  const shopify = await readJson(path.join(dataDir, shopifyFile), null);
  const googleAds = await readJson(path.join(dataDir, googleAdsFile), null);
  const bolEnriched = await readJson(path.join(dataDir, bolEnrichedFile), null);
  const bolAds = await readJson(path.join(dataDir, bolAdsFile), null);

  if (!shopify) warnings.push(`Missing ${shopifyFile}; run npm run shopify-orders after setting Shopify secrets.`);
  if (!googleAds) warnings.push(`Missing ${googleAdsFile}; run npm run google-ads after setting Google Ads secrets.`);
  if (!bolEnriched) warnings.push(`Missing ${bolEnrichedFile}; run npm run bol-enrichment after setting bol secrets.`);
  if (!bolAds) warnings.push(`Missing ${bolAdsFile}; run npm run bol-enrichment after setting bol secrets.`);

  const rawOrders = dedupeOrders(Array.isArray(shopify?.orders) ? shopify.orders : []);
  const bolMatches = buildBolMatchIndex(bolEnriched);
  const totalAdCost = Number(googleAds?.totals?.cost_eur || 0);
  const totalBolAdsCost = Number(bolAds?.totals?.cost || 0);
  const nonBolRevenue = rawOrders
    .filter((order) => classifyChannel(order, bolMatches).channel !== "Bol via Shopify")
    .reduce((sum, order) => sum + money(order.total_order_amount), 0);
  const bolRevenue = rawOrders
    .filter((order) => classifyChannel(order, bolMatches).channel === "Bol via Shopify")
    .reduce((sum, order) => sum + money(order.total_order_amount), 0);

  const orders = rawOrders.map((order) => {
    const channelInfo = classifyChannel(order, bolMatches);
    const bolMatch = bolMatches.get(order.order_number);
    const revenue = money(order.total_order_amount);
    const adCost = channelInfo.channel === "Bol via Shopify"
      ? 0
      : nonBolRevenue > 0 ? money(totalAdCost * (revenue / nonBolRevenue)) : 0;
    const bolAdsCost = channelInfo.channel === "Bol via Shopify" && bolRevenue > 0
      ? money(totalBolAdsCost * (revenue / bolRevenue))
      : 0;
    const bolCommission = channelInfo.channel === "Bol via Shopify" ? money(bolMatch?.bol?.total_commission || 0) : 0;
    const shippingPaid = money(order.shipping_paid_by_customer);
    const actualShipping = estimateShippingCost(order, shippingRates);
    const lineItems = (order.line_items || []).map((item) => buildLineItemProfit(item, costIndex));
    const productCost = money(lineItems.reduce((sum, item) => sum + item.product_cost_total, 0));
    const discount = money(order.discount);
    const grossProfit = money(revenue - actualShipping - productCost);
    const netProfit = money(grossProfit - adCost - bolCommission - bolAdsCost);

    const orderWarnings = [];
    if (lineItems.some((item) => item.cost_status !== "matched")) orderWarnings.push("product_cost_missing_or_estimated");
    if (actualShipping === 0 && revenue > 0) orderWarnings.push("shipping_cost_unknown");
    if (adCost > 0) orderWarnings.push("ad_cost_allocated_by_revenue_share");
    if (bolAdsCost > 0) orderWarnings.push("bol_ads_allocated_by_bol_revenue_share");
    if (channelInfo.channel === "Bol via Shopify" && bolCommission === 0) orderWarnings.push("commission_missing_or_estimated");
    if (channelInfo.channel === "Bol via Shopify" && !bolMatch) orderWarnings.push("bol_order_not_matched_but_shopify_source_is_bol");
    if (bolMatch?.warnings?.length) orderWarnings.push(...bolMatch.warnings);

    return {
      order_number: order.order_number,
      date: order.date,
      channel_source: order.channel_source,
      channel: channelInfo.channel,
      channel_reason: channelInfo.reason,
      customer_country_code: order.customer_country_code,
      customer_country: order.customer_country,
      tags: order.tags || [],
      payment_status: order.payment_status,
      fulfillment_status: order.fulfillment_status,
      landing_site: order.landing_site || null,
      referring_site: order.referring_site || null,
      omzet: revenue,
      verzendkosten_betaald_door_klant: shippingPaid,
      werkelijke_verzendkosten: actualShipping,
      productkostprijs: productCost,
      korting: discount,
      bruto_winst: grossProfit,
      bol_commissie: bolCommission,
      advertentiekosten: adCost,
      advertentiekosten_methode: adCost > 0 ? "allocated_by_order_revenue_share" : "none",
      bol_advertentiekosten: bolAdsCost,
      bol_advertentiekosten_methode: bolAdsCost > 0 ? "allocated_by_bol_order_revenue_share" : "none",
      nettowinst: netProfit,
      nettowinst_pct: revenue > 0 ? roundPercent(netProfit / revenue) : null,
      bol_order_id: bolMatch?.bol?.bol_order_id || null,
      bol_match_method: bolMatch?.match_method || null,
      bol_match_confidence: bolMatch?.confidence || null,
      eans: bolMatch?.bol?.eans || [],
      line_items: lineItems,
      warnings: [...new Set(orderWarnings)],
    };
  });

  const payload = {
    generated_at: new Date().toISOString(),
    period: label,
    source_files: { shopify: shopifyFile, google_ads: googleAdsFile, bol_enriched: bolEnrichedFile, bol_ads: bolAdsFile },
    warnings: [
      ...warnings,
      ...(bolEnriched?.warnings || []),
      ...(bolEnriched?.unmatched_bol_orders || []).map((order) => `${order.bol?.bol_order_id || "unknown"}: bol_order_missing_in_shopify`),
      ...(bolAds?.warnings || []),
    ],
    cost_lookup: {
      entries: costIndex.entries.length,
      source: "config/prijsberekening 2026.xlsx",
      note: costIndex.note,
    },
    totals: summarizeProfitOrders(orders, totalAdCost, googleAds, totalBolAdsCost, bolAds),
    channel_totals: summarizeChannels(orders),
    bol: {
      matched_orders: bolEnriched?.summary?.matched_orders || 0,
      missing_in_shopify: bolEnriched?.summary?.missing_in_shopify || 0,
      ads_supported: Boolean(bolAds?.supported),
    },
    orders,
  };

  await writeJson(path.join(dataDir, outputFile), payload);
  return payload;
}

function buildLineItemProfit(item, costIndex) {
  const sku = normalizeKey(item.sku);
  const productName = normalizeKey(item.product_name);
  const quantity = Number(item.quantity || 0);
  const unitRevenue = money(item.product_sale_price);
  const lineRevenue = money(unitRevenue * quantity);
  const match = costIndex.bySku.get(sku) || costIndex.byProduct.get(productName) || null;
  const unitCost = match ? money(match.cost) : 0;
  const productCostTotal = money(unitCost * quantity);

  return {
    product_name: item.product_name,
    sku: item.sku || null,
    quantity,
    product_sale_price: unitRevenue,
    line_revenue: lineRevenue,
    product_cost_unit: unitCost,
    product_cost_total: productCostTotal,
    gross_profit_before_shipping_ads: money(lineRevenue - productCostTotal),
    margin_before_shipping_ads_pct: lineRevenue > 0 ? roundPercent((lineRevenue - productCostTotal) / lineRevenue) : null,
    cost_status: match ? "matched" : "missing",
    cost_match_key: match?.key || null,
  };
}

function estimateShippingCost(order, shippingRates) {
  const country = String(order.customer_country_code || "").toUpperCase();
  const tags = (order.tags || []).join(" ").toLowerCase();
  const title = String(order.shipping_title || "").toLowerCase();
  const items = order.line_items || [];
  const text = `${tags} ${title} ${items.map((item) => `${item.product_name || ""} ${item.sku || ""}`).join(" ")}`.toLowerCase();

  if (country === "NL") {
    if (looksLikeLetterbox(text)) return money(shippingRates.rates?.NL?.letterbox ?? 3.7);
    return money(shippingRates.rates?.NL?.parcel ?? 5.6);
  }
  if (country === "BE") return money(shippingRates.rates?.BE?.parcel ?? 8.09);
  if (country === "FR") return money(shippingRates.rates?.FR?.parcel_0_2kg ?? 11.85);
  if (country) {
    const base = Number(shippingRates.rates?.FR?.parcel_0_2kg ?? 11.85);
    const surcharge = Number(shippingRates.rates?.EU_OTHER?.parcel_0_2kg_surcharge ?? 0.25);
    return money(base + surcharge);
  }
  return 0;
}

function looksLikeLetterbox(text) {
  const parcelWords = ["pakket", "duo", "dc18rc", "dc18rd", "bosch 4a", "verstelbare", "kantelbare"];
  if (parcelWords.some((word) => text.includes(word))) return false;
  const letterboxWords = ["unifi", "wandbeugel", "beugel", "mount", "houder"];
  return letterboxWords.some((word) => text.includes(word));
}

function dedupeOrders(orders) {
  const seen = new Map();
  for (const order of orders) {
    const key = order.order_number || `${order.date}|${order.total_order_amount}`;
    if (!seen.has(key)) seen.set(key, order);
  }
  return [...seen.values()];
}

function buildBolMatchIndex(bolEnriched) {
  const index = new Map();
  for (const match of bolEnriched?.matches || []) {
    if (match.shopify_order_number) index.set(match.shopify_order_number, match);
  }
  return index;
}

function classifyChannel(order, bolMatches) {
  if (bolMatches.has(order.order_number)) {
    return { channel: "Bol via Shopify", reason: "matched_bol_retailer_api" };
  }

  const text = normalizeKey([order.channel_source, ...(order.tags || [])].join(" "));
  if (text.includes("bol")) {
    return { channel: "Bol via Shopify", reason: "shopify_source_or_tag_is_bol" };
  }

  if (normalizeKey(order.channel_source).includes("web")) {
    return { channel: "Shopify direct", reason: "shopify_source_web" };
  }

  return { channel: "Onbekend/overig", reason: "source_not_classified" };
}

function summarizeProfitOrders(orders, totalAdCost, googleAds, totalBolAdsCost, bolAds) {
  const totals = orders.reduce((sum, order) => {
    sum.orders += 1;
    sum.omzet += order.omzet;
    sum.verzendkosten_betaald_door_klant += order.verzendkosten_betaald_door_klant;
    sum.werkelijke_verzendkosten += order.werkelijke_verzendkosten;
    sum.productkostprijs += order.productkostprijs;
    sum.bruto_winst += order.bruto_winst;
    sum.bol_commissie += order.bol_commissie;
    sum.advertentiekosten += order.advertentiekosten;
    sum.bol_advertentiekosten += order.bol_advertentiekosten;
    sum.nettowinst += order.nettowinst;
    return sum;
  }, {
    orders: 0,
    omzet: 0,
    verzendkosten_betaald_door_klant: 0,
    werkelijke_verzendkosten: 0,
    productkostprijs: 0,
    bruto_winst: 0,
    bol_commissie: 0,
    advertentiekosten: 0,
    bol_advertentiekosten: 0,
    nettowinst: 0,
  });

  for (const key of Object.keys(totals)) {
    if (key !== "orders") totals[key] = money(totals[key]);
  }
  totals.nettowinst_pct = totals.omzet > 0 ? roundPercent(totals.nettowinst / totals.omzet) : null;
  totals.gemiddelde_winst_per_order = totals.orders > 0 ? money(totals.nettowinst / totals.orders) : 0;
  totals.google_ads_cost_total = money(totalAdCost);
  totals.google_ads_unallocated = money(Math.max(0, totalAdCost - totals.advertentiekosten));
  totals.google_ads_roas = googleAds?.totals?.roas ?? null;
  totals.bol_ads_cost_total = money(totalBolAdsCost);
  totals.bol_ads_unallocated = money(Math.max(0, totalBolAdsCost - totals.bol_advertentiekosten));
  totals.bol_ads_roas = bolAds?.totals?.roas ?? null;
  totals.bol_ads_supported = Boolean(bolAds?.supported);
  return totals;
}

function summarizeChannels(orders) {
  const channels = new Map();
  for (const order of orders) {
    const current = channels.get(order.channel) || {
      orders: 0,
      omzet: 0,
      werkelijke_verzendkosten: 0,
      productkostprijs: 0,
      bol_commissie: 0,
      advertentiekosten: 0,
      bol_advertentiekosten: 0,
      nettowinst: 0,
    };
    current.orders += 1;
    current.omzet += order.omzet;
    current.werkelijke_verzendkosten += order.werkelijke_verzendkosten;
    current.productkostprijs += order.productkostprijs;
    current.bol_commissie += order.bol_commissie;
    current.advertentiekosten += order.advertentiekosten;
    current.bol_advertentiekosten += order.bol_advertentiekosten;
    current.nettowinst += order.nettowinst;
    channels.set(order.channel, current);
  }

  return Object.fromEntries([...channels.entries()].map(([channel, values]) => {
    const rounded = {};
    for (const [key, value] of Object.entries(values)) rounded[key] = key === "orders" ? value : money(value);
    rounded.nettowinst_pct = rounded.omzet > 0 ? roundPercent(rounded.nettowinst / rounded.omzet) : null;
    return [channel, rounded];
  }));
}

function readCostIndex(workbookPath) {
  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const entries = [];

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null });
    for (const row of rows) {
      const cells = row.map((value) => typeof value === "string" ? value.trim() : value);
      const sku = findValueAfterLabel(cells, ["sku-code #", "sku", "sku-code"]);
      const product = findValueAfterLabel(cells, ["productnaam", "product"]);
      const cost = findValueAfterLabel(cells, ["productiekosten", "totale productiekosten", "inclusief mislukkingen", "purchase price", "kostprijs"]);

      if ((sku || product) && Number.isFinite(Number(cost))) {
        entries.push({
          key: sku || product,
          sku: sku || null,
          product: product || null,
          cost: Number(cost),
          sheet: sheetName,
        });
      }
    }
  }

  const bySku = new Map();
  const byProduct = new Map();
  for (const entry of entries) {
    if (entry.sku) bySku.set(normalizeKey(entry.sku), entry);
    if (entry.product) byProduct.set(normalizeKey(entry.product), entry);
  }

  return {
    entries,
    bySku,
    byProduct,
    note: entries.length < 5
      ? "Workbook appears to be a calculator/template, not a complete product cost table. Missing SKU costs will be flagged."
      : "Cost entries parsed from workbook labels.",
  };
}

function findValueAfterLabel(cells, labels) {
  const normalizedLabels = labels.map(normalizeKey);
  for (let index = 0; index < cells.length; index += 1) {
    if (!normalizedLabels.includes(normalizeKey(cells[index]))) continue;
    for (let offset = 1; offset <= 8; offset += 1) {
      const value = cells[index + offset];
      if (value !== null && value !== undefined && value !== "") return value;
    }
  }
  return null;
}

async function writeMorningReport(daily, last7) {
  const topProducts = productPerformance(daily.orders)
    .filter((product) => product.nettowinst > 0)
    .slice(0, 5);
  const lowMarginProducts = productPerformance(daily.orders)
    .filter((product) => product.nettowinst_pct !== null && product.nettowinst_pct < 20)
    .slice(0, 10);
  const dailyBol = daily.channel_totals?.["Bol via Shopify"] || emptyChannelTotals();
  const last7Bol = last7.channel_totals?.["Bol via Shopify"] || emptyChannelTotals();
  const dailyDirect = daily.channel_totals?.["Shopify direct"] || emptyChannelTotals();

  const lines = [
    "# 3DTS Morning Report",
    "",
    `Gegenereerd: ${new Date().toISOString()}`,
    "",
    "## Samenvatting gisteren",
    "",
    `- Omzet gisteren: EUR ${daily.totals.omzet.toFixed(2)}`,
    `- Nettowinst gisteren: EUR ${daily.totals.nettowinst.toFixed(2)}`,
    `- Orders gisteren: ${daily.totals.orders}`,
    `- Gemiddelde winst per order: EUR ${daily.totals.gemiddelde_winst_per_order.toFixed(2)}`,
    "",
    "## Top 5 winstgevende producten",
    "",
    ...markdownProductList(topProducts, "Geen winstgevende producten gevonden in de beschikbare dagdata."),
    "",
    "## Producten met lage marge",
    "",
    ...markdownProductList(lowMarginProducts, "Geen lage-marge producten gevonden in de beschikbare dagdata."),
    "",
    "## Shopify vs Google Ads",
    "",
    `- Shopify omzet gisteren: EUR ${daily.totals.omzet.toFixed(2)}`,
    `- Shopify direct omzet gisteren: EUR ${dailyDirect.omzet.toFixed(2)}`,
    `- Google Ads kosten gisteren: EUR ${daily.totals.google_ads_cost_total.toFixed(2)}`,
    `- Google Ads ROAS gisteren: ${daily.totals.google_ads_roas ?? "onbekend"}`,
    `- Laatste 7 dagen omzet: EUR ${last7.totals.omzet.toFixed(2)}`,
    `- Laatste 7 dagen Google Ads kosten: EUR ${last7.totals.google_ads_cost_total.toFixed(2)}`,
    `- Laatste 7 dagen nettowinst: EUR ${last7.totals.nettowinst.toFixed(2)}`,
    "",
    "## Bol.com",
    "",
    `- Bol omzet gisteren: EUR ${dailyBol.omzet.toFixed(2)}`,
    `- Bol winst gisteren: EUR ${dailyBol.nettowinst.toFixed(2)}`,
    `- Bol commissie gisteren: EUR ${dailyBol.bol_commissie.toFixed(2)}`,
    `- Bol Ads kosten gisteren: EUR ${daily.totals.bol_ads_cost_total.toFixed(2)}`,
    `- Winst na Bol Ads gisteren: EUR ${dailyBol.nettowinst.toFixed(2)}`,
    `- Bol omzet laatste 7 dagen: EUR ${last7Bol.omzet.toFixed(2)}`,
    `- Bol winst laatste 7 dagen: EUR ${last7Bol.nettowinst.toFixed(2)}`,
    `- Bol commissie laatste 7 dagen: EUR ${last7Bol.bol_commissie.toFixed(2)}`,
    `- Bol Ads kosten laatste 7 dagen: EUR ${last7.totals.bol_ads_cost_total.toFixed(2)}`,
    `- Bol Ads ROAS laatste 7 dagen: ${last7.totals.bol_ads_roas ?? "onbekend"}`,
    `- Bol orders gematcht laatste 7 dagen: ${last7.bol?.matched_orders || 0}`,
    `- Bol orders niet in Shopify gevonden laatste 7 dagen: ${last7.bol?.missing_in_shopify || 0}`,
    "",
    "## AI-adviezen",
    "",
    ...buildAdvice(daily, last7).map((item) => `- ${item}`),
    "",
    "## Datakwaliteit",
    "",
    ...[...daily.warnings, ...last7.warnings].map((warning) => `- ${warning}`),
    daily.warnings.length || last7.warnings.length ? "" : "- Geen waarschuwingen.",
  ];

  await writeFile(path.join(reportsDir, "morning_report.md"), `${lines.join("\n")}\n`, "utf8");
}

function emptyChannelTotals() {
  return {
    orders: 0,
    omzet: 0,
    werkelijke_verzendkosten: 0,
    productkostprijs: 0,
    bol_commissie: 0,
    advertentiekosten: 0,
    bol_advertentiekosten: 0,
    nettowinst: 0,
    nettowinst_pct: null,
  };
}

async function writeActionItems(daily, last7) {
  const actions = [];
  for (const order of [...daily.orders, ...last7.orders]) {
    for (const item of order.line_items) {
      if (item.cost_status !== "matched") {
        actions.push({
          type: "product controleren",
          priority: "high",
          product_name: item.product_name,
          sku: item.sku,
          reason: "Kostprijs ontbreekt in Excel-kostprijsindex; nettowinst kan te hoog lijken.",
        });
      }
      if (item.margin_before_shipping_ads_pct !== null && item.margin_before_shipping_ads_pct < 25) {
        actions.push({
          type: "prijs verhogen",
          priority: "medium",
          product_name: item.product_name,
          sku: item.sku,
          reason: `Marge voor shipping/ads is ${item.margin_before_shipping_ads_pct}%.`,
        });
      }
    }
  }

  if (last7.totals.google_ads_cost_total > 0 && last7.totals.google_ads_roas !== null && last7.totals.google_ads_roas < 1.5) {
    actions.push({
      type: "campagne pauzeren",
      priority: "high",
      campaign: "Google Ads",
      reason: `ROAS laatste 7 dagen is ${last7.totals.google_ads_roas}; eerst tracking/productmarges controleren voordat budget omhoog gaat.`,
    });
  }

  if (last7.totals.bol_ads_cost_total > 0 && last7.totals.bol_ads_roas !== null && last7.totals.bol_ads_roas < 1.5) {
    actions.push({
      type: "campagne pauzeren",
      priority: "high",
      campaign: "Bol Sponsored Products",
      reason: `Bol Ads ROAS laatste 7 dagen is ${last7.totals.bol_ads_roas}; controleer zoektermen en biedingen voordat budget omhoog gaat.`,
    });
  }

  for (const order of [...daily.orders, ...last7.orders]) {
    if (order.warnings.includes("commission_missing_or_estimated")) {
      actions.push({
        type: "product controleren",
        priority: "high",
        product_name: order.line_items?.[0]?.product_name,
        sku: order.line_items?.[0]?.sku,
        reason: `Bol commissie ontbreekt voor order ${order.order_number}; winst kan te hoog lijken.`,
      });
    }
    if (order.warnings.includes("bol_order_not_matched_but_shopify_source_is_bol")) {
      actions.push({
        type: "product controleren",
        priority: "medium",
        product_name: order.line_items?.[0]?.product_name,
        sku: order.line_items?.[0]?.sku,
        reason: `Shopify markeert order ${order.order_number} als bol, maar Retailer API match ontbreekt.`,
      });
    }
  }

  if (last7.totals.orders > 0 && last7.totals.gemiddelde_winst_per_order > 8 && last7.totals.google_ads_roas > 2.5) {
    actions.push({
      type: "campagne verhogen",
      priority: "medium",
      campaign: "Google Ads",
      reason: "Orders zijn winstgevend en ROAS is gezond.",
    });
  }

  const productStats = productPerformance(last7.orders);
  for (const product of productStats.filter((item) => item.quantity >= 2 && item.nettowinst > 0).slice(0, 5)) {
    actions.push({
      type: "bundel maken",
      priority: "medium",
      product_name: product.product_name,
      sku: product.sku,
      reason: "Meerdere verkopen in 7 dagen; test een bundel of 2-pack om verzendkosten per stuk te verlagen.",
    });
  }

  await writeJson(path.join(reportsDir, "action_items.json"), {
    generated_at: new Date().toISOString(),
    actions: dedupeActions(actions),
  });
}

function productPerformance(orders) {
  const byKey = new Map();
  for (const order of orders) {
    for (const item of order.line_items) {
      const key = normalizeKey(item.sku || item.product_name);
      const current = byKey.get(key) || {
        product_name: item.product_name,
        sku: item.sku,
        quantity: 0,
        omzet: 0,
        nettowinst: 0,
      };
      const orderShare = order.omzet > 0 ? item.line_revenue / order.omzet : 0;
      current.quantity += item.quantity;
      current.omzet += item.line_revenue;
      current.nettowinst += order.nettowinst * orderShare;
      byKey.set(key, current);
    }
  }

  return [...byKey.values()].map((product) => ({
    ...product,
    omzet: money(product.omzet),
    nettowinst: money(product.nettowinst),
    nettowinst_pct: product.omzet > 0 ? roundPercent(product.nettowinst / product.omzet) : null,
  })).sort((a, b) => b.nettowinst - a.nettowinst);
}

function markdownProductList(products, emptyText) {
  if (!products.length) return [`- ${emptyText}`];
  return products.map((product) => (
    `- ${product.product_name || "(onbekend)"} (${product.sku || "geen SKU"}): EUR ${product.nettowinst.toFixed(2)} nettowinst, ${product.nettowinst_pct ?? "?"}% marge`
  ));
}

function buildAdvice(daily, last7) {
  const advice = [];
  if (!daily.orders.length) advice.push("Shopify dagdata ontbreekt nog; vul SHOPIFY secrets in en draai de workflow opnieuw.");
  if (last7.totals.google_ads_roas !== null && last7.totals.google_ads_roas < 1) {
    advice.push("Google Ads geeft minder conversiewaarde terug dan advertentiekosten; controleer tracking en pauzeer verliesgevende campagnes tijdelijk.");
  }
  if (last7.orders.some((order) => order.warnings.includes("product_cost_missing_or_estimated"))) {
    advice.push("Maak een echte SKU-kostprijstabel uit je calculator, anders lijkt winst hoger dan hij is.");
  }
  if (last7.totals.werkelijke_verzendkosten > last7.totals.verzendkosten_betaald_door_klant) {
    advice.push("Verzendkosten liggen hoger dan wat klanten betalen; verhoog gratis-verzending drempel of bundel producten.");
  }
  if ((last7.bol?.missing_in_shopify || 0) > 0) {
    advice.push("Er zijn bol-orders die niet in Shopify gematcht zijn; controleer Market Sync voordat omzet dubbel of juist niet wordt meegenomen.");
  }
  if (last7.orders.some((order) => order.warnings.includes("commission_missing_or_estimated"))) {
    advice.push("Voor sommige bol-orders ontbreekt commissie; voeg EAN/referentie goed toe of controleer bol Retailer API toegang.");
  }
  if (last7.totals.bol_ads_cost_total > 0 && last7.totals.bol_ads_roas !== null && last7.totals.bol_ads_roas < 1.5) {
    advice.push("Bol Sponsored Products kost relatief veel; verlaag biedingen of pauzeer campagnes met lage marge.");
  }
  if (!advice.length) advice.push("Data ziet er gezond uit; focus op producten met hoogste nettowinst en test bundels.");
  return advice;
}

function dedupeActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = `${action.type}|${action.product_name || ""}|${action.sku || ""}|${action.campaign || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function roundPercent(value) {
  return Math.round((Number(value || 0) * 100 + Number.EPSILON) * 100) / 100;
}
