// MCP tools for Google Tasks, modelled after todoist/todoist-mcp
// (Todoist "project" ~ Google "task list"; batch inputs as arrays).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GoogleTasksClient, type Task, type TaskList, toDue } from './google-tasks.ts';

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message ?? String(e) }] });

const slimTask = (t: Task, listId?: string) => ({
  id: t.id,
  tasklistId: listId,
  title: t.title,
  status: t.status,
  due: t.due?.slice(0, 10),
  notes: t.notes,
  parentId: t.parent,
  completed: t.completed,
});

// YYYY-MM-DD in the server's local timezone (set TZ, e.g. Asia/Ho_Chi_Minh, when hosting)
const todayLocal = () => new Date().toLocaleDateString('sv-SE');
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const listRef = z.string().describe('Task list ID, or its exact title (case-insensitive). "@default" = default list.');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export function registerTools(server: McpServer, api: GoogleTasksClient) {
  // Resolve a list by id or title (cached per call).
  async function resolveList(ref: string, lists?: TaskList[]): Promise<TaskList> {
    if (ref === '@default') return { id: '@default', title: '@default' };
    lists ??= await api.listTaskLists();
    const hit = lists.find((l) => l.id === ref) ?? lists.find((l) => l.title.toLowerCase() === ref.toLowerCase());
    if (!hit) throw new Error(`Task list "${ref}" not found. Existing: ${lists.map((l) => l.title).join(', ')}`);
    return hit;
  }
  const wrap =
    <A,>(fn: (a: A) => Promise<unknown>) =>
    async (a: A) => {
      try {
        return ok(await fn(a));
      } catch (e) {
        return fail(e);
      }
    };

  // ---------------- task lists ----------------
  server.registerTool(
    'find-tasklists',
    {
      title: 'Find task lists',
      description: 'List all Google Tasks lists, optionally filtered by a title substring.',
      inputSchema: { search: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ search }) => {
      const lists = await api.listTaskLists();
      const s = search?.toLowerCase();
      return lists.filter((l) => !s || l.title.toLowerCase().includes(s)).map((l) => ({ id: l.id, title: l.title, updated: l.updated }));
    }),
  );

  server.registerTool(
    'add-tasklists',
    {
      title: 'Add task lists',
      description: 'Create one or more task lists. Skips titles that already exist unless allowDuplicates=true.',
      inputSchema: { titles: z.array(z.string().min(1)).min(1), allowDuplicates: z.boolean().optional() },
    },
    wrap(async ({ titles, allowDuplicates }) => {
      const existing = await api.listTaskLists();
      const out = [];
      for (const title of titles) {
        const dup = existing.find((l) => l.title === title);
        if (dup && !allowDuplicates) out.push({ id: dup.id, title, status: 'exists' });
        else {
          const l = await api.insertTaskList(title);
          existing.push(l);
          out.push({ id: l.id, title: l.title, status: 'created' });
        }
      }
      return out;
    }),
  );

  server.registerTool(
    'update-tasklists',
    {
      title: 'Rename task lists',
      description: 'Rename one or more task lists.',
      inputSchema: { lists: z.array(z.object({ tasklist: listRef, title: z.string().min(1) })).min(1) },
      annotations: { idempotentHint: true },
    },
    wrap(async ({ lists }) => {
      const all = await api.listTaskLists();
      const out = [];
      for (const { tasklist, title } of lists) {
        const l = await resolveList(tasklist, all);
        const u = await api.patchTaskList(l.id, title);
        out.push({ id: u.id, title: u.title });
      }
      return out;
    }),
  );

  // ---------------- tasks ----------------
  server.registerTool(
    'find-tasks',
    {
      title: 'Find tasks',
      description:
        'Find tasks in one list (or all lists if tasklist is omitted). Filters: title/notes substring, parentId, includeCompleted. Follows pagination.',
      inputSchema: {
        tasklist: listRef.optional(),
        search: z.string().optional(),
        parentId: z.string().optional().describe('Only subtasks of this task'),
        includeCompleted: z.boolean().optional().describe('Default false'),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ tasklist, search, parentId, includeCompleted, limit }) => {
      const all = await api.listTaskLists();
      const lists = tasklist ? [await resolveList(tasklist, all)] : all;
      const s = search?.toLowerCase();
      const out = [];
      for (const l of lists) {
        const tasks = await api.listTasks(l.id, { showCompleted: !!includeCompleted, showHidden: !!includeCompleted });
        for (const t of tasks) {
          if (s && !`${t.title} ${t.notes ?? ''}`.toLowerCase().includes(s)) continue;
          if (parentId && t.parent !== parentId) continue;
          out.push({ ...slimTask(t, l.id), tasklist: l.title });
        }
      }
      return { count: out.length, tasks: limit ? out.slice(0, limit) : out };
    }),
  );

  server.registerTool(
    'find-tasks-by-date',
    {
      title: 'Find tasks by due date',
      description:
        'Open tasks due in [startDate, endDate] across all lists (or one list). overdue=true returns tasks due before today. Google Tasks stores dates only (no time).',
      inputSchema: {
        startDate: dateStr.optional().describe('Default: today'),
        endDate: dateStr.optional().describe('Default: startDate'),
        overdue: z.boolean().optional(),
        tasklist: listRef.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ startDate, endDate, overdue, tasklist }) => {
      const today = todayLocal();
      // Inclusive date range [from, to] as YYYY-MM-DD strings.
      const from = overdue ? undefined : (startDate ?? today);
      const to = overdue ? addDays(today, -1) : (endDate ?? from!);
      // The real API's dueMin/dueMax boundaries are not reliably inclusive (dueMax=…T23:59:59 drops that
      // day), so query one day wider on each side and filter exactly on the date part here.
      const min = from ? toDue(addDays(from, -1)) : undefined;
      const max = toDue(addDays(to, 1));
      const all = await api.listTaskLists();
      const lists = tasklist ? [await resolveList(tasklist, all)] : all;
      const out = [];
      for (const l of lists) {
        const tasks = await api.listTasks(l.id, { showCompleted: false, dueMin: min, dueMax: max });
        for (const t of tasks) {
          const d = t.due?.slice(0, 10);
          if (d && (!from || d >= from) && d <= to) out.push({ ...slimTask(t, l.id), tasklist: l.title });
        }
      }
      out.sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
      return { count: out.length, tasks: out };
    }),
  );

  const newTask = z.object({
    tasklist: listRef,
    title: z.string().min(1),
    notes: z.string().optional(),
    dueDate: dateStr.optional().describe('YYYY-MM-DD (time is not supported by Google Tasks; put it in notes)'),
    parentId: z.string().optional().describe('Create as subtask of this task (same list)'),
    previousId: z.string().optional().describe('Insert after this sibling'),
  });

  server.registerTool(
    'add-tasks',
    {
      title: 'Add tasks',
      description: 'Create one or more tasks (optionally as subtasks). Tasks are created in order.',
      inputSchema: { tasks: z.array(newTask).min(1).max(100) },
    },
    wrap(async ({ tasks }) => {
      const all = await api.listTaskLists();
      const out = [];
      for (const t of tasks) {
        const l = await resolveList(t.tasklist, all);
        const created = await api.insertTask(
          l.id,
          { title: t.title, notes: t.notes, due: t.dueDate ? toDue(t.dueDate) : undefined },
          { parent: t.parentId, previous: t.previousId },
        );
        out.push(slimTask(created, l.id));
      }
      return out;
    }),
  );

  server.registerTool(
    'update-tasks',
    {
      title: 'Update tasks',
      description: 'Edit title / notes / due date of tasks. Pass dueDate=null or notes=null to clear. Use move-task to re-parent.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              tasklist: listRef,
              id: z.string(),
              title: z.string().min(1).optional(),
              notes: z.string().nullable().optional(),
              dueDate: dateStr.nullable().optional(),
            }),
          )
          .min(1),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async ({ tasks }) => {
      const all = await api.listTaskLists();
      const out = [];
      for (const t of tasks) {
        const l = await resolveList(t.tasklist, all);
        const patch: Record<string, any> = {};
        if (t.title !== undefined) patch.title = t.title;
        if (t.notes !== undefined) patch.notes = t.notes;
        if (t.dueDate !== undefined) patch.due = t.dueDate === null ? null : toDue(t.dueDate);
        out.push(slimTask(await api.patchTask(l.id, t.id, patch), l.id));
      }
      return out;
    }),
  );

  const taskRef = z.object({ tasklist: listRef, id: z.string() });
  for (const [name, status] of [
    ['complete-tasks', 'completed'],
    ['uncomplete-tasks', 'needsAction'],
  ] as const) {
    server.registerTool(
      name,
      {
        title: status === 'completed' ? 'Complete tasks' : 'Reopen tasks',
        description: status === 'completed' ? 'Mark tasks as completed.' : 'Mark completed tasks as not completed.',
        inputSchema: { tasks: z.array(taskRef).min(1) },
        annotations: { idempotentHint: true },
      },
      wrap(async ({ tasks }) => {
        const all = await api.listTaskLists();
        const out = [];
        for (const t of tasks) {
          const l = await resolveList(t.tasklist, all);
          const patch: Record<string, any> = { status };
          if (status === 'needsAction') patch.completed = null;
          out.push(slimTask(await api.patchTask(l.id, t.id, patch), l.id));
        }
        return out;
      }),
    );
  }

  server.registerTool(
    'move-task',
    {
      title: 'Move task',
      description: 'Reorder a task, make it a subtask (parentId), un-nest it (parentId omitted), or move it to another list.',
      inputSchema: {
        tasklist: listRef,
        id: z.string(),
        parentId: z.string().optional(),
        previousId: z.string().optional(),
        destinationTasklist: listRef.optional(),
      },
    },
    wrap(async ({ tasklist, id, parentId, previousId, destinationTasklist }) => {
      const all = await api.listTaskLists();
      const l = await resolveList(tasklist, all);
      const dest = destinationTasklist ? await resolveList(destinationTasklist, all) : undefined;
      const t = await api.moveTask(l.id, id, { parent: parentId, previous: previousId, destinationTasklist: dest?.id });
      return slimTask(t, dest?.id ?? l.id);
    }),
  );

  server.registerTool(
    'delete-object',
    {
      title: 'Delete task or list',
      description: 'Permanently delete a task (type="task", needs id) or a whole task list (type="tasklist"). The default list cannot be deleted.',
      inputSchema: { type: z.enum(['task', 'tasklist']), tasklist: listRef, id: z.string().optional() },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ type, tasklist, id }) => {
      const l = await resolveList(tasklist);
      if (type === 'tasklist') {
        await api.deleteTaskList(l.id);
        return { deleted: 'tasklist', id: l.id, title: l.title };
      }
      if (!id) throw new Error('id is required when type="task"');
      await api.deleteTask(l.id, id);
      return { deleted: 'task', tasklistId: l.id, id };
    }),
  );

  server.registerTool(
    'get-overview',
    {
      title: 'Overview',
      description: 'Per-list counts of open, overdue and due-today tasks.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      const today = todayLocal();
      const lists = await api.listTaskLists();
      const out = [];
      for (const l of lists) {
        const tasks = await api.listTasks(l.id, { showCompleted: false });
        out.push({
          id: l.id,
          title: l.title,
          open: tasks.length,
          overdue: tasks.filter((t) => t.due && t.due.slice(0, 10) < today).length,
          dueToday: tasks.filter((t) => t.due?.slice(0, 10) === today).length,
        });
      }
      return out;
    }),
  );
}
