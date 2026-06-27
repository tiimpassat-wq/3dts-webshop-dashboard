import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

const apiVersion = process.env.GOOGLE_ADS_API_VERSION || "v21";
const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const customerId = cleanCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID);
const loginCustomerId = cleanCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);

const required = {
  GOOGLE_ADS_DEVELOPER_TOKEN: developerToken,
  GOOGLE_ADS_CLIENT_ID: clientId,
  GOOGLE_ADS_CLIENT_SECRET: clientSecret,
  GOOGLE_ADS_REFRESH_TOKEN: refreshToken,
  GOOGLE_ADS_CUSTOMER_ID: customerId,
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: loginCustomerId,
};

for (const [name, value] of Object.entries(required)) {
  if (!value) throw new Error(`Missing ${name}`);
}

const ranges = [
  { label: "daily", file: "google_ads_daily.json", where: "segments.date DURING YESTERDAY" },
  { label: "last_7_days", file: "google_ads_last_7_days.json", where: "segments.date DURING LAST_7_DAYS" },
  { label: "last_30_days", file: "google_ads_last_30_days.json", where: "segments.date DURING LAST_30_DAYS" },
];

await mkdir(dataDir, { recursive: true });

const accessToken = await requestAccessToken();
const accessibleCustomers = await listAccessibleCustomers(accessToken);

for (const range of ranges) {
  const campaigns = await fetchCampaignReport(accessToken, range.where);
  const payload = {
    generated_at: new Date().toISOString(),
    period: range.label,
    customer_id: customerId,
    login_customer_id: loginCustomerId,
    accessible_customers: accessibleCustomers.resourceNames || [],
    totals: summarize(campaigns),
    campaigns,
  };

  await writeJson(path.join(dataDir, range.file), payload);
  console.log(`${range.file}: ${campaigns.length} campaigns, cost EUR ${payload.totals.cost_eur.toFixed(2)}`);
}

function cleanCustomerId(value = "") {
  return String(value).replaceAll("-", "").trim();
}

async function requestAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`OAuth refresh failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

async function listAccessibleCustomers(accessToken) {
  const response = await fetch(`https://googleads.googleapis.com/${apiVersion}/customers:listAccessibleCustomers`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": developerToken,
    },
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Accessible customers failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function fetchCampaignReport(accessToken, dateWhereClause) {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE ${dateWhereClause}
    ORDER BY metrics.cost_micros DESC
    LIMIT 200`;

  const stream = await googleAdsFetch(accessToken, `customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });

  return rowsFromSearchStream(stream).map((row) => {
    const cost = Number(row.metrics?.costMicros || 0) / 1_000_000;
    const conversionValue = Number(row.metrics?.conversionsValue || 0);
    return {
      id: row.campaign?.id,
      name: row.campaign?.name,
      status: row.campaign?.status,
      impressions: Number(row.metrics?.impressions || 0),
      clicks: Number(row.metrics?.clicks || 0),
      cost_eur: roundMoney(cost),
      conversions: Number(row.metrics?.conversions || 0),
      conversion_value: roundMoney(conversionValue),
      roas: cost > 0 ? roundNumber(conversionValue / cost, 4) : null,
    };
  });
}

async function googleAdsFetch(accessToken, resourcePath, options = {}) {
  const response = await fetch(`https://googleads.googleapis.com/${apiVersion}/${resourcePath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": developerToken,
      "login-customer-id": loginCustomerId,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`Google Ads request failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function rowsFromSearchStream(stream) {
  return Array.isArray(stream) ? stream.flatMap((chunk) => chunk.results || []) : [];
}

function summarize(campaigns) {
  const totals = campaigns.reduce((sum, campaign) => {
    sum.impressions += campaign.impressions;
    sum.clicks += campaign.clicks;
    sum.cost_eur += campaign.cost_eur;
    sum.conversions += campaign.conversions;
    sum.conversion_value += campaign.conversion_value;
    return sum;
  }, { impressions: 0, clicks: 0, cost_eur: 0, conversions: 0, conversion_value: 0 });

  totals.cost_eur = roundMoney(totals.cost_eur);
  totals.conversion_value = roundMoney(totals.conversion_value);
  totals.roas = totals.cost_eur > 0 ? roundNumber(totals.conversion_value / totals.cost_eur, 4) : null;
  totals.cpc_eur = totals.clicks > 0 ? roundMoney(totals.cost_eur / totals.clicks) : null;
  return totals;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundNumber(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

