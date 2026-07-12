import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const reportsDir = path.join(rootDir, "reports");

const apiVersion = process.env.GOOGLE_ADS_API_VERSION || "v21";
const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const customerId = cleanCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID);
const loginCustomerId = cleanCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);

const dryRun = parseBool(process.env.GOOGLE_ADS_CPC_AUTOPILOT_DRY_RUN, true);
const campaignId = String(process.env.GOOGLE_ADS_CPC_CAMPAIGN_ID || "24026877085").trim();
const campaignName = String(process.env.GOOGLE_ADS_CPC_CAMPAIGN_NAME || "3DTS Beugels Clean Test").trim();
const minCpc = parseEuro(process.env.GOOGLE_ADS_CPC_MIN_EUR, 0.35);
const maxCpc = parseEuro(process.env.GOOGLE_ADS_CPC_MAX_EUR, 1.20);
const firstPageBuffer = parseFloat(process.env.GOOGLE_ADS_CPC_FIRST_PAGE_BUFFER || "1.08");
const roasTarget = parseFloat(process.env.GOOGLE_ADS_CPC_TARGET_ROAS || "2.0");
const noConversionClickLimit = parseInt(process.env.GOOGLE_ADS_CPC_NO_CONVERSION_CLICK_LIMIT || "12", 10);
const noConversionCostLimit = parseEuro(process.env.GOOGLE_ADS_CPC_NO_CONVERSION_COST_LIMIT_EUR, 8);

await mkdir(reportsDir, { recursive: true });

const missingRequired = [
  ["GOOGLE_ADS_DEVELOPER_TOKEN", developerToken],
  ["GOOGLE_ADS_CLIENT_ID", clientId],
  ["GOOGLE_ADS_CLIENT_SECRET", clientSecret],
  ["GOOGLE_ADS_REFRESH_TOKEN", refreshToken],
  ["GOOGLE_ADS_CUSTOMER_ID", customerId],
  ["GOOGLE_ADS_LOGIN_CUSTOMER_ID", loginCustomerId],
].filter(([, value]) => !value).map(([name]) => name);

if (missingRequired.length) {
  await writeReport({
    status: "error",
    dry_run: dryRun,
    error: `Missing Google Ads environment values: ${missingRequired.join(", ")}`,
    recommendations: [],
  });
  process.exitCode = 1;
} else {
  try {
    const accessToken = await requestAccessToken();
    const adGroups = await fetchAdGroups(accessToken);
    const keywordSignals = await fetchKeywordSignals(accessToken);
    const recommendations = buildRecommendations(adGroups, keywordSignals);
    const applied = dryRun ? [] : await applyRecommendations(accessToken, recommendations);

    await writeReport({
      status: "ok",
      generated_at: new Date().toISOString(),
      dry_run: dryRun,
      campaign_id: campaignId,
      campaign_name: campaignName,
      rules: {
        min_cpc_eur: minCpc,
        max_cpc_eur: maxCpc,
        first_page_buffer: firstPageBuffer,
        roas_target: roasTarget,
        no_conversion_click_limit: noConversionClickLimit,
        no_conversion_cost_limit_eur: noConversionCostLimit,
      },
      totals: summarizeRecommendations(recommendations),
      recommendations,
      applied,
    });

    console.log(`Google Ads CPC autopilot ${dryRun ? "dry-run" : "live"}: ${recommendations.length} ad groups checked.`);
    console.log(`Report: reports/google_ads_cpc_autopilot.json`);
  } catch (error) {
    const safeError = String(error?.message || error).replace(/[A-Za-z0-9_-]{30,}/g, "[redacted]");
    await writeReport({
      status: "error",
      generated_at: new Date().toISOString(),
      dry_run: dryRun,
      error: safeError,
      recommendations: [],
    });
    console.error(`Google Ads CPC autopilot failed: ${safeError}`);
    process.exitCode = 1;
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

async function fetchAdGroups(accessToken) {
  const campaignFilter = campaignId
    ? `campaign.id = ${campaignId}`
    : `campaign.name = '${escapeGaql(campaignName)}'`;

  const query = `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group.resource_name,
      ad_group.status,
      ad_group.cpc_bid_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group
    WHERE ${campaignFilter}
      AND campaign.status = ENABLED
      AND ad_group.status = ENABLED
      AND segments.date DURING LAST_7_DAYS
    ORDER BY ad_group.name`;

  const stream = await googleAdsSearch(accessToken, query);
  return rowsFromSearchStream(stream).map((row) => ({
    campaign_id: row.campaign?.id,
    campaign_name: row.campaign?.name,
    id: row.adGroup?.id,
    name: row.adGroup?.name,
    resource_name: row.adGroup?.resourceName,
    status: row.adGroup?.status,
    current_cpc_eur: microsToEuro(row.adGroup?.cpcBidMicros || 0),
    impressions_7d: Number(row.metrics?.impressions || 0),
    clicks_7d: Number(row.metrics?.clicks || 0),
    cost_7d_eur: microsToEuro(row.metrics?.costMicros || 0),
    conversions_7d: Number(row.metrics?.conversions || 0),
    conversion_value_7d_eur: roundMoney(Number(row.metrics?.conversionsValue || 0)),
  }));
}

async function fetchKeywordSignals(accessToken) {
  const campaignFilter = campaignId
    ? `campaign.id = ${campaignId}`
    : `campaign.name = '${escapeGaql(campaignName)}'`;

  const query = `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group_criterion.status,
      ad_group_criterion.keyword.text,
      ad_group_criterion.position_estimates.first_page_cpc_micros,
      ad_group_criterion.position_estimates.top_of_page_cpc_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group_criterion
    WHERE ${campaignFilter}
      AND campaign.status = ENABLED
      AND ad_group.status = ENABLED
      AND ad_group_criterion.status = ENABLED
      AND ad_group_criterion.type = KEYWORD
      AND segments.date DURING LAST_7_DAYS`;

  const stream = await googleAdsSearch(accessToken, query);
  return rowsFromSearchStream(stream).map((row) => ({
    ad_group_id: row.adGroup?.id,
    ad_group_name: row.adGroup?.name,
    keyword: row.adGroupCriterion?.keyword?.text,
    first_page_cpc_eur: microsToEuro(row.adGroupCriterion?.positionEstimates?.firstPageCpcMicros || 0),
    top_of_page_cpc_eur: microsToEuro(row.adGroupCriterion?.positionEstimates?.topOfPageCpcMicros || 0),
    impressions_7d: Number(row.metrics?.impressions || 0),
    clicks_7d: Number(row.metrics?.clicks || 0),
    cost_7d_eur: microsToEuro(row.metrics?.costMicros || 0),
    conversions_7d: Number(row.metrics?.conversions || 0),
    conversion_value_7d_eur: roundMoney(Number(row.metrics?.conversionsValue || 0)),
  }));
}

function buildRecommendations(adGroups, keywordSignals) {
  const signalsByAdGroup = new Map();
  for (const signal of keywordSignals) {
    if (!signalsByAdGroup.has(signal.ad_group_id)) signalsByAdGroup.set(signal.ad_group_id, []);
    signalsByAdGroup.get(signal.ad_group_id).push(signal);
  }

  return adGroups.map((adGroup) => {
    const signals = signalsByAdGroup.get(adGroup.id) || [];
    const firstPageBids = signals.map((item) => item.first_page_cpc_eur).filter((value) => value > 0);
    const topPageBids = signals.map((item) => item.top_of_page_cpc_eur).filter((value) => value > 0);
    const maxFirstPage = firstPageBids.length ? Math.max(...firstPageBids) : null;
    const medianFirstPage = percentile(firstPageBids, 0.5);
    const medianTopPage = percentile(topPageBids, 0.5);
    const current = adGroup.current_cpc_eur;
    const roas = adGroup.cost_7d_eur > 0 ? adGroup.conversion_value_7d_eur / adGroup.cost_7d_eur : null;

    let action = "hold";
    let target = current;
    const reasons = [];

    if (maxFirstPage && current < maxFirstPage) {
      target = clamp(roundMoney((medianFirstPage || maxFirstPage) * firstPageBuffer), minCpc, maxCpc);
      action = target > current ? "increase_to_first_page_range" : "hold";
      reasons.push(`Current CPC EUR ${current.toFixed(2)} is below observed first-page estimates up to EUR ${maxFirstPage.toFixed(2)}.`);
    }

    if (adGroup.clicks_7d >= noConversionClickLimit && adGroup.cost_7d_eur >= noConversionCostLimit && adGroup.conversions_7d === 0) {
      const lowered = clamp(roundMoney(current * 0.85), minCpc, maxCpc);
      if (lowered < target || action === "hold") {
        target = lowered;
        action = "decrease_no_conversions";
        reasons.push(`No conversions after ${adGroup.clicks_7d} clicks and EUR ${adGroup.cost_7d_eur.toFixed(2)} spend in 7 days.`);
      }
    }

    if (roas !== null && adGroup.conversions_7d >= 1 && roas >= roasTarget) {
      const raised = clamp(roundMoney(current * 1.10), minCpc, maxCpc);
      if (raised > target) {
        target = raised;
        action = "increase_profitable";
        reasons.push(`ROAS ${roas.toFixed(2)} is above target ${roasTarget}.`);
      }
    }

    if (target === current) action = "hold";
    if (!reasons.length) reasons.push("Insufficient evidence for a CPC change.");

    return {
      ad_group_id: adGroup.id,
      ad_group_name: adGroup.name,
      resource_name: adGroup.resource_name,
      current_cpc_eur: current,
      recommended_cpc_eur: target,
      change_eur: roundMoney(target - current),
      action,
      confidence: confidenceFor(action, adGroup, signals),
      signals: {
        keywords_checked: signals.length,
        median_first_page_cpc_eur: medianFirstPage,
        max_first_page_cpc_eur: maxFirstPage,
        median_top_of_page_cpc_eur: medianTopPage,
        clicks_7d: adGroup.clicks_7d,
        cost_7d_eur: adGroup.cost_7d_eur,
        conversions_7d: adGroup.conversions_7d,
        conversion_value_7d_eur: adGroup.conversion_value_7d_eur,
        roas_7d: roas === null ? null : roundNumber(roas, 4),
      },
      reasons,
    };
  });
}

async function applyRecommendations(accessToken, recommendations) {
  const operations = recommendations
    .filter((item) => item.action !== "hold" && item.recommended_cpc_eur !== item.current_cpc_eur)
    .map((item) => ({
      update: {
        resourceName: item.resource_name,
        cpcBidMicros: euroToMicros(item.recommended_cpc_eur),
      },
      updateMask: "cpc_bid_micros",
    }));

  if (!operations.length) return [];

  const body = await googleAdsFetch(accessToken, `customers/${customerId}/adGroups:mutate`, {
    method: "POST",
    body: JSON.stringify({ operations, partialFailure: false }),
  });

  return (body.results || []).map((result, index) => ({
    resource_name: result.resourceName,
    requested_change: operations[index]?.update || null,
  }));
}

async function googleAdsSearch(accessToken, query) {
  return googleAdsFetch(accessToken, `customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    body: JSON.stringify({ query }),
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

async function writeReport(payload) {
  await writeFile(path.join(reportsDir, "google_ads_cpc_autopilot.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(path.join(reportsDir, "google_ads_cpc_autopilot.md"), renderMarkdown(payload), "utf8");
}

function renderMarkdown(payload) {
  const lines = [
    "# Google Ads CPC Autopilot",
    "",
    `Status: ${payload.status}`,
    `Dry-run: ${payload.dry_run}`,
  ];

  if (payload.error) {
    lines.push("", `Error: ${payload.error}`);
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `Campaign: ${payload.campaign_name} (${payload.campaign_id})`,
    "",
    "## Rules",
    "",
    `- Min CPC: EUR ${payload.rules.min_cpc_eur.toFixed(2)}`,
    `- Max CPC: EUR ${payload.rules.max_cpc_eur.toFixed(2)}`,
    `- First-page buffer: ${payload.rules.first_page_buffer}`,
    `- ROAS target: ${payload.rules.roas_target}`,
    "",
    "## Recommendations",
    "",
    "| Ad group | Current | Recommended | Action | Reason |",
    "| --- | ---: | ---: | --- | --- |",
  );

  for (const item of payload.recommendations || []) {
    lines.push(`| ${item.ad_group_name} | EUR ${item.current_cpc_eur.toFixed(2)} | EUR ${item.recommended_cpc_eur.toFixed(2)} | ${item.action} | ${item.reasons.join(" ")} |`);
  }

  return `${lines.join("\n")}\n`;
}

function summarizeRecommendations(recommendations) {
  return recommendations.reduce((summary, item) => {
    summary.checked += 1;
    summary[item.action] = (summary[item.action] || 0) + 1;
    return summary;
  }, { checked: 0 });
}

function confidenceFor(action, adGroup, signals) {
  if (action === "hold" && signals.length === 0) return "low";
  if (action === "decrease_no_conversions" && adGroup.clicks_7d >= noConversionClickLimit * 2) return "high";
  if (action === "increase_profitable" && adGroup.conversions_7d >= 2) return "high";
  if (action === "increase_to_first_page_range" && signals.some((item) => item.first_page_cpc_eur > 0)) return "medium";
  return "low";
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return roundMoney(sorted[index]);
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "ja"].includes(String(value).toLowerCase());
}

function parseEuro(value, fallback) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function microsToEuro(value) {
  return roundMoney(Number(value || 0) / 1_000_000);
}

function euroToMicros(value) {
  return Math.round(Number(value || 0) * 1_000_000);
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function roundNumber(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function escapeGaql(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}
