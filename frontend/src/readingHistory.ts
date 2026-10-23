type Send = <T>(url: string, init?: RequestInit) => Promise<T>;
type Saved = Record<string, unknown> & { id: number };
type Change = { collection: string; id: number; before?: Saved; after?: Saved };
type History = { undo: Change[]; redo: Change[]; queue: Promise<unknown>; pending: number };
const histories = new Map<number, History>();
export const historyEvents = new EventTarget();
const notify = () => historyEvents.dispatchEvent(new Event('change'));

export function beginReadingHistory(docId: number) {
  const history: History = {undo: [], redo: [], queue: Promise.resolve(), pending: 0};
  histories.set(docId, history); notify();
  return () => { if (histories.get(docId) === history) histories.delete(docId); };
}

export function readingHistoryState(docId: number) {
  const h = histories.get(docId);
  return {undo: !!h?.undo.length, redo: !!h?.redo.length, busy: !!h?.pending};
}

function enqueue<T>(h: History, operation: () => Promise<T>): Promise<T> {
  h.pending++; notify();
  const result = h.queue.then(operation);
  h.queue = result.catch(() => {});
  return result.finally(() => { h.pending--; notify(); });
}

function payload(record: Saved) {
  const {id, document_id, created_at, updated_at, ...body} = record;
  return body;
}

/** Only successful reading-record mutations enter history. Translation is excluded. */
export function readingRequest<T>(url: string, init: RequestInit | undefined, send: Send): Promise<T> {
  const match = url.match(/^\/api\/documents\/(\d+)\/(annotations|notes)(?:\/(\d+))?$/);
  const method = init?.method;
  const h = match && histories.get(Number(match[1]));
  if (!match || !h || !['POST', 'PATCH', 'DELETE'].includes(method || '')) return send<T>(url, init);
  return enqueue(h, async () => {
    const collection = `/api/documents/${match[1]}/${match[2]}`;
    const id = Number(match[3]);
    const before = method === 'POST' ? undefined : (await send<Saved[]>(collection)).find(r => r.id === id);
    if (method !== 'POST' && !before) throw new Error('阅读记录已变化，请刷新后重试');
    const result = await send<T>(url, init);
    const after = method === 'DELETE' ? undefined : result as Saved;
    if (!before || !after || JSON.stringify(payload(before)) !== JSON.stringify(payload(after))) {
      h.undo.push({collection, id: after?.id ?? id, before, after});
      if (h.undo.length > 100) h.undo.shift();
      h.redo = [];
    }
    return result;
  });
}

export function replayReadingHistory(docId: number, direction: 'undo' | 'redo', send: Send): Promise<boolean> {
  const h = histories.get(docId);
  if (!h) return Promise.resolve(false);
  return enqueue(h, async () => {
    const source = h[direction], target = h[direction === 'undo' ? 'redo' : 'undo'];
    const change = source[source.length - 1];
    if (!change) return false;
    const wanted = direction === 'undo' ? change.before : change.after;
    const current = direction === 'undo' ? change.after : change.before;
    // Refuse to overwrite a record edited by another tab or reparsing.
    const live = (await send<Saved[]>(change.collection)).find(r => r.id === change.id);
    if (current ? !live || JSON.stringify(payload(live)) !== JSON.stringify(payload(current)) : !!live) {
      throw new Error('阅读记录已在其他位置改变，请重新打开文献后操作');
    }
    if (!wanted) {
      await send(`${change.collection}/${change.id}`, {method: 'DELETE'});
    } else {
      const restored = await send<Saved>(current ? `${change.collection}/${change.id}` : change.collection, {
        method: current ? 'PATCH' : 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload(wanted)),
      });
      // Restoring a deletion receives a new ID. Earlier edits of the same record
      // must follow it so repeated undo/redo remains attached to this record.
      const oldId = change.id;
      for (const item of [...h.undo, ...h.redo]) {
        if (item.collection === change.collection && item.id === oldId) item.id = restored.id;
      }
    }
    source.pop(); target.push(change);
    return true;
  });
}
