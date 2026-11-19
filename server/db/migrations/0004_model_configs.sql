-- Server-side model providers, selections and provider API keys for the single-user instance.

CREATE TABLE model_configs (
	instance_id INTEGER NOT NULL,
	providers_json TEXT NOT NULL,
	credentials_json TEXT NOT NULL,
	selected_id VARCHAR(200),
	title_model_id VARCHAR(200),
	memory_model_id VARCHAR(200),
	revision INTEGER NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (instance_id),
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE
);
