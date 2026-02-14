-- ============================================
-- ClaudeScope - Seed Data (customize for your setup)
-- ============================================

-- Add your machines here
INSERT INTO machines (id, label, os) VALUES
  ('mac-home', 'Mac (Home)', 'macos'),
  ('windows-home', 'Windows (Home)', 'windows'),
  ('mac-work', 'Mac (Work)', 'macos')
ON CONFLICT (id) DO NOTHING;
