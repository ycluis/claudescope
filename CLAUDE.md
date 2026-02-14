# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClaudeScope tracks Claude Code usage and costs across multiple machines. It reads local Claude Code session data (JSONL files), calculates costs using model pricing, and syncs everything to a Supabase PostgreSQL database.

## Monorepo Structure

npm workspaces monorepo with ES modules (`"type": "module"`). Requires **Node.js 24** (managed via mise.toml).

- `scripts/hooks/sync-usage.js` — Parses Claude Code session JSONL files from `~/.claude/projects/` and `~/.config/claude/projects/`, deduplicates by requestId, calculates costs, and upserts to Supabase. Tracks synced sessions in `~/.claude/.usage-synced.json`.
- `scripts/sync-pricing.js` — Fetches model pricing from LiteLLM's public GitHub data, filters for direct Anthropic Claude models, normalizes naming, and upserts to Supabase `model_pricing` table.
- `supabase/migrations/001_initial_schema.sql` — Full schema: `machines`, `projects`, `model_pricing`, `usage_records` tables with RLS, indexes, triggers, and a `daily_summary` view.
- `apps/web/` — Planned web dashboard (not yet implemented).
- `packages/shared/` — Planned shared utilities (not yet implemented).

## Commands

```bash
npm install                   # Install dependencies
npm run sync:dry              # Preview usage sync (no writes)
npm run sync                  # Sync usage data to Supabase
npm run sync:pricing:dry      # Preview pricing sync (no writes)
npm run sync:pricing          # Sync model pricing to Supabase
npm run dev                   # Start web app dev server (apps/web)
npm run build                 # Build web app (apps/web)
```

## Environment

Copy `.env.example` to `.env` and set:
- `CLAUDESCOPE_SUPABASE_URL` — Supabase project URL
- `CLAUDESCOPE_SUPABASE_KEY` — Supabase service role key (not anon key; needs write access)
- `CLAUDESCOPE_MACHINE_ID` — Identifier for this machine (e.g., `windows-home`)

Scripts load env via Node's `--env-file=.env` flag.

## Key Architecture Details

**Session data parsing** supports two JSONL formats: Opus format (`entry.message.usage` + `entry.requestId`) and Haiku/Agent format (`entry.data.message.message.usage` with nested requestId). Both are handled in `sync-usage.js`.

**Model family detection** maps model ID substrings (e.g., `opus-4-6` → `claude-opus-4.6`, `haiku` → `claude-haiku-4.5`) and defaults to `"unknown"`.

**Cost calculation** fetches pricing from Supabase with hardcoded fallback defaults. Formula splits normal input tokens from cache tokens: `cost = (normal_input * input_rate) + (cache_write * write_rate) + (cache_read * read_rate) + (output * output_rate)`, all per-million-token rates.

**Database RLS**: anon role is read-only across all tables; service role has insert/update for sync operations. An auto-create trigger on `usage_records` inserts new projects automatically.

**Sync is idempotent**: usage sync tracks previously synced session IDs in a local ledger file and skips them. Both sync scripts support `--dry-run` mode via the `DRY_RUN` environment variable.
