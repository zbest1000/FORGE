// Operations data routes: historians, recipe management, and Modbus TCP maps.

import { db, now, uuid, jsonOrDefault } from "../db.js";
import { audit } from "../audit.js";
import { require_ } from "../auth.js";
import { broadcast } from "../sse.js";
import {
  archiveRecipeEvent,
  listHistorianBackends,
  readHistorianSamples,
  summaryFor,
  writeHistorianSample,
} from "../historians/index.js";
import { writeModbusValue } from "../connectors/modbus.js";

function pointRow(row) {
  if (!row) return null;
  return {
    ...row,
    source: row.source_id ? db.prepare("SELECT * FROM data_sources WHERE id = ?").get(row.source_id) || null : null,
  };
}

function recipeRow(row) {
  if (!row) return null;
  const versions = db.prepare("SELECT * FROM recipe_versions WHERE recipe_id = ? ORDER BY version DESC").all(row.id)
    .map(v => ({ ...v, parameters: jsonOrDefault(v.parameters, {}) }));
  return { ...row, versions };
}

function modbusRegisterRow(row) {
  return row ? { ...row, scale: Number(row.scale) } : null;
}

function parseIso(value, fallback) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.valueOf()) ? d.toISOString() : fallback;
}

export default async function operationsRoutes(fastify) {
  fastify.get("/api/historian/backends", { preHandler: require_("view") }, async () => ({ backends: listHistorianBackends() }));

  fastify.get("/api/historian/points", { preHandler: require_("view") }, async (req) => {
    const assetId = req.query.assetId ? String(req.query.assetId) : null;
    const rows = assetId
      ? db.prepare("SELECT * FROM historian_points WHERE asset_id = ? ORDER BY tag").all(assetId)
      : db.prepare("SELECT * FROM historian_points ORDER BY tag").all();
    return rows.map(pointRow);
  });

  fastify.post("/api/historian/points", { preHandler: require_("integration.write") }, async (req, reply) => {
    const { assetId, sourceId = null, tag, name, unit = null, dataType = "number", historian = "sqlite", retentionPolicyId = null } = req.body || {};
    if (!assetId || !tag || !name) return reply.code(400).send({ error: "assetId, tag, and name required" });
    const asset = db.prepare("SELECT id FROM assets WHERE id = ?").get(assetId);
    if (!asset) return reply.code(404).send({ error: "asset not found" });
    const id = uuid("HP");
    db.prepare(`INSERT INTO historian_points (id, asset_id, source_id, tag, name, unit, data_type, historian, retention_policy_id, created_at, updated_at)
                VALUES (@id, @assetId, @sourceId, @tag, @name, @unit, @dataType, @historian, @retentionPolicyId, @now, @now)`)
      .run({ id, assetId, sourceId, tag, name, unit, dataType, historian, retentionPolicyId, now: now() });
    audit({ actor: req.user.id, action: "historian.point.create", subject: id, detail: { assetId, tag } });
    broadcast("historian", { id, assetId, tag });
    return pointRow(db.prepare("SELECT * FROM historian_points WHERE id = ?").get(id));
  });

  fastify.get("/api/historian/samples", { preHandler: require_("view") }, async (req, reply) => {
    const pointId = req.query.pointId ? String(req.query.pointId) : null;
    const tag = req.query.tag ? String(req.query.tag) : null;
    const point = pointId
      ? db.prepare("SELECT * FROM historian_points WHERE id = ?").get(pointId)
      : tag ? db.prepare("SELECT * FROM historian_points WHERE tag = ?").get(tag) : null;
    if (!point) return reply.code(400).send({ error: "pointId or tag required" });
    const limit = Math.min(5000, Number(req.query.limit || 500));
    const since = parseIso(req.query.since, "1970-01-01T00:00:00.000Z");
    const until = parseIso(req.query.until, "9999-12-31T23:59:59.999Z");
    const result = await readHistorianSamples(point, { since, until, limit });
    return { point: pointRow(point), samples: result.samples, backend: result.backend, fallbackFrom: result.fallbackFrom || null };
  });

  fastify.post("/api/historian/samples", { preHandler: require_("integration.write") }, async (req, reply) => {
    const { pointId, tag, ts = now(), value, quality = "Good", sourceType = "api", rawPayload = {} } = req.body || {};
    const point = pointId
      ? db.prepare("SELECT * FROM historian_points WHERE id = ?").get(pointId)
      : tag ? db.prepare("SELECT * FROM historian_points WHERE tag = ?").get(tag) : null;
    if (!point) return reply.code(400).send({ error: "valid pointId or tag required" });
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return reply.code(400).send({ error: "numeric value required" });
    const { sample, backend } = await writeHistorianSample(point, { ts: parseIso(ts, now()), value: numeric, quality, sourceType, rawPayload });
    audit({ actor: req.user.id, action: "historian.sample.ingest", subject: point.id, detail: { value: numeric, quality } });
    broadcast("historian", { pointId: point.id, value: numeric, ts: sample.ts, backend });
    return { ...sample, backend };
  });

  fastify.get("/api/historian/trends", { preHandler: require_("view") }, async (req, reply) => {
    const assetId = req.query.assetId ? String(req.query.assetId) : null;
    const points = req.query.pointIds
      ? String(req.query.pointIds).split(",").map(s => s.trim()).filter(Boolean)
      : assetId ? db.prepare("SELECT id FROM historian_points WHERE asset_id = ? ORDER BY tag").all(assetId).map(r => r.id) : [];
    if (!points.length) return reply.code(400).send({ error: "assetId or pointIds required" });
    const since = parseIso(req.query.since, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const until = parseIso(req.query.until, now());
    const limit = Math.min(5000, Number(req.query.limit || 1000));
    const series = await Promise.all(points.map(id => {
      const point = db.prepare("SELECT * FROM historian_points WHERE id = ?").get(id);
      if (!point) return null;
      return readHistorianSamples(point, { since, until, limit }).then(result => ({
        point: pointRow(point),
        samples: result.samples,
        summary: summaryFor(result.samples),
        backend: result.backend,
        fallbackFrom: result.fallbackFrom || null,
      }));
    }));
    const visibleSeries = series.filter(Boolean);
    return { since, until, series: visibleSeries };
  });

  fastify.get("/api/recipes", { preHandler: require_("view") }, async (req) => {
    const assetId = req.query.assetId ? String(req.query.assetId) : null;
    const rows = assetId
      ? db.prepare("SELECT * FROM recipes WHERE asset_id = ? ORDER BY name").all(assetId)
      : db.prepare("SELECT * FROM recipes ORDER BY name").all();
    return rows.map(recipeRow);
  });

  fastify.post("/api/recipes", { preHandler: require_("edit") }, async (req, reply) => {
    const { assetId = null, name, parameters = {}, notes = "" } = req.body || {};
    if (!name) return reply.code(400).send({ error: "name required" });
    const id = uuid("RCP");
    const versionId = uuid("RCV");
    const ts = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO recipes (id, asset_id, name, status, current_version_id, created_by, created_at, updated_at)
                  VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`).run(id, assetId, name, versionId, req.user.id, ts, ts);
      db.prepare(`INSERT INTO recipe_versions (id, recipe_id, version, state, parameters, notes, created_by, created_at)
                  VALUES (?, ?, 1, 'draft', ?, ?, ?, ?)`).run(versionId, id, JSON.stringify(parameters || {}), notes, req.user.id, ts);
    })();
    audit({ actor: req.user.id, action: "recipe.create", subject: id, detail: { assetId, name } });
    await archiveRecipeEvent("recipe.create", db.prepare("SELECT * FROM recipes WHERE id = ?").get(id)).catch(() => null);
    broadcast("recipes", { id, assetId });
    return recipeRow(db.prepare("SELECT * FROM recipes WHERE id = ?").get(id));
  });

  fastify.post("/api/recipes/:id/versions", { preHandler: require_("edit") }, async (req, reply) => {
    const recipe = db.prepare("SELECT * FROM recipes WHERE id = ?").get(req.params.id);
    if (!recipe) return reply.code(404).send({ error: "recipe not found" });
    const next = (db.prepare("SELECT MAX(version) AS v FROM recipe_versions WHERE recipe_id = ?").get(recipe.id)?.v || 0) + 1;
    const id = uuid("RCV");
    const { parameters = {}, notes = "" } = req.body || {};
    db.prepare(`INSERT INTO recipe_versions (id, recipe_id, version, state, parameters, notes, created_by, created_at)
                VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`).run(id, recipe.id, next, JSON.stringify(parameters || {}), notes, req.user.id, now());
    db.prepare("UPDATE recipes SET current_version_id = ?, status = 'draft', updated_at = ? WHERE id = ?").run(id, now(), recipe.id);
    audit({ actor: req.user.id, action: "recipe.version.create", subject: recipe.id, detail: { version: next } });
    await archiveRecipeEvent("recipe.version.create", db.prepare("SELECT * FROM recipes WHERE id = ?").get(recipe.id), db.prepare("SELECT * FROM recipe_versions WHERE id = ?").get(id)).catch(() => null);
    broadcast("recipes", { id: recipe.id, version: next });
    return recipeRow(db.prepare("SELECT * FROM recipes WHERE id = ?").get(recipe.id));
  });

  fastify.post("/api/recipes/:id/activate", { preHandler: require_("approve") }, async (req, reply) => {
    const recipe = db.prepare("SELECT * FROM recipes WHERE id = ?").get(req.params.id);
    if (!recipe) return reply.code(404).send({ error: "recipe not found" });
    const versionId = req.body?.versionId || recipe.current_version_id;
    const version = db.prepare("SELECT * FROM recipe_versions WHERE id = ? AND recipe_id = ?").get(versionId, recipe.id);
    if (!version) return reply.code(400).send({ error: "valid versionId required" });
    const ts = now();
    db.transaction(() => {
      db.prepare("UPDATE recipe_versions SET state = 'superseded' WHERE recipe_id = ? AND state = 'active'").run(recipe.id);
      db.prepare("UPDATE recipe_versions SET state = 'active', approved_by = ?, approved_at = ? WHERE id = ?").run(req.user.id, ts, version.id);
      db.prepare("UPDATE recipes SET status = 'active', current_version_id = ?, updated_at = ? WHERE id = ?").run(version.id, ts, recipe.id);
    })();
    audit({ actor: req.user.id, action: "recipe.activate", subject: recipe.id, detail: { version: version.version } });
    await archiveRecipeEvent("recipe.activate", db.prepare("SELECT * FROM recipes WHERE id = ?").get(recipe.id), version).catch(() => null);
    broadcast("recipes", { id: recipe.id, activeVersionId: version.id });
    return recipeRow(db.prepare("SELECT * FROM recipes WHERE id = ?").get(recipe.id));
  });

  fastify.get("/api/modbus/devices", { preHandler: require_("integration.read") }, async () => {
    const devices = db.prepare("SELECT * FROM modbus_devices ORDER BY name").all()
      .map(d => ({ ...d, config: jsonOrDefault(d.config, {}) }));
    return devices.map(device => ({
      ...device,
      registers: db.prepare("SELECT * FROM modbus_registers WHERE device_id = ? ORDER BY address").all(device.id).map(modbusRegisterRow),
    }));
  });

  fastify.post("/api/modbus/devices", { preHandler: require_("integration.write") }, async (req, reply) => {
    const { name, host, port = 502, unitId = 1, integrationId = "INT-MODBUS", config = {} } = req.body || {};
    if (!name || !host) return reply.code(400).send({ error: "name and host required" });
    const id = uuid("MBD");
    db.prepare(`INSERT INTO modbus_devices (id, integration_id, name, host, port, unit_id, status, config, created_at, updated_at)
                VALUES (@id, @integrationId, @name, @host, @port, @unitId, 'configured', @config, @now, @now)`)
      .run({ id, integrationId, name, host, port: Number(port), unitId: Number(unitId), config: JSON.stringify(config || {}), now: now() });
    audit({ actor: req.user.id, action: "modbus.device.create", subject: id, detail: { host, port } });
    return db.prepare("SELECT * FROM modbus_devices WHERE id = ?").get(id);
  });

  fastify.post("/api/modbus/registers", { preHandler: require_("integration.write") }, async (req, reply) => {
    const { deviceId, assetId = null, pointId = null, name, address, functionCode = 3, dataType = "float32", scale = 1, unit = null, pollingMs = 1000 } = req.body || {};
    if (!deviceId || !name || !Number.isInteger(Number(address))) return reply.code(400).send({ error: "deviceId, name, and address required" });
    const device = db.prepare("SELECT * FROM modbus_devices WHERE id = ?").get(deviceId);
    if (!device) return reply.code(404).send({ error: "device not found" });
    const id = uuid("MBR");
    db.prepare(`INSERT INTO modbus_registers (id, device_id, asset_id, point_id, name, address, function_code, data_type, scale, unit, polling_ms, created_at, updated_at)
                VALUES (@id, @deviceId, @assetId, @pointId, @name, @address, @functionCode, @dataType, @scale, @unit, @pollingMs, @now, @now)`)
      .run({ id, deviceId, assetId, pointId, name, address: Number(address), functionCode: Number(functionCode), dataType, scale: Number(scale), unit, pollingMs: Number(pollingMs), now: now() });
    audit({ actor: req.user.id, action: "modbus.register.create", subject: id, detail: { deviceId, address } });
    return modbusRegisterRow(db.prepare("SELECT * FROM modbus_registers WHERE id = ?").get(id));
  });

  fastify.post("/api/modbus/registers/:id/read", { preHandler: require_("integration.write") }, async (req, reply) => {
    const reg = db.prepare("SELECT * FROM modbus_registers WHERE id = ?").get(req.params.id);
    if (!reg) return reply.code(404).send({ error: "register not found" });
    const raw = Number(req.body?.rawValue ?? req.body?.value);
    if (!Number.isFinite(raw)) return reply.code(400).send({ error: "rawValue required" });
    const value = raw * Number(reg.scale || 1);
    const quality = req.body?.quality || "Good";
    const ts = parseIso(req.body?.ts, now());
    let historianResult = null;
    db.transaction(() => {
      db.prepare("UPDATE modbus_registers SET last_value = ?, last_quality = ?, last_seen = ?, updated_at = ? WHERE id = ?")
        .run(value, quality, ts, now(), reg.id);
      db.prepare("UPDATE modbus_devices SET status = 'connected', last_poll_at = ?, updated_at = ? WHERE id = ?").run(ts, now(), reg.device_id);
    })();
    if (reg.point_id) {
      const point = db.prepare("SELECT * FROM historian_points WHERE id = ?").get(reg.point_id);
      if (point) historianResult = await writeHistorianSample(point, { ts, value, quality, sourceType: "modbus_tcp", rawPayload: { rawValue: raw, registerId: reg.id } });
    }
    audit({ actor: req.user.id, action: "modbus.register.read", subject: reg.id, detail: { rawValue: raw, value, quality } });
    broadcast("modbus", { id: reg.id, value, ts, historian: historianResult?.backend || null });
    return { ...modbusRegisterRow(db.prepare("SELECT * FROM modbus_registers WHERE id = ?").get(reg.id)), historian_backend: historianResult?.backend || null };
  });

  fastify.post("/api/modbus/registers/:id/write", { preHandler: require_("integration.write") }, async (req, reply) => {
    const reg = db.prepare("SELECT * FROM modbus_registers WHERE id = ?").get(req.params.id);
    if (!reg) return reply.code(404).send({ error: "register not found" });
    const device = db.prepare("SELECT * FROM modbus_devices WHERE id = ?").get(reg.device_id);
    if (!device) return reply.code(404).send({ error: "device not found" });
    const value = Number(req.body?.value);
    if (!Number.isFinite(value)) return reply.code(400).send({ error: "value required" });
    const ts = parseIso(req.body?.ts, now());
    const quality = "Written";
    const write = await writeModbusValue(device, reg, { value, rawValue: req.body?.rawValue });
    let historianResult = null;
    db.transaction(() => {
      db.prepare("UPDATE modbus_registers SET last_value = ?, last_quality = ?, last_seen = ?, updated_at = ? WHERE id = ?")
        .run(value, quality, ts, now(), reg.id);
      db.prepare("UPDATE modbus_devices SET status = ?, last_poll_at = ?, updated_at = ? WHERE id = ?")
        .run(write.written ? "connected" : "configured", ts, now(), reg.device_id);
    })();
    if (reg.point_id) {
      const point = db.prepare("SELECT * FROM historian_points WHERE id = ?").get(reg.point_id);
      if (point) historianResult = await writeHistorianSample(point, { ts, value, quality, sourceType: "modbus_tcp_write", rawPayload: { registerId: reg.id, write } });
    }
    audit({ actor: req.user.id, action: "modbus.register.write", subject: reg.id, detail: { value, write } });
    broadcast("modbus", { id: reg.id, value, ts, write, historian: historianResult?.backend || null });
    return { ...modbusRegisterRow(db.prepare("SELECT * FROM modbus_registers WHERE id = ?").get(reg.id)), write, historian_backend: historianResult?.backend || null };
  });
}
