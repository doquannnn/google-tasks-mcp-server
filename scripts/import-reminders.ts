// Import data/reminders.md into Google Tasks THROUGH the MCP server's tools.
// Idempotent: lists matched by title, tasks matched by (title, parent) — safe to re-run.
// Everything the import creates is recorded in .import-state.json so --undo removes ONLY that
// (lists it created; tasks it added into lists that already existed) — never your pre-existing data.
//   node scripts/import-reminders.ts [file.md]
//   node scripts/import-reminders.ts --undo
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { parseReminders, countTasks, type ParsedTask } from './parse-reminders.ts';
import { connect } from './mcp-client.ts';

type State = { createdLists: { id: string; title: string }[]; createdTasks: { listId: string; id: string; title: string }[] };
const stateFile = () => process.env.IMPORT_STATE_FILE ?? '.import-state.json';
const loadState = (): State => (existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), 'utf8')) : { createdLists: [], createdTasks: [] });
const saveState = (s: State) => writeFileSync(stateFile(), JSON.stringify(s, null, 2));

export async function importReminders(file: string, env: Record<string, string> = {}, log = console.log) {
  const lists = parseReminders(file);
  const state = loadState();
  const { call, close } = await connect(env);
  const stats = { listsCreated: 0, listsExisting: 0, tasksCreated: 0, tasksSkipped: 0 };
  try {
    const res = await call<{ id: string; title: string; status: string }[]>('add-tasklists', { titles: lists.map((l) => l.title) });
    for (const r of res) {
      if (r.status === 'created') {
        stats.listsCreated++;
        state.createdLists.push({ id: r.id, title: r.title });
      } else stats.listsExisting++;
    }
    saveState(state);
    const ownedList = (id: string) => state.createdLists.some((l) => l.id === id);

    for (const l of lists) {
      const listId = res.find((r) => r.title === l.title)!.id;
      const existing = (await call('find-tasks', { tasklist: listId, includeCompleted: true })).tasks as any[];
      const findExisting = (title: string, parentId?: string) => existing.find((t) => t.title === title && t.parentId === parentId);

      const addAll = async (tasks: ParsedTask[], parentId?: string) => {
        const missing = tasks.filter((t) => !findExisting(t.title, parentId));
        stats.tasksSkipped += tasks.length - missing.length;
        // Google inserts new tasks at the top; pass previousId to keep file order.
        let previousId = existing.filter((t) => t.parentId === parentId).at(-1)?.id;
        for (const t of missing) {
          const [c] = await call('add-tasks', {
            tasks: [{ tasklist: listId, title: t.title, notes: t.notes, dueDate: t.dueDate, parentId, previousId }],
          });
          existing.push(c);
          previousId = c.id;
          stats.tasksCreated++;
          if (!ownedList(listId)) {
            state.createdTasks.push({ listId, id: c.id, title: c.title });
            saveState(state);
          }
        }
        for (const t of tasks) if (t.children?.length) await addAll(t.children, findExisting(t.title, parentId).id);
      };
      await addAll(l.tasks);
      log(`  ✔ ${l.title}: ${countTasks(l.tasks)} tasks${ownedList(listId) ? '' : ' (list already existed — merged)'}`);
    }
    return { lists, stats };
  } finally {
    await close();
  }
}

export async function undoImport(env: Record<string, string> = {}, log = console.log) {
  const state = loadState();
  const { call, close } = await connect(env);
  const ignore404 = (e: Error) => {
    if (!/404|not found/i.test(e.message)) throw e;
  };
  try {
    // tasks added into pre-existing lists (reverse order: children before parents)
    for (const t of [...state.createdTasks].reverse()) {
      await call('delete-object', { type: 'task', tasklist: t.listId, id: t.id }).catch(ignore404);
      log(`  ✖ deleted task "${t.title}"`);
    }
    for (const l of state.createdLists) {
      await call('delete-object', { type: 'tasklist', tasklist: l.id }).catch(ignore404);
      log(`  ✖ deleted list "${l.title}"`);
    }
    rmSync(stateFile(), { force: true });
  } finally {
    await close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--undo')) await undoImport();
  else console.log((await importReminders(args.find((a) => !a.startsWith('--')) ?? 'data/reminders.md')).stats);
}
