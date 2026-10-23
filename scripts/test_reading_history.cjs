/* Unit checks for reading-record undo, with an in-memory server and no browser/data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', {paths: [path.join(root, 'frontend')]}));
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'frontend/src/readingHistory.ts'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021},
}).outputText;
const sandbox = new Module('reading-history-test');
sandbox._compile(compiled, 'reading-history-test.cjs');
const {beginReadingHistory, readingRequest, replayReadingHistory, readingHistoryState} = sandbox.exports;

async function main() {
  const records = new Map(); let nextId = 1, fail = false, active = 0, maximum = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const send = async (url, options = {}) => {
    const match = url.match(/^(.*\/(notes|annotations))(?:\/(\d+))?$/);
    assert(match); const collection = match[1], id = Number(match[3]);
    const rows = records.get(collection) || []; records.set(collection, rows);
    if (!options.method) return clone(rows);
    active++; maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (fail) throw new Error('offline');
      const index = rows.findIndex(r => r.id === id);
      if (options.method === 'DELETE') { assert(index >= 0); rows.splice(index, 1); return {deleted: id}; }
      const body = JSON.parse(options.body);
      if (options.method === 'POST') {
        const record = {...body, id: nextId++, document_id: 1, created_at: 'now', updated_at: 'now'};
        rows.push(record); return clone(record);
      }
      assert(index >= 0); rows[index] = {...rows[index], ...body}; return clone(rows[index]);
    } finally { active--; }
  };
  const end = beginReadingHistory(1), notes = '/api/documents/1/notes';
  const mutate = (url, method, body) => readingRequest(url, {method, body: body && JSON.stringify(body)}, send);
  const note = await mutate(notes, 'POST', {title: 'note', content: 'first', block_id: 7, page_number: 2, quote: 'source'});
  await mutate(`${notes}/${note.id}`, 'PATCH', {content: 'second'});
  await mutate(`${notes}/${note.id}`, 'DELETE');
  await replayReadingHistory(1, 'undo', send);
  let restored = records.get(notes)[0]; assert.notEqual(restored.id, note.id);
  assert.equal(restored.content, 'second'); assert.equal(restored.block_id, 7);
  await replayReadingHistory(1, 'undo', send); assert.equal(records.get(notes)[0].content, 'first');
  await replayReadingHistory(1, 'undo', send); assert.equal(records.get(notes).length, 0);
  for (let i = 0; i < 3; i++) await replayReadingHistory(1, 'redo', send);
  assert.equal(records.get(notes).length, 0);
  await replayReadingHistory(1, 'undo', send);
  restored = records.get(notes)[0];
  console.log('PASS create/edit/delete undo and redo preserve quotes and follow newly restored IDs');

  fail = true;
  await assert.rejects(mutate(notes, 'POST', {content: 'failed save'}), /offline/);
  await assert.rejects(replayReadingHistory(1, 'undo', send), /offline/);
  assert.equal(readingHistoryState(1).busy, false); assert.equal(readingHistoryState(1).undo, true);
  assert.equal(records.get(notes)[0].content, 'second');
  fail = false; await replayReadingHistory(1, 'undo', send);
  assert.equal(records.get(notes)[0].content, 'first');
  console.log('PASS failed saves do not enter history and failed undo keeps history for retry');

  records.get(notes)[0].content = 'edited by another tab';
  await assert.rejects(replayReadingHistory(1, 'undo', send), /其他位置改变/);
  assert.equal(records.get(notes)[0].content, 'edited by another tab');
  records.get(notes)[0].content = 'first';
  await mutate(`${notes}/${restored.id}`, 'PATCH', {title: 'new branch'});
  assert.equal(readingHistoryState(1).redo, false);
  assert.equal(await replayReadingHistory(2, 'undo', send), false);
  console.log('PASS conflicts are protected, new edits clear redo and documents have separate history');

  await Promise.all(Array.from({length: 5}, (_, i) => mutate(notes, 'POST', {content: `queued ${i}`})));
  assert.equal(maximum, 1); assert.equal(readingHistoryState(1).busy, false);
  end(); assert.equal(readingHistoryState(1).undo, false);
  console.log('PASS concurrent reading mutations are serialized and leaving a document clears session history');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
