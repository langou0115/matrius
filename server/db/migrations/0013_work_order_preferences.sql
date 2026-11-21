ALTER TABLE work_settings ADD COLUMN project_order_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE work_settings ADD COLUMN cli_provider_order_json TEXT NOT NULL DEFAULT '["codex","antigravity","claude"]';
