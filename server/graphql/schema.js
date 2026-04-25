// GraphQL schema (SDL). Read-heavy with a few mutations. Aligns with the
// FORGE object model from PRODUCT_SPEC §4 and the SQLite shape in db.js.

export const typeDefs = /* GraphQL */ `
  scalar JSON
  scalar DateTime

  type Query {
    me: User

    # Org / workspace
    organization: Organization
    workspaces: [Workspace!]!

    # Top-level lists
    teamSpaces: [TeamSpace!]!
    teamSpace(id: ID!): TeamSpace
    projects(teamSpaceId: ID): [Project!]!
    project(id: ID!): Project
    channels(teamSpaceId: ID): [Channel!]!
    channel(id: ID!): Channel
    documents: [Document!]!
    document(id: ID!): Document
    revision(id: ID!): Revision
    drawings: [Drawing!]!
    drawing(id: ID!): Drawing
    assets: [Asset!]!
    asset(id: ID!): Asset
    workItems(projectId: ID): [WorkItem!]!
    workItem(id: ID!): WorkItem
    incidents: [Incident!]!
    incident(id: ID!): Incident
    approvals(status: String): [Approval!]!
    approval(id: ID!): Approval

    # Search + audit + events
    search(q: String!, kind: [String!], from: DateTime, to: DateTime, revision: [String!]): SearchResult!
    audit(limit: Int = 100): [AuditEvent!]!
    events(limit: Int = 50): [Event!]!
    metricsSeries(metric: String!, days: Int = 14): [MetricPoint!]!
  }

  type Mutation {
    # Work items
    createWorkItem(projectId: ID!, type: String!, title: String!, severity: String, assigneeId: ID, due: DateTime): WorkItem!
    updateWorkItem(id: ID!, status: String, severity: String, title: String, description: String, blockers: [ID!], labels: [String!]): WorkItem!

    # Channels
    postMessage(channelId: ID!, type: String = "discussion", text: String!): Message!

    # Revisions
    transitionRevision(id: ID!, to: String!, notes: String): Revision!

    # Approvals
    decideApproval(id: ID!, outcome: String!, notes: String): Approval!

    # Events / automations
    ingestEvent(input: EventIngestInput!): Event!
  }

  input EventIngestInput {
    eventType: String!
    severity: String
    assetRef: ID
    projectRef: ID
    payload: JSON
    dedupeKey: String
    source: String
    sourceType: String
  }

  type User {
    id: ID!
    name: String!
    email: String!
    role: String!
    initials: String
  }

  type Organization { id: ID!, name: String!, tenantKey: String }
  type Workspace    { id: ID!, name: String!, region: String }

  type TeamSpace {
    id: ID!
    name: String!
    summary: String
    status: String
    members: [User!]!
    channels: [Channel!]!
    projects: [Project!]!
    documents: [Document!]!
  }

  type Project {
    id: ID!
    name: String!
    status: String!
    dueDate: DateTime
    teamSpace: TeamSpace
    workItems: [WorkItem!]!
  }

  type Channel {
    id: ID!
    name: String!
    kind: String!
    teamSpace: TeamSpace
    messages(limit: Int = 100): [Message!]!
  }

  type Message {
    id: ID!
    channelId: ID!
    authorId: ID!
    author: User
    ts: DateTime!
    type: String!
    text: String!
    edits: JSON
    deleted: Boolean
  }

  type Document {
    id: ID!
    name: String!
    discipline: String
    sensitivity: String
    currentRevision: Revision
    revisions: [Revision!]!
    drawings: [Drawing!]!
    teamSpace: TeamSpace
    project: Project
  }

  type Revision {
    id: ID!
    docId: ID!
    label: String!
    status: String!
    summary: String
    notes: String
    pdfUrl: String
    createdAt: DateTime!
    document: Document
    approvals: [Approval!]!
    reviewCycles: [ReviewCycle!]!
  }

  type Drawing {
    id: ID!
    name: String!
    discipline: String
    sheets: JSON
    document: Document
    markups: [Markup!]!
    modelPins: [ModelPin!]!
  }

  type Markup {
    id: ID!
    drawingId: ID!
    sheetId: String!
    kind: String!
    x: Float!
    y: Float!
    text: String
    author: String
    seq: Int
    createdAt: DateTime!
  }

  type ModelPin {
    id: ID!
    drawingId: ID!
    elementId: String!
    text: String!
    author: String
    createdAt: DateTime!
  }

  type Asset {
    id: ID!
    name: String!
    type: String
    hierarchy: String
    status: String!
    mqttTopics: [String!]!
    opcuaNodes: [String!]!
    docs: [Document!]!
    incidents: [Incident!]!
  }

  type WorkItem {
    id: ID!
    type: String!
    title: String!
    description: String
    status: String!
    severity: String
    due: DateTime
    blockers: [String!]!
    labels: [String!]!
    project: Project
    assignee: User
  }

  type Incident {
    id: ID!
    title: String!
    severity: String!
    status: String!
    asset: Asset
    channel: Channel
    commander: User
    timeline: JSON
    startedAt: DateTime!
    resolvedAt: DateTime
  }

  type Approval {
    id: ID!
    subjectKind: String!
    subjectId: ID!
    status: String!
    approvers: [String!]!
    chain: JSON
    dueTs: DateTime
    signedBy: String
    signedAt: DateTime
  }

  type ReviewCycle {
    id: ID!
    docId: ID!
    revId: ID!
    name: String!
    reviewers: [String!]!
    status: String!
    dueTs: DateTime
    notes: String
    closedAt: DateTime
    createdAt: DateTime!
  }

  type AuditEvent {
    id: ID!
    ts: DateTime!
    actor: String!
    action: String!
    subject: String!
    detail: JSON
    traceId: String
    prevHash: String
    hash: String
    seq: Int
  }

  type Event {
    eventId: ID!
    receivedAt: DateTime!
    source: String!
    sourceType: String!
    assetRef: ID
    projectRef: ID
    severity: String
    eventType: String!
    payload: JSON
    traceId: String
    dedupeKey: String
  }

  type SearchResult {
    hits: [SearchHit!]!
    facets: JSON!
  }

  type SearchHit {
    kind: String!
    id: ID!
    title: String
    snippet: String
    route: String
    revision: String
    date: DateTime
  }

  type MetricPoint { day: String!, value: Float! }
`;
