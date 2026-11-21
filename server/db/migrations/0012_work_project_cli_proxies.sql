ALTER TABLE work_projects ADD COLUMN codex_proxy_url TEXT NOT NULL DEFAULT '';
ALTER TABLE work_projects ADD COLUMN antigravity_proxy_url TEXT NOT NULL DEFAULT '';
ALTER TABLE work_projects ADD COLUMN claude_proxy_url TEXT NOT NULL DEFAULT '';
UPDATE work_projects
SET codex_proxy_url = proxy_url,
    antigravity_proxy_url = proxy_url,
    claude_proxy_url = proxy_url,
    proxy_url = ''
WHERE proxy_url != '';
