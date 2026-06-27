import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-04";
const shopDomain = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN);
const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

if (!shopDomain) throw new Error("Missing SHOPIFY_SHOP_DOMAIN");
if (!accessToken) throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");

const ranges = buildRanges();
const queryWarnings = [];
const ordersQuery = buildOrdersQuery({ includeVariantFields: true });
const ordersQueryWithoutVariants = buildOrdersQuery({ includeVariantFields: false });

function buildOrdersQuery({ includeVariantFields }) {
  const variantFields = includeVariantFields
    ? `variant {
              id
              barcode
            }`
    : "";

  return `
  query OrdersReport($query: String!, $cursor: String) {
    orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        name
        createdAt
        sourceName
        tags
        displayFinancialStatus
        displayFulfillmentStatus
        customerJourneySummary {
          lastVisit {
            landingPage
            referrerUrl
            referralCode
          }
        }
        shippingAddress {
          countryCodeV2
          country
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        shippingLine {
          title
          discountedPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
        lineItems(first: 100) {
          nodes {
            name
            ${variantFields}
            sku
            quantity
            discountedUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            totalDiscountSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }`;
}

await mkdir(dataDir, { recursive: true });

for (const range of ranges) {
  const orders = await fetchOrders(range.query);
  const payload = {
    generated_at: new Date().toISOString(),
    period: range.label,
    date_from: range.from,
    date_to_exclusive: range.to,
    warnings: queryWarnings,
    totals: summarizeOrders(orders),
    orders,
  };

  await writeJson(path.join(dataDir, range.file), payload);
  console.log(`${range.file}: ${orders.length} orders, revenue EUR ${payload.totals.total_order_amount.toFixed(2)}`);
}

async function fetchOrders(searchQuery) {
  try {
    return await fetchOrdersWithQuery(searchQuery, ordersQuery);
  } catch (error) {
    if (!isVariantScopeError(error)) throw error;
    const warning = "Shopify read_products scope is missing; orders were imported without variant_id/barcode. Product cost matching will use SKU/EAN/product name fallback.";
    if (!queryWarnings.includes(warning)) queryWarnings.push(warning);
    return fetchOrdersWithQuery(searchQuery, ordersQueryWithoutVariants);
  }
}

async function fetchOrdersWithQuery(searchQuery, query) {
  const orders = [];
  let cursor = null;

  do {
    const response = await shopifyGraphql(query, {
      query: searchQuery,
      cursor,
    });

    const connection = response.data?.orders;
    if (!connection) {
      throw new Error(`Unexpected Shopify response: ${JSON.stringify(response)}`);
    }

    orders.push(...connection.nodes.map(normalizeOrder));
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return orders;
}

function isVariantScopeError(error) {
  return String(error?.message || error).includes("Access denied for variant field")
    && String(error?.message || error).includes("read_products");
}

async function shopifyGraphql(query, variables) {
  const response = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`Shopify request failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function normalizeOrder(order) {
  const totalOrderAmount = moneyAmount(order.totalPriceSet);
  const orderDiscount = moneyAmount(order.totalDiscountsSet);
  const shippingPaid = moneyAmount(order.shippingLine?.discountedPriceSet);
  const currency = moneyCurrency(order.totalPriceSet);
  const lastVisit = order.customerJourneySummary?.lastVisit || {};

  return {
    order_number: order.name,
    date: order.createdAt,
    channel_source: order.sourceName || null,
    customer_country_code: order.shippingAddress?.countryCodeV2 || null,
    customer_country: order.shippingAddress?.country || null,
    shipping_paid_by_customer: shippingPaid,
    shipping_title: order.shippingLine?.title || null,
    discount: orderDiscount,
    total_order_amount: totalOrderAmount,
    currency,
    payment_status: order.displayFinancialStatus,
    fulfillment_status: order.displayFulfillmentStatus,
    tags: order.tags || [],
    landing_site: lastVisit.landingPage || null,
    referring_site: lastVisit.referrerUrl || null,
    referral_code: lastVisit.referralCode || null,
    line_items: (order.lineItems?.nodes || []).map((item) => ({
      product_name: item.name,
      variant_id: numericId(item.variant?.id),
      variant_gid: item.variant?.id || null,
      sku: item.sku || null,
      barcode: item.variant?.barcode || null,
      ean: item.variant?.barcode || null,
      quantity: Number(item.quantity || 0),
      product_sale_price: moneyAmount(item.discountedUnitPriceSet),
      original_unit_price: moneyAmount(item.originalUnitPriceSet),
      line_discount: moneyAmount(item.totalDiscountSet),
      currency: moneyCurrency(item.discountedUnitPriceSet) || currency,
    })),
  };
}

function summarizeOrders(orders) {
  const totals = orders.reduce((sum, order) => {
    sum.order_count += 1;
    sum.item_count += order.line_items.reduce((itemSum, item) => itemSum + item.quantity, 0);
    sum.total_order_amount += order.total_order_amount;
    sum.shipping_paid_by_customer += order.shipping_paid_by_customer;
    sum.discount += order.discount;
    return sum;
  }, {
    order_count: 0,
    item_count: 0,
    total_order_amount: 0,
    shipping_paid_by_customer: 0,
    discount: 0,
  });

  totals.total_order_amount = roundMoney(totals.total_order_amount);
  totals.shipping_paid_by_customer = roundMoney(totals.shipping_paid_by_customer);
  totals.discount = roundMoney(totals.discount);
  return totals;
}

function buildRanges() {
  const today = localDateParts(0);
  const tomorrow = localDateParts(1);
  const yesterday = localDateParts(-1);
  const sevenDaysAgo = localDateParts(-6);
  const thirtyDaysAgo = localDateParts(-29);

  return [
    makeRange("daily", "shopify_orders_daily.json", yesterday, today),
    makeRange("last_7_days", "shopify_orders_last_7_days.json", sevenDaysAgo, tomorrow),
    makeRange("last_30_days", "shopify_orders_last_30_days.json", thirtyDaysAgo, tomorrow),
  ];
}

function makeRange(label, file, from, to) {
  return {
    label,
    file,
    from,
    to,
    query: `created_at:>=${from} created_at:<${to}`,
  };
}

function localDateParts(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeShopDomain(value = "") {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
}

function moneyAmount(priceSet) {
  return roundMoney(Number(priceSet?.shopMoney?.amount || 0));
}

function moneyCurrency(priceSet) {
  return priceSet?.shopMoney?.currencyCode || null;
}

function numericId(gid) {
  return String(gid || "").split("/").pop() || null;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
