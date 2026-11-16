// In-memory fake of the Google Tasks v1 REST API + OAuth token endpoint, for offline tests.
// Mimics the behaviours that matter: date-only `due`, maxResults default 20 / max 100 with
// nextPageToken, showCompleted/showHidden, dueMin/dueMax, parent/previous, move, undeletable @default.
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

type L = { id: string; title: string; updated: string };
type T = { id: string; title: string; notes?: string; status: string; due?: string; completed?: string; parent?: string; position: string; updated: string; hidden?: boolean };

export function startMock(port = 0): Promise<{ server: Server; base: string; tokenUrl: string; state: { lists: L[]; tasks: Map<string, T[]>; calls: number } }> {
  const now = () => new Date().toISOString();
  const state = { lists: [{ id: 'DEFAULT', title: 'My Tasks', updated: now() }] as L[], tasks: new Map<string, T[]>([['DEFAULT', []]]), calls: 0 };
  const id = () => randomUUID().replace(/-/g, '').slice(0, 22);
  const resolve = (lid: string) => (lid === '@default' ? 'DEFAULT' : lid);
  const reposition = (arr: T[]) => arr.forEach((t, i) => (t.position = String(i).padStart(20, '0')));
  const dateOnly = (d?: string | null) => (d ? d.slice(0, 10) + 'T00:00:00.000Z' : undefined);

  const server = createServer(async (req, res) => {
    state.calls++;
    const url = new URL(req.url!, 'http://x');
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : undefined;
    const send = (code: number, data?: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const err = (code: number, message: string) => send(code, { error: { code, message } });

    if (url.pathname === '/token') return send(200, { access_token: 'mock-access', expires_in: 3600, token_type: 'Bearer' });
    if (req.headers.authorization !== 'Bearer mock-access') return err(401, 'bad token');

    const p = url.pathname.replace(/^\/tasks\/v1/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const q = url.searchParams;

    // /users/@me/lists[/id]
    if (p[0] === 'users' && p[2] === 'lists') {
      const lid = p[3] && resolve(p[3]);
      if (!lid && req.method === 'GET') return send(200, { kind: 'tasks#taskLists', items: state.lists });
      if (!lid && req.method === 'POST') {
        const l = { id: id(), title: body.title, updated: now() };
        state.lists.push(l);
        state.tasks.set(l.id, []);
        return send(200, l);
      }
      const l = state.lists.find((x) => x.id === lid);
      if (!l) return err(404, 'Not Found');
      if (req.method === 'GET') return send(200, l);
      if (req.method === 'PATCH') return (Object.assign(l, { title: body.title ?? l.title, updated: now() }), send(200, l));
      if (req.method === 'DELETE') {
        if (l.id === 'DEFAULT') return err(400, 'Invalid Value'); // default list can't be deleted
        state.lists = state.lists.filter((x) => x !== l);
        state.tasks.delete(l.id);
        return send(204);
      }
    }

    // /lists/{lid}/tasks[/{tid}[/move]] , /lists/{lid}/clear
    if (p[0] === 'lists') {
      const lid = resolve(p[1]);
      const arr = state.tasks.get(lid);
      if (!arr) return err(404, 'Not Found');
      if (p[2] === 'clear') return (arr.forEach((t) => t.status === 'completed' && (t.hidden = true)), send(204));
      const tid = p[3];
      if (!tid && req.method === 'GET') {
        const max = Math.min(Number(q.get('maxResults') ?? 20), 100);
        const showCompleted = q.get('showCompleted') !== 'false';
        const showHidden = q.get('showHidden') === 'true';
        const dueMin = q.get('dueMin'), dueMax = q.get('dueMax');
        const filtered = arr.filter(
          (t) =>
            (showCompleted || t.status !== 'completed') &&
            (showHidden || !t.hidden) &&
            (!dueMin || (t.due && t.due >= dueMin)) &&
            (!dueMax || (t.due && t.due <= dueMax)),
        );
        const start = Number(q.get('pageToken') ?? 0);
        const page = filtered.slice(start, start + max);
        return send(200, { items: page, ...(start + max < filtered.length ? { nextPageToken: String(start + max) } : {}) });
      }
      if (!tid && req.method === 'POST') {
        const parent = q.get('parent') ?? undefined;
        if (parent && !arr.find((t) => t.id === parent)) return err(400, 'Invalid parent');
        const t: T = { id: id(), title: body.title, notes: body.notes, status: body.status ?? 'needsAction', due: dateOnly(body.due), parent, position: '', updated: now() };
        const prev = q.get('previous');
        // like Google: without `previous` the task goes to the TOP of its siblings
        const idx = prev ? arr.findIndex((x) => x.id === prev) + 1 : parent ? arr.findIndex((x) => x.id === parent) + 1 : 0;
        arr.splice(idx, 0, t);
        reposition(arr);
        return send(200, t);
      }
      const t = arr.find((x) => x.id === tid);
      if (!t) return err(404, 'Not Found');
      if (p[4] === 'move' && req.method === 'POST') {
        const parent = q.get('parent') ?? undefined;
        const destId = q.get('destinationTasklist') ? resolve(q.get('destinationTasklist')!) : lid;
        const dest = state.tasks.get(destId);
        if (!dest) return err(404, 'Not Found');
        arr.splice(arr.indexOf(t), 1);
        t.parent = parent;
        const prev = q.get('previous');
        dest.splice(prev ? dest.findIndex((x) => x.id === prev) + 1 : dest.length, 0, t);
        reposition(arr);
        reposition(dest);
        return send(200, t);
      }
      if (req.method === 'GET') return send(200, t);
      if (req.method === 'PATCH') {
        if ('title' in body) t.title = body.title;
        if ('notes' in body) t.notes = body.notes ?? undefined;
        if ('due' in body) t.due = dateOnly(body.due);
        if ('status' in body) {
          t.status = body.status;
          t.completed = body.status === 'completed' ? now() : undefined;
        }
        t.updated = now();
        return send(200, t);
      }
      if (req.method === 'DELETE') {
        // deleting a parent removes its subtasks too
        const doomed = new Set([t.id, ...arr.filter((x) => x.parent === t.id).map((x) => x.id)]);
        state.tasks.set(lid, arr.filter((x) => !doomed.has(x.id)));
        return send(204);
      }
    }
    err(404, `no route ${req.method} ${url.pathname}`);
  });

  return new Promise((ok) =>
    server.listen(port, '127.0.0.1', () => {
      const a = server.address() as any;
      const origin = `http://127.0.0.1:${a.port}`;
      ok({ server, base: `${origin}/tasks/v1`, tokenUrl: `${origin}/token`, state });
    }),
  );
}
