CREATE TABLE IF NOT EXISTS user_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON auth_sessions(user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS auth_sessions_active_idx
  ON auth_sessions(token_hash)
  WHERE revoked_at IS NULL;

INSERT INTO user_credentials (user_id, password_hash, must_change_password)
VALUES
  (
    '00000000-0000-4000-8000-000000000101',
    'scrypt$16384$8$1$jasIWNbryLjULPNvQ8hRng$UmS5R4Gb4LhIBlisWNk5wJurW7_T7UjyonPYHvHIqxW3J0LQPkN7-PA-Bd0ADgkec27tpOD_nNFbqoZhvfOCRA',
    TRUE
  ),
  (
    '00000000-0000-4000-8000-000000000102',
    'scrypt$16384$8$1$fIcJIOcO955z3XUwj11yRw$FmbwwyBu_1MtTHukrD8bLo3dqAmtuS6wtWpAafxvrqRioDwoURepH_9ycj81IFcWj_OtiOvtu_gzDvteu2a7ww',
    TRUE
  )
ON CONFLICT (user_id) DO NOTHING;
