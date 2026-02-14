#!/usr/bin/env node

// ============================================
// ClaudeScope - Sync Model Pricing
// ============================================
// Fetches Claude model pricing from LiteLLM's community-maintained
// pricing database and upserts into Supabase model_pricing table.
//
// Usage:
//   node scripts/sync-pricing.js              # sync to Supabase
//   node scripts/sync-pricing.js --dry-run    # preview only

const DRY_RUN = process.argv.includes("--dry-run");

const SUPABASE_URL = process.env.CLAUDESCOPE_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.CLAUDESCOPE_SUPABASE_KEY || "";

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// We only care about direct Anthropic Claude models (not bedrock/vertex variants)
// Skip -latest aliases and old naming variants (e.g. claude-4-opus -> claude-opus-4)
function isDirectClaudeModel(key, val) {
  return (
    val.litellm_provider === "anthropic" &&
    key.startsWith("claude-") &&
    val.mode === "chat" &&
    val.input_cost_per_token != null &&
    val.output_cost_per_token != null &&
    !key.endsWith("-latest") &&
    !key.startsWith("claude-4-") &&
    !key.startsWith("claude-3-7-") // alias for claude-sonnet-4
  );
}

// Convert per-token cost to per-1M-tokens cost
function toPerMillion(perToken) {
  if (perToken == null) return 0;
  return Math.round(perToken * 1e6 * 10000) / 10000; // 4 decimal places
}

// Derive a model family from the model key
// e.g. "claude-sonnet-4-20250514" -> "claude-sonnet-4"
//      "claude-3-5-haiku-20241022" -> "claude-3.5-haiku"
function getModelFamily(key) {
  // Remove date suffix like -20250514
  const withoutDate = key.replace(/-\d{8}$/, "");

  // Normalize 3-5 -> 3.5 etc
  return withoutDate.replace(/-(\d)-(\d)/, "-$1.$2");
}

async function fetchPricing() {
  console.log(`Fetching pricing from LiteLLM...\n`);
  const res = await fetch(LITELLM_PRICING_URL);

  if (!res.ok) {
    throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const models = [];

  // Deduplicate by model family — keep the first (usually latest) entry
  const seen = new Set();

  for (const [key, val] of Object.entries(data)) {
    if (!isDirectClaudeModel(key, val)) continue;

    const family = getModelFamily(key);
    if (seen.has(family)) continue;
    seen.add(family);

    models.push({
      model_family: family,
      input_per_m: toPerMillion(val.input_cost_per_token),
      output_per_m: toPerMillion(val.output_cost_per_token),
      cache_read_per_m: toPerMillion(val.cache_read_input_token_cost),
      cache_write_per_m: toPerMillion(val.cache_creation_input_token_cost),
    });
  }

  return models;
}

async function upsertToSupabase(models) {
  for (const model of models) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/model_pricing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(model),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`✗ Failed ${model.model_family}: ${res.status} ${text}`);
    } else {
      console.log(`✓ Upserted: ${model.model_family}`);
    }
  }
}

async function main() {
  const models = await fetchPricing();

  console.log(`Found ${models.length} Claude model families:\n`);

  for (const m of models) {
    console.log(`  ${m.model_family}`);
    console.log(
      `    input: $${m.input_per_m}/M  output: $${m.output_per_m}/M  cache_read: $${m.cache_read_per_m}/M  cache_write: $${m.cache_write_per_m}/M`,
    );
  }

  if (DRY_RUN) {
    console.log("\n(DRY RUN - nothing uploaded)");
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(
      "\nMissing CLAUDESCOPE_SUPABASE_URL or CLAUDESCOPE_SUPABASE_KEY",
    );
    process.exit(1);
  }

  console.log("\nSyncing to Supabase...\n");
  await upsertToSupabase(models);
  console.log("\nDone!");
}

main().catch(console.error);
