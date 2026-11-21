CREATE TABLE IF NOT EXISTS work_terminals (
  id TEXT NOT NULL,
  instance_id INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  title TEXT NOT NULL,
  preset TEXT NOT NULL DEFAULT 'shell',
  shell TEXT,
  command TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL,
  cols INTEGER NOT NULL DEFAULT 100,
  rows INTEGER NOT NULL DEFAULT 30,
  pinned INTEGER NOT NULL DEFAULT 0,
  scrollback TEXT NOT NULL DEFAULT '',
  last_status TEXT NOT NULL DEFAULT 'running',
  last_exit_code INTEGER,
  error_message TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  CONSTRAINT work_terminals_pk PRIMARY KEY (id),
  CONSTRAINT work_terminals_instance_fk FOREIGN KEY (instance_id) REFERENCES instance (id) ON DELETE CASCADE,
  CONSTRAINT work_terminals_project_fk FOREIGN KEY (project_id) REFERENCES work_projects (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_work_terminals_project_created
  ON work_terminals (instance_id, project_id, created_at_ms);

CREATE TABLE IF NOT EXISTS work_settings (
  instance_id INTEGER NOT NULL DEFAULT 1,
  default_windows_shell TEXT NOT NULL DEFAULT 'powershell',
  active_project_id TEXT,
  active_terminals_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms BIGINT NOT NULL,
  CONSTRAINT work_settings_pk PRIMARY KEY (instance_id),
  CONSTRAINT work_settings_instance_fk FOREIGN KEY (instance_id) REFERENCES instance (id) ON DELETE CASCADE
);
