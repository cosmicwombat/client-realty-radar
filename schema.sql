-- ============================================================
-- Realty Radar — D1 schema  (database: realty-radar-db)
-- ============================================================
-- DESIGN PRINCIPLE (locked via first-principles, 2026-05-30):
--   Human data and machine data are quarantined.
--   • findings        = PRECIOUS, hand-entered. Keyed by a STABLE parcel
--                       identity (state|county|parcel_number) so a note NEVER
--                       detaches from its piece of land — even if we wipe and
--                       re-pull snapshots, or swap Realie for another source.
--   • parcel_snapshots = DISPOSABLE machine data, re-pulled from Realie.
--                       Safe to delete/refresh at will. Never the source of truth
--                       for anything Robert typed.
--   • watch_areas      = search configuration.
-- ============================================================

PRAGMA foreign_keys = ON;

-- 1) WATCH AREAS — saved searches ------------------------------------------------
CREATE TABLE IF NOT EXISTS watch_areas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT    NOT NULL,
  mode           TEXT    NOT NULL DEFAULT 'radius',  -- 'radius' (≤2mi) | 'county'
  state          TEXT    NOT NULL DEFAULT 'WA',
  county         TEXT,                               -- 'WHATCOM' | 'SKAGIT'
  center_lat     REAL,
  center_lon     REAL,
  radius_miles   REAL    DEFAULT 2,                  -- Realie Location Search caps at 2
  min_acres      REAL    DEFAULT 2,
  max_acres      REAL    DEFAULT 3,
  max_value      REAL,                               -- NULL = no cap
  vacant_only    INTEGER DEFAULT 0,                  -- 0/1
  zoning_filter  TEXT    DEFAULT 'RR',               -- substring match on zoningCode
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_refreshed TEXT
);

-- 2) PARCEL SNAPSHOTS — disposable machine data, re-pulled from Realie ----------
-- One row = a parcel's state as of one refresh batch of a watch area.
-- The two most-recent batches per area are diffed to build the change feed.
CREATE TABLE IF NOT EXISTS parcel_snapshots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id              INTEGER NOT NULL REFERENCES watch_areas(id) ON DELETE CASCADE,
  batch_id             TEXT    NOT NULL,             -- shared id for one refresh batch
  parcel_key           TEXT    NOT NULL,             -- STABLE: state|county|parcel_number
  state                TEXT,
  county               TEXT,
  parcel_number        TEXT,                         -- Realie parcelId (assessor APN)
  address_full         TEXT,
  owner_name           TEXT,                         -- change = likely SOLD
  zoning_code          TEXT,
  acres                REAL,
  use_code             TEXT,
  building_count       INTEGER,
  year_built           INTEGER,
  total_assessed_value REAL,
  total_market_value   REAL,
  transfer_date        TEXT,                         -- Realie transferDate
  transfer_price       REAL,
  foreclose_code       TEXT,                         -- non-null = in foreclosure
  vacant_flag          INTEGER DEFAULT 0,            -- derived: no buildings/year_built
  latitude             REAL,
  longitude            REAL,
  raw_json             TEXT,                         -- full Realie record → detail view costs 0 extra calls
  snapshot_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snap_area      ON parcel_snapshots(area_id);
CREATE INDEX IF NOT EXISTS idx_snap_batch     ON parcel_snapshots(area_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_snap_key       ON parcel_snapshots(parcel_key);

-- 3) FINDINGS — precious human data, keyed by stable parcel identity ------------
CREATE TABLE IF NOT EXISTS findings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parcel_key    TEXT    NOT NULL UNIQUE,            -- state|county|parcel_number
  state         TEXT,
  county        TEXT,
  parcel_number TEXT,
  address_full  TEXT,                                -- denormalized label for display
  note          TEXT,
  status        TEXT    DEFAULT 'watching',          -- watching|contacted|visited|passed|offer
  has_power     INTEGER DEFAULT 0,                   -- manual: not in any data source
  has_water     INTEGER DEFAULT 0,
  has_septic    INTEGER DEFAULT 0,
  starred       INTEGER DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_find_star   ON findings(starred);
CREATE INDEX IF NOT EXISTS idx_find_status ON findings(status);
