UPDATE agent_connections
   SET protocol = 'local',
       launcher_command = 'codex',
       launcher_arguments = '[]'::JSONB,
       credential_environment_variable = 'OPENAI_API_KEY'
 WHERE provider = 'codex';
