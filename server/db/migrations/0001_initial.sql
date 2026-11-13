-- Baseline schema for the single-user Matrius instance.
-- Generated from the Alembic 0001_initial database; do not edit after it has shipped.

CREATE TABLE conversation_deletions (
	instance_id INTEGER NOT NULL, 
	client_id VARCHAR(128) NOT NULL, 
	PRIMARY KEY (instance_id, client_id), 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE
);
CREATE TABLE conversations (
	id CHAR(32) NOT NULL, 
	instance_id INTEGER NOT NULL, 
	client_id VARCHAR(128), 
	title VARCHAR(500) NOT NULL, 
	pinned BOOLEAN NOT NULL, 
	model_id VARCHAR(200), 
	title_source VARCHAR(16), 
	context_summary JSON, 
	client_updated_at_ms BIGINT, 
	completed_state VARCHAR(16) NOT NULL, 
	completed_read_at_ms BIGINT, 
	error_state VARCHAR(16) NOT NULL, 
	error_read_at_ms BIGINT, 
	updated_at DATETIME NOT NULL, 
	revision INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_conversations_completed_state CHECK (completed_state IN ('absent','unread','read')), 
	CONSTRAINT ck_conversations_error_state CHECK (error_state IN ('absent','unread','read')), 
	CONSTRAINT ck_conversations_title_source CHECK (title_source IS NULL OR title_source IN ('auto','ai','manual')), 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE, 
	CONSTRAINT uq_conversations_instance_client UNIQUE (instance_id, client_id)
);
CREATE TABLE files (
	id CHAR(32) NOT NULL, 
	instance_id INTEGER NOT NULL, 
	client_id VARCHAR(128), 
	conversation_id CHAR(32), 
	filename VARCHAR(255) NOT NULL, 
	object_key VARCHAR(512) NOT NULL, 
	content_type VARCHAR(255) NOT NULL, 
	size BIGINT NOT NULL, 
	sha256 VARCHAR(64) NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	revision INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE SET NULL, 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE, 
	CONSTRAINT uq_files_instance_client UNIQUE (instance_id, client_id), 
	UNIQUE (object_key)
);
CREATE TABLE instance (
	id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_instance_singleton CHECK (id = 1)
);
CREATE TABLE memory_entries (
	id CHAR(32) NOT NULL, 
	instance_id INTEGER NOT NULL, 
	client_id VARCHAR(128), 
	scope VARCHAR(16) NOT NULL, 
	type VARCHAR(16) NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	content TEXT NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	client_created_at_ms BIGINT, 
	client_updated_at_ms BIGINT, 
	revision INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_memory_entries_scope CHECK (scope IN ('global','conversation')), 
	CONSTRAINT ck_memory_entries_source CHECK (source IN ('manual','tool','extracted')), 
	CONSTRAINT ck_memory_entries_status CHECK (status IN ('active','archived')), 
	CONSTRAINT ck_memory_entries_type CHECK (type IN ('identity','workflow','voice','instruction')), 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE, 
	CONSTRAINT uq_memory_entries_instance_client UNIQUE (instance_id, client_id)
);
CREATE TABLE messages (
	id CHAR(32) NOT NULL, 
	instance_id INTEGER NOT NULL, 
	conversation_id CHAR(32) NOT NULL, 
	client_id VARCHAR(128), 
	position INTEGER NOT NULL, 
	role VARCHAR(16) NOT NULL, 
	content TEXT NOT NULL, 
	steering BOOLEAN NOT NULL, 
	quote TEXT, 
	feedback VARCHAR(8), 
	reasoning TEXT, 
	activities JSON, 
	process JSON, 
	thinking_ms BIGINT, 
	status VARCHAR(16) NOT NULL, 
	error TEXT, 
	file_ids JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	revision INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_messages_feedback CHECK (feedback IS NULL OR feedback IN ('good','bad')), 
	CONSTRAINT ck_messages_role CHECK (role IN ('user','assistant')), 
	CONSTRAINT ck_messages_status CHECK (status IN ('complete','stopped','error')), 
	FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE CASCADE, 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE, 
	CONSTRAINT uq_messages_conversation_position UNIQUE (conversation_id, position), 
	CONSTRAINT uq_messages_instance_client UNIQUE (instance_id, client_id)
);
CREATE TABLE preferences (
	id CHAR(32) NOT NULL, 
	instance_id INTEGER NOT NULL, 
	theme_id VARCHAR(64) NOT NULL, 
	mode VARCHAR(16) NOT NULL, 
	revision INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE, 
	UNIQUE (instance_id)
);
CREATE TABLE profile_fields (
	id CHAR(32) NOT NULL, 
	instance_id INTEGER NOT NULL, 
	"key" VARCHAR(64) NOT NULL, 
	value TEXT NOT NULL, 
	source VARCHAR(32) NOT NULL, 
	client_updated_at_ms BIGINT, 
	revision INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE, 
	CONSTRAINT uq_profile_fields_instance_key UNIQUE (instance_id, "key")
);
CREATE TABLE profiles (
	id CHAR(32) NOT NULL, 
	instance_id INTEGER NOT NULL, 
	custom_instructions TEXT NOT NULL, 
	about_name VARCHAR(100) NOT NULL, 
	occupation VARCHAR(100) NOT NULL, 
	about_more TEXT NOT NULL, 
	revision INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE, 
	UNIQUE (instance_id)
);
CREATE TABLE token_usage_daily (
	id CHAR(32) NOT NULL, 
	instance_id INTEGER NOT NULL, 
	day DATE NOT NULL, 
	input_tokens BIGINT NOT NULL, 
	output_tokens BIGINT NOT NULL, 
	cache_read_tokens BIGINT NOT NULL, 
	cache_write_tokens BIGINT NOT NULL, 
	requests INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE, 
	CONSTRAINT uq_token_usage_daily_instance_day UNIQUE (instance_id, day)
);
CREATE TABLE token_usage_estimate_daily (
	id CHAR(32) NOT NULL, 
	instance_id INTEGER NOT NULL, 
	day DATE NOT NULL, 
	input_tokens BIGINT NOT NULL, 
	output_tokens BIGINT NOT NULL, 
	requests INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE, 
	CONSTRAINT uq_token_usage_estimate_daily_instance_day UNIQUE (instance_id, day)
);
CREATE TABLE usage_backfills (
	instance_id INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (instance_id), 
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE
);

CREATE INDEX ix_conversations_instance_order ON conversations (instance_id, pinned, updated_at);
CREATE INDEX ix_files_instance_created ON files (instance_id, created_at);
CREATE INDEX ix_memory_entries_instance_updated ON memory_entries (instance_id, updated_at);
CREATE INDEX ix_messages_conversation_position ON messages (conversation_id, position);
