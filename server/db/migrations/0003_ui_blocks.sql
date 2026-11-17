-- Persist Intelligent UI blocks attached to assistant messages.

ALTER TABLE messages ADD COLUMN ui_blocks TEXT;
