// Tag writeback route — Phase 7c.
//
// POST /api/tags/:pointId/write { value, quality? }
//
// The highest-risk operation in FORGE: pushes a value back to a
// physical device through the connector orchestrator (publish on
// MQTT, Session.write on OPC UA). Per spec §15.2:
//
//   "Write operations to devices (tag writeback, OPC UA write,
//    MQTT command publish) are gated by a separate
//    CAN_WRITE_DEVICE capability, not just general write permission.
//    This is the highest-risk operation in the system."
//
// FORGE's expression: the new `device.write` capability (see
// server/auth.js). Granted only to Workspace Admin + Org Owner.
// Per-route rate limit: 10 writes / minute / authenticated user
// (the global limit is 600/min). A misconfigured automation or a
// compromised credential cannot fire setpoint writes at full
// route capacity.
//
// Every call audits twice — `device.write.attempt` records intent
// before dispatch (so a registry-side crash still leaves a trace),
// then either `device.write.success` or `device.write.fail` records
// the result. Spec §22 anti-pattern row: "Write operations to
// devices not in the audit log".
//
// Out of scope for this phase (queued for 7d):
//   - Live OPC UA address-space refresh on hierarchy / asset /
//     binding writes.
//   - WriteValue Method node on the FORGE-as-OPC-UA-server.

import { db } from "../db.js";
import { audit } from "../audit.js";
import { require_ } from "../auth.js";
import { broadcast } from "../sse.js";
import { tenantOrgId } from "../tenant.js";
import { sendError } from "../errors.js";
import { writeBindingValue } from "../connectors/registry.js";
import { NonEmptyString } from "../schemas/common.js";

const TagWriteBody = {
  type: "object",
  required: ["value"],
  additionalProperties: true,
  properties: {
    value: { type: ["number", "boolean", "string"] },
    quality: { type: "string", enum: ["Good", "Uncertain", "Bad", "Substituted"] },
    note: NonEmptyString(1024),
  },
};

export default async function tagWritebackRoutes(fastify) {
  fastify.post("/api/tags/:pointId/write", {
    // device.write is the highest-risk capability in FORGE per spec
    // §15.2. Per-route rate limit is intentionally strict: 10 writes
    // per minute per authenticated user (the global limit is
    // 600/min). A misconfigured automation or compromised credential
    // can't fire setpoint writes at full route capacity. Operators
    // with bulk-setpoint use cases should drive a dedicated batch
    // endpoint (separate follow-up) so the per-write audit trail
    // stays intact.
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    preHandler: require_("device.write"),
    schema: { body: TagWriteBody },
  }, async (req, reply) => {
    const orgId = tenantOrgId(req);
    if (!orgId) return sendError(reply, { status: 401 });

    const point = db.prepare("SELECT * FROM historian_points WHERE id = ?").get(req.params.pointId);
    if (!point) return sendError(reply, { status: 404, code: "not_found", message: "tag not found" });

    // Tenant-scope through the asset row that owns the point.
    const asset = db.prepare("SELECT * FROM assets WHERE id = ?").get(point.asset_id);
    if (!asset || asset.org_id !== orgId) {
      return sendError(reply, { status: 404, code: "not_found", message: "tag not found" });
    }

    // The binding row carries the source_kind / system_id / source_path
    // that the orchestrator's writeBindingValue() needs.
    const binding = db.prepare(
      "SELECT * FROM asset_point_bindings WHERE point_id = ? AND enabled = 1 LIMIT 1"
    ).get(point.id);
    if (!binding) {
      return sendError(reply, {
        status: 409,
        code: "no_active_binding",
        message: "no enabled binding for this tag — apply a profile first",
      });
    }

    const { value, quality = "Good", note = null } = req.body || {};
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) && typeof value !== "boolean" && typeof value !== "string") {
      return sendError(reply, { status: 400, code: "bad_value", message: "value must be number, boolean, or string" });
    }

    // Audit FIRST so even a registry-side dispatch failure leaves a
    // record of intent (defense in depth: an attacker who finds a
    // way to crash dispatch can't silently write without a trace).
    audit({
      actor: req.user.id,
      action: "device.write.attempt",
      subject: point.id,
      detail: {
        bindingId: binding.id,
        assetId: point.asset_id,
        sourceKind: binding.source_kind,
        sourcePath: binding.source_path,
        systemId: binding.system_id,
        value: typeof value === "number" ? value : String(value),
        quality,
        note,
      },
    });

    const result = await writeBindingValue({ binding, value: numeric, quality });

    audit({
      actor: req.user.id,
      action: result.ok ? "device.write.success" : "device.write.fail",
      subject: point.id,
      detail: { bindingId: binding.id, ...result },
    });
    broadcast("tag-writeback", {
      pointId: point.id,
      bindingId: binding.id,
      assetId: point.asset_id,
      value: numeric,
      ok: result.ok,
      code: result.code || null,
    }, orgId);

    if (!result.ok) {
      return sendError(reply, {
        status: result.code === "unsupported_writeback" ? 405 : 502,
        code: result.code || "writeback_failed",
        message: result.message || "writeback failed",
      });
    }
    return { ok: true, pointId: point.id, bindingId: binding.id, dispatch: result };
  });
}
