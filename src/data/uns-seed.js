// Builds the Unified Namespace (UNS) + i3X metadata graph from the FORGE seed.
//
// Namespaces:
//   - urn:forge:core:1        Core FORGE types (Document, Drawing, WorkItem, Incident)
//   - urn:cesmii:isa95:1      ISA-95 equipment hierarchy (Enterprise, Site, Area, Line, Cell, Equipment)
//   - urn:forge:signals:1     Signal/Variable types
//   - urn:atlas:workspace:1   Tenant-scoped instance namespace
//
// Instance graph follows ISA-95 mirrored in one hierarchical UNS path.

import { joinPath, slug } from "../core/i3x/uns.js";

export function buildUns(forgeData) {
  const org = forgeData.organization;
  const ws = forgeData.workspace;

  const namespaces = [
    { uri: "urn:forge:core:1",       name: "FORGE Core",     description: "Core FORGE record types (documents, drawings, work items, incidents)." },
    { uri: "urn:cesmii:isa95:1",     name: "ISA-95 Hierarchy",description: "Equipment hierarchy types: Enterprise → Site → Area → ProductionLine → Cell → Equipment." },
    { uri: "urn:forge:signals:1",    name: "FORGE Signals",  description: "Contextualized signals (variables, sensors) bound to physical equipment." },
    { uri: "urn:atlas:workspace:1",  name: "Atlas Workspace",description: "Tenant-scoped instance namespace for Atlas Industrial Systems." },
  ];

  const objectTypes = [
    // ISA-95
    { elementId: "isa95:Enterprise",     namespaceUri: "urn:cesmii:isa95:1", name: "Enterprise",     description: "Top-level business entity.", attributes: [attr("name","string"), attr("region","string")] },
    { elementId: "isa95:Site",           namespaceUri: "urn:cesmii:isa95:1", name: "Site",           description: "A physical site.",           attributes: [attr("name","string"), attr("latlon","string")] },
    { elementId: "isa95:Area",           namespaceUri: "urn:cesmii:isa95:1", name: "Area",           description: "Area within a site.",        attributes: [attr("name","string")] },
    { elementId: "isa95:ProductionLine", namespaceUri: "urn:cesmii:isa95:1", name: "ProductionLine", description: "A line within an area.",     attributes: [attr("name","string"), attr("state","string")] },
    { elementId: "isa95:Cell",           namespaceUri: "urn:cesmii:isa95:1", name: "Cell",           description: "Work cell within a line.",   attributes: [attr("name","string")] },
    { elementId: "isa95:Equipment",      namespaceUri: "urn:cesmii:isa95:1", name: "Equipment",      description: "Physical equipment unit.",   attributes: [attr("name","string"), attr("type","string"), attr("state","string")] },

    // Signals
    { elementId: "signals:Variable",     namespaceUri: "urn:forge:signals:1", name: "Variable",     description: "A scalar or composite variable bound to an equipment instance.", attributes: [attr("unit","string"), attr("dataType","string"), attr("sampling","string")] },
    { elementId: "signals:Alarm",        namespaceUri: "urn:forge:signals:1", name: "Alarm",        description: "A boolean alarm signal.",          attributes: [attr("threshold","number")] },

    // FORGE records
    { elementId: "forge:Document",       namespaceUri: "urn:forge:core:1", name: "Document",   description: "Controlled engineering document.", attributes: [attr("discipline","string"), attr("sensitivity","string")] },
    { elementId: "forge:Drawing",        namespaceUri: "urn:forge:core:1", name: "Drawing",    description: "Technical drawing.",               attributes: [attr("discipline","string")] },
    { elementId: "forge:WorkItem",       namespaceUri: "urn:forge:core:1", name: "WorkItem",   description: "Work item / task / issue.",        attributes: [attr("status","string"), attr("severity","string")] },
    { elementId: "forge:Incident",       namespaceUri: "urn:forge:core:1", name: "Incident",   description: "Operational incident record.",     attributes: [attr("severity","string"), attr("status","string")] },
  ];

  const relationshipTypes = [
    { elementId: "rel:HasChild",      namespaceUri: "urn:cesmii:isa95:1", name: "HasChild",      inverse: "isChildOf",     description: "Generic ISA-95 child relationship." },
    { elementId: "rel:HasComponent",  namespaceUri: "urn:cesmii:isa95:1", name: "HasComponent",  inverse: "isComponentOf", description: "Physical composition. Used by i3X value recursion (maxDepth)." },
    { elementId: "rel:LocatedIn",     namespaceUri: "urn:cesmii:isa95:1", name: "LocatedIn",     inverse: "contains",      description: "Spatial containment." },
    { elementId: "rel:Measures",      namespaceUri: "urn:forge:signals:1", name: "Measures",     inverse: "measuredBy",    description: "Variable measures equipment." },
    { elementId: "rel:DocumentedBy",  namespaceUri: "urn:forge:core:1",   name: "DocumentedBy",  inverse: "documents",     description: "Equipment is documented by a Document." },
    { elementId: "rel:DepictedIn",    namespaceUri: "urn:forge:core:1",   name: "DepictedIn",    inverse: "depicts",       description: "Equipment depicted on a Drawing." },
  ];

  // ----- Instance graph -----
  const objects = [];
  const relationships = []; // {sourceElementId, targetElementId, relationshipType}
  const byPath = new Map();

  const orgSlug = slug(org?.name || "org");
  const wsSlug = slug(ws?.name || "workspace");

  // Enterprise
  const enterprise = makeObj({
    elementId: eid("enterprise", orgSlug),
    typeElementId: "isa95:Enterprise",
    namespaceUri: "urn:atlas:workspace:1",
    path: orgSlug,
    name: org?.name || "Enterprise",
    displayName: org?.name,
    attributes: { name: org?.name, region: ws?.region || "" },
  });
  objects.push(enterprise);

  // Site (workspace)
  const site = makeObj({
    elementId: eid("site", orgSlug, wsSlug),
    typeElementId: "isa95:Site",
    namespaceUri: "urn:atlas:workspace:1",
    path: joinPath(orgSlug, wsSlug),
    name: ws?.name || "Site",
    displayName: ws?.name,
    attributes: { name: ws?.name, latlon: "" },
  });
  objects.push(site);
  rel(enterprise, site, "rel:HasChild");
  rel(site, enterprise, "rel:LocatedIn");

  // Synthesize ISA-95 chain from asset.hierarchy strings of the form
  //   "North Plant > Line A > Cell-3 > HX-01"
  // We interpret: site > area-or-line > cell > equipment.
  const hierarchyCache = new Map(); // pathPrefix -> object

  for (const asset of (forgeData.assets || [])) {
    const parts = (asset.hierarchy || asset.name || "").split(/\s*>\s*/).filter(Boolean);
    // Drop leading site name if it matches workspace name (case-insensitive).
    if (parts[0] && parts[0].toLowerCase() === (ws?.name || "").toLowerCase()) parts.shift();

    // Attach to site at the start.
    let parent = site;
    let pathAcc = site.path;
    let depth = 0;
    for (let i = 0; i < parts.length - 1; i++) {
      const segSlug = slug(parts[i]);
      pathAcc = joinPath(pathAcc, segSlug);
      depth += 1;

      // Infer type from depth: 1=Area, 2=ProductionLine, 3=Cell. Cap at Cell.
      const typeElementId = depth === 1 ? "isa95:Area"
        : depth === 2 ? "isa95:ProductionLine"
        : "isa95:Cell";

      let node = hierarchyCache.get(pathAcc);
      if (!node) {
        node = makeObj({
          elementId: eid(typeSegForEid(typeElementId), segSlug, String(depth)),
          typeElementId,
          namespaceUri: "urn:atlas:workspace:1",
          path: pathAcc,
          name: parts[i],
          displayName: parts[i],
          attributes: { name: parts[i], state: "normal" },
        });
        objects.push(node);
        hierarchyCache.set(pathAcc, node);
        rel(parent, node, "rel:HasChild");
        rel(node, parent, "rel:LocatedIn");
      }
      parent = node;
    }

    // Equipment leaf
    const equipSlug = slug(parts[parts.length - 1] || asset.name || asset.id);
    const equipPath = joinPath(pathAcc || site.path, equipSlug);
    const equipment = makeObj({
      elementId: eid("equipment", equipSlug, slug(asset.id)),
      typeElementId: "isa95:Equipment",
      namespaceUri: "urn:atlas:workspace:1",
      path: equipPath,
      name: asset.name,
      displayName: asset.name,
      attributes: {
        name: asset.name,
        type: asset.type,
        state: asset.status,
      },
      // Cross-reference back to FORGE asset id so the UI can link.
      metadata: { forgeAssetId: asset.id, aliases: [asset.id] },
    });
    objects.push(equipment);
    rel(parent, equipment, "rel:HasChild");
    rel(parent, equipment, "rel:HasComponent");
    rel(equipment, parent, "rel:LocatedIn");

    // Variables for MQTT topics
    (asset.mqttTopics || []).forEach((topic, idx) => {
      const varName = leafOfTopic(topic);
      const v = makeObj({
        elementId: eid("var", slug(asset.id), slug(varName), "m"),
        typeElementId: guessAlarm(topic) ? "signals:Alarm" : "signals:Variable",
        namespaceUri: "urn:atlas:workspace:1",
        path: joinPath(equipPath, varName),
        name: varName,
        displayName: varName,
        attributes: {
          unit: guessUnit(varName),
          dataType: guessAlarm(topic) ? "Boolean" : "Double",
          sampling: "1s",
        },
        metadata: {
          source: "mqtt",
          topic,
          aliases: [topic],
        },
        initialValue: guessInitialValue(varName, topic),
      });
      objects.push(v);
      rel(equipment, v, "rel:HasComponent");
      rel(v, equipment, "rel:Measures");
    });

    // Variables for OPC UA nodes
    (asset.opcuaNodes || []).forEach((node, idx) => {
      const varName = leafOfOpcNode(node);
      const v = makeObj({
        elementId: eid("var", slug(asset.id), slug(varName), "o"),
        typeElementId: "signals:Variable",
        namespaceUri: "urn:atlas:workspace:1",
        path: joinPath(equipPath, varName),
        name: varName,
        displayName: varName,
        attributes: {
          unit: guessUnit(varName),
          dataType: "Double",
          sampling: "500ms",
        },
        metadata: {
          source: "opcua",
          nodeId: node,
          aliases: [node],
        },
        initialValue: guessInitialValue(varName, node),
      });
      objects.push(v);
      rel(equipment, v, "rel:HasComponent");
      rel(v, equipment, "rel:Measures");
    });

    // Link documents
    (asset.docIds || []).forEach(docId => {
      const docObj = {
        elementId: eid("document", slug(docId)),
        typeElementId: "forge:Document",
        namespaceUri: "urn:atlas:workspace:1",
        path: joinPath("records", "documents", slug(docId)),
        name: (forgeData.documents.find(d => d.id === docId) || {}).name || docId,
        displayName: docId,
        attributes: {
          discipline: (forgeData.documents.find(d => d.id === docId) || {}).discipline || "",
          sensitivity: (forgeData.documents.find(d => d.id === docId) || {}).sensitivity || "",
        },
        metadata: { forgeDocId: docId, aliases: [docId] },
      };
      ensureObject(docObj);
      rel(equipment, docObj, "rel:DocumentedBy");
      rel(docObj, equipment, "rel:DocumentedBy");
    });
  }

  // Record objects for all documents (even unlinked) + drawings + incidents + work items.
  for (const doc of (forgeData.documents || [])) {
    ensureObject({
      elementId: eid("document", slug(doc.id)),
      typeElementId: "forge:Document",
      namespaceUri: "urn:atlas:workspace:1",
      path: joinPath("records", "documents", slug(doc.id)),
      name: doc.name,
      displayName: doc.id,
      attributes: { discipline: doc.discipline, sensitivity: doc.sensitivity },
      metadata: { forgeDocId: doc.id, aliases: [doc.id] },
    });
  }
  for (const dr of (forgeData.drawings || [])) {
    ensureObject({
      elementId: eid("drawing", slug(dr.id)),
      typeElementId: "forge:Drawing",
      namespaceUri: "urn:atlas:workspace:1",
      path: joinPath("records", "drawings", slug(dr.id)),
      name: dr.name,
      displayName: dr.id,
      attributes: { discipline: dr.discipline },
      metadata: { forgeDrawingId: dr.id, aliases: [dr.id] },
    });
  }
  for (const inc of (forgeData.incidents || [])) {
    const incObj = ensureObject({
      elementId: eid("incident", slug(inc.id)),
      typeElementId: "forge:Incident",
      namespaceUri: "urn:atlas:workspace:1",
      path: joinPath("records", "incidents", slug(inc.id)),
      name: inc.title,
      displayName: inc.id,
      attributes: { severity: inc.severity, status: inc.status },
      metadata: { forgeIncidentId: inc.id, aliases: [inc.id] },
    });
    if (inc.assetId) {
      const equipElId = eid("equipment", slug((forgeData.assets.find(a => a.id === inc.assetId) || {}).name || ""), slug(inc.assetId));
      const target = objects.find(o => o.elementId === equipElId);
      if (target) {
        rel(incObj, target, "rel:LocatedIn");
      }
    }
  }
  for (const w of (forgeData.workItems || [])) {
    ensureObject({
      elementId: eid("workitem", slug(w.id)),
      typeElementId: "forge:WorkItem",
      namespaceUri: "urn:atlas:workspace:1",
      path: joinPath("records", "work-items", slug(w.id)),
      name: w.title,
      displayName: w.id,
      attributes: { status: w.status, severity: w.severity },
      metadata: { forgeWorkItemId: w.id, aliases: [w.id] },
    });
  }

  // Build index structures for the engine.
  const objectsById = new Map();
  const objectsByPath = new Map();
  const objectsByAlias = new Map();
  for (const o of objects) {
    objectsById.set(o.elementId, o);
    objectsByPath.set(o.path, o);
    const aliases = [o.path, o.name, o.displayName, ...(o.metadata?.aliases || [])].filter(Boolean);
    for (const a of aliases) if (!objectsByAlias.has(a)) objectsByAlias.set(a, o);
  }

  // Build "has children" index.
  const childIndex = new Map(); // parentElementId -> [ {targetElementId, relationshipType} ]
  for (const r of relationships) {
    if (!childIndex.has(r.sourceElementId)) childIndex.set(r.sourceElementId, []);
    childIndex.get(r.sourceElementId).push(r);
  }

  return {
    namespaces,
    objectTypes,
    relationshipTypes,
    objects,
    relationships,
    indexes: { objectsById, objectsByPath, objectsByAlias, childIndex },
  };

  // ---------- helpers ----------

  function makeObj(o) {
    const full = {
      ...o,
      isComposition: !!(o.metadata?.source) ? false : true, // variables are leaf values
      metadata: o.metadata || {},
    };
    if (byPath.has(full.path)) {
      // Merge aliases/metadata so a variable reachable via both MQTT and OPC UA
      // keeps both as alternate addresses.
      const existing = byPath.get(full.path);
      existing.metadata = existing.metadata || {};
      const existingAliases = new Set([...(existing.metadata.aliases || [])]);
      for (const a of full.metadata?.aliases || []) existingAliases.add(a);
      existing.metadata.aliases = [...existingAliases];
      if (!existing.metadata.source && full.metadata?.source) existing.metadata.source = full.metadata.source;
      if (full.metadata?.topic)  existing.metadata.topic  = existing.metadata.topic  || full.metadata.topic;
      if (full.metadata?.nodeId) existing.metadata.nodeId = existing.metadata.nodeId || full.metadata.nodeId;
      return existing;
    }
    byPath.set(full.path, full);
    return full;
  }

  function ensureObject(o) {
    const existing = objects.find(x => x.elementId === o.elementId);
    if (existing) return existing;
    const full = makeObj(o);
    objects.push(full);
    return full;
  }

  function rel(src, tgt, type) {
    const entry = {
      sourceElementId: src.elementId,
      targetElementId: tgt.elementId,
      relationshipType: type,
    };
    const dup = relationships.some(r =>
      r.sourceElementId === entry.sourceElementId &&
      r.targetElementId === entry.targetElementId &&
      r.relationshipType === entry.relationshipType
    );
    if (!dup) relationships.push(entry);
  }
}

function eid(...parts) {
  return parts.filter(Boolean).join(":");
}

function typeSegForEid(typeElementId) {
  const name = typeElementId.split(":").pop();
  return name.toLowerCase();
}

function attr(name, dataType) {
  return { name, dataType };
}

function leafOfTopic(topic) {
  const p = topic.split("/").filter(x => x !== "#" && x !== "+");
  return p[p.length - 1] || "value";
}

function leafOfOpcNode(nodeId) {
  // Match the string identifier segment only (s=...), not the ns= prefix.
  const m = nodeId.match(/(?:^|;)s=([^;]+)/);
  if (m) {
    const parts = m[1].split(".");
    return parts[parts.length - 1].toLowerCase();
  }
  return "value";
}

function guessAlarm(topic) {
  return /alarm|trip|fault/i.test(topic);
}

function guessUnit(name) {
  if (/temp/i.test(name)) return "degC";
  if (/current/i.test(name) || name === "a") return "A";
  if (/press|steam\.p$|\.p$/i.test(name)) return "bar";
  if (/flow/i.test(name)) return "m3/h";
  if (/high-?temp|alarm/i.test(name)) return "bool";
  return "";
}

function guessInitialValue(name, alias) {
  if (/alarm|trip|fault/i.test(alias)) return { value: false, quality: "Good" };
  if (/temp/i.test(name)) return { value: 72.3, quality: "Good" };
  if (/current/i.test(name)) return { value: 48.1, quality: "Good" };
  if (/press|\.p$/i.test(name)) return { value: 10.2, quality: "Good" };
  return { value: 0, quality: "Uncertain" };
}
