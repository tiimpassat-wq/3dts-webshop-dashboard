import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

const retailerBaseUrl = "https://api.bol.com/retailer";
const advertiserBaseUrl = "https://api.bol.com/advertiser/sponsored-products/reporting";
const clientId = process.env.BOL_CLIENT_ID;
const clientSecret = process.env.BOL_CLIENT_SECRET;
const adsClientId = process.env.BOL_ADS_CLIENT_ID || clientId;
const adsClientSecret = process.env.BOL_ADS_CLIENT_SECRET || clientSecret;

await mkdir(dataDir, { recursive: true });

const ranges = buildRanges();

for (const range of ranges) {
  const shopify = await readJson(path.join(dataDir, range.shopifyFile), { orders: [] });
  const rawOrdersPayload = await fetchBolOrdersPayload(range);
  await writeJson(path.join(dataDir, range.rawFile), rawOrdersPayload);

  const enriched = enrichShopifyOrders({
    range,
    shopifyOrders: Array.isArray(shopify.orders) ? shopify.orders : [],
    bolOrders: rawOrdersPayload.orders || [],
    bolWarnings: rawOrdersPayload.warnings || [],
  });
  await writeJson(path.join(dataDir, range.enrichedFile), enriched);

  const ads = await fetchBolAdsPayload(range);
  await writeJson(path.join(dataDir, range.adsFile), ads);

  console.log(`${range.enrichedFile}: ${enriched.summary.matched_orders} matched, ${enriched.summary.missing_in_shopify} missing in Shopify`);
  console.log(`${range.adsFile}: supported=${ads.supported}, cost EUR ${money(ads.totals?.cost || 0).toFixed(2)}`);
}

async function fetchBolOrdersPayload(range) {
  const basePayload = {
    generated_at: new Date().toISOString(),
    period: range.label,
    date_from: range.from,
    date_to_exclusive: range.toExclusive,
    source: "bol.com Retailer API",
    orders: [],
    warnings: [],
  };

  if (!clientId || !clientSecret) {
    return {
      ...basePayload,
      credentials_configured: false,
      warnings: ["Missing BOL_CLIENT_ID or BOL_CLIENT_SECRET; bol enrichment skipped."],
    };
  }

  try {
    const token = await getBolAccessToken(clientId, clientSecret);
    const summaries = await fetchBolOrderSummaries(token, range);
    const details = [];
    for (const summary of summaries) {
      try {
        details.push(await fetchBolOrderDetail(token, summary.orderId));
      } catch (error) {
        basePayload.warnings.push(`Could not fetch bol order ${summary.orderId}: ${safeError(error)}`);
      }
    }

    const orders = details
      .map(normalizeBolOrder)
      .filter((order) => isInRange(order.order_placed_at, range));

    return {
      ...basePayload,
      credentials_configured: true,
      totals: summarizeBolOrders(orders),
      orders,
      warnings: basePayload.warnings,
    };
  } catch (error) {
    return {
      ...basePayload,
      credentials_configured: true,
      orders: [],
      warnings: [`Bol Retailer API request failed: ${safeError(error)}`],
    };
  }
}

async function fetchBolAdsPayload(range) {
  const basePayload = {
    generated_at: new Date().toISOString(),
    period: range.label,
    date_from: range.from,
    date_to: range.toInclusive,
    source: "bol.com Advertising API Sponsored Products advertiser performance",
    supported: false,
    totals: emptyAdsTotals(),
    raw: null,
    warnings: [],
  };

  if (!adsClientId || !adsClientSecret) {
    return {
      ...basePayload,
      warnings: ["Missing BOL_ADS_CLIENT_ID/BOL_ADS_CLIENT_SECRET or BOL_CLIENT_ID/BOL_CLIENT_SECRET; bol ads skipped."],
    };
  }

  try {
    const token = await getBolAccessToken(adsClientId, adsClientSecret);
    const params = new URLSearchParams({
      "period-start-date": range.from,
      "period-end-date": range.toInclusive,
    });
    const raw = await bolFetchJson(`${advertiserBaseUrl}/performance/advertiser?${params}`, token, {
      accept: "application/vnd.advertiser.v11+json",
    });
    return {
      ...basePayload,
      supported: true,
      totals: normalizeAdsTotals(raw),
      raw,
      warnings: [],
    };
  } catch (error) {
    return {
      ...basePayload,
      supported: false,
      warnings: [`Bol Advertising API unavailable or not authorized: ${safeError(error)}`],
    };
  }
}

async function fetchBolOrderSummaries(token, range) {
  const seen = new Map();
  for (const date of eachDate(range.from, range.toInclusive)) {
    for (const status of ["ALL"]) {
      let page = 1;
      let pageHadOrders = false;
      do {
        const params = new URLSearchParams({
          page: String(page),
          "fulfilment-method": "ALL",
          status,
          "latest-change-date": date,
        });
        const body = await bolFetchJson(`${retailerBaseUrl}/orders?${params}`, token);
        const orders = Array.isArray(body.orders) ? body.orders : [];
        pageHadOrders = orders.length > 0;
        for (const order of orders) seen.set(order.orderId, order);
        page += 1;
      } while (pageHadOrders && page <= 20);
    }
  }
  return [...seen.values()];
}

async function fetchBolOrderDetail(token, orderId) {
  return bolFetchJson(`${retailerBaseUrl}/orders/${encodeURIComponent(orderId)}`, token);
}

async function getBolAccessToken(id, secret) {
  const credentials = Buffer.from(`${id}:${secret}`, "utf8").toString("base64");
  const response = await fetch("https://login.bol.com/token?grant_type=client_credentials", {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      accept: "application/json",
    },
  });
  const body = await readResponseBody(response);
  if (!response.ok) throw new Error(`token ${response.status}: ${body}`);
  const parsed = JSON.parse(body);
  if (!parsed.access_token) throw new Error("token response did not contain access_token");
  return parsed.access_token;
}

async function bolFetchJson(url, token, { accept = "application/vnd.retailer.v10+json" } = {}) {
  const response = await fetch(url, {
    headers: {
      accept,
      authorization: `Bearer ${token}`,
    },
  });
  const body = await readResponseBody(response);
  if (!response.ok) throw new Error(`${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : {};
}

async function readResponseBody(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("utf8");
}

function normalizeBolOrder(order) {
  const lineItems = (order.orderItems || []).map((item) => {
    const unitPrice = money(item.unitPrice);
    const quantity = Number(item.quantity || 0);
    const totalPrice = money(item.totalPrice || unitPrice * quantity);
    const commission = Number.isFinite(Number(item.commission)) ? money(item.commission) : null;
    return {
      bol_order_item_id: item.orderItemId,
      ean: item.product?.ean || null,
      product_name: item.product?.title || null,
      offer_id: item.offer?.offerId || null,
      offer_reference: item.offer?.reference || null,
      sku: item.offer?.reference || null,
      quantity,
      quantity_shipped: Number(item.quantityShipped || 0),
      quantity_cancelled: Number(item.quantityCancelled || 0),
      unit_price: unitPrice,
      total_price: totalPrice,
      commission,
      fulfilment_method: item.fulfilment?.method || null,
      distribution_party: item.fulfilment?.distributionParty || null,
      cancellation_request: Boolean(item.cancellationRequest),
      latest_changed_at: item.latestChangedDateTime || null,
    };
  });

  return {
    bol_order_id: order.orderId,
    order_placed_at: order.orderPlacedDateTime || null,
    customer_country_code: order.shipmentDetails?.countryCode || null,
    pickup_point: Boolean(order.pickupPoint),
    total_order_amount: money(lineItems.reduce((sum, item) => sum + item.total_price, 0)),
    total_commission: nullableMoney(lineItems.reduce((sum, item) => sum + (item.commission ?? 0), 0), lineItems.some((item) => item.commission !== null)),
    eans: [...new Set(lineItems.map((item) => item.ean).filter(Boolean))],
    offer_references: [...new Set(lineItems.map((item) => item.offer_reference).filter(Boolean))],
    line_items: lineItems,
  };
}

function enrichShopifyOrders({ range, shopifyOrders, bolOrders, bolWarnings }) {
  const matches = [];
  const unmatchedBolOrders = [];
  const usedShopifyKeys = new Set();

  for (const bolOrder of bolOrders) {
    const match = findShopifyMatch(bolOrder, shopifyOrders, usedShopifyKeys);
    if (match) {
      usedShopifyKeys.add(match.order_number);
      matches.push({
        match_status: "matched",
        match_method: match.match_method,
        confidence: match.confidence,
        shopify_order_number: match.order_number,
        shopify_order_date: match.date,
        shopify_total_order_amount: money(match.total_order_amount),
        channel: "bol.com",
        bol: bolOrder,
        warnings: buildBolWarnings(bolOrder),
      });
    } else {
      unmatchedBolOrders.push({
        match_status: "bol_order_missing_in_shopify",
        channel: "bol.com",
        bol: bolOrder,
        warnings: ["bol_order_missing_in_shopify", ...buildBolWarnings(bolOrder)],
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    period: range.label,
    date_from: range.from,
    date_to_exclusive: range.toExclusive,
    source_files: {
      shopify: range.shopifyFile,
      bol_raw: range.rawFile,
    },
    summary: {
      bol_orders: bolOrders.length,
      matched_orders: matches.length,
      missing_in_shopify: unmatchedBolOrders.length,
      total_bol_revenue: money(bolOrders.reduce((sum, order) => sum + order.total_order_amount, 0)),
      total_bol_commission: money(bolOrders.reduce((sum, order) => sum + (order.total_commission || 0), 0)),
    },
    warnings: bolWarnings,
    matches,
    unmatched_bol_orders: unmatchedBolOrders,
  };
}

function findShopifyMatch(bolOrder, shopifyOrders, usedShopifyKeys) {
  const directNeedles = [
    bolOrder.bol_order_id,
    ...bolOrder.offer_references,
    ...bolOrder.eans,
  ].map(normalizeKey).filter(Boolean);

  for (const shopifyOrder of shopifyOrders) {
    if (usedShopifyKeys.has(shopifyOrder.order_number)) continue;
    const haystack = normalizeKey([
      shopifyOrder.order_number,
      shopifyOrder.channel_source,
      ...(shopifyOrder.tags || []),
      shopifyOrder.landing_site,
      shopifyOrder.referring_site,
      ...(shopifyOrder.line_items || []).flatMap((item) => [item.sku, item.product_name]),
    ].filter(Boolean).join(" "));
    if (directNeedles.some((needle) => needle && haystack.includes(needle))) {
      return { ...shopifyOrder, match_method: "identifier_or_sku_tag_source", confidence: 0.95 };
    }
  }

  const candidates = shopifyOrders
    .filter((order) => !usedShopifyKeys.has(order.order_number))
    .map((order) => ({ order, score: fallbackScore(bolOrder, order) }))
    .filter((candidate) => candidate.score >= 70)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  return {
    ...candidates[0].order,
    match_method: "date_amount_country_product_fallback",
    confidence: Math.min(0.9, candidates[0].score / 100),
  };
}

function fallbackScore(bolOrder, shopifyOrder) {
  let score = 0;
  const amountDiff = Math.abs(money(bolOrder.total_order_amount) - money(shopifyOrder.total_order_amount));
  if (amountDiff <= 0.03) score += 35;
  if (normalizeCountry(bolOrder.customer_country_code) === normalizeCountry(shopifyOrder.customer_country_code)) score += 20;
  if (sameLocalDate(bolOrder.order_placed_at, shopifyOrder.date)) score += 20;
  if (hasProductOverlap(bolOrder, shopifyOrder)) score += 25;
  if (isShopifyBolOrder(shopifyOrder)) score += 15;
  return score;
}

function hasProductOverlap(bolOrder, shopifyOrder) {
  const bolText = normalizeKey([
    ...bolOrder.eans,
    ...bolOrder.offer_references,
    ...bolOrder.line_items.flatMap((item) => [item.sku, item.product_name]),
  ].join(" "));
  const shopifyText = normalizeKey((shopifyOrder.line_items || []).flatMap((item) => [item.sku, item.product_name]).join(" "));
  if (!bolText || !shopifyText) return false;
  return bolText.split(/\s+/).some((part) => part.length >= 6 && shopifyText.includes(part))
    || shopifyText.split(/\s+/).some((part) => part.length >= 6 && bolText.includes(part));
}

function isShopifyBolOrder(order) {
  const text = normalizeKey([order.channel_source, ...(order.tags || [])].join(" "));
  return text.includes("bol");
}

function buildBolWarnings(bolOrder) {
  const warnings = [];
  if (bolOrder.total_commission === null) warnings.push("commission_missing_or_estimated");
  if (!bolOrder.eans.length) warnings.push("ean_missing");
  return warnings;
}

function summarizeBolOrders(orders) {
  return {
    order_count: orders.length,
    total_order_amount: money(orders.reduce((sum, order) => sum + order.total_order_amount, 0)),
    total_commission: money(orders.reduce((sum, order) => sum + (order.total_commission || 0), 0)),
  };
}

function normalizeAdsTotals(raw) {
  return {
    impressions: Number(raw?.impressions || 0),
    clicks: Number(raw?.clicks || 0),
    conversions: Number(raw?.conversions14d || 0),
    direct_conversions: Number(raw?.directConversions14d || 0),
    indirect_conversions: Number(raw?.indirectConversions14d || 0),
    sales: money(raw?.sales14d || 0),
    cost: money(raw?.cost || 0),
    average_cpc: raw?.averageCpc ?? null,
    acos: raw?.acos14d ?? null,
    roas: raw?.roas14d ?? null,
    ctr: raw?.ctr ?? null,
  };
}

function emptyAdsTotals() {
  return {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    direct_conversions: 0,
    indirect_conversions: 0,
    sales: 0,
    cost: 0,
    average_cpc: null,
    acos: null,
    roas: null,
    ctr: null,
  };
}

function buildRanges() {
  const today = localDateParts(0);
  const tomorrow = localDateParts(1);
  const yesterday = localDateParts(-1);
  const sevenDaysAgo = localDateParts(-6);
  return [
    makeRange("daily", "bol_orders_raw_daily.json", "bol_enriched_daily.json", "bol_ads_daily.json", "shopify_orders_daily.json", yesterday, today),
    makeRange("last_7_days", "bol_orders_raw_last_7_days.json", "bol_enriched_last_7_days.json", "bol_ads_last_7_days.json", "shopify_orders_last_7_days.json", sevenDaysAgo, tomorrow),
  ];
}

function makeRange(label, rawFile, enrichedFile, adsFile, shopifyFile, from, toExclusive) {
  const toInclusive = previousDate(toExclusive);
  return { label, rawFile, enrichedFile, adsFile, shopifyFile, from, toExclusive, toInclusive };
}

function localDateParts(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return formatLocalDate(date);
}

function formatLocalDate(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function previousDate(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function eachDate(from, toInclusive) {
  const dates = [];
  const current = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${toInclusive}T12:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function isInRange(isoDate, range) {
  if (!isoDate) return false;
  const localDate = formatLocalDate(new Date(isoDate));
  return localDate >= range.from && localDate < range.toExclusive;
}

function sameLocalDate(left, right) {
  if (!left || !right) return false;
  return formatLocalDate(new Date(left)) === formatLocalDate(new Date(right));
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

function normalizeCountry(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function nullableMoney(value, hasValue) {
  return hasValue ? money(value) : null;
}

function safeError(error) {
  return String(error?.message || error)
    .replace(clientSecret || "NO_SECRET", "[redacted]")
    .replace(adsClientSecret || "NO_ADS_SECRET", "[redacted]");
}
