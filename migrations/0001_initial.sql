PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collaborators (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  zalo_user_id TEXT UNIQUE,
  area TEXT,
  team TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('ADMIN','CTV')),
  actor_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  campaign_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_allocations (
  id TEXT PRIMARY KEY,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  product_id TEXT NOT NULL REFERENCES sample_products(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  allocated_at TEXT NOT NULL,
  allocated_by TEXT NOT NULL REFERENCES admins(id),
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED'))
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_normalized TEXT NOT NULL UNIQUE,
  phone_masked TEXT NOT NULL,
  created_by_collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  phone_normalized TEXT NOT NULL,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  campaign_code TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  otp_hash TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_objects (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  captured_at_server TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','FINALIZED','ORPHANED')),
  created_by_collaborator_id TEXT NOT NULL REFERENCES collaborators(id)
);

CREATE TABLE IF NOT EXISTS sample_distributions (
  id TEXT PRIMARY KEY,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL REFERENCES sample_products(id),
  campaign_code TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  otp_challenge_id TEXT NOT NULL UNIQUE REFERENCES otp_challenges(id),
  evidence_id TEXT NOT NULL UNIQUE REFERENCES evidence_objects(id),
  distributed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK(status IN ('COMPLETED','REVERSED')),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  UNIQUE(collaborator_id, idempotency_key),
  UNIQUE(phone_normalized, campaign_code)
);

CREATE TRIGGER IF NOT EXISTS trg_distribution_validate BEFORE INSERT ON sample_distributions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM otp_challenges o
     WHERE o.id=NEW.otp_challenge_id
       AND o.collaborator_id=NEW.collaborator_id
       AND o.phone_normalized=NEW.phone_normalized
       AND o.campaign_code=NEW.campaign_code
       AND o.verified_at IS NOT NULL
       AND o.consumed_at IS NULL
       AND o.expires_at > NEW.distributed_at
  ) THEN RAISE(ABORT, 'OTP_INVALID_STATE') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM evidence_objects e
     WHERE e.id=NEW.evidence_id
       AND e.created_by_collaborator_id=NEW.collaborator_id
       AND e.status='PENDING'
  ) THEN RAISE(ABORT, 'EVIDENCE_INVALID_STATE') END;

  SELECT CASE WHEN (
    COALESCE((SELECT SUM(quantity) FROM inventory_allocations a WHERE a.collaborator_id=NEW.collaborator_id AND a.product_id=NEW.product_id AND a.status='ACTIVE'),0)
    + COALESCE((SELECT SUM(quantity_delta) FROM inventory_adjustments j WHERE j.collaborator_id=NEW.collaborator_id AND j.product_id=NEW.product_id),0)
    - COALESCE((SELECT SUM(quantity) FROM sample_distributions d WHERE d.collaborator_id=NEW.collaborator_id AND d.product_id=NEW.product_id AND d.status='COMPLETED'),0)
  ) < NEW.quantity THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_distribution_finalize AFTER INSERT ON sample_distributions
BEGIN
  UPDATE otp_challenges SET consumed_at=NEW.distributed_at WHERE id=NEW.otp_challenge_id;
  UPDATE evidence_objects SET status='FINALIZED' WHERE id=NEW.evidence_id;
END;

CREATE TABLE IF NOT EXISTS daily_reconciliations (
  id TEXT PRIMARY KEY,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  business_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK(status IN ('SUBMITTED','APPROVED','REJECTED')),
  submitted_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT REFERENCES admins(id),
  note TEXT,
  UNIQUE(collaborator_id, business_date)
);

CREATE TABLE IF NOT EXISTS daily_reconciliation_lines (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES daily_reconciliations(id),
  product_id TEXT NOT NULL REFERENCES sample_products(id),
  assigned_qty INTEGER NOT NULL CHECK(assigned_qty >= 0),
  distributed_qty INTEGER NOT NULL CHECK(distributed_qty >= 0),
  returned_qty INTEGER NOT NULL CHECK(returned_qty >= 0),
  damaged_qty INTEGER NOT NULL CHECK(damaged_qty >= 0),
  closing_qty INTEGER NOT NULL CHECK(closing_qty >= 0),
  variance_qty INTEGER NOT NULL,
  reason TEXT,
  UNIQUE(reconciliation_id, product_id)
);

CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id TEXT PRIMARY KEY,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  product_id TEXT NOT NULL REFERENCES sample_products(id),
  quantity_delta INTEGER NOT NULL CHECK(quantity_delta != 0),
  reason_code TEXT NOT NULL,
  note TEXT,
  created_by_admin_id TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash, expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_actor ON sessions(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_collaborators_status ON collaborators(status, code);
CREATE INDEX IF NOT EXISTS idx_products_campaign ON sample_products(campaign_code, status);
CREATE INDEX IF NOT EXISTS idx_allocations_actor_product ON inventory_allocations(collaborator_id, product_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_otp_actor_phone_created ON otp_challenges(collaborator_id, phone_normalized, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_distributions_actor_date ON sample_distributions(collaborator_id, distributed_at DESC);
CREATE INDEX IF NOT EXISTS idx_distributions_product ON sample_distributions(product_id, status);
CREATE INDEX IF NOT EXISTS idx_distributions_phone_campaign ON sample_distributions(phone_normalized, campaign_code);
CREATE INDEX IF NOT EXISTS idx_reconciliation_date ON daily_reconciliations(business_date, status);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
