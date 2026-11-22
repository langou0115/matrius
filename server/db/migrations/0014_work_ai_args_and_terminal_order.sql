ALTER TABLE work_projects ADD COLUMN codex_cli_args TEXT NOT NULL DEFAULT '';
ALTER TABLE work_projects ADD COLUMN antigravity_cli_args TEXT NOT NULL DEFAULT '';
ALTER TABLE work_projects ADD COLUMN claude_cli_args TEXT NOT NULL DEFAULT '';
ALTER TABLE work_settings ADD COLUMN terminal_order_json TEXT NOT NULL DEFAULT '[]';
