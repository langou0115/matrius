ALTER TABLE work_settings ADD COLUMN editor_diff_layout TEXT NOT NULL DEFAULT 'inline' CHECK (editor_diff_layout IN ('inline', 'split'));
