import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

const apiVersion = process.env.GOOGLE_ADS_API_VERSION || "v24";
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

const ranges = buildRanges();

await mkdir(dataDir, { recursive: true });

const missingRequired = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missingRequired.length) {
  await writeErrorReports(ranges, {
    errorType: "missing_secret",
    errorMessage: `Missing Google Ads GitHub secret(s): ${missingRequired.join(", ")}`,
  });
} else {
  try {
    const accessToken = await requestAccessToken();
    const accessibleCustomers = await listAccessibleCustomers(accessToken);

    for (const range of ranges) {
      const campaigns = await fetchCampaignReport(accessToken, range.where);
      const payload = {
        generated_at: new Date().toISOString(),
        period: range.label,
        date_from: range.from,
        date_to: range.toInclusive,
        timezone: "Europe/Amsterdam",
        status: "ok",
        data_quality: "complete",
        customer_id: customerId,
        login_customer_id: loginCustomerId,
        accessible_customers: accessibleCustomers.resourceNames || [],
        totals: summarize(campaigns),
        campaigns,
      };

      await writeJson(path.join(dataDir, range.file), payload);
      console.log(`${range.file}: ${campaigns.length} campaigns, cost EUR ${payload.totals.cost_eur.toFixed(2)}`);
    }
  } catch (error) {
    const errorType = classifyImportError(error);
    const errorMessage = safeImportError(error);
    await writeErrorReports(ranges, { errorType, errorMessage });
    console.error(`Google Ads import warning (${errorType}): ${errorMessage}`);
  }
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
    ORDER BY metrics.cost_micros DESC`;

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

function buildRanges() {
  const today = localDateParts(0);
  const yesterday = localDateParts(-1);
  const sevenDaysAgo = localDateParts(-6);
  const thirtyDaysAgo = localDateParts(-29);

  return [
    makeRange("daily", "google_ads_daily.json", yesterday, yesterday),
    makeRange("last_7_days", "google_ads_last_7_days.json", sevenDaysAgo, today),
    makeRange("last_30_days", "google_ads_last_30_days.json", thirtyDaysAgo, today),
  ];
}

function makeRange(label, file, from, toInclusive) {
  return {
    label,
    file,
    from,
    toInclusive,
    where: `segments.date BETWEEN '${from}' AND '${toInclusive}'`,
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

async function writeErrorReports(reportRanges, { errorType, errorMessage }) {
  for (const range of reportRanges) {
    const payload = {
      generated_at: new Date().toISOString(),
      period: range.label,
      date_from: range.from,
      date_to: range.toInclusive,
      timezone: "Europe/Amsterdam",
      status: "error",
      data_quality: "google_ads_unavailable",
      error_type: errorType,
      error_message: errorMessage,
      customer_id: customerId || null,
      login_customer_id: loginCustomerId || null,
      accessible_customers: [],
      totals: emptyTotals(),
      campaigns: [],
    };

    await writeJson(path.join(dataDir, range.file), payload);
    console.log(`${range.file}: Google Ads unavailable (${errorType})`);
  }
}

function emptyTotals() {
  return {
    impressions: 0,
    clicks: 0,
    cost_eur: 0,
    conversions: 0,
    conversion_value: 0,
    roas: null,
    cpc_eur: null,
  };
}

function classifyImportError(error) {
  const message = String(error?.message || error);
  if (message.includes("invalid_grant")) return "oauth_invalid_grant";
  if (message.includes("OAuth refresh failed")) return "oauth_refresh_failed";
  if (message.includes("Google Ads request failed")) return "google_ads_api_error";
  if (message.includes("Accessible customers failed")) return "google_ads_access_error";
  return "google_ads_import_error";
}

function safeImportError(error) {
  const message = String(error?.message || error);
  if (message.includes("invalid_grant")) {
    return "Google Ads OAuth refresh token is invalid or revoked. Update GOOGLE_ADS_REFRESH_TOKEN in GitHub Actions secrets.";
  }
  return message.replace(/[A-Za-z0-9_-]{30,}/g, "[redacted]");
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
