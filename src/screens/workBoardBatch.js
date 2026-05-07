// Batch-selection helper for the work board. Tiny module — but
// living in workBoard.js created a circular import problem when the
// kanban view (which calls toggleBatch on shift-click) was extracted
// to its own file. Putting the helper here breaks the cycle: kanban
// + table import from this module, the batch action bar in
// workBoard.js does the same.

/**
 * Toggle membership of `itemId` in the batch-selection set held in
 * sessionStorage at `batchKey`. Pure I/O over storage — re-rendering
 * is the caller's job.
 *
 * @param {string} itemId
 * @param {string} batchKey
 */
export function toggleBatch(itemId, batchKey) {
  const arr = JSON.parse(sessionStorage.getItem(batchKey) || "[]");
  const s = new Set(arr);
  if (s.has(itemId)) s.delete(itemId); else s.add(itemId);
  sessionStorage.setItem(batchKey, JSON.stringify([...s]));
}
