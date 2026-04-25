// Thin client for the in-process i3X server. Mirrors REST endpoint names.
// UI code uses this so that it's trivial to swap to a real HTTP fetch() later.

import { createI3XServer } from "./server.js";

let _server = null;

export function initI3X(forgeData) {
  _server = createI3XServer(forgeData);
  _server.startTicker(1500);
  // Pre-populate a small history so sparklines have something to show.
  _server.tickN(20);
  return _server;
}

export function getServer() {
  if (!_server) throw new Error("i3X server not initialized");
  return _server;
}

// Convenience REST-like wrappers — each returns the exact envelope the real
// i3X API would return, so the explorer screen can show true request/response
// payloads without a backend.

export const i3x = {
  info: () => getServer().getInfo(),
  namespaces: () => getServer().getNamespaces(),
  objectTypes: (namespaceUri) => getServer().getObjectTypes(namespaceUri),
  queryObjectTypes: (body) => getServer().queryObjectTypesById(body),
  relationshipTypes: (namespaceUri) => getServer().getRelationshipTypes(namespaceUri),
  queryRelationshipTypes: (body) => getServer().queryRelationshipTypesById(body),
  objects: (params) => getServer().getObjects(params || {}),
  listObjects: (body) => getServer().listObjectsById(body),
  relatedObjects: (body) => getServer().queryRelatedObjects(body),
  value: (body) => getServer().queryLastKnownValues(body),
  history: (body) => getServer().queryHistoricalValues(body),
  historyOne: (elementId, params) => getServer().getHistoricalValues(elementId, params || {}),
  putValue: (elementId, body) => getServer().updateObjectValue(elementId, body),
  putHistory: (elementId, body) => getServer().updateObjectHistory(elementId, body),
  createSubscription: (body) => getServer().createSubscription(body || {}),
  registerItems: (body) => getServer().registerMonitoredItems(body),
  unregisterItems: (body) => getServer().removeMonitoredItems(body),
  stream: (subscriptionId, onEvent) => getServer().streamSubscription({ subscriptionId, onEvent }),
  syncSubscription: (body) => getServer().syncSubscription(body),
  deleteSubscriptions: (body) => getServer().deleteSubscriptions(body),
  listSubscriptions: (body) => getServer().listSubscriptions(body),
};
