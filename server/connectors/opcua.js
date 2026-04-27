// OPC UA ingress bridge — subscribes to monitored nodes on an OPC UA server
// and pipes value changes through the canonical event pipeline as
// `state_change` events.
//
// Env:
//   FORGE_OPCUA_URL      e.g. opc.tcp://plc.local:4840
//   FORGE_OPCUA_NODES    comma-separated node IDs, e.g. "ns=2;s=HX01.Temp,ns=2;s=Feeder.A1.Current"
//
// `node-opcua` is declared as an **optional** dependency. If it isn't
// installed (some environments can't build the native side), the bridge
// logs a notice and does nothing. Everything else in the server keeps
// working.

import { ingest } from "../events.js";

let _client = null;

function strictMode(env = process.env) {
  if (/^(1|true|yes|on)$/i.test(String(env.FORGE_STRICT_CONFIG || ""))) return true;
  return env.NODE_ENV === "production";
}

function resolveSecurity(node_opcua, env = process.env) {
  const { MessageSecurityMode, SecurityPolicy } = node_opcua;
  const mode = String(env.FORGE_OPCUA_SECURITY_MODE || (strictMode(env) ? "SignAndEncrypt" : "None"));
  const policy = String(env.FORGE_OPCUA_SECURITY_POLICY || (strictMode(env) ? "Basic256Sha256" : "None"));
  if (strictMode(env) && (mode === "None" || policy === "None")) {
    throw new Error(
      "OPC UA bridge in strict/production mode requires FORGE_OPCUA_SECURITY_MODE and FORGE_OPCUA_SECURITY_POLICY to be set to non-None values; " +
      "received mode='" + mode + "' policy='" + policy + "'"
    );
  }
  const resolvedMode = MessageSecurityMode[mode] ?? MessageSecurityMode.None;
  const resolvedPolicy = SecurityPolicy[policy] ?? SecurityPolicy.None;
  return { mode: resolvedMode, policy: resolvedPolicy, modeName: mode, policyName: policy };
}

export async function startOpcuaBridge(logger) {
  const url = process.env.FORGE_OPCUA_URL;
  if (!url) { logger.info("OPC UA bridge disabled (set FORGE_OPCUA_URL to enable)"); return; }
  let node_opcua;
  try {
    node_opcua = await import("node-opcua");
  } catch (err) {
    logger.warn({ err: String(err?.message || err) }, "OPC UA bridge requested but node-opcua is not installed; skipping");
    return;
  }

  const { OPCUAClient, AttributeIds, ClientSubscription, TimestampsToReturn } = node_opcua;
  const nodeIds = (process.env.FORGE_OPCUA_NODES || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!nodeIds.length) { logger.warn("FORGE_OPCUA_NODES is empty — bridge started with 0 subscriptions"); }

  let security;
  try { security = resolveSecurity(node_opcua); }
  catch (err) {
    logger.error({ err: String(err?.message || err) }, "OPC UA bridge configuration is unsafe; refusing to start");
    return;
  }
  if (security.modeName === "None" || security.policyName === "None") {
    logger.warn({ mode: security.modeName, policy: security.policyName }, "OPC UA bridge running without transport security; do not use in production");
  }

  const client = OPCUAClient.create({
    applicationName: "FORGE",
    securityMode: security.mode,
    securityPolicy: security.policy,
    endpointMustExist: false,
    connectionStrategy: { initialDelay: 1000, maxRetry: 5 },
  });
  _client = client;

  try {
    logger.info({ url }, "OPC UA bridge connecting");
    await client.connect(url);
    const session = await client.createSession();
    const subscription = ClientSubscription.create(session, {
      requestedPublishingInterval: 1000,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 10,
    });

    for (const nid of nodeIds) {
      const item = await subscription.monitor(
        { nodeId: nid, attributeId: AttributeIds.Value },
        { samplingInterval: 1000, discardOldest: true, queueSize: 10 },
        TimestampsToReturn.Both
      );
      item.on("changed", (dataValue) => {
        ingest({
          event_type: "state_change",
          severity: "info",
          asset_ref: null,
          payload: { nodeId: nid, value: dataValue.value?.value, dataType: dataValue.value?.dataType },
          dedupe_key: `opcua:${nid}:${Date.parse(dataValue.sourceTimestamp || new Date()) || Date.now()}`,
        }, { source: nid, source_type: "opcua" });
      });
    }
    logger.info({ subscribed: nodeIds.length }, "OPC UA bridge subscribed");
  } catch (err) {
    logger.error({ err: String(err?.message || err) }, "OPC UA bridge failed to start");
  }
}

export async function stopOpcuaBridge() {
  try { await _client?.disconnect?.(); } catch { /* noop */ }
  _client = null;
}
