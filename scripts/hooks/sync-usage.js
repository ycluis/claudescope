#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";

const DRY_RUN = process.argv.includes("--dry-run");

// ---- Configuration ----
const CONFIG = {
  SUPABASE_URL: process.env.CLAUDESCOPE_SUPABASE_URL || "",
  SUPABASE_SERVICE_KEY: process.env.CLAUDESCOPE_SUPABASE_KEY || "",
  MACHINE_ID: process.env.CLAUDESCOPE_MACHINE_ID || "",
};

// ---- Pricing Table (USD per 1M tokens) ----
const PRICING = {
  "claude-opus-4.6": {
    input: 5,
    output: 25,
    cache_read: 0.5,
    cache_write: 6.25,
  },
  "claude-opus-4": {
    input: 15,
    output: 75,
    cache_read: 1.5,
    cache_write: 18.75,
  },
  "claude-sonnet-4": {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75,
  },
  "claude-haiku-4.5": {
    input: 0.8,
    output: 4,
    cache_read: 0.08,
    cache_write: 1,
  },
  default: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
};

function getModelFamily(modelString) {
  if (modelString.includes("opus-4-6")) return "claude-opus-4.6";
  if (modelString.includes("opus")) return "claude-opus-4";
  if (modelString.includes("haiku")) return "claude-haiku-4.5";
  if (modelString.includes("sonnet")) return "claude-sonnet-4";
  return "default";
}

function calculateCost(usage, modelFamily) {
  const p = PRICING[modelFamily] || PRICING.default;

  const normalInput =
    (usage.input_tokens || 0) -
    (usage.cache_read_input_tokens || 0) -
    (usage.cache_creation_input_tokens || 0);

  const cost =
    (Math.max(0, normalInput) / 1e6) * p.input +
    ((usage.cache_creation_input_tokens || 0) / 1e6) * p.cache_write +
    ((usage.cache_read_input_tokens || 0) / 1e6) * p.cache_read +
    ((usage.output_tokens || 0) / 1e6) * p.output;

  return Math.round(cost * 1e6) / 1e6;
}

// ---- Find and parse session files ----

function getClaudeDir() {
  return path.join(os.homedir(), ".claude");
}

function getProjectsDir() {
  return path.join(getClaudeDir(), "projects");
}

function parseSessionFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");

  const requestMap = new Map();
  let sessionStart = null;
  let sessionEnd = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (entry.timestamp) {
        if (!sessionStart) sessionStart = entry.timestamp;
        sessionEnd = entry.timestamp; // always update to latest
      }

      // Path 1: opus 格式 — entry.message.usage + entry.requestId
      if (entry.message?.usage && entry.requestId) {
        requestMap.set(entry.requestId, {
          usage: entry.message.usage,
          model: entry.message.model || "unknown",
        });
      }

      // Path 2: haiku/agent 格式 — entry.data.message.message.usage
      const nested = entry.data?.message?.message;
      const nestedReqId = entry.data?.message?.requestId;
      if (nested?.usage && nestedReqId) {
        requestMap.set(nestedReqId, {
          usage: nested.usage,
          model: nested.model || "unknown",
        });
      }
    } catch {}
  }

  let totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let totalCost = 0;
  let modelCount = {};
  let modelCost = {};

  for (const { usage, model } of requestMap.values()) {
    totalUsage.input_tokens += usage.input_tokens || 0;
    totalUsage.output_tokens += usage.output_tokens || 0;
    totalUsage.cache_creation_input_tokens +=
      usage.cache_creation_input_tokens || 0;
    totalUsage.cache_read_input_tokens += usage.cache_read_input_tokens || 0;

    const family = getModelFamily(model);
    const reqCost = calculateCost(
      {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      },
      family,
    );
    totalCost += reqCost;

    modelCount[family] = (modelCount[family] || 0) + 1;
    modelCost[family] = (modelCost[family] || 0) + reqCost;
  }

  const primaryModel =
    Object.entries(modelCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  return {
    totalUsage,
    totalCost,
    primaryModel,
    modelCount,
    modelCost,
    sessionStart,
    sessionEnd,
  };
}

function extractProjectName(dirPath) {
  const parts = dirPath.split(path.sep);
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx >= 0 && parts.length > projectsIdx + 1) {
    const encoded = parts[projectsIdx + 1];
    try {
      const lastSegment = encoded.split("-").pop() || encoded;
      return lastSegment;
    } catch {
      return encoded;
    }
  }
  return "unknown";
}

// ---- Sync logic ----

async function getAlreadySynced() {
  const ledgerPath = path.join(getClaudeDir(), ".usage-synced.json");
  try {
    return JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
  } catch {
    return {};
  }
}

function markSynced(sessionId) {
  const ledgerPath = path.join(getClaudeDir(), ".usage-synced.json");
  const synced = (() => {
    try {
      return JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
    } catch {
      return {};
    }
  })();
  synced[sessionId] = Date.now();
  fs.writeFileSync(ledgerPath, JSON.stringify(synced, null, 2));
}

async function uploadRecord(record) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/usage_records`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CONFIG.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${CONFIG.SUPABASE_SERVICE_KEY}`,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(record),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: ${res.status} ${text}`);
  }
}

async function syncAll() {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) {
    console.log("No projects directory found.");
    return;
  }

  const synced = await getAlreadySynced();
  let uploaded = 0;
  let skipped = 0;
  let grandTotal = 0;

  const projectDirs = fs.readdirSync(projectsDir);

  for (const projectDir of projectDirs) {
    const fullProjectDir = path.join(projectsDir, projectDir);
    if (!fs.statSync(fullProjectDir).isDirectory()) continue;

    const files = fs
      .readdirSync(fullProjectDir)
      .filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const sessionId = path.basename(file, ".jsonl");

      if (synced[sessionId]) {
        skipped++;
        continue;
      }

      const filePath = path.join(fullProjectDir, file);

      const stat = fs.statSync(filePath);

      const {
        totalUsage,
        totalCost,
        primaryModel,
        modelCount,
        modelCost,
        sessionStart,
        sessionEnd,
      } = parseSessionFile(filePath);

      if (totalUsage.input_tokens === 0 && totalUsage.output_tokens === 0) {
        if (!DRY_RUN) markSynced(sessionId);
        skipped++;
        continue;
      }

      const cost = totalCost;
      const project = extractProjectName(fullProjectDir);
      grandTotal += cost;

      const record = {
        machine_id: CONFIG.MACHINE_ID,
        session_id: sessionId,
        model: primaryModel || "unknown",
        project_slug: project,
        input_tokens: totalUsage.input_tokens,
        output_tokens: totalUsage.output_tokens,
        cache_write_tokens: totalUsage.cache_creation_input_tokens,
        cache_read_tokens: totalUsage.cache_read_input_tokens,
        cost_usd: cost,
        session_start: sessionStart || stat.birthtime.toISOString(),
        session_end: sessionEnd || stat.mtime.toISOString(),
      };

      if (DRY_RUN) {
        uploaded++;
        console.log(`── ${project} ── ${sessionId.slice(0, 8)}...`);
        console.log(
          `   input:  ${totalUsage.input_tokens.toLocaleString()}  output: ${totalUsage.output_tokens.toLocaleString()}`,
        );
        console.log(
          `   cache_read: ${totalUsage.cache_read_input_tokens.toLocaleString()}  cache_write: ${totalUsage.cache_creation_input_tokens.toLocaleString()}`,
        );

        // Per-model breakdown
        for (const [family, count] of Object.entries(modelCount)) {
          const familyCost = modelCost[family] || 0;
          console.log(
            `   ${family}: ${count} reqs → $${familyCost.toFixed(4)}`,
          );
        }

        console.log(`   total:  $${cost.toFixed(4)}`);
        console.log();
      } else {
        try {
          await uploadRecord(record);
          markSynced(sessionId);
          uploaded++;
          console.log(
            `✓ Synced: ${sessionId} (${project}) $${cost.toFixed(4)}`,
          );
        } catch (err) {
          console.error(`✗ Failed: ${sessionId}:`, err.message);
        }
      }
    }
  }

  console.log(`\n${"─".repeat(40)}`);
  console.log(
    `Total: ${uploaded} processed, ${skipped} skipped, $${grandTotal.toFixed(2)}`,
  );
  if (DRY_RUN) console.log("(DRY RUN - nothing uploaded)");
}

// ---- Main ----
if (DRY_RUN) {
  console.log("🔍 DRY RUN MODE - no data will be uploaded\n");
  if (!CONFIG.MACHINE_ID) CONFIG.MACHINE_ID = "dry-run";
} else if (
  !CONFIG.SUPABASE_URL ||
  !CONFIG.SUPABASE_SERVICE_KEY ||
  !CONFIG.MACHINE_ID
) {
  console.error(
    "Missing config. Set SUPABASE_URL, SUPABASE_SERVICE_KEY, MACHINE_ID",
  );
  console.error("Either via environment variables or edit the CONFIG object.");
  process.exit(1);
}

syncAll().catch(console.error);
