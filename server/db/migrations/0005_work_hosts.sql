-- Connected/configured SSH hosts and WSL distributions for the desktop Work workspace.

CREATE TABLE work_hosts (
	id CHAR(32) NOT NULL,
	instance_id INTEGER NOT NULL,
	kind VARCHAR(16) NOT NULL,
	name VARCHAR(120) NOT NULL,
	host VARCHAR(255) NOT NULL DEFAULT '',
	port INTEGER NOT NULL DEFAULT 22,
	username VARCHAR(120) NOT NULL DEFAULT '',
	auth_method VARCHAR(16) NOT NULL DEFAULT 'agent',
	private_key_path VARCHAR(500) NOT NULL DEFAULT '',
	secret_value TEXT NOT NULL DEFAULT '',
	distro VARCHAR(120) NOT NULL DEFAULT '',
	default_directory VARCHAR(500) NOT NULL DEFAULT '',
	note VARCHAR(500) NOT NULL DEFAULT '',
	status VARCHAR(16) NOT NULL DEFAULT 'disconnected',
	status_message TEXT,
	last_checked_at_ms BIGINT,
	revision INTEGER NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT ck_work_hosts_kind CHECK (kind IN ('ssh', 'wsl')),
	CONSTRAINT ck_work_hosts_auth_method CHECK (auth_method IN ('agent', 'key', 'password')),
	CONSTRAINT ck_work_hosts_status CHECK (status IN ('connected', 'disconnected', 'error')),
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE
);
CREATE INDEX ix_work_hosts_instance_updated ON work_hosts (instance_id, updated_at);
