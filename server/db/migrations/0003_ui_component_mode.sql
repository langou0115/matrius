-- Creation-time design mode. A stateful component is bound to a conversation
-- (its state is stored per conversation); a display-only one receives props.
-- Existing components are backfilled from their versions so a component that
-- already declared a state schema stays stateful.

ALTER TABLE ui_components ADD COLUMN stateful BOOLEAN NOT NULL DEFAULT 0;

UPDATE ui_components SET stateful = 1 WHERE EXISTS (
  SELECT 1 FROM ui_component_versions v
  WHERE v.component_id = ui_components.id
    AND v.state_schema IS NOT NULL
    AND v.state_schema <> 'null'
);
