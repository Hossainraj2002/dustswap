CREATE TABLE IF NOT EXISTS user_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  display_name TEXT,
  discord_username TEXT,
  pfp_url TEXT,
  pfp_storage_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_profiles_username_format CHECK (
    username IS NULL OR username ~ '^[a-z0-9._]{3,24}$'
  ),
  CONSTRAINT user_profiles_display_name_length CHECK (
    display_name IS NULL OR char_length(display_name) BETWEEN 2 AND 32
  ),
  CONSTRAINT user_profiles_discord_length CHECK (
    discord_username IS NULL OR char_length(discord_username) BETWEEN 2 AND 40
  )
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_username
ON user_profiles (username);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_all_user_profiles" ON user_profiles;

CREATE POLICY "service_all_user_profiles"
ON user_profiles
FOR ALL
USING (true);
