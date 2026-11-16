-- UI workshop: components, immutable versions, per-conversation bindings and commands.
-- The component code lives once per version; messages and bindings only reference it.

CREATE TABLE ui_components (
	id CHAR(32) NOT NULL,
	instance_id INTEGER NOT NULL,
	name VARCHAR(200) NOT NULL,
	description TEXT NOT NULL,
	status VARCHAR(16) NOT NULL,
	current_version INTEGER NOT NULL,
	published_version INTEGER,
	conversation_id CHAR(32),
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	revision INTEGER NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT ck_ui_components_status CHECK (status IN ('draft','published','archived')),
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE,
	FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE SET NULL
);

CREATE TABLE ui_component_versions (
	id CHAR(32) NOT NULL,
	component_id CHAR(32) NOT NULL,
	version INTEGER NOT NULL,
	status VARCHAR(16) NOT NULL,
	name VARCHAR(200) NOT NULL,
	description TEXT NOT NULL,
	html TEXT NOT NULL,
	input_schema JSON NOT NULL,
	state_schema JSON,
	commands JSON NOT NULL,
	events JSON NOT NULL,
	protocol_version INTEGER NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_ui_component_versions_number UNIQUE (component_id, version),
	CONSTRAINT ck_ui_component_versions_status CHECK (status IN ('draft','published')),
	FOREIGN KEY(component_id) REFERENCES ui_components (id) ON DELETE CASCADE
);

CREATE TABLE ui_component_bindings (
	id CHAR(32) NOT NULL,
	instance_id INTEGER NOT NULL,
	conversation_id CHAR(32) NOT NULL,
	component_id CHAR(32) NOT NULL,
	version INTEGER NOT NULL,
	props JSON,
	state JSON,
	state_schema JSON,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	revision INTEGER NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(instance_id) REFERENCES instance (id) ON DELETE CASCADE,
	FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
	FOREIGN KEY(component_id) REFERENCES ui_components (id) ON DELETE CASCADE
);

CREATE TABLE ui_binding_commands (
	id CHAR(32) NOT NULL,
	binding_id CHAR(32) NOT NULL,
	name VARCHAR(80) NOT NULL,
	payload JSON,
	status VARCHAR(16) NOT NULL,
	error TEXT,
	created_at DATETIME NOT NULL,
	applied_at DATETIME,
	PRIMARY KEY (id),
	CONSTRAINT ck_ui_binding_commands_status CHECK (status IN ('pending','applied','failed')),
	FOREIGN KEY(binding_id) REFERENCES ui_component_bindings (id) ON DELETE CASCADE
);

ALTER TABLE messages ADD COLUMN ui_components JSON;
ALTER TABLE conversations ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'chat';

CREATE INDEX ix_ui_components_instance_status ON ui_components (instance_id, status, updated_at);
CREATE INDEX ix_ui_component_versions_component ON ui_component_versions (component_id, version);
CREATE INDEX ix_ui_component_bindings_conversation ON ui_component_bindings (conversation_id);
CREATE INDEX ix_ui_binding_commands_binding ON ui_binding_commands (binding_id, status);
