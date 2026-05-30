/**
 * ============================================================
 *  Realty Radar — Cloudflare Worker  (realty-radar-worker)
 * ============================================================
 * Dedicated backend for Robert's personal land-hunting app. Kept OFF the
 * shared appsforhire-worker so the paid Realie key + personal D1 data have a
 * tiny blast radius (decided via first-principles 2026-05-30).
 *
 * Claude text generation is NOT here — the app calls the shared
 * https://worker.appsforhire.app/ai endpoint for that.
 *
 * Routes:
 *   GET  /health                       → which secrets/bindings are present
 *   GET  /realie/location?...          → Realie Location Search (lat/lon/radius ≤2mi)
 *   GET  /realie/search?...            → Realie Property Search (county, transferedSince, ...)
 *   GET  /realie/parcel?...            → Realie Parcel ID lookup
 *   GET/POST /gis?url=<allow-listed>   → CORS proxy for FEMA/USDA/county/WA gov data
 *   GET    /db/areas                   → list watch areas
 *   POST   /db/areas                   → create a watch area
 *   DELETE /db/areas/:id               → delete a watch area (+ its snapshots)
 *   POST   /db/areas/:id/snapshot      → store a refresh batch of parcels
 *   GET    /db/areas/:id/changes       → diff the two newest batches (the change feed)
 *   GET    /db/findings                → list findings
 *   GET    /db/findings/:key           → one finding
 *   PUT    /db/findings/:key           → upsert a finding (note/status/utilities/star)
 *   DELETE /db/findings/:key           → delete a finding
 *
 * Secrets: REALIE_API_KEY (required), APP_TOKEN (optional bearer gate).
 * Binding: DB → realty-radar-db.
 * ============================================================
 */

const REALIE_BASE = "https://app.realie.ai/api/public/property";

// Hosts the /gis proxy is allowed to reach. Prevents this from being an open proxy.
const GIS_ALLOW = [
  "hazards.fema.gov",            // FEMA National Flood Hazard Layer
  "sdmdataaccess.sc.egov.usda.gov", // USDA Soil Data Access
  "sdmdataaccess.nrcs.usda.gov",
  "gis.whatcomcounty.us",        // Whatcom County ArcGIS
  "gis.skagitcountywa.gov",      // Skagit County ArcGIS
  "geo.skagitcountywa.gov",
  "apps.ecology.wa.gov",         // WA Dept. of Ecology (well logs)
  "fortress.wa.gov",
  "data.wa.gov",
];

// ── CORS ───────────────────────────────────────────────────────────────────────
const DEV_PORTS = new Set(["3000", "5173", "8000", "8080", "8787", "8888"]);
function isAllowedOrigin(origin) {
  if (!origin || origin === "null") return false;
  if (/^https:\/\/[a-z0-9-]+\.appsforhire\.app$/.test(origin)) return true;
  if (origin === "https://appsforhire.app") return true;
  const m = /^http:\/\/(localhost|127\.0\.0\.1)(?::(\d+))?$/.exec(origin);
  if (m) return DEV_PORTS.has(m[2] || "80");
  return false;
}
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// Optional shared-token gate. If APP_TOKEN is set, require it on protected routes.
function authOk(request, env) {
  if (!env.APP_TOKEN) return true; // not configured → rely on Origin + CF Access
  const h = request.headers.get("Authorization") || "";
  return h === `Bearer ${env.APP_TOKEN}`;
}

// Build "state|county|parcelId" — the STABLE identity a finding clings to forever.
function parcelKey(state, county, parcelId) {
  return [
    (state || "").toUpperCase().trim(),
    (county || "").toUpperCase().trim(),
    (parcelId || "").toUpperCase().trim(),
  ].join("|");
}

// Reduce a full Realie record down to the columns we snapshot.
function toSnapshotRow(p) {
  const buildingCount = p.buildingCount != null ? p.buildingCount : null;
  const yearBuilt = p.yearBuilt != null ? p.yearBuilt : null;
  const vacant = (!buildingCount || buildingCount === 0) && !yearBuilt ? 1 : 0;
  return {
    parcel_key: parcelKey(p.state, p.county, p.parcelId),
    state: p.state || null,
    county: p.county || null,
    parcel_number: p.parcelId || null,
    address_full: p.addressFull || p.address || null,
    owner_name: p.ownerName || null,
    zoning_code: p.zoningCode || null,
    acres: p.acres != null ? p.acres : null,
    use_code: p.useCode || null,
    building_count: buildingCount,
    year_built: yearBuilt,
    total_assessed_value: p.totalAssessedValue != null ? p.totalAssessedValue : null,
    total_market_value: p.totalMarketValue != null ? p.totalMarketValue : null,
    transfer_date: p.transferDate || null,
    transfer_price: p.transferPrice != null ? p.transferPrice : null,
    foreclose_code: p.forecloseCode || null,
    vacant_flag: vacant,
    latitude: p.latitude != null ? p.latitude : null,
    longitude: p.longitude != null ? p.longitude : null,
    raw_json: JSON.stringify(p),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = isAllowedOrigin(origin) ? origin : "";

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    // Health is open and origin-agnostic.
    if (path === "/health") {
      let dbOk = false;
      try { await env.DB.prepare("SELECT 1").first(); dbOk = true; } catch (_) {}
      return json({
        ok: true,
        worker: "realty-radar-worker",
        realie_key: !!env.REALIE_API_KEY,
        app_token_set: !!env.APP_TOKEN,
        db: dbOk,
        time: new Date().toISOString(),
      }, 200, allowOrigin);
    }

    // Everything else requires an allowed browser origin.
    if (!allowOrigin) return json({ error: "Origin not allowed" }, 403, "");
    if (!authOk(request, env)) return json({ error: "Unauthorized" }, 401, allowOrigin);

    try {
      // ── Realie proxy ──────────────────────────────────────────────────────
      if (path.startsWith("/realie/")) {
        if (!env.REALIE_API_KEY) return json({ error: "REALIE_API_KEY not set" }, 500, allowOrigin);
        const sub = path.slice("/realie/".length); // location | search | parcel
        const endpoint = { location: "/location/", search: "/search/", parcel: "/parcel/" }[sub];
        if (!endpoint) return json({ error: "Unknown Realie endpoint" }, 404, allowOrigin);
        const target = `${REALIE_BASE}${endpoint}?${url.searchParams.toString()}`;
        const r = await fetch(target, { headers: { Authorization: env.REALIE_API_KEY } });
        const body = await r.text();
        return new Response(body, {
          status: r.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(allowOrigin) },
        });
      }

      // ── Allow-listed government-data CORS proxy ───────────────────────────
      if (path === "/gis") {
        const target = url.searchParams.get("url");
        if (!target) return json({ error: "missing url param" }, 400, allowOrigin);
        let host;
        try { host = new URL(target).hostname; } catch { return json({ error: "bad url" }, 400, allowOrigin); }
        if (!GIS_ALLOW.includes(host)) return json({ error: `host not allow-listed: ${host}` }, 403, allowOrigin);
        const init = { method: request.method === "POST" ? "POST" : "GET" };
        if (init.method === "POST") {
          init.body = await request.text();
          init.headers = { "Content-Type": request.headers.get("Content-Type") || "application/x-www-form-urlencoded" };
        }
        const r = await fetch(target, init);
        const body = await r.text();
        const ct = r.headers.get("Content-Type") || "application/json";
        return new Response(body, { status: r.status, headers: { "Content-Type": ct, ...corsHeaders(allowOrigin) } });
      }

      // ── D1: watch areas ───────────────────────────────────────────────────
      if (path === "/db/areas" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM watch_areas ORDER BY created_at DESC"
        ).all();
        return json({ areas: results }, 200, allowOrigin);
      }
      if (path === "/db/areas" && request.method === "POST") {
        const b = await request.json();
        const r = await env.DB.prepare(
          `INSERT INTO watch_areas
             (label, mode, state, county, center_lat, center_lon, radius_miles,
              min_acres, max_acres, max_value, vacant_only, zoning_filter)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          b.label || "Untitled area", b.mode || "radius", b.state || "WA",
          b.county || null, b.center_lat ?? null, b.center_lon ?? null,
          b.radius_miles ?? 2, b.min_acres ?? 2, b.max_acres ?? 3,
          b.max_value ?? null, b.vacant_only ? 1 : 0, b.zoning_filter || "RR"
        ).run();
        return json({ id: r.meta.last_row_id }, 200, allowOrigin);
      }
      const areaMatch = path.match(/^\/db\/areas\/(\d+)$/);
      if (areaMatch && request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM watch_areas WHERE id = ?").bind(areaMatch[1]).run();
        return json({ ok: true }, 200, allowOrigin);
      }

      // Store one refresh batch of parcels for an area.
      const snapMatch = path.match(/^\/db\/areas\/(\d+)\/snapshot$/);
      if (snapMatch && request.method === "POST") {
        const areaId = snapMatch[1];
        const b = await request.json();
        const parcels = Array.isArray(b.parcels) ? b.parcels : [];
        const batchId = b.batch_id || new Date().toISOString();
        const stmt = env.DB.prepare(
          `INSERT INTO parcel_snapshots
            (area_id, batch_id, parcel_key, state, county, parcel_number, address_full,
             owner_name, zoning_code, acres, use_code, building_count, year_built,
             total_assessed_value, total_market_value, transfer_date, transfer_price,
             foreclose_code, vacant_flag, latitude, longitude, raw_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        );
        const batch = parcels.map((p) => {
          const s = toSnapshotRow(p);
          return stmt.bind(
            areaId, batchId, s.parcel_key, s.state, s.county, s.parcel_number,
            s.address_full, s.owner_name, s.zoning_code, s.acres, s.use_code,
            s.building_count, s.year_built, s.total_assessed_value, s.total_market_value,
            s.transfer_date, s.transfer_price, s.foreclose_code, s.vacant_flag,
            s.latitude, s.longitude, s.raw_json
          );
        });
        if (batch.length) await env.DB.batch(batch);
        await env.DB.prepare("UPDATE watch_areas SET last_refreshed = datetime('now') WHERE id = ?")
          .bind(areaId).run();
        // Prune: keep only the two most-recent batches for this area.
        const { results: keep } = await env.DB.prepare(
          `SELECT DISTINCT batch_id FROM parcel_snapshots WHERE area_id = ?
             ORDER BY batch_id DESC LIMIT 2`
        ).bind(areaId).all();
        const keepIds = keep.map((r) => r.batch_id);
        if (keepIds.length) {
          const ph = keepIds.map(() => "?").join(",");
          await env.DB.prepare(
            `DELETE FROM parcel_snapshots WHERE area_id = ? AND batch_id NOT IN (${ph})`
          ).bind(areaId, ...keepIds).run();
        }
        return json({ ok: true, stored: batch.length, batch_id: batchId }, 200, allowOrigin);
      }

      // Diff the two newest batches → the "since last visit" change feed.
      const changeMatch = path.match(/^\/db\/areas\/(\d+)\/changes$/);
      if (changeMatch && request.method === "GET") {
        const areaId = changeMatch[1];
        const { results: batches } = await env.DB.prepare(
          `SELECT DISTINCT batch_id FROM parcel_snapshots WHERE area_id = ?
             ORDER BY batch_id DESC LIMIT 2`
        ).bind(areaId).all();
        const newest = batches[0]?.batch_id;
        const prev = batches[1]?.batch_id;
        if (!newest) return json({ current: [], new: [], sold: [], valueChanged: [], firstLook: true }, 200, allowOrigin);
        const cur = (await env.DB.prepare(
          "SELECT * FROM parcel_snapshots WHERE area_id = ? AND batch_id = ?"
        ).bind(areaId, newest).all()).results;
        if (!prev) return json({ current: cur, new: [], sold: [], valueChanged: [], firstLook: true }, 200, allowOrigin);
        const old = (await env.DB.prepare(
          "SELECT * FROM parcel_snapshots WHERE area_id = ? AND batch_id = ?"
        ).bind(areaId, prev).all()).results;
        const oldMap = new Map(old.map((r) => [r.parcel_key, r]));
        const isNew = [], sold = [], valueChanged = [];
        for (const c of cur) {
          const o = oldMap.get(c.parcel_key);
          if (!o) { isNew.push(c); continue; }
          if ((c.owner_name || "") !== (o.owner_name || "") ||
              (c.transfer_date || "") !== (o.transfer_date || "")) sold.push(c);
          else if ((c.total_assessed_value || 0) !== (o.total_assessed_value || 0) ||
                   (c.total_market_value || 0) !== (o.total_market_value || 0)) {
            valueChanged.push({ ...c, prev_assessed: o.total_assessed_value, prev_market: o.total_market_value });
          }
        }
        return json({ current: cur, new: isNew, sold, valueChanged, firstLook: false }, 200, allowOrigin);
      }

      // ── D1: findings (precious human data) ────────────────────────────────
      if (path === "/db/findings" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM findings ORDER BY starred DESC, updated_at DESC"
        ).all();
        return json({ findings: results }, 200, allowOrigin);
      }
      const findMatch = path.match(/^\/db\/findings\/(.+)$/);
      if (findMatch) {
        const key = decodeURIComponent(findMatch[1]);
        if (request.method === "GET") {
          const row = await env.DB.prepare("SELECT * FROM findings WHERE parcel_key = ?").bind(key).first();
          return json({ finding: row || null }, 200, allowOrigin);
        }
        if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM findings WHERE parcel_key = ?").bind(key).run();
          return json({ ok: true }, 200, allowOrigin);
        }
        if (request.method === "PUT") {
          const b = await request.json();
          // Upsert by the stable parcel_key. Snapshots can come and go; this stays.
          await env.DB.prepare(
            `INSERT INTO findings
               (parcel_key, state, county, parcel_number, address_full, note, status,
                has_power, has_water, has_septic, starred, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
             ON CONFLICT(parcel_key) DO UPDATE SET
               address_full = excluded.address_full,
               note         = excluded.note,
               status       = excluded.status,
               has_power    = excluded.has_power,
               has_water    = excluded.has_water,
               has_septic   = excluded.has_septic,
               starred      = excluded.starred,
               updated_at   = datetime('now')`
          ).bind(
            key, b.state || null, b.county || null, b.parcel_number || null,
            b.address_full || null, b.note || null, b.status || "watching",
            b.has_power ? 1 : 0, b.has_water ? 1 : 0, b.has_septic ? 1 : 0, b.starred ? 1 : 0
          ).run();
          return json({ ok: true }, 200, allowOrigin);
        }
      }

      return json({ error: "Not found", path }, 404, allowOrigin);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500, allowOrigin);
    }
  },
};
