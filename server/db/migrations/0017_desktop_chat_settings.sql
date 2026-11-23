CREATE TABLE desktop_chat_settings (
  instance_id INTEGER PRIMARY KEY CHECK (instance_id = 1),
  storage_limit_bytes INTEGER NOT NULL CHECK (storage_limit_bytes > 0),
  webtool_proxy_url TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0)
);
