-- Scheduled tasks for the single-user Matrius instance.

CREATE TABLE scheduled_tasks (
	id CHAR(32) NOT NULL,
	instance_id INTEGER NOT NULL,
	title VARCHAR(200) NOT NULL,
	prompt TEXT NOT NULL,
	kind VARCHAR(16) NOT NULL,
	interval_minutes INTEGER,
	run_at_ms BIGINT,
	next_run_at_ms BIGINT,
	last_run_at_ms BIGINT,
	conversation_client_id VARCHAR(128),
	enabled BOOLEAN NOT NULL,
	status VARCHAR(16) NOT NULL,
	run_count INTEGER NOT NULL DEFAULT 0,
	revision INTEGER NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT ck_scheduled_tasks_kind CHECK (kind IN ('recurring', 'once')),
	CONSTRAINT ck_scheduled_tasks_status CHECK (status IN ('active', 'paused', 'completed')),
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE
);
CREATE INDEX ix_scheduled_tasks_instance_updated ON scheduled_tasks (instance_id, updated_at);
