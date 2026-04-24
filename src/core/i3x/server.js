// In-memory i3X-compatible API engine.
//
// Mirrors the CESMII i3X 1.0 Beta OpenAPI surface:
//   GET  /info
//   GET  /namespaces
//   GET  /objecttypes
//   POST /objecttypes/query
//   GET  /relationshiptypes
//   POST /relationshiptypes/query
//   GET  /objects
//   POST /objects/list
//   POST /objects/related
//   POST /objects/value
//   POST /objects/history
//   GET  /objects/{elementId}/history
//   PUT  /objects/{elementId}/value
//   PUT  /objects/{elementId}/history
//   POST /subscriptions
//   POST /subscriptions/register
//   POST /subscriptions/unregister
//   POST /subscriptions/stream        (implemented via callback handles)
//   POST /subscriptions/sync
//   POST /subscriptions/delete
//   POST /subscriptions/list
//
// Uses the BulkResponse / SuccessResponse envelopes. VQT = value/quality/timestamp.

import { buildUns } from "../../data/uns-seed.js";
import { ancestors } from "./uns.js";

export const I3X_INFO = {
  version: "1.0-Beta",
  apiVersion: "v1",
  implementation: "FORGE (in-browser, reference i3X-compatible engine)",
  capabilities: {
    explore: true,
    query: true,
    update: true,
    history: true,
    subscribe: true,
    bulkResponses: true,
    relationships: true,
    composition: "instance-only",
    streaming: "sse-compatible",
  },
  vendor: "FORGE",
};

export function createI3XServer(forgeData) {
  const uns = buildUns(forgeData);
  const history = new Map();        // elementId -> [{value, quality, timestamp}]
  const lastValue = new Map();      // elementId -> {value, quality, timestamp}
  const subscriptions = new Map();  // subscriptionId -> { clientId, displayName, items:Set, queue:[{sequenceNumber, elementId, value, quality, timestamp}], nextSeq, listeners:Set }

  // Seed initial values + history for every variable.
  for (const obj of uns.objects) {
    if (isVariable(obj)) {
      const iv = obj.initialValue || { value: 0, quality: "Uncertain" };
      const rec = { value: iv.value, quality: iv.quality || "Good", timestamp: nowISO() };
      lastValue.set(obj.elementId, rec);
      history.set(obj.elementId, [rec]);
    }
  }

  // --------- Envelope helpers ---------
  const ok = (data) => ({ success: true, data });
  const bulk = (results) => ({ success: true, results });
  const err = (code, message) => ({ success: false, error: { code, message } });

  // --------- Info / Explore ---------
  function getInfo() {
    return ok({
      ...I3X_INFO,
      namespaces: uns.namespaces.length,
      objectTypes: uns.objectTypes.length,
      relationshipTypes: uns.relationshipTypes.length,
      objects: uns.objects.length,
      subscriptions: subscriptions.size,
      timestamp: nowISO(),
    });
  }

  function getNamespaces() {
    return ok(uns.namespaces.slice());
  }

  function getObjectTypes(namespaceUri) {
    const list = namespaceUri
      ? uns.objectTypes.filter(t => t.namespaceUri === namespaceUri)
      : uns.objectTypes.slice();
    return ok(list);
  }

  function queryObjectTypesById({ elementIds }) {
    return bulk((elementIds || []).map(id => {
      const t = uns.objectTypes.find(x => x.elementId === id);
      return t
        ? { success: true, elementId: id, result: t }
        : { success: false, elementId: id, error: { code: 404, message: `ObjectType ${id} not found` } };
    }));
  }

  function getRelationshipTypes(namespaceUri) {
    const list = namespaceUri
      ? uns.relationshipTypes.filter(t => t.namespaceUri === namespaceUri)
      : uns.relationshipTypes.slice();
    return ok(list);
  }

  function queryRelationshipTypesById({ elementIds }) {
    return bulk((elementIds || []).map(id => {
      const t = uns.relationshipTypes.find(x => x.elementId === id);
      return t
        ? { success: true, elementId: id, result: t }
        : { success: false, elementId: id, error: { code: 404, message: `RelationshipType ${id} not found` } };
    }));
  }

  function getObjects({ typeElementId = null, includeMetadata = false, root = null } = {}) {
    let list = uns.objects;
    if (typeElementId) list = list.filter(o => o.typeElementId === typeElementId);
    if (root === true) {
      const childIds = new Set();
      for (const r of uns.relationships) {
        if (r.relationshipType === "rel:HasChild" || r.relationshipType === "rel:HasComponent") {
          childIds.add(r.targetElementId);
        }
      }
      list = list.filter(o => !childIds.has(o.elementId));
    }
    return ok(list.map(o => toInstance(o, includeMetadata)));
  }

  function listObjectsById({ elementIds, includeMetadata = false }) {
    return bulk((elementIds || []).map(id => {
      const o = resolveObject(id);
      return o
        ? { success: true, elementId: o.elementId, result: toInstance(o, includeMetadata) }
        : { success: false, elementId: id, error: { code: 404, message: `Object ${id} not found` } };
    }));
  }

  function queryRelatedObjects({ elementIds, relationshipType = null, includeMetadata = false }) {
    return bulk((elementIds || []).map(id => {
      const o = resolveObject(id);
      if (!o) return { success: false, elementId: id, error: { code: 404, message: `Object ${id} not found` } };
      const rels = (uns.indexes.childIndex.get(o.elementId) || [])
        .filter(r => !relationshipType || r.relationshipType === relationshipType);
      const list = rels.map(r => {
        const tgt = uns.indexes.objectsById.get(r.targetElementId);
        return {
          relationshipType: r.relationshipType,
          object: tgt ? toInstance(tgt, includeMetadata) : null,
        };
      }).filter(x => x.object);
      return { success: true, elementId: o.elementId, result: list };
    }));
  }

  // --------- Values / History ---------
  function queryLastKnownValues({ elementIds, maxDepth = 1 }) {
    return bulk((elementIds || []).map(id => {
      const o = resolveObject(id);
      if (!o) return { success: false, elementId: id, error: { code: 404, message: `Object ${id} not found` } };
      return { success: true, elementId: o.elementId, result: collectCurrent(o, maxDepth) };
    }));
  }

  function queryHistoricalValues({ elementIds, startTime, endTime, maxDepth = 1 }) {
    return bulk((elementIds || []).map(id => {
      const o = resolveObject(id);
      if (!o) return { success: false, elementId: id, error: { code: 404, message: `Object ${id} not found` } };
      return { success: true, elementId: o.elementId, result: collectHistory(o, startTime, endTime, maxDepth) };
    }));
  }

  function getHistoricalValues(elementId, { startTime, endTime, maxDepth = 1 } = {}) {
    const o = resolveObject(elementId);
    if (!o) return err(404, `Object ${elementId} not found`);
    return ok(collectHistory(o, startTime, endTime, maxDepth));
  }

  function updateObjectValue(elementId, body) {
    const o = resolveObject(elementId);
    if (!o) return err(404, `Object ${elementId} not found`);
    if (!isVariable(o)) return err(400, `Object ${elementId} is not a variable`);
    const rec = normalizeVQT(body);
    lastValue.set(o.elementId, rec);
    appendHistory(o.elementId, rec);
    fanoutUpdate(o.elementId, rec);
    return ok(null);
  }

  function updateObjectHistory(elementId, body) {
    const o = resolveObject(elementId);
    if (!o) return err(404, `Object ${elementId} not found`);
    if (!isVariable(o)) return err(400, `Object ${elementId} is not a variable`);
    const entries = Array.isArray(body) ? body : [body];
    for (const e of entries) appendHistory(o.elementId, normalizeVQT(e));
    return ok(null);
  }

  // --------- Subscriptions ---------
  function createSubscription({ clientId = null, displayName = null } = {}) {
    const subscriptionId = "sub-" + Math.random().toString(36).slice(2, 10);
    subscriptions.set(subscriptionId, {
      clientId, displayName, items: new Set(), queue: [], nextSeq: 1, listeners: new Set(),
    });
    return ok({ clientId, subscriptionId, displayName });
  }

  function registerMonitoredItems({ subscriptionId, elementIds }) {
    const sub = subscriptions.get(subscriptionId);
    if (!sub) return err(404, `Subscription ${subscriptionId} not found`);
    return bulk((elementIds || []).map(id => {
      const o = resolveObject(id);
      if (!o) return { success: false, elementId: id, error: { code: 404, message: `Object ${id} not found` } };
      if (!isVariable(o)) return { success: false, elementId: id, error: { code: 400, message: "Not a variable" } };
      sub.items.add(o.elementId);
      const last = lastValue.get(o.elementId);
      if (last) pushUpdate(sub, o.elementId, last);
      return { success: true, elementId: o.elementId, subscriptionId, result: null };
    }));
  }

  function removeMonitoredItems({ subscriptionId, elementIds }) {
    const sub = subscriptions.get(subscriptionId);
    if (!sub) return err(404, `Subscription ${subscriptionId} not found`);
    return bulk((elementIds || []).map(id => {
      sub.items.delete(resolveId(id));
      return { success: true, elementId: id, subscriptionId, result: null };
    }));
  }

  function syncSubscription({ subscriptionId, lastSequenceNumber = null }) {
    const sub = subscriptions.get(subscriptionId);
    if (!sub) return err(404, `Subscription ${subscriptionId} not found`);
    if (lastSequenceNumber != null) {
      sub.queue = sub.queue.filter(u => u.sequenceNumber > lastSequenceNumber);
    }
    return ok(sub.queue.slice());
  }

  function deleteSubscriptions({ subscriptionIds }) {
    return bulk((subscriptionIds || []).map(sid => {
      const ok2 = subscriptions.delete(sid);
      return { success: ok2, subscriptionId: sid, result: null, error: ok2 ? null : { code: 404, message: "Not found" } };
    }));
  }

  function listSubscriptions({ subscriptionIds }) {
    return bulk((subscriptionIds || []).map(sid => {
      const s = subscriptions.get(sid);
      return s
        ? { success: true, subscriptionId: sid, result: {
            subscriptionId: sid, clientId: s.clientId, displayName: s.displayName,
            itemCount: s.items.size, queued: s.queue.length, nextSequence: s.nextSeq,
          }}
        : { success: false, subscriptionId: sid, error: { code: 404, message: "Not found" } };
    }));
  }

  // Stream: SSE-compatible. Here we return an object with an event emitter API the UI can consume.
  function streamSubscription({ subscriptionId, onEvent }) {
    const sub = subscriptions.get(subscriptionId);
    if (!sub) return err(404, `Subscription ${subscriptionId} not found`);
    const listener = (update) => onEvent && onEvent(update);
    sub.listeners.add(listener);
    // Flush any already-queued updates.
    for (const u of sub.queue) listener(u);
    const close = () => sub.listeners.delete(listener);
    return ok({ subscriptionId, close, items: [...sub.items] });
  }

  // --------- Live ticker (simulated telemetry) ---------
  let tickerHandle = null;
  function startTicker(intervalMs = 1500) {
    if (tickerHandle) return;
    tickerHandle = setInterval(() => tickOnce(), intervalMs);
  }
  function stopTicker() {
    if (tickerHandle) clearInterval(tickerHandle);
    tickerHandle = null;
  }
  function tickOnce() {
    for (const obj of uns.objects) {
      if (!isVariable(obj)) continue;
      const prev = lastValue.get(obj.elementId);
      if (!prev) continue;
      const next = mutateVQT(prev, obj);
      lastValue.set(obj.elementId, next);
      appendHistory(obj.elementId, next);
      fanoutUpdate(obj.elementId, next);
    }
  }
  function tickN(n = 20) {
    for (let i = 0; i < n; i++) tickOnce();
  }

  // --------- Internals ---------
  function resolveObject(idOrPathOrAlias) {
    if (!idOrPathOrAlias) return null;
    return uns.indexes.objectsById.get(idOrPathOrAlias)
      || uns.indexes.objectsByPath.get(idOrPathOrAlias)
      || uns.indexes.objectsByAlias.get(idOrPathOrAlias)
      || null;
  }
  function resolveId(idOrPathOrAlias) {
    const o = resolveObject(idOrPathOrAlias);
    return o ? o.elementId : idOrPathOrAlias;
  }

  function toInstance(o, includeMetadata) {
    const base = {
      elementId: o.elementId,
      typeElementId: o.typeElementId,
      namespaceUri: o.namespaceUri,
      name: o.name,
      displayName: o.displayName,
      path: o.path,
      ancestors: ancestors(o.path),
      isComposition: !!(o.isComposition && !isVariable(o)),
      attributes: o.attributes || {},
    };
    if (includeMetadata) base.metadata = o.metadata || {};
    return base;
  }

  function collectCurrent(o, maxDepth) {
    if (isVariable(o)) {
      const last = lastValue.get(o.elementId) || { value: null, quality: "GoodNoData", timestamp: nowISO() };
      return {
        elementId: o.elementId,
        isComposition: false,
        value: last.value,
        quality: last.quality,
        timestamp: last.timestamp,
      };
    }
    const node = {
      elementId: o.elementId,
      isComposition: true,
      value: null,
      quality: "Good",
      timestamp: nowISO(),
      components: {},
    };
    if (maxDepth === 1) return node;
    const nextDepth = maxDepth === 0 ? 0 : maxDepth - 1;
    const rels = (uns.indexes.childIndex.get(o.elementId) || [])
      .filter(r => r.relationshipType === "rel:HasComponent");
    for (const r of rels) {
      const child = uns.indexes.objectsById.get(r.targetElementId);
      if (!child) continue;
      const childRes = collectCurrent(child, nextDepth || (maxDepth === 0 ? 0 : 1));
      node.components[child.name] = {
        value: childRes.value,
        quality: childRes.quality,
        timestamp: childRes.timestamp,
      };
    }
    return node;
  }

  function collectHistory(o, startTime, endTime, maxDepth) {
    const start = startTime ? Date.parse(startTime) : -Infinity;
    const end = endTime ? Date.parse(endTime) : Infinity;
    if (isVariable(o)) {
      const hist = (history.get(o.elementId) || []).filter(h => {
        const t = Date.parse(h.timestamp);
        return t >= start && t <= end;
      });
      return { elementId: o.elementId, isComposition: false, values: hist };
    }
    const node = { elementId: o.elementId, isComposition: true, components: {} };
    if (maxDepth === 1) return node;
    const nextDepth = maxDepth === 0 ? 0 : maxDepth - 1;
    const rels = (uns.indexes.childIndex.get(o.elementId) || [])
      .filter(r => r.relationshipType === "rel:HasComponent");
    for (const r of rels) {
      const child = uns.indexes.objectsById.get(r.targetElementId);
      if (!child) continue;
      node.components[child.name] = collectHistory(child, startTime, endTime, nextDepth || (maxDepth === 0 ? 0 : 1));
    }
    return node;
  }

  function appendHistory(elementId, rec) {
    const arr = history.get(elementId) || [];
    arr.push(rec);
    if (arr.length > 240) arr.splice(0, arr.length - 240);
    history.set(elementId, arr);
  }

  function fanoutUpdate(elementId, rec) {
    for (const sub of subscriptions.values()) {
      if (!sub.items.has(elementId)) continue;
      pushUpdate(sub, elementId, rec);
    }
  }

  function pushUpdate(sub, elementId, rec) {
    const update = {
      sequenceNumber: sub.nextSeq++,
      subscriptionId: findSubId(sub),
      elementId,
      value: rec.value,
      quality: rec.quality,
      timestamp: rec.timestamp,
    };
    sub.queue.push(update);
    if (sub.queue.length > 500) sub.queue.splice(0, sub.queue.length - 500);
    for (const l of sub.listeners) { try { l(update); } catch { /* ignore */ } }
  }

  function findSubId(sub) {
    for (const [sid, s] of subscriptions) if (s === sub) return sid;
    return null;
  }

  function normalizeVQT(body) {
    if (body && typeof body === "object" && "value" in body) {
      return {
        value: body.value,
        quality: body.quality || "Good",
        timestamp: body.timestamp || nowISO(),
      };
    }
    return { value: body, quality: "Good", timestamp: nowISO() };
  }

  function mutateVQT(prev, obj) {
    const dt = obj.attributes?.dataType;
    if (dt === "Boolean") {
      const flip = Math.random() < 0.05;
      return { value: flip ? !prev.value : prev.value, quality: "Good", timestamp: nowISO() };
    }
    let next = Number(prev.value ?? 0);
    const unit = obj.attributes?.unit || "";
    const scale = unit === "degC" ? 0.6 : unit === "A" ? 0.9 : unit === "bar" ? 0.2 : 0.5;
    next += (Math.random() - 0.5) * scale * 2;
    if (unit === "degC") next = clamp(next, 40, 130);
    else if (unit === "A") next = clamp(next, 0, 120);
    else if (unit === "bar") next = clamp(next, 0, 20);
    return { value: round(next, 2), quality: next > 110 && unit === "degC" ? "Uncertain" : "Good", timestamp: nowISO() };
  }

  return {
    uns,
    // explore
    getInfo, getNamespaces, getObjectTypes, queryObjectTypesById,
    getRelationshipTypes, queryRelationshipTypesById,
    getObjects, listObjectsById, queryRelatedObjects,
    // values
    queryLastKnownValues, queryHistoricalValues, getHistoricalValues,
    updateObjectValue, updateObjectHistory,
    // subscriptions
    createSubscription, registerMonitoredItems, removeMonitoredItems,
    streamSubscription, syncSubscription, deleteSubscriptions, listSubscriptions,
    // demo
    startTicker, stopTicker, tickN,
    // helpers
    resolveObject, toInstance: (o, m = false) => toInstance(o, m),
  };
}

function isVariable(o) {
  return o.typeElementId === "signals:Variable" || o.typeElementId === "signals:Alarm";
}

function nowISO() { return new Date().toISOString(); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function round(n, p) { const k = 10 ** p; return Math.round(n * k) / k; }
