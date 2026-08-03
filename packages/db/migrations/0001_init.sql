CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  organization_id text,
  name text NOT NULL,
  public_ingest_key_hash text NOT NULL UNIQUE,
  github_installation_id bigint,
  github_owner text NOT NULL,
  github_repo text NOT NULL,
  github_base_branch text NOT NULL DEFAULT 'main',
  allowed_environments jsonb NOT NULL DEFAULT '["development","staging"]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_feedback_id text NOT NULL,
  status text NOT NULL,
  comment text NOT NULL,
  page_url text NOT NULL,
  page_path text NOT NULL,
  page_title text NOT NULL,
  page_referrer text,
  environment text NOT NULL,
  viewport_json jsonb NOT NULL,
  selected_element_json jsonb NOT NULL,
  client_json jsonb NOT NULL,
  app_revision text,
  classification_json jsonb,
  github_issue_number integer,
  github_issue_url text,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, client_feedback_id)
);

CREATE INDEX IF NOT EXISTS feedback_project_status_idx ON feedback(project_id, status);

CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feedback_id text NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('screenshot')),
  storage_key text,
  mime_type text,
  byte_size integer,
  sha256 text,
  redaction_applied boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'stored',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feedback_id text NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  status text NOT NULL,
  base_sha text,
  branch_name text,
  workspace_reference text,
  model text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  cost_estimate numeric,
  summary text,
  blocked_reason text,
  validation_summary_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_feedback_idx ON agent_runs(feedback_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feedback_id text NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  agent_run_id text REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  event_type text NOT NULL,
  safe_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(feedback_id, sequence)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feedback_id text NOT NULL REFERENCES feedback(id) ON DELETE CASCADE UNIQUE,
  agent_run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  number integer NOT NULL,
  url text NOT NULL,
  branch_name text NOT NULL,
  head_sha text NOT NULL,
  validation_summary_json jsonb NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text PRIMARY KEY,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  event_name text NOT NULL,
  action text,
  processed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
