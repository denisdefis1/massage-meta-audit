/**
 * build-analytics.js
 * Generates data/analytics/ from data/meta/raw/
 * Audit period: AUDIT_START and later (pre-March = different manager, excluded).
 */

// Audit period filter — all insight rows with date_start before this are excluded.
const AUDIT_START = '2026-03-01';
const AUDIT_END   = '2026-08-25';

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, '../data/meta/raw');
const OUT = path.join(__dirname, '../data/analytics');
fs.mkdirSync(OUT, { recursive: true });

// ─── Helpers ────────────────────────────────────────────────────────────────

function load(f) { return JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8')); }
// Filter insight rows to AUDIT_START+ (structural files like campaigns/adsets/ads are not filtered)
function filterInsights(rows) {
  return (rows || []).filter(r => (r.date_start || '') >= AUDIT_START);
}
function save(f, data) {
  const fp = path.join(OUT, f);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  console.log(`  ✓ ${f} (${(fs.statSync(fp).size / 1024).toFixed(1)} KB)`);
}
function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }
function pct(n, d) { return d ? r4(n / d) : null; }
function safeDivide(n, d) { return (d && d !== 0) ? r2(n / d) : null; }

function getAction(actions, type) {
  if (!Array.isArray(actions)) return null;
  const a = actions.find(x => x.action_type === type);
  return a ? parseFloat(a.value) : null;
}
function sumAction(actions, type) {
  const v = getAction(actions, type);
  return v || 0;
}
function getOutbound(row) {
  if (!row.outbound_clicks) return null;
  const arr = Array.isArray(row.outbound_clicks) ? row.outbound_clicks : [];
  return arr.reduce((s, x) => s + parseFloat(x.value || 0), 0);
}

// Aggregate multiple insight rows into one metrics object
function aggregate(rows) {
  if (!rows || rows.length === 0) return null;
  let spend = 0, impr = 0, clicks = 0, ilc = 0;
  let reach_max = 0, wfNum = 0, wfDen = 0;
  let outbound = 0, hasOutbound = false;
  let msg_started = 0, msg_reply1 = 0, msg_replied = 0, msg_order = 0, msg_conn = 0;
  let leads = 0, purchases = 0;
  let vviews = 0, vp25 = 0, vp50 = 0, vp75 = 0, vp100 = 0, hasVideo = false;

  rows.forEach(r => {
    const s = parseFloat(r.spend || 0);
    const i = parseInt(r.impressions || 0);
    const c = parseInt(r.clicks || 0);
    spend += s; impr += i; clicks += c;
    ilc += parseInt(r.inline_link_clicks || 0);
    const rc = parseInt(r.reach || 0);
    if (rc > reach_max) reach_max = rc;
    const freq = parseFloat(r.frequency || 0);
    wfNum += freq * i; wfDen += i;
    const ob = getOutbound(r);
    if (ob !== null) { hasOutbound = true; outbound += ob; }
    const acts = r.actions || [];
    msg_started += sumAction(acts, 'onsite_conversion.messaging_conversation_started_7d');
    msg_reply1  += sumAction(acts, 'onsite_conversion.messaging_first_reply');
    msg_replied += sumAction(acts, 'onsite_conversion.messaging_conversation_replied_7d');
    msg_order   += sumAction(acts, 'onsite_conversion.messaging_order_created_v2');
    msg_conn    += sumAction(acts, 'onsite_conversion.total_messaging_connection');
    leads       += sumAction(acts, 'onsite_conversion.lead_grouped');
    purchases   += sumAction(acts, 'onsite_conversion.purchase');
    const vp = r.video_play_actions || [];
    const vv = sumAction(vp, 'video_view');
    if (vv) { hasVideo = true; vviews += vv; }
    const p25 = r.video_p25_watched_actions || [];
    vp25 += sumAction(p25, 'video_view');
    const p50 = r.video_p50_watched_actions || [];
    vp50 += sumAction(p50, 'video_view');
    const p75 = r.video_p75_watched_actions || [];
    vp75 += sumAction(p75, 'video_view');
    const p100 = r.video_p100_watched_actions || [];
    vp100 += sumAction(p100, 'video_view');
  });

  const cpm = impr ? r2(spend / impr * 1000) : null;
  const ctr = impr ? r2(clicks / impr * 100) : null;
  const cpc = clicks ? r2(spend / clicks) : null;
  const freq_avg = wfDen ? r2(wfNum / wfDen) : null;

  return {
    spend: r2(spend),
    impressions: impr,
    clicks,
    inline_link_clicks: ilc,
    outbound_clicks: hasOutbound ? Math.round(outbound) : null,
    reach_max: reach_max || null,
    frequency_avg: freq_avg,
    cpm, ctr, cpc,
    messaging_started: msg_started,
    messaging_first_reply: msg_reply1,
    messaging_replied: msg_replied,
    messaging_order: msg_order,
    messaging_total_connection: msg_conn,
    cost_per_messaging_started: msg_started ? safeDivide(spend, msg_started) : null,
    first_reply_rate: msg_started ? r4(msg_reply1 / msg_started) : null,
    replied_rate: msg_started ? r4(msg_replied / msg_started) : null,
    order_rate: msg_started ? r4(msg_order / msg_started) : null,
    leads: leads || null,
    cost_per_lead: leads ? safeDivide(spend, leads) : null,
    purchases: purchases || null,
    cost_per_purchase: purchases ? safeDivide(spend, purchases) : null,
    video_views: hasVideo ? Math.round(vviews) : null,
    video_p25: vp25 || null, video_p50: vp50 || null,
    video_p75: vp75 || null, video_p100: vp100 || null,
    video_completion_rate: (vviews && vp100) ? r4(vp100 / vviews) : null,
    active_months: rows.length
  };
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── Load RAW ───────────────────────────────────────────────────────────────

console.log('\n📂 Loading RAW data...');
console.log(`   Audit period: ${AUDIT_START} → ${AUDIT_END}`);
const campaigns   = load('campaigns.json').data;
const adsets      = load('adsets.json').data;
const ads         = load('ads.json').data;
const ci_m        = filterInsights(load('campaign_insights_monthly.json').data);
const ci_d        = filterInsights(load('campaign_insights_daily.json').data);
const asi_m       = filterInsights(load('adset_insights_monthly.json').data);
const ai_m        = filterInsights(load('ad_insights_monthly.json').data);
const bdn_age     = filterInsights(load('breakdown_age_gender.json').data);
const bdn_pl      = filterInsights(load('breakdown_placement.json').data);
const bdn_geo     = filterInsights(load('breakdown_geo.json').data);
const bdn_dev     = filterInsights(load('breakdown_device.json').data);
const msg_raw     = filterInsights(load('messaging_actions.json').data);

// ─── Lookup Maps ─────────────────────────────────────────────────────────────

const campById     = Object.fromEntries(campaigns.map(c => [c.id, c]));
const adsetById    = Object.fromEntries(adsets.map(a => [a.id, a]));

const ci_m_byCamp  = {};
ci_m.forEach(r => { (ci_m_byCamp[r.campaign_id] = ci_m_byCamp[r.campaign_id] || []).push(r); });

const asi_m_byAdset = {};
asi_m.forEach(r => { (asi_m_byAdset[r.adset_id] = asi_m_byAdset[r.adset_id] || []).push(r); });

const ai_m_byAd = {};
ai_m.forEach(r => { (ai_m_byAd[r.ad_id] = ai_m_byAd[r.ad_id] || []).push(r); });

const adsByCamp = {};
ads.forEach(a => { (adsByCamp[a.campaign_id] = adsByCamp[a.campaign_id] || []).push(a); });

const adsByAdset = {};
ads.forEach(a => { (adsByAdset[a.adset_id] = adsByAdset[a.adset_id] || []).push(a); });

const adsetsByCamp = {};
adsets.forEach(a => { (adsetsByCamp[a.campaign_id] = adsetsByCamp[a.campaign_id] || []).push(a); });

// All campaign IDs that have insights (including orphans)
const allCampIdsInInsights = [...new Set(ci_m.map(r => r.campaign_id))];
const campIdsInStructure = new Set(campaigns.map(c => c.id));
const orphanCampIds = new Set(allCampIdsInInsights.filter(id => !campIdsInStructure.has(id)));

// ─── 1. account-kpis.json ────────────────────────────────────────────────────

console.log('\n📊 Building analytics files...');

const acct = aggregate(ci_m);

// Get account-level messaging totals (from messaging_actions.json which has deduped rows)
const msg_totals = {};
msg_raw.forEach(r => {
  (r.actions || []).forEach(a => {
    msg_totals[a.action_type] = (msg_totals[a.action_type] || 0) + parseFloat(a.value || 0);
  });
});

const accountKpis = {
  generated_at: new Date().toISOString(),
  period: { start: AUDIT_START, end: AUDIT_END, note: 'Период с марта 2026. До марта — другой менеджер, другая структура аккаунта. Данные за этот период в аудит не включены.' },
  pre_period_note: 'До марта 2026: другой менеджер (Марк), другая настройка. Исключено из аудита.',
  active_months_count: 6,
  gap_months: [],

  spend: r2(acct.spend),
  impressions: acct.impressions,
  clicks: acct.clicks,
  inline_link_clicks: acct.inline_link_clicks,
  outbound_clicks: acct.outbound_clicks,
  outbound_clicks_note: 'Доступно только для кампаний с целями MESSAGES/SALES (32/84 строки). Null для LINK_CLICKS/ENGAGEMENT.',

  cpm: acct.cpm,
  ctr: acct.ctr,
  cpc: acct.cpc,

  campaigns_total: campaigns.length,
  campaigns_with_spend: allCampIdsInInsights.length,
  campaigns_zero_spend: campaigns.length - (allCampIdsInInsights.length - orphanCampIds.size),
  campaigns_orphan_deleted: orphanCampIds.size,
  adsets_total: adsets.length,
  adsets_with_spend: new Set(asi_m.map(r => r.adset_id)).size,
  ads_total: ads.length,
  ads_with_spend: new Set(ai_m.map(r => r.ad_id)).size,

  // PRIMARY KPI: messaging_conversation_started_7d (deduplication rule: use only this)
  messaging_total_connection: msg_totals['onsite_conversion.total_messaging_connection'] || 0,
  messaging_started: msg_totals['onsite_conversion.messaging_conversation_started_7d'] || 0,
  messaging_first_reply: msg_totals['onsite_conversion.messaging_first_reply'] || 0,
  messaging_replied: msg_totals['onsite_conversion.messaging_conversation_replied_7d'] || 0,
  messaging_order: msg_totals['onsite_conversion.messaging_order_created_v2'] || 0,
  cost_per_conversation: null, // computed below
  first_reply_rate: null,
  replied_rate: null,
  order_rate: null,

  leads: null, // 7 events (onsite_conversion.lead_grouped) - too few for reliable conclusions
  leads_note: '7 событий лидов. Недостаточно для надёжного анализа.',
  purchases: null, // 6 events
  purchases_note: '6 событий покупок. Недостаточно для расчёта ROAS.',
  roas_note: 'ROAS недоступен: данные о выручке отсутствуют в экспорте API.',

  reach_note: 'Охват на уровне аккаунта не суммируется по кампаниям (не дедуплицирован). Охват по каждой кампании показан отдельно.',
  frequency_note: 'Частота на уровне аккаунта не вычисляется без дедуплицированного охвата.',
  quality_rankings_note: 'Рейтинги качества/вовлечённости/конверсии = UNKNOWN для всех сущностей (данные старше 35 дней).',
};

const msg_started = accountKpis.messaging_started;
accountKpis.cost_per_conversation = msg_started ? safeDivide(accountKpis.spend, msg_started) : null;
accountKpis.first_reply_rate      = msg_started ? r4(accountKpis.messaging_first_reply / msg_started) : null;
accountKpis.replied_rate          = msg_started ? r4(accountKpis.messaging_replied / msg_started) : null;
accountKpis.order_rate            = msg_started ? r4(accountKpis.messaging_order / msg_started) : null;

save('account-kpis.json', accountKpis);

// ─── 2. monthly-performance.json ─────────────────────────────────────────────

// Aggregate daily insights by month for account-level monthly view
const monthlyMap = {};
ci_d.forEach(r => {
  const mo = r.date_start.slice(0, 7);
  if (!monthlyMap[mo]) monthlyMap[mo] = { days: new Set(), rows: [] };
  monthlyMap[mo].days.add(r.date_start);
  monthlyMap[mo].rows.push(r);
});

// Generate month sequence March 2026 → Aug 2026
const allMonths = [];
let cur = new Date(Date.UTC(2026, 2, 1)); // March 2026
const end = new Date(Date.UTC(2026, 7, 31));
while (cur <= end) {
  const mo = cur.toISOString().slice(0, 7);
  allMonths.push(mo);
  cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
}

const gapMonths = new Set();
const partialMonths = {
  '2026-08': 'Текущий месяц на дату экспорта (25 авг 2026).'
};

const monthsOutput = [];
let prevMonth = null;

for (const mo of allMonths) {
  if (gapMonths.has(mo)) {
    monthsOutput.push({ month: mo, gap: true, gap_reason: 'Нет расходов — аккаунт неактивен' });
    prevMonth = null;
    continue;
  }

  const data = monthlyMap[mo];
  if (!data) { prevMonth = null; continue; }

  const agg = aggregate(data.rows);
  const activeDays = data.days.size;

  const row = {
    month: mo,
    gap: false,
    partial: !!partialMonths[mo],
    partial_reason: partialMonths[mo] || null,
    active_days: activeDays,
    ...agg,
    // delta vs previous month
    vs_prev_month: prevMonth ? {
      spend_delta_pct: prevMonth.spend ? r2((agg.spend - prevMonth.spend) / prevMonth.spend * 100) : null,
      cpm_delta_pct:   prevMonth.cpm   ? r2((agg.cpm   - prevMonth.cpm)   / prevMonth.cpm   * 100) : null,
      ctr_delta_pct:   prevMonth.ctr   ? r2((agg.ctr   - prevMonth.ctr)   / prevMonth.ctr   * 100) : null,
      cpc_delta_pct:   prevMonth.cpc   ? r2((agg.cpc   - prevMonth.cpc)   / prevMonth.cpc   * 100) : null,
      cost_msg_delta_pct: (prevMonth.cost_per_messaging_started && agg.cost_per_messaging_started)
        ? r2((agg.cost_per_messaging_started - prevMonth.cost_per_messaging_started) / prevMonth.cost_per_messaging_started * 100)
        : null,
      messaging_delta: agg.messaging_started - (prevMonth.messaging_started || 0),
    } : null,
    campaigns_active: new Set(data.rows.map(r => r.campaign_id)).size,
  };

  monthsOutput.push(row);
  prevMonth = agg;
}

save('monthly-performance.json', {
  generated_at: new Date().toISOString(),
  period: accountKpis.period,
  gap_months: [...gapMonths],
  partial_months: Object.keys(partialMonths),
  months: monthsOutput,
});

// ─── 3. campaign-performance.json ────────────────────────────────────────────

// Determine efficiency tiers: compute P25/P50/P75 of cost_per_messaging_started
// among MESSAGES objective campaigns that have msg_started > 0
const msgCampCosts = [];

// First pass: build raw campaign data
const allCampIds = new Set([
  ...campaigns.map(c => c.id),
  ...allCampIdsInInsights
]);

const campaignPerf = [];

for (const campId of allCampIds) {
  const struct = campById[campId];
  const rows   = ci_m_byCamp[campId] || [];
  const agg    = aggregate(rows);
  const orphan = orphanCampIds.has(campId);

  const firstRow = rows[0] || {};
  const name     = struct ? struct.name : firstRow.campaign_name || 'Unknown (Deleted)';
  const obj      = struct ? struct.objective : firstRow.objective || null;
  const status   = struct ? struct.status : 'DELETED';
  const effStatus = struct ? struct.effective_status : 'DELETED';

  // Budget info from campaigns.json
  let budgetType = null, budgetValue = null;
  if (struct) {
    if (struct.daily_budget) { budgetType = 'daily'; budgetValue = parseFloat(struct.daily_budget) / 100; }
    else if (struct.lifetime_budget) { budgetType = 'lifetime'; budgetValue = parseFloat(struct.lifetime_budget) / 100; }
    else { budgetType = 'cbo'; budgetValue = null; } // budget managed at campaign level
  }

  // Duration
  let durationDays = null;
  if (struct && struct.start_time && struct.stop_time) {
    durationDays = Math.round((new Date(struct.stop_time) - new Date(struct.start_time)) / 86400000);
  }

  const adsets_count = (adsetsByCamp[campId] || []).length;
  const ads_count    = (adsByCamp[campId] || []).length;

  // Months active
  const activeMonths = rows.map(r => r.date_start.slice(0, 7));

  const camp = {
    campaign_id: campId,
    campaign_name: name,
    objective: obj,
    status, effective_status: effStatus,
    bid_strategy: struct ? (struct.bid_strategy || null) : null,
    budget_type: budgetType,
    budget_value: budgetValue,
    start_time: struct ? (struct.start_time || null) : null,
    stop_time:  struct ? (struct.stop_time  || null) : null,
    duration_days: durationDays,
    orphan,
    has_spend_data: rows.length > 0,
    adsets_count, ads_count,
    active_months: activeMonths,
    ...(agg || {
      spend: 0, impressions: 0, clicks: 0, inline_link_clicks: 0,
      outbound_clicks: null, reach_max: null, frequency_avg: null,
      cpm: null, ctr: null, cpc: null,
      messaging_started: null, messaging_first_reply: null, messaging_replied: null,
      messaging_order: null, messaging_total_connection: null,
      cost_per_messaging_started: null, first_reply_rate: null, replied_rate: null, order_rate: null,
      leads: null, cost_per_lead: null, purchases: null, cost_per_purchase: null,
      video_views: null, video_p25: null, video_p50: null, video_p75: null, video_p100: null,
      video_completion_rate: null, active_months: 0
    }),
    efficiency_tier: null, // computed in second pass
  };

  // Collect for percentile computation
  if (agg && agg.messaging_started > 0 && obj && (obj.includes('MESSAGE') || obj.includes('CONVERSATION') || obj === 'OUTCOME_ENGAGEMENT' || obj === 'OUTCOME_SALES')) {
    msgCampCosts.push({ id: campId, cost: agg.cost_per_messaging_started });
  }

  campaignPerf.push(camp);
}

// Compute percentiles and assign tiers
const msgCosts = msgCampCosts.map(x => x.cost).filter(Boolean);
const p25 = percentile(msgCosts, 25);
const p50 = percentile(msgCosts, 50);
const p75 = percentile(msgCosts, 75);

const MESSAGING_OBJECTIVES = new Set(['MESSAGES', 'OUTCOME_ENGAGEMENT', 'OUTCOME_SALES', 'OUTCOME_LEADS', 'LINK_CLICKS']);

campaignPerf.forEach(c => {
  if (!c.has_spend_data) { c.efficiency_tier = 'no_data'; return; }
  if (c.messaging_started > 0 && c.cost_per_messaging_started) {
    const cost = c.cost_per_messaging_started;
    if (cost <= p25)      c.efficiency_tier = 'best';
    else if (cost <= p50) c.efficiency_tier = 'good';
    else if (cost <= p75) c.efficiency_tier = 'average';
    else                  c.efficiency_tier = 'expensive';
  } else if (c.spend > 0 && (c.messaging_started === 0 || c.messaging_started === null)) {
    // Campaigns with spend but no messaging
    // If objective is MESSAGES → anomaly; for LINK_CLICKS/ENGAGEMENT it's expected
    c.efficiency_tier = 'no_messaging';
  } else {
    c.efficiency_tier = 'no_data';
  }
});

// Sort by spend desc
campaignPerf.sort((a, b) => b.spend - a.spend);

// Validate total spend
const totalCampSpend = campaignPerf.reduce((s, c) => s + (c.spend || 0), 0);

save('campaign-performance.json', {
  generated_at: new Date().toISOString(),
  period: accountKpis.period,
  total_campaigns: campaignPerf.length,
  campaigns_with_spend: campaignPerf.filter(c => c.spend > 0).length,
  total_spend_validation: r2(totalCampSpend),
  messaging_cost_percentiles: { p25: r2(p25), p50: r2(p50), p75: r2(p75) },
  tier_methodology: 'Efficiency tiers based on cost_per_messaging_started percentiles (P25/P50/P75) across all campaigns with messaging_started > 0. Non-messaging objectives evaluated by CTR/CPC.',
  campaigns: campaignPerf,
});

// ─── 4. adset-performance.json ───────────────────────────────────────────────

function summarizeTargeting(t) {
  if (!t) return null;
  const age_min = t.age_min || t.age_range?.min || null;
  const age_max = t.age_max || t.age_range?.max || null;
  const age_range = (age_min && age_max) ? `${age_min}-${age_max}` : null;

  const has_interests = !!(t.flexible_spec && t.flexible_spec.length > 0);
  const has_custom_audience = !!(t.custom_audiences && t.custom_audiences.length > 0);
  const has_lookalike = !!(t.custom_audiences && t.custom_audiences.some(a => (a.name || '').includes('Похожая') || (a.name || '').includes('Lookalike')));

  const is_broad_age = (age_min <= 18 && age_max >= 65);
  const is_advantage_plus = !!(t.targeting_automation && Object.keys(t.targeting_automation).length > 0);

  const geo = (t.geo_locations && t.geo_locations.countries) ? t.geo_locations.countries : null;
  const platforms = t.publisher_platforms || [];
  const ig_positions = t.instagram_positions || [];

  // Gender
  let gender = 'all';
  if (t.genders && t.genders.length === 1) {
    gender = t.genders[0] === 1 ? 'male' : 'female';
  }

  return {
    age_range, age_min, age_max, gender, geo, platforms, ig_positions,
    has_interests, has_custom_audience, has_lookalike, is_advantage_plus,
    is_broad: is_broad_age && !has_interests && !has_custom_audience,
    audience_type: has_lookalike ? 'lookalike' : has_custom_audience ? 'custom' : has_interests ? 'interest' : 'broad',
  };
}

const adsetPerf = adsets.map(a => {
  const rows = asi_m_byAdset[a.id] || [];
  const agg  = aggregate(rows);
  const targeting_summary = summarizeTargeting(a.targeting);

  const attrSpec = (a.attribution_spec || []);
  const attrWindow = attrSpec.map(s => `${s.event_type}_${s.window_days}d`).join(',') || null;
  const isCbo = !a.daily_budget && !a.lifetime_budget;

  const adsInAdset = adsByAdset[a.id] || [];

  return {
    adset_id: a.id,
    adset_name: a.name,
    campaign_id: a.campaign_id,
    status: a.status,
    effective_status: a.effective_status,
    optimization_goal: a.optimization_goal,
    billing_event: a.billing_event,
    destination_type: a.destination_type || null,
    attribution_window: attrWindow,
    budget_type: isCbo ? 'cbo' : a.daily_budget ? 'daily' : 'lifetime',
    budget_value: a.daily_budget ? r2(parseFloat(a.daily_budget) / 100)
                : a.lifetime_budget ? r2(parseFloat(a.lifetime_budget) / 100) : null,
    is_cbo: isCbo,
    is_dynamic_creative: a.is_dynamic_creative || false,
    start_time: a.start_time || null,
    has_spend_data: rows.length > 0,
    ads_count: adsInAdset.length,
    targeting_summary,
    ...(agg || {
      spend: 0, impressions: 0, clicks: 0, inline_link_clicks: 0,
      outbound_clicks: null, reach_max: null, frequency_avg: null,
      cpm: null, ctr: null, cpc: null,
      messaging_started: null, messaging_first_reply: null, messaging_replied: null,
      messaging_order: null, cost_per_messaging_started: null,
      first_reply_rate: null, replied_rate: null, order_rate: null,
      leads: null, cost_per_lead: null, purchases: null, cost_per_purchase: null,
      active_months: 0,
    }),
  };
});

adsetPerf.sort((a, b) => (b.spend || 0) - (a.spend || 0));

save('adset-performance.json', {
  generated_at: new Date().toISOString(),
  period: accountKpis.period,
  total_adsets: adsetPerf.length,
  adsets_with_spend: adsetPerf.filter(a => (a.spend || 0) > 0).length,
  adsets: adsetPerf,
});

// ─── 5. creative-performance.json ────────────────────────────────────────────

// Build creative ID dedup map
const creativeIdCount = {};
ads.forEach(a => {
  const cid = a.creative && a.creative.id;
  if (cid) creativeIdCount[cid] = (creativeIdCount[cid] || 0) + 1;
});

const creativePerf = ads.map(ad => {
  const rows = ai_m_byAd[ad.id] || [];
  const agg  = aggregate(rows);
  const cr   = ad.creative || {};

  // Format inference from insights
  const hasVideo = rows.some(r => r.video_play_actions && r.video_play_actions.length > 0);
  const hasVideoPlay = agg && agg.video_views && agg.video_views > 0;
  const format = hasVideo || hasVideoPlay ? 'video' : 'image';

  const cta_type = cr.call_to_action && cr.call_to_action.type ? cr.call_to_action.type : null;
  const has_body = !!(cr.body && cr.body.trim());
  const has_title = !!(cr.title && cr.title.trim());
  const is_duplicate_creative = cr.id && creativeIdCount[cr.id] > 1;

  // Get campaign name for context
  const campStruct = campById[ad.campaign_id];
  const campName = campStruct ? campStruct.name : null;
  const adsetStruct = adsetById[ad.adset_id];
  const adsetName = adsetStruct ? adsetStruct.name : null;

  return {
    ad_id: ad.id,
    ad_name: ad.name,
    adset_id: ad.adset_id,
    adset_name: adsetName,
    campaign_id: ad.campaign_id,
    campaign_name: campName,
    status: ad.status,
    effective_status: ad.effective_status,
    creative_id: cr.id || null,
    format,
    cta_type,
    has_body, has_title,
    is_duplicate_creative: !!is_duplicate_creative,
    instagram_permalink: cr.instagram_permalink_url || null,
    object_story_id: cr.effective_object_story_id || cr.object_story_id || null,
    has_spend_data: rows.length > 0,
    ...(agg || {
      spend: 0, impressions: 0, clicks: 0, inline_link_clicks: 0,
      outbound_clicks: null, reach_max: null, frequency_avg: null,
      cpm: null, ctr: null, cpc: null,
      messaging_started: null, messaging_first_reply: null, messaging_replied: null,
      messaging_order: null, cost_per_messaging_started: null,
      first_reply_rate: null, replied_rate: null, order_rate: null,
      video_views: null, video_p25: null, video_p50: null, video_p75: null, video_p100: null,
      video_completion_rate: null, active_months: 0,
    }),
    quality_ranking_note: 'UNKNOWN for all ads — data older than 35 days.',
  };
});

creativePerf.sort((a, b) => (b.spend || 0) - (a.spend || 0));

save('creative-performance.json', {
  generated_at: new Date().toISOString(),
  period: accountKpis.period,
  total_ads: creativePerf.length,
  ads_with_spend: creativePerf.filter(a => (a.spend || 0) > 0).length,
  duplicate_creative_ids: Object.entries(creativeIdCount).filter(([, v]) => v > 1).map(([id, count]) => ({ creative_id: id, used_by_count: count })),
  quality_rankings_unavailable: true,
  ads: creativePerf,
});

// ─── 6. targeting-analysis.json ──────────────────────────────────────────────

// Age/gender breakdown aggregation
const ageGenderMap = {};
bdn_age.forEach(r => {
  const key = `${r.age}__${r.gender}`;
  if (!ageGenderMap[key]) ageGenderMap[key] = { age: r.age, gender: r.gender, rows: [] };
  ageGenderMap[key].rows.push(r);
});

const ageGenderPerf = Object.values(ageGenderMap).map(g => {
  const agg = aggregate(g.rows);
  return { age: g.age, gender: g.gender, months_data: g.rows.length, ...agg };
}).sort((a, b) => (b.spend || 0) - (a.spend || 0));

// Targeting pattern analysis from adsets
const patterns = {
  broad:    adsets.filter(a => {
    const t = a.targeting;
    if (!t) return false;
    const age_min = t.age_min || 0, age_max = t.age_max || 0;
    return age_min <= 18 && age_max >= 65 && !t.flexible_spec && !(t.custom_audiences && t.custom_audiences.length);
  }).length,
  narrow_age: adsets.filter(a => {
    const t = a.targeting;
    if (!t) return false;
    const range = (t.age_max || 65) - (t.age_min || 18);
    return range < 35;
  }).length,
  interest_based: adsets.filter(a => a.targeting && a.targeting.flexible_spec && a.targeting.flexible_spec.length > 0).length,
  custom_audience: adsets.filter(a => a.targeting && a.targeting.custom_audiences && a.targeting.custom_audiences.length > 0).length,
  lookalike: adsets.filter(a => a.targeting && a.targeting.custom_audiences && a.targeting.custom_audiences.some(c => (c.name||'').includes('Похожая') || (c.name||'').includes('Lookalike'))).length,
  advantage_plus: adsets.filter(a => a.targeting && a.targeting.targeting_automation && Object.keys(a.targeting.targeting_automation).length > 0).length,
};

// Attribution window distribution
const attrWindows = {};
adsets.forEach(a => {
  (a.attribution_spec || []).forEach(s => {
    const key = `${s.event_type}_${s.window_days}d`;
    attrWindows[key] = (attrWindows[key] || 0) + 1;
  });
});

// Destination type distribution
const destTypes = {};
adsets.forEach(a => {
  const d = a.destination_type || 'UNDEFINED';
  destTypes[d] = (destTypes[d] || 0) + 1;
});

// Optimization goal distribution
const optGoals = {};
adsets.forEach(a => {
  const g = a.optimization_goal || 'UNKNOWN';
  optGoals[g] = (optGoals[g] || 0) + 1;
});

// Publisher platforms
const pubPlatforms = {};
adsets.forEach(a => {
  (a.targeting && a.targeting.publisher_platforms || []).forEach(p => {
    pubPlatforms[p] = (pubPlatforms[p] || 0) + 1;
  });
});

save('targeting-analysis.json', {
  generated_at: new Date().toISOString(),
  period: accountKpis.period,
  adset_totals: adsets.length,
  audience_patterns: patterns,
  attribution_windows: attrWindows,
  destination_types: destTypes,
  optimization_goals: optGoals,
  publisher_platforms: pubPlatforms,
  age_gender_performance: {
    methodology: 'Aggregated from breakdown_age_gender.json. Messaging actions included where available (privacy threshold may hide small segments).',
    privacy_threshold_note: 'Segments with 0 messaging may reflect Meta privacy threshold, not actual zero performance.',
    data: ageGenderPerf,
  },
  recommendations_note: 'Use "associated with" language — correlation, not causation. A/B test required to confirm targeting effects.',
});

// ─── 7. breakdown-analysis.json ──────────────────────────────────────────────

function aggregateBreakdown(rows, groupKey) {
  const map = {};
  rows.forEach(r => {
    const keys = Array.isArray(groupKey) ? groupKey.map(k => r[k]).join(' / ') : r[groupKey];
    if (!map[keys]) map[keys] = { label: keys, rows: [] };
    map[keys].rows.push(r);
  });
  return Object.values(map).map(g => {
    const agg = aggregate(g.rows);
    const spend = agg ? agg.spend : 0;
    return {
      ...( Array.isArray(groupKey)
        ? Object.fromEntries(groupKey.map(k => [k, g.rows[0][k]]))
        : { [groupKey]: g.rows[0][groupKey] } ),
      months_data: g.rows.length,
      ...agg,
    };
  }).sort((a, b) => (b.spend || 0) - (a.spend || 0));
}

const totalSpendForShare = accountKpis.spend;

function addSpendShare(arr) {
  arr.forEach(r => {
    r.spend_share_pct = totalSpendForShare ? r2(r.spend / totalSpendForShare * 100) : null;
  });
  return arr;
}

const byPlacement = addSpendShare(aggregateBreakdown(bdn_pl, ['publisher_platform', 'platform_position']));
const byDevice    = addSpendShare(aggregateBreakdown(bdn_dev, 'impression_device'));
const byCountry   = addSpendShare(aggregateBreakdown(bdn_geo, 'country'));

save('breakdown-analysis.json', {
  generated_at: new Date().toISOString(),
  period: accountKpis.period,
  by_placement: {
    note: 'Outbound clicks and messaging not available in breakdown files. Actions include messaging events where delivered.',
    data: byPlacement,
  },
  by_device: {
    note: 'Messaging per device not directly available from breakdown_device. Spend/CTR/CPC shown.',
    data: byDevice,
  },
  by_country: {
    note: 'GE = Georgia (100% of effective spend). AZ = Azerbaijan (trace). unknown = unresolved.',
    data: byCountry,
  },
  by_age_gender: {
    note: 'See targeting-analysis.json for detailed age/gender breakdown.',
    summary: ageGenderPerf.slice(0, 20),
  },
});

// ─── 8. messaging-funnel.json ─────────────────────────────────────────────────

// Per-campaign messaging aggregation
const msgByCamp = {};
msg_raw.forEach(r => {
  if (!msgByCamp[r.campaign_id]) {
    msgByCamp[r.campaign_id] = {
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      objective: r.objective,
      spend: 0, impressions: 0, months: [],
      messaging_started: 0, messaging_first_reply: 0,
      messaging_replied: 0, messaging_order: 0, messaging_total_connection: 0,
    };
  }
  const entry = msgByCamp[r.campaign_id];
  entry.spend += parseFloat(r.spend || 0);
  entry.impressions += parseInt(r.impressions || 0);
  entry.months.push(r.date_start.slice(0, 7));
  (r.actions || []).forEach(a => {
    if (a.action_type === 'onsite_conversion.messaging_conversation_started_7d') entry.messaging_started += parseFloat(a.value);
    if (a.action_type === 'onsite_conversion.messaging_first_reply') entry.messaging_first_reply += parseFloat(a.value);
    if (a.action_type === 'onsite_conversion.messaging_conversation_replied_7d') entry.messaging_replied += parseFloat(a.value);
    if (a.action_type === 'onsite_conversion.messaging_order_created_v2') entry.messaging_order += parseFloat(a.value);
    if (a.action_type === 'onsite_conversion.total_messaging_connection') entry.messaging_total_connection += parseFloat(a.value);
  });
});

const campMsgList = Object.values(msgByCamp).map(c => ({
  ...c,
  spend: r2(c.spend),
  active_months_count: [...new Set(c.months)].length,
  cost_per_messaging_started: c.messaging_started ? safeDivide(c.spend, c.messaging_started) : null,
  first_reply_rate: c.messaging_started ? r4(c.messaging_first_reply / c.messaging_started) : null,
  replied_rate: c.messaging_started ? r4(c.messaging_replied / c.messaging_started) : null,
  order_rate: c.messaging_started ? r4(c.messaging_order / c.messaging_started) : null,
})).sort((a, b) => b.messaging_started - a.messaging_started);

// Monthly messaging
const monthlyMsg = {};
msg_raw.forEach(r => {
  const mo = r.date_start.slice(0, 7);
  if (!monthlyMsg[mo]) monthlyMsg[mo] = {
    month: mo, spend: 0, campaigns: new Set(),
    messaging_started: 0, messaging_first_reply: 0, messaging_replied: 0, messaging_order: 0,
  };
  const entry = monthlyMsg[mo];
  entry.spend += parseFloat(r.spend || 0);
  entry.campaigns.add(r.campaign_id);
  (r.actions || []).forEach(a => {
    if (a.action_type === 'onsite_conversion.messaging_conversation_started_7d') entry.messaging_started += parseFloat(a.value);
    if (a.action_type === 'onsite_conversion.messaging_first_reply') entry.messaging_first_reply += parseFloat(a.value);
    if (a.action_type === 'onsite_conversion.messaging_conversation_replied_7d') entry.messaging_replied += parseFloat(a.value);
    if (a.action_type === 'onsite_conversion.messaging_order_created_v2') entry.messaging_order += parseFloat(a.value);
  });
});

const monthlyMsgList = Object.values(monthlyMsg).map(m => ({
  ...m,
  campaigns: m.campaigns.size,
  spend: r2(m.spend),
  cost_per_messaging_started: m.messaging_started ? safeDivide(m.spend, m.messaging_started) : null,
  first_reply_rate: m.messaging_started ? r4(m.messaging_first_reply / m.messaging_started) : null,
  replied_rate: m.messaging_started ? r4(m.messaging_replied / m.messaging_started) : null,
})).sort((a, b) => a.month.localeCompare(b.month));

save('messaging-funnel.json', {
  generated_at: new Date().toISOString(),
  period: accountKpis.period,
  primary_kpi_note: 'Primary KPI: onsite_conversion.messaging_conversation_started_7d. Do NOT sum with total_messaging_connection.',
  attribution_note: '7-day click attribution window for most adsets. Conversations attributed to last click within 7 days.',
  historical_data_note: 'messaging_conversation_started_7d for old campaigns (>7 days ago) may show 0 — attribution window expired, not actual zero.',
  order_reliability_note: 'messaging_order_created_v2 = 6 total. Too few for reliable analysis.',
  account_funnel: {
    total_messaging_connection: msg_totals['onsite_conversion.total_messaging_connection'] || 0,
    messaging_started: accountKpis.messaging_started,
    messaging_first_reply: accountKpis.messaging_first_reply,
    messaging_replied: accountKpis.messaging_replied,
    messaging_order: accountKpis.messaging_order,
    spend: accountKpis.spend,
    cost_per_conversation: accountKpis.cost_per_conversation,
    first_reply_rate: accountKpis.first_reply_rate,
    replied_rate: accountKpis.replied_rate,
    order_rate: accountKpis.order_rate,
  },
  monthly_funnel: monthlyMsgList,
  campaign_funnel: campMsgList,
});

// ─── 9. anomalies.json ───────────────────────────────────────────────────────

const anomalies = [];

// Compute campaign-level CPM / CPC for percentile-based thresholds
const campCPMs = campaignPerf.filter(c => c.cpm && c.spend > 20).map(c => c.cpm);
const campCPCs = campaignPerf.filter(c => c.cpc && c.spend > 20).map(c => c.cpc);
const medCPM  = percentile(campCPMs, 50);
const medCPC  = percentile(campCPCs, 50);
const thrCPM  = medCPM ? r2(medCPM * 2) : null;
const thrCPC  = medCPC ? r2(medCPC * 2.5) : null;

// A1: High spend, no messaging result — for MESSAGES-objective campaigns
const highSpendNoMsg = campaignPerf.filter(c =>
  c.spend > 50 &&
  (c.objective === 'MESSAGES' || c.objective === 'OUTCOME_LEADS') &&
  (c.messaging_started === 0 || c.messaging_started === null)
);
if (highSpendNoMsg.length > 0) {
  anomalies.push({
    id: 'high_spend_no_messaging',
    severity: 'critical',
    title: 'Высокие расходы без результатов в диалогах',
    explanation: 'Кампании с целью MESSAGES/OUTCOME_LEADS потратили >$50, но сгенерировали 0 диалогов. Возможные причины: проблемы с трекингом, неверный адрес назначения или несоответствие аудитории.',
    methodology: 'Порог: расходы > $50 И цель = MESSAGES/LEADS И messaging_started = 0.',
    affected_campaigns: highSpendNoMsg.map(c => ({ id: c.campaign_id, name: c.campaign_name, spend: c.spend, objective: c.objective })),
    count: highSpendNoMsg.length,
  });
}

// A2: Budget concentration
const topN = 5;
const sortedBySpend = campaignPerf.filter(c => c.spend > 0).sort((a, b) => b.spend - a.spend);
const top5Spend = sortedBySpend.slice(0, topN).reduce((s, c) => s + c.spend, 0);
const top5Pct = r2(top5Spend / accountKpis.spend * 100);
if (top5Pct > 50) {
  anomalies.push({
    id: 'budget_concentration',
    severity: 'warning',
    title: 'Концентрация бюджета в топ-кампаниях',
    explanation: `Топ-${topN} кампании составляют ${top5Pct}% от общих расходов. Высокая концентрация увеличивает риск при снижении эффективности топ-кампаний.`,
    methodology: `Порог: топ-${topN} кампании > 50% общих расходов.`,
    top_campaigns: sortedBySpend.slice(0, topN).map(c => ({ name: c.campaign_name, spend: c.spend, pct: r2(c.spend / accountKpis.spend * 100) })),
    top5_spend_pct: top5Pct,
  });
}

// A3: Campaign fragmentation — many tiny campaigns
const tinyThreshold = 10;
const tinyCampaigns = campaignPerf.filter(c => c.spend > 0 && c.spend < tinyThreshold);
if (tinyCampaigns.length > 5) {
  anomalies.push({
    id: 'campaign_fragmentation',
    severity: 'warning',
    title: 'Фрагментация кампаний (много кампаний с малыми расходами)',
    explanation: `${tinyCampaigns.length} кампаний потратили менее $${tinyThreshold}. Малые бюджеты ограничивают способность Meta выйти из фазы обучения (~50 конверсий/нед. на адсет).`,
    methodology: `Порог: расходы < $${tinyThreshold} на кампанию.`,
    affected_count: tinyCampaigns.length,
    affected_campaigns: tinyCampaigns.map(c => ({ name: c.campaign_name, spend: c.spend })),
  });
}

// A4: High CPM months
const highCpmMonths = monthsOutput.filter(m => !m.gap && m.cpm && thrCPM && m.cpm > thrCPM);
if (highCpmMonths.length > 0) {
  anomalies.push({
    id: 'high_cpm_periods',
    severity: 'info',
    title: 'Высокий CPM в отдельные периоды',
    explanation: `CPM превысил ${thrCPM} (2× медианы ${r2(medCPM)}) в ${highCpmMonths.length} месяцах. Высокий CPM может указывать на рост конкуренции на аукционе или несоответствие креатива/аудитории.`,
    methodology: `Порог: CPM > 2× медиана CPM по кампаниям ($${r2(medCPM)}).`,
    affected_months: highCpmMonths.map(m => ({ month: m.month, cpm: m.cpm })),
  });
}

// A5: Duplicate creatives
const duplicateCreatives = Object.entries(creativeIdCount).filter(([, v]) => v > 1);
if (duplicateCreatives.length > 0) {
  anomalies.push({
    id: 'duplicate_creatives',
    severity: 'info',
    title: 'Дублирующиеся Creative ID в объявлениях',
    explanation: `${duplicateCreatives.length} creative ID используются несколькими объявлениями. Это может быть намеренным (один креатив в разных адсетах), но затрудняет атрибуцию эффективности к конкретному варианту.`,
    methodology: 'Поле creative.id сравнивается по всем объявлениям в ads.json.',
    affected_creatives: duplicateCreatives.map(([id, count]) => ({ creative_id: id, used_by_count: count })),
  });
}

// A6: Broad targeting
const broadAdsets = adsets.filter(a => {
  const t = a.targeting;
  if (!t) return false;
  const age_min = t.age_min || 0, age_max = t.age_max || 0;
  return age_min <= 18 && age_max >= 65 && !t.flexible_spec && !(t.custom_audiences && t.custom_audiences.length);
});
if (broadAdsets.length > 10) {
  anomalies.push({
    id: 'broad_targeting',
    severity: 'info',
    title: 'Большинство адсетов — максимально широкий таргетинг (18-65, без интересов)',
    explanation: `${broadAdsets.length}/${adsets.length} адсетов таргетируют возраст 18-65 без уточнения интересов или аудитории. Advantage+ выигрывает от широкого входа, но это ограничивает тестирование гипотез по аудитории.`,
    methodology: 'Адсеты с age_min ≤ 18, age_max ≥ 65, без flexible_spec, без custom_audiences.',
    count: broadAdsets.length,
    total_adsets: adsets.length,
  });
}

// A7: Attribution window mismatch
const w1d = adsets.filter(a => (a.attribution_spec || []).some(s => s.window_days === 1)).length;
const w7d = adsets.filter(a => (a.attribution_spec || []).some(s => s.window_days === 7)).length;
if (w1d > 0 && w7d > 0) {
  anomalies.push({
    id: 'attribution_window_mismatch',
    severity: 'info',
    title: 'Разные окна атрибуции в адсетах',
    explanation: `${w7d} адсетов используют 7-дневную атрибуцию по клику, ${w1d} — 1-дневную. Сравнение адсетов с разными окнами может давать искажённые результаты — длинные окна завышают отчётные конверсии.`,
    methodology: 'attribution_spec.window_days из adsets.json.',
    w7d_count: w7d, w1d_count: w1d,
  });
}

// A8: Cost/msg spikes in specific months
const acctMedianCostMsg = accountKpis.cost_per_conversation;
const spikeMonths = monthsOutput.filter(m =>
  !m.gap && m.cost_per_messaging_started &&
  acctMedianCostMsg && m.cost_per_messaging_started > acctMedianCostMsg * 2.5
);
if (spikeMonths.length > 0) {
  anomalies.push({
    id: 'cost_per_msg_spikes',
    severity: 'warning',
    title: 'Скачки стоимости диалога в отдельные месяцы',
    explanation: `Стоимость/диалог превысила $${r2(acctMedianCostMsg * 2.5)} (2.5× средней $${acctMedianCostMsg}) в ${spikeMonths.length} месяцах. Вероятно, вызвано кампаниями без цели диалогов или несоответствием аудитории.`,
    methodology: `Порог: стоимость/диалог > 2.5× средней по аккаунту ($${acctMedianCostMsg}).`,
    affected_months: spikeMonths.map(m => ({ month: m.month, cost_per_msg: m.cost_per_messaging_started })),
  });
}

// A9: High frequency months
const highFreqRows = ci_m.filter(r => parseFloat(r.frequency || 0) > 3);
if (highFreqRows.length > 0) {
  anomalies.push({
    id: 'high_frequency',
    severity: 'info',
    title: 'Высокая частота показов в отдельных кампаниях-месяцах',
    explanation: `${highFreqRows.length} строк кампания-месяц показывают частоту > 3 (пользователи видели рекламу >3 раз в месяц). Высокая частота коррелирует с усталостью от рекламы и ростом CPM, хотя причинно-следственная связь требует мониторинга CTR.`,
    methodology: 'Порог: frequency > 3 в одном месячном периоде (из campaign_insights_monthly).',
    affected_count: highFreqRows.length,
    affected: highFreqRows.map(r => ({ campaign: r.campaign_name, month: r.date_start.slice(0, 7), frequency: parseFloat(r.frequency).toFixed(2) })).slice(0, 10),
  });
}

// A10: Orphan deleted campaigns
if (orphanCampIds.size > 0) {
  const orphanSpend = campaignPerf.filter(c => c.orphan).reduce((s, c) => s + c.spend, 0);
  anomalies.push({
    id: 'orphan_deleted_campaigns',
    severity: 'info',
    title: 'Удалённые кампании с историческими расходами',
    explanation: `${orphanCampIds.size} кампании присутствуют в инсайтах, но отсутствуют в campaigns.json (удалены из аккаунта). Их расходы ($${r2(orphanSpend)}) включены в общие суммы, но структурные метаданные (таргетинг, креативы) недоступны.`,
    methodology: 'ID кампаний, присутствующие в campaign_insights_monthly, но отсутствующие в campaigns.json.',
    affected_ids: [...orphanCampIds],
    total_spend: r2(orphanSpend),
  });
}

// A11: Inactive campaigns with allocated budget
const pausedWithBudget = campaigns.filter(c =>
  c.status === 'PAUSED' && (c.daily_budget || c.lifetime_budget) && c.budget_remaining
);
if (pausedWithBudget.length > 10) {
  anomalies.push({
    id: 'inactive_campaigns_with_budget',
    severity: 'info',
    title: 'Большое количество приостановленных кампаний',
    explanation: `${campaigns.filter(c => c.status === 'PAUSED').length}/111 кампаний сейчас на паузе. ${pausedWithBudget.length} имеют оставшийся бюджет. Это создаёт беспорядок в аккаунте и может влиять на сигналы качества кампаний.`,
    methodology: 'status = PAUSED из campaigns.json.',
    paused_count: campaigns.filter(c => c.status === 'PAUSED').length,
    paused_with_budget: pausedWithBudget.length,
  });
}

save('anomalies.json', {
  generated_at: new Date().toISOString(),
  period: accountKpis.period,
  thresholds_used: { cpm_threshold: thrCPM, cpc_threshold: thrCPC, median_cpm: r2(medCPM), median_cpc: r2(medCPC) },
  total_anomalies: anomalies.length,
  by_severity: {
    critical: anomalies.filter(a => a.severity === 'critical').length,
    warning: anomalies.filter(a => a.severity === 'warning').length,
    info: anomalies.filter(a => a.severity === 'info').length,
  },
  anomalies,
});

// ─── 10. recommendations.json ────────────────────────────────────────────────

const recs = [];

// Find best performing months for pattern
const goodMonths = monthlyMsgList.filter(m => m.cost_per_messaging_started && m.cost_per_messaging_started < 3.00 && m.messaging_started > 50);
const bestMonth = goodMonths.sort((a, b) => a.cost_per_messaging_started - b.cost_per_messaging_started)[0];

// Find best campaigns by cost/msg
const bestMsgCamps = campaignPerf.filter(c => c.efficiency_tier === 'best' && c.messaging_started > 10).slice(0, 3);

// Find campaigns to stop
const stopCandidates = campaignPerf.filter(c =>
  c.spend > 50 && (c.messaging_started === 0 || c.messaging_started === null) &&
  (c.objective === 'MESSAGES' || c.objective === 'OUTCOME_LEADS')
);

recs.push({
  priority: 'P1',
  category: 'кампания',
  title: 'Масштабировать лучшие кампании по диалогам',
  evidence: `${bestMsgCamps.length} кампаний достигли стоимости диалога ниже $${r2(p25)} (порог P25). Лучшая кампания: "${bestMsgCamps[0] ? bestMsgCamps[0].campaign_name : 'N/A'}" — $${bestMsgCamps[0] ? bestMsgCamps[0].cost_per_messaging_started : 'N/A'}/диалог.`,
  action: 'Увеличить дневной бюджет кампаний уровня P25 на 20–30%, отслеживая стоимость/диалог. Не масштабировать одновременно кампании уровня "дорогие".',
  expected_impact: 'A — Подтверждено данными: эти кампании уже обеспечивают диалоги ниже среднего по аккаунту.',
  confidence: 'high',
  affected: bestMsgCamps.map(c => ({ id: c.campaign_id, name: c.campaign_name, cost_per_msg: c.cost_per_messaging_started })),
});

if (stopCandidates.length > 0) {
  recs.push({
    priority: 'P1',
    category: 'кампания',
    title: 'Расследовать / приостановить кампании MESSAGES с нулевыми диалогами',
    evidence: `${stopCandidates.length} кампаний с целью MESSAGES потратили >$50, но сгенерировали 0 диалогов. Суммарные расходы: $${r2(stopCandidates.reduce((s, c) => s + c.spend, 0))}.`,
    action: 'Проверить URL назначения, поток сообщений и аудиторию каждой кампании. Если структурных проблем нет — приостановить и перераспределить бюджет на результативные кампании.',
    expected_impact: 'A — Перераспределение расходов от кампаний без результатов напрямую измеримо.',
    confidence: 'high',
    affected: stopCandidates.map(c => ({ id: c.campaign_id, name: c.campaign_name, spend: c.spend })),
  });
}

if (bestMonth) {
  recs.push({
    priority: 'P1',
    category: 'бюджет',
    title: 'Воспроизвести условия лучших месяцев (дек. 2025, фев.–мар. 2026)',
    evidence: `Дек. 2025: $2.20/диалог, ${(monthlyMsgList.find(m => m.month === '2025-12') || {}).messaging_started || 0} диалогов. Фев. 2026: $2.15/диалог. Мар. 2026: $2.32/диалог. Средняя по аккаунту: $${accountKpis.cost_per_conversation}/диалог.`,
    action: 'Проанализировать, какие кампании были активны в дек. 2025 и фев.–мар. 2026. Приоритизировать реактивацию тех структур/аудиторий. Сравнить типы креативов в пиковые месяцы.',
    expected_impact: 'B — Гипотеза: пиковые месяцы показали лучший набор кампаний. Требует анализа на уровне кампаний.',
    confidence: 'medium',
    affected: [{ month: '2025-12', cost_per_msg: 2.20 }, { month: '2026-02', cost_per_msg: 2.15 }],
  });
}

recs.push({
  priority: 'P2',
  category: 'таргетинг',
  title: 'Тест: суженный возрастной таргетинг против широкого (18-65)',
  evidence: `${broadAdsets.length}/${adsets.length} адсетов используют 18-65 без интересов. Разбивка по возрасту/полу показывает вариацию эффективности. Корреляция ≠ причинно-следственная связь — требует A/B теста.`,
  action: 'Провести A/B тест: один и тот же креатив и бюджет, разделённый между 18-65 (контроль) и 25-50 (тест) на минимум 2 недели. Измерить стоимость/диалог.',
  expected_impact: 'B — Гипотеза: крайние возрастные группы могут завышать CPM без вклада в диалоги. Требует тестирования.',
  confidence: 'medium',
  affected: [{ type: 'adset_pattern', count: broadAdsets.length, description: 'broad 18-65 adsets' }],
});

recs.push({
  priority: 'P2',
  category: 'таргетинг',
  title: 'Расширить использование похожих / кастомных аудиторий',
  evidence: `Только ${patterns.lookalike}/${adsets.length} адсетов используют похожие аудитории. Кастомные аудитории — в ${patterns.custom_audience} адсетах. Имеющиеся источники (список телефонов клиентов, взаимодействия в IG) используются недостаточно.`,
  action: 'Создать новые адсеты с похожими аудиториями (GE 1-2% из телефонов клиентов и взаимодействий в IG) в рамках лучших структур кампаний.',
  expected_impact: 'B — Похожие аудитории коррелируют с лучшей конверсией в индустрии, но для данного аккаунта/рынка не тестировались.',
  confidence: 'medium',
  affected: [{ type: 'targeting_pattern', lookalike_count: patterns.lookalike, total: adsets.length }],
});

recs.push({
  priority: 'P2',
  category: 'креатив',
  title: 'Устранить дублирование Creative ID',
  evidence: `${duplicateCreatives.length} creative ID используются 2+ объявлениями. Дублирование делает невозможной атрибуцию эффективности к конкретному варианту креатива.`,
  action: 'Для активных кампаний с дублирующимися креативами создать уникальные копии. Это позволит проводить чистое A/B тестирование и отслеживать усталость от рекламы.',
  expected_impact: 'A — Улучшение качества данных: без влияния на эффективность, но открывает точный анализ креативов.',
  confidence: 'high',
  affected: duplicateCreatives.map(([id, count]) => ({ creative_id: id, used_by: count })),
});

const aprilMayIssue = monthlyMsgList.filter(m => ['2026-04', '2026-05'].includes(m.month));
if (aprilMayIssue.some(m => m.cost_per_messaging_started > 8)) {
  recs.push({
    priority: 'P2',
    category: 'кампания',
    title: 'Расследовать падение эффективности апр.–май 2026',
    evidence: `Апр. 2026: $8.48/диалог (29 диалогов). Май 2026: $13.12/диалог (27 диалогов). После пика янв.–мар. 2026 ($2.15–3.42/диалог, 196–211 диалогов/мес.). Падение коррелирует с изменением набора кампаний — требует расследования.`,
    action: 'Сравнить кампании, активные в янв.–мар. 2026 и апр.–май 2026. Определить, какие приостановлены/изменены. Проверить, не заменены ли кампании MESSAGES кампаниями LINK_CLICKS.',
    expected_impact: 'B — Гипотеза: смена структуры кампаний привела к снижению эффективности. Диагностика необходима до принятия мер.',
    confidence: 'medium',
    affected: aprilMayIssue.map(m => ({ month: m.month, cost_per_msg: m.cost_per_messaging_started, messaging: m.messaging_started })),
  });
}

recs.push({
  priority: 'P3',
  category: 'трекинг',
  title: 'Стандартизировать окна атрибуции по всем адсетам',
  evidence: `${w7d} адсетов — 7-дневный клик, ${w1d} — 1-дневный клик. Смешанные окна делают сравнение кампаний ненадёжным.`,
  action: 'Стандартизировать на 7-дневную атрибуцию по клику, если у кампании нет обоснованной причины для более короткого окна. Задокументировать обоснование для исключений.',
  expected_impact: 'A — Качество данных: единая атрибуция обеспечивает корректное сравнение эффективности.',
  confidence: 'high',
  affected: [{ type: 'attribution', w7d_adsets: w7d, w1d_adsets: w1d }],
});

recs.push({
  priority: 'P3',
  category: 'кампания',
  title: 'Архивировать или объединить микрорасходные кампании',
  evidence: `${tinyCampaigns.length} кампаний с суммарными расходами менее $10. Недостаточно данных для оптимизации (Meta требует ~50 конверсий/нед. для выхода из фазы обучения).`,
  action: 'Приостановить все кампании с расходами менее $10 и без активного бюджета. Объединить схожие комбинации аудитории/креатива в меньшее количество более крупных кампаний.',
  expected_impact: 'A — Снижает фрагментацию аккаунта, улучшает сигналы качества кампаний и упрощает отчётность.',
  confidence: 'high',
  affected: tinyCampaigns.slice(0, 10).map(c => ({ name: c.campaign_name, spend: c.spend })),
});

save('recommendations.json', {
  generated_at: new Date().toISOString(),
  period: accountKpis.period,
  total_recommendations: recs.length,
  by_priority: {
    P1: recs.filter(r => r.priority === 'P1').length,
    P2: recs.filter(r => r.priority === 'P2').length,
    P3: recs.filter(r => r.priority === 'P3').length,
  },
  confidence_methodology: {
    high: 'Directly supported by observed data. Effect is measurable.',
    medium: 'Correlation observed in data. Causation requires A/B testing. Labeled "B — Hypothesis" in expected_impact.',
    low: 'Industry benchmark or general best practice. Labeled "C — Cannot determine from this export".',
  },
  recommendations: recs,
});

// ─── 11. audit-summary.json ───────────────────────────────────────────────────

const bestCamp = campaignPerf.filter(c => c.efficiency_tier === 'best' && c.messaging_started > 5)
  .sort((a, b) => a.cost_per_messaging_started - b.cost_per_messaging_started)[0];

const worstMsgCamp = campaignPerf.filter(c =>
  c.spend > 50 && c.messaging_started > 0 && c.efficiency_tier === 'expensive'
).sort((a, b) => b.cost_per_messaging_started - a.cost_per_messaging_started)[0];

const topPlacement = byPlacement[0];
const topDevice = byDevice[0];
const topAgeGender = ageGenderPerf.filter(g => g.messaging_started > 0)
  .sort((a, b) => (a.cost_per_messaging_started || 999) - (b.cost_per_messaging_started || 999))[0];

save('audit-summary.json', {
  generated_at: new Date().toISOString(),
  account_id: '1734567316918620',
  business: 'Massage Studio, Tbilisi, Georgia',
  audit_period: accountKpis.period,
  primary_kpi: 'messaging_conversation_started_7d (Instagram DM)',

  headline_metrics: {
    total_spend: accountKpis.spend,
    total_conversations: accountKpis.messaging_started,
    cost_per_conversation: accountKpis.cost_per_conversation,
    impressions: accountKpis.impressions,
    ctr: accountKpis.ctr,
    cpc: accountKpis.cpc,
    cpm: accountKpis.cpm,
    first_reply_rate_pct: accountKpis.first_reply_rate ? r2(accountKpis.first_reply_rate * 100) : null,
    replied_rate_pct: accountKpis.replied_rate ? r2(accountKpis.replied_rate * 100) : null,
  },

  campaign_summary: {
    total: campaigns.length,
    with_spend: allCampIdsInInsights.length,
    active: campaigns.filter(c => c.effective_status === 'ACTIVE').length,
    paused: campaigns.filter(c => c.status === 'PAUSED').length,
    deleted_orphan: orphanCampIds.size,
    best_cost_per_msg: bestCamp ? { name: bestCamp.campaign_name, cost: bestCamp.cost_per_messaging_started } : null,
    worst_cost_per_msg: worstMsgCamp ? { name: worstMsgCamp.campaign_name, cost: worstMsgCamp.cost_per_messaging_started } : null,
  },

  messaging_funnel: {
    total_connection: accountKpis.messaging_total_connection,
    started: accountKpis.messaging_started,
    first_reply: accountKpis.messaging_first_reply,
    replied: accountKpis.messaging_replied,
    order: accountKpis.messaging_order,
    cost_per_conv: accountKpis.cost_per_conversation,
  },

  top_placement: topPlacement ? { label: topPlacement.publisher_platform + '/' + topPlacement.platform_position, spend: topPlacement.spend, spend_share_pct: topPlacement.spend_share_pct } : null,
  top_device: topDevice ? { device: topDevice.impression_device, spend: topDevice.spend, spend_share_pct: topDevice.spend_share_pct } : null,
  top_age_gender_segment: topAgeGender ? { age: topAgeGender.age, gender: topAgeGender.gender, cost_per_msg: topAgeGender.cost_per_messaging_started } : null,

  key_anomalies: anomalies.filter(a => a.severity === 'critical' || a.severity === 'warning').map(a => ({
    severity: a.severity, title: a.title, id: a.id,
  })),

  top_recommendations: recs.filter(r => r.priority === 'P1').map(r => ({ priority: r.priority, title: r.title, confidence: r.confidence })),

  data_quality_flags: [
    'Quality/Engagement/Conversion Rankings: UNKNOWN for all entities',
    'ROAS: unavailable (no revenue data)',
    'Purchases (6) and Leads (7): insufficient for statistical analysis',
    'Account-level reach cannot be summed',
    'Deleted campaigns: 4 orphan campaigns with spend but no structural metadata',
    'Missing months: 2025-06, 2025-09 (zero activity confirmed)',
    '2026-08: partial month (21 of 31 days as of export date)',
  ],
});

// ─── Validation ───────────────────────────────────────────────────────────────

console.log('\n✅ Validation:');
console.log(`  Spend: $${r2(totalCampSpend)} (expected: $3933.06, diff: ${r2(Math.abs(totalCampSpend - 3933.06))})`);
const totalImpr = campaignPerf.reduce((s, c) => s + (c.impressions || 0), 0);
console.log(`  Impressions: ${totalImpr.toLocaleString()} (expected: 2,088,638)`);
const totalClicks = campaignPerf.reduce((s, c) => s + (c.clicks || 0), 0);
console.log(`  Clicks: ${totalClicks.toLocaleString()} (expected: 30,872)`);
console.log(`  Conversations: ${accountKpis.messaging_started} (expected: 939)`);
console.log(`  Cost/Conv: $${accountKpis.cost_per_conversation} (expected: ~$4.19)`);
console.log(`  Anomalies: ${anomalies.length} detected`);
console.log(`  Recommendations: ${recs.length} generated\n`);
