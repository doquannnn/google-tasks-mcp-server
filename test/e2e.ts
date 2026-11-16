// End-to-end test: MCP client -> our MCP server (stdio + HTTP) -> Google Tasks API.
//   node test/e2e.ts          # offline, against the in-memory mock Google API
//   node test/e2e.ts --real   # against YOUR Google account (needs credentials.json + token.json)
// In --real mode the import is idempotent and all add/edit/delete checks run on a throwaway list that is deleted at the end.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-google.ts';
import { connect } from '../scripts/mcp-client.ts';
import { importReminders, undoImport } from '../scripts/import-reminders.ts';
import { type ParsedTask } from '../scripts/parse-reminders.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const flat = (ts: ParsedTask[]): string[] => ts.flatMap((t) => [t.title, ...flat(t.children ?? [])]);

const REAL = process.argv.includes('--real');
const FILE = fileURLToPath(new URL('../data/reminders.md', import.meta.url));
let env: Record<string, string> = {};
let mock: Awaited<ReturnType<typeof startMock>> | undefined;
const step = (s: string) => console.log(`\n▶ ${s}`);
const pass = (s: string) => console.log(`  ✔ ${s}`);

if (!REAL) {
  mock = await startMock();
  env = {
    GTASKS_API_BASE: mock.base,
    GOOGLE_TOKEN_URL: mock.tokenUrl,
    GOOGLE_CLIENT_ID: 'mock',
    GOOGLE_CLIENT_SECRET: 'mock',
    GOOGLE_REFRESH_TOKEN: 'mock',
  };
  Object.assign(process.env, env);
  process.env.IMPORT_STATE_FILE = join(tmpdir(), `gtasks-import-state-${process.pid}.json`);
  console.log(`Mock Google Tasks API at ${mock.base}`);
} else console.log('Running against the REAL Google Tasks API');

try {
  // ---------- 1. tool discovery ----------
  step('Tool discovery (stdio)');
  const { client, call, close } = await connect(env);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  console.log('  tools:', tools.join(', '));
  for (const n of ['find-tasklists', 'add-tasklists', 'update-tasklists', 'find-tasks', 'find-tasks-by-date', 'add-tasks', 'update-tasks', 'complete-tasks', 'uncomplete-tasks', 'move-task', 'delete-object', 'get-overview'])
    assert.ok(tools.includes(n), `missing tool ${n}`);
  pass(`${tools.length} tools registered`);

  // ---------- 2. import reminders.md ----------
  if (!REAL) {
    step('Pre-existing user data: list "Work" with an unrelated task (must survive import + undo)');
    const [w] = await call('add-tasklists', { titles: ['Work'] });
    await call('add-tasks', { tasks: [{ tasklist: w.id, title: 'Việc cũ của tôi' }] });
    pass('created Work / "Việc cũ của tôi"');
  }

  step('Import reminders.md (creates lists + tasks via MCP tools)');
  const { lists, stats } = await importReminders(FILE, env);
  console.log('  stats:', stats);
  let expectedTotal = 0;
  for (const l of lists) {
    const want = flat(l.tasks);
    expectedTotal += want.length;
    const have = new Set((await call('find-tasks', { tasklist: l.title })).tasks.map((t: any) => t.title));
    const missing = want.filter((t) => !have.has(t));
    assert.deepEqual(missing, [], `missing in ${l.title}`);
  }
  pass(`${lists.length} lists, all ${expectedTotal} tasks found (Reminder has >20 tasks → pagination works)`);

  step('Re-run import (idempotency)');
  const again = await importReminders(FILE, env, () => {});
  assert.equal(again.stats.tasksCreated, 0);
  assert.equal(again.stats.listsCreated, 0);
  pass(`0 created, ${again.stats.tasksSkipped} skipped`);

  step('Subtasks + dates preserved');
  const deco = (await call('find-tasks', { tasklist: 'Todo', search: 'Tìm hiểu Deco' })).tasks[0];
  const decoKids = await call('find-tasks', { tasklist: 'Todo', parentId: deco.id });
  assert.equal(decoKids.count, 5);
  pass(`"Tìm hiểu Deco" has ${decoKids.count} subtasks`);
  const overdue = await call('find-tasks-by-date', { overdue: true });
  console.log('  overdue:', overdue.tasks.map((t: any) => `${t.due} ${t.title} [${t.tasklist}]`));
  assert.ok(overdue.tasks.some((t: any) => t.title.startsWith('Clean Devices')));
  const listTitles = new Set(lists.map((l) => l.title));
  const nov = (await call('find-tasks-by-date', { startDate: '2026-11-16', endDate: '2026-11-30' })).tasks.filter((t: any) => listTitles.has(t.tasklist));
  console.log('  due 16–30/11:', nov.map((t: any) => `${t.due} ${t.title}`));
  for (const want of ['Gemini Pro', 'Monthly 4G']) assert.ok(nov.some((t: any) => t.title === want), want);
  pass('date queries OK');

  // ---------- 3. CRUD on a throwaway list ----------
  const T = `MCP Test ${new Date().toISOString().slice(0, 16)}`;
  step(`CRUD on throwaway list "${T}"`);
  const [tl] = await call('add-tasklists', { titles: [T] });
  assert.equal(tl.status, 'created');
  try {
  const [parent] = await call('add-tasks', { tasks: [{ tasklist: tl.id, title: 'Mua đồ', dueDate: '2026-11-20', notes: 'Giờ: 18:00' }] });
  const [child] = await call('add-tasks', { tasks: [{ tasklist: tl.id, title: 'Sữa chua Hy Lạp', parentId: parent.id }] });
  assert.equal(parent.due, '2026-11-20');
  assert.equal(child.parentId, parent.id);
  pass('add list + task + subtask');

  const [upd] = await call('update-tasks', { tasks: [{ tasklist: tl.id, id: parent.id, title: 'Mua đồ siêu thị', dueDate: '2026-11-21', notes: null }] });
  assert.equal(upd.title, 'Mua đồ siêu thị');
  assert.equal(upd.due, '2026-11-21');
  assert.equal(upd.notes, undefined);
  pass('update title / due / clear notes');

  const [done] = await call('complete-tasks', { tasks: [{ tasklist: tl.id, id: child.id }] });
  assert.equal(done.status, 'completed');
  assert.equal((await call('find-tasks', { tasklist: tl.id })).count, 1);
  assert.equal((await call('find-tasks', { tasklist: tl.id, includeCompleted: true })).count, 2);
  const [reopened] = await call('uncomplete-tasks', { tasks: [{ tasklist: tl.id, id: child.id }] });
  assert.equal(reopened.status, 'needsAction');
  pass('complete / uncomplete');

  const moved = await call('move-task', { tasklist: tl.id, id: child.id });
  assert.equal(moved.parentId, undefined);
  pass('move-task (un-nest subtask)');

  const [ren] = await call('update-tasklists', { lists: [{ tasklist: tl.id, title: `${T} (renamed)` }] });
  assert.ok(ren.title.endsWith('(renamed)'));
  pass('rename list');

  await call('delete-object', { type: 'task', tasklist: tl.id, id: child.id });
  assert.equal((await call('find-tasks', { tasklist: tl.id, includeCompleted: true })).count, 1);
  } finally {
    await call('delete-object', { type: 'tasklist', tasklist: tl.id }).catch(() => {});
  }
  assert.equal((await call('find-tasklists', { search: T })).length, 0);
  pass('delete task + delete list (throwaway list removed)');

  // ---------- 4. edit imported reminders (mock only: don't touch real data unasked) ----------
  if (!REAL) {
    step('Add / edit / complete / delete on the imported reminders');
    const clean = (await call('find-tasks', { tasklist: 'Me', search: 'Clean Devices' })).tasks[0];
    await call('update-tasks', { tasks: [{ tasklist: 'Me', id: clean.id, dueDate: '2026-11-22' }] }); // weekly → next week
    const [added] = await call('add-tasks', { tasks: [{ tasklist: 'Hàng tạp hóa', title: 'Chuối' }] });
    const towel = (await call('find-tasks', { tasklist: 'Hàng tạp hóa', search: 'towel' })).tasks[0];
    await call('complete-tasks', { tasks: [{ tasklist: 'Hàng tạp hóa', id: towel.id }] });
    const uw = (await call('find-tasks', { tasklist: 'Hàng tạp hóa', search: 'Underwear' })).tasks[0];
    await call('delete-object', { type: 'task', tasklist: 'Hàng tạp hóa', id: uw.id });
    const groc = await call('find-tasks', { tasklist: 'Hàng tạp hóa' });
    assert.deepEqual(groc.tasks.map((t: any) => t.title).sort(), ['Chuối', 'Meiji Plain Crackers', 'Spenco Heel Gel (đệm gót chân)', 'Sữa chua Hy Lạp'].sort());
    assert.equal((await call('find-tasks-by-date', { overdue: true })).count, 0);
    pass(`rescheduled "Clean Devices" → 2026-11-22, added "${added.title}", completed towel, deleted Underwear`);

    step('Guard rails');
    await assert.rejects(call('delete-object', { type: 'tasklist', tasklist: '@default' }), /400/);
    await assert.rejects(call('find-tasks', { tasklist: 'Không tồn tại' }), /not found/);
    pass('default list cannot be deleted; unknown list → clear error');

    step('Undo import only removes what the import created');
    await undoImport(env, () => {});
    const left = (await call('find-tasklists')).map((l: any) => l.title).sort();
    assert.deepEqual(left, ['My Tasks', 'Work']);
    const work = (await call('find-tasks', { tasklist: 'Work', includeCompleted: true })).tasks.map((t: any) => t.title);
    assert.deepEqual(work, ['Việc cũ của tôi']);
    pass(`remaining lists: ${left.join(', ')}; Work keeps only "${work[0]}"`);
  }

  step('Overview');
  console.table(await call('get-overview'));
  await close();

  // ---------- 5. Streamable HTTP transport ----------
  step('Streamable HTTP transport with bearer token');
  const PORT = String(18000 + Math.floor(Math.random() * 1000));
  const srv = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url)), '--http'], {
    env: { ...process.env, ...env, PORT, MCP_AUTH_TOKEN: 'test-secret' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise((ok) => srv.stderr!.on('data', (d) => String(d).includes('listening') && ok(null)));
  const url = `http://127.0.0.1:${PORT}/mcp`;
  const unauth = await fetch(url, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);
  process.env.MCP_URL = url;
  process.env.MCP_AUTH_TOKEN = 'test-secret';
  const http = await connect();
  const viaHttp = await http.call('find-tasklists');
  await http.close();
  delete process.env.MCP_URL;
  srv.kill();
  pass(`401 without token; with token: ${viaHttp.length} lists via ${url}`);

  console.log('\n✅ ALL CHECKS PASSED' + (mock ? ` (${mock.state.calls} Google API calls served by mock)` : ''));
} finally {
  mock?.server.close();
}
