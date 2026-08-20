ALTER TABLE agent_connections
  DROP CONSTRAINT IF EXISTS agent_connections_protocol_check;

ALTER TABLE agent_connections
  ADD CONSTRAINT agent_connections_protocol_check CHECK (
    protocol IN ('acp', 'yoke', 'local', 'openai-compatible')
  ),
  ADD COLUMN IF NOT EXISTS api_base_url TEXT,
  ADD COLUMN IF NOT EXISTS max_tool_rounds INTEGER NOT NULL DEFAULT 24;

ALTER TABLE agent_connections
  DROP CONSTRAINT IF EXISTS agent_connections_max_tool_rounds_check;

ALTER TABLE agent_connections
  ADD CONSTRAINT agent_connections_max_tool_rounds_check CHECK (
    max_tool_rounds BETWEEN 1 AND 100
  );

ALTER TABLE agent_connections
  DROP CONSTRAINT IF EXISTS agent_connections_openai_compatible_config_check;

ALTER TABLE agent_connections
  ADD CONSTRAINT agent_connections_openai_compatible_config_check CHECK (
    protocol <> 'openai-compatible'
    OR (api_base_url IS NOT NULL AND model IS NOT NULL)
  );
