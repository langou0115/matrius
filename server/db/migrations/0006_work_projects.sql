CREATE TABLE IF NOT EXISTS work_projects (
  id TEXT NOT NULL,
  instance_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  host_id TEXT NOT NULL,
  directory TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  CONSTRAINT work_projects_pk PRIMARY KEY (id),
  CONSTRAINT work_projects_instance_fk FOREIGN KEY (instance_id) REFERENCES instance (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_work_projects_instance_updated
  ON work_projects (instance_id, updated_at);
