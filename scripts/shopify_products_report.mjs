import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-04";
const shopDomain = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN);
const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

const productsQuery = `
  query ProductVariantsCostReport($cursor: String) {
    productVariants(first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        sku
        barcode
        price
        title
        product {
          id
          title
        }
        inventoryItem {
          unitCost {
            amount
            currencyCode
          }
        }
      }
    }
  }`;

await mkdir(dataDir, { recursive: true });

const payload = await buildPayload();
await writeJson(path.join(dataDir, "shopify_products.json"), payload);

console.log(`shopify_products.json: ${payload.variants.length} variants, ${payload.totals.with_unit_cost} with Cost per item`);

async function buildPayload() {
  const base = {
    generated_at: new Date().toISOString(),
    source: "Shopify Admin GraphQL productVariants.inventoryItem.unitCost",
    required_scopes: ["read_products", "read_inventory"],
    status: "ok",
    warnings: [],
    totals: {
      variants: 0,
      with_unit_cost: 0,
      missing_unit_cost: 0,
    },
    variants: [],
  };

  if (!shopDomain || !accessToken) {
    return {
      ...base,
      status: "missing_credentials",
      warnings: ["Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN; Shopify product costs skipped."],
    };
  }

  try {
    const variants = await fetchVariants();
    return {
      ...base,
      totals: summarizeVariants(variants),
      variants,
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      warnings: [`Shopify product cost import failed: ${safeError(error)}`],
    };
  }
}

async function fetchVariants() {
  const variants = [];
  let cursor = null;

  do {
    const response = await shopifyGraphql(productsQuery, { cursor });
    const connection = response.data?.productVariants;
    if (!connection) throw new Error(`Unexpected Shopify response: ${JSON.stringify(response)}`);
    variants.push(...connection.nodes.map(normalizeVariant));
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return variants;
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

function normalizeVariant(variant) {
  const unitCost = variant.inventoryItem?.unitCost || null;
  return {
    product_id: numericId(variant.product?.id),
    variant_id: numericId(variant.id),
    product_gid: variant.product?.id || null,
    variant_gid: variant.id,
    sku: variant.sku || "",
    barcode: variant.barcode || "",
    ean: variant.barcode || "",
    product_title: variant.product?.title || "",
    variant_title: variant.title || "",
    verkoopprijs: money(variant.price),
    unit_cost_amount: unitCost ? money(unitCost.amount) : 0,
    unit_cost_currency_code: unitCost?.currencyCode || null,
    has_unit_cost: Boolean(unitCost && Number(unitCost.amount) > 0),
  };
}

function summarizeVariants(variants) {
  const withUnitCost = variants.filter((variant) => variant.has_unit_cost).length;
  return {
    variants: variants.length,
    with_unit_cost: withUnitCost,
    missing_unit_cost: variants.length - withUnitCost,
  };
}

function numericId(gid) {
  return String(gid || "").split("/").pop() || null;
}

function normalizeShopDomain(value = "") {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function safeError(error) {
  const message = String(error?.message || error).replace(accessToken || "NO_TOKEN", "[redacted]");
  if (message.includes("Access denied for productVariants field")) {
    return "Access denied for productVariants field. Add Shopify Admin API scopes read_products and read_inventory, reinstall the custom app, and update SHOPIFY_ADMIN_ACCESS_TOKEN in GitHub Secrets.";
  }
  if (message.includes("Access denied") && message.includes("unitCost")) {
    return "Access denied for inventoryItem.unitCost. Add Shopify Admin API scope read_inventory, reinstall the custom app, and update SHOPIFY_ADMIN_ACCESS_TOKEN in GitHub Secrets.";
  }
  return message;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
