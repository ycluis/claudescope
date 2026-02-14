-- ============================================
-- ClaudeScope - Initial Schema
-- ============================================

-- 1. Machines table
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  os TEXT CHECK (os IN ('macos', 'windows', 'linux')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Projects table
CREATE TABLE projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  label TEXT,
  color TEXT,
  category TEXT CHECK (category IN ('work', 'personal', 'oss', 'other')) DEFAULT 'other',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Model pricing table
CREATE TABLE model_pricing (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  model_family TEXT UNIQUE NOT NULL,
  input_per_m NUMERIC(10, 4) NOT NULL,
  output_per_m NUMERIC(10, 4) NOT NULL,
  cache_read_per_m NUMERIC(10, 4) NOT NULL,
  cache_write_per_m NUMERIC(10, 4) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Usage records table
CREATE TABLE usage_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  project_slug TEXT REFERENCES projects(slug),
  input_tokens BIGINT DEFAULT 0,
  output_tokens BIGINT DEFAULT 0,
  cache_write_tokens BIGINT DEFAULT 0,
  cache_read_tokens BIGINT DEFAULT 0,
  cost_usd NUMERIC(10, 6) DEFAULT 0,
  session_start TIMESTAMPTZ,
  session_end TIMESTAMPTZ,
  duration_seconds INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN session_start IS NOT NULL AND session_end IS NOT NULL
      THEN EXTRACT(EPOCH FROM (session_end - session_start))::INTEGER
      ELSE NULL
    END
  ) STORED,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(machine_id, session_id)
);

-- 5. Indexes
CREATE INDEX idx_usage_created ON usage_records(created_at DESC);
CREATE INDEX idx_usage_machine ON usage_records(machine_id);
CREATE INDEX idx_usage_model ON usage_records(model);
CREATE INDEX idx_usage_project ON usage_records(project_slug);
CREATE INDEX idx_usage_session_start ON usage_records(session_start DESC);

-- 6. Daily summary view
CREATE OR REPLACE VIEW daily_summary AS
SELECT
  DATE(session_start) AS date,
  machine_id,
  model,
  project_slug,
  COUNT(*) AS sessions,
  SUM(input_tokens) AS total_input_tokens,
  SUM(output_tokens) AS total_output_tokens,
  SUM(cache_write_tokens) AS total_cache_write_tokens,
  SUM(cache_read_tokens) AS total_cache_read_tokens,
  SUM(cost_usd) AS total_cost,
  SUM(duration_seconds) AS total_duration_seconds
FROM usage_records
GROUP BY DATE(session_start), machine_id, model, project_slug;

-- 7. Triggers: auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machines_updated_at
  BEFORE UPDATE ON machines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER model_pricing_updated_at
  BEFORE UPDATE ON model_pricing
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 8. Trigger: auto-create project on usage insert
CREATE OR REPLACE FUNCTION ensure_project_exists()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.project_slug IS NOT NULL THEN
    INSERT INTO projects (slug, label, category)
    VALUES (NEW.project_slug, NEW.project_slug, 'other')
    ON CONFLICT (slug) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER usage_ensure_project
  BEFORE INSERT ON usage_records
  FOR EACH ROW EXECUTE FUNCTION ensure_project_exists();

-- 9. RLS policies
ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;

-- Anon: read only
CREATE POLICY "anon_read_machines" ON machines FOR SELECT USING (true);
CREATE POLICY "anon_read_projects" ON projects FOR SELECT USING (true);
CREATE POLICY "anon_read_pricing" ON model_pricing FOR SELECT USING (true);
CREATE POLICY "anon_read_usage" ON usage_records FOR SELECT USING (true);

-- Service role: write
CREATE POLICY "service_insert_machines" ON machines FOR INSERT WITH CHECK (true);
CREATE POLICY "service_update_machines" ON machines FOR UPDATE USING (true);
CREATE POLICY "service_insert_projects" ON projects FOR INSERT WITH CHECK (true);
CREATE POLICY "service_update_projects" ON projects FOR UPDATE USING (true);
CREATE POLICY "service_insert_pricing" ON model_pricing FOR INSERT WITH CHECK (true);
CREATE POLICY "service_update_pricing" ON model_pricing FOR UPDATE USING (true);
CREATE POLICY "service_insert_usage" ON usage_records FOR INSERT WITH CHECK (true);
