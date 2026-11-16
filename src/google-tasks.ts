// Minimal Google Tasks API v1 client (no googleapis dependency).
// Auth: OAuth2 refresh token -> short-lived access token, refreshed automatically.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_BASE = process.env.GTASKS_API_BASE ?? 'https://tasks.googleapis.com/tasks/v1';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';

export type TaskList = { id: string; title: string; updated?: string; selfLink?: string };
export type Task = {
  id: string;
  title: string;
  notes?: string;
  status: 'needsAction' | 'completed';
  due?: string; // RFC 3339; Google keeps only the DATE part
  completed?: string;
  parent?: string;
  position?: string;
  updated?: string;
  deleted?: boolean;
  hidden?: boolean;
  webViewLink?: string;
};

type Creds = { clientId: string; clientSecret: string; refreshToken: string };

export function loadCreds(root = process.cwd()): Creds {
  // 1) env vars win (handy for Cloud Run / CI), 2) credentials.json + token.json files
  const env = process.env;
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN };
  }
  const credPath = resolve(root, env.GOOGLE_CREDENTIALS_FILE ?? 'credentials.json');
  const tokenPath = resolve(root, env.GOOGLE_TOKEN_FILE ?? 'token.json');
  let c: any, t: any;
  try {
    c = JSON.parse(readFileSync(credPath, 'utf8'));
    t = JSON.parse(readFileSync(tokenPath, 'utf8'));
  } catch (e) {
    throw new Error(
      `Missing Google credentials. Put the OAuth client JSON at ${credPath} and run "npm run auth" to create ${tokenPath}. (${(e as Error).message})`,
    );
  }
  const app = c.installed ?? c.web ?? c;
  return { clientId: app.client_id, clientSecret: app.client_secret, refreshToken: t.refresh_token };
}

export class GoogleTasksClient {
  private accessToken?: string;
  private expiresAt = 0;
  private creds: Creds;
  constructor(creds: Creds) {
    this.creds = creds;
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${JSON.stringify(body)}. Re-run "npm run auth".`);
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken!;
  }

  private async req<T>(method: string, path: string, opts: { query?: Record<string, any>; body?: any } = {}): Promise<T> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) throw new Error(`Google Tasks API ${method} ${path} -> ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ---- task lists ----
  async listTaskLists(): Promise<TaskList[]> {
    const out: TaskList[] = [];
    let pageToken: string | undefined;
    do {
      const r: any = await this.req('GET', '/users/@me/lists', { query: { maxResults: 100, pageToken } });
      out.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }
  insertTaskList(title: string) {
    return this.req<TaskList>('POST', '/users/@me/lists', { body: { title } });
  }
  patchTaskList(id: string, title: string) {
    return this.req<TaskList>('PATCH', `/users/@me/lists/${enc(id)}`, { body: { title } });
  }
  deleteTaskList(id: string) {
    return this.req<void>('DELETE', `/users/@me/lists/${enc(id)}`);
  }

  // ---- tasks ----
  async listTasks(
    listId: string,
    q: { showCompleted?: boolean; showHidden?: boolean; dueMin?: string; dueMax?: string } = {},
  ): Promise<Task[]> {
    const out: Task[] = [];
    let pageToken: string | undefined;
    do {
      const r: any = await this.req('GET', `/lists/${enc(listId)}/tasks`, { query: { maxResults: 100, pageToken, ...q } });
      out.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    // Order isn't guaranteed by the API; `position` sorts correctly within each sibling group.
    return out.sort((a, b) => (a.position ?? '').localeCompare(b.position ?? ''));
  }
  getTask(listId: string, taskId: string) {
    return this.req<Task>('GET', `/lists/${enc(listId)}/tasks/${enc(taskId)}`);
  }
  insertTask(listId: string, task: Partial<Task>, opts: { parent?: string; previous?: string } = {}) {
    return this.req<Task>('POST', `/lists/${enc(listId)}/tasks`, { query: opts, body: task });
  }
  patchTask(listId: string, taskId: string, patch: Partial<Task> | Record<string, any>) {
    return this.req<Task>('PATCH', `/lists/${enc(listId)}/tasks/${enc(taskId)}`, { body: patch });
  }
  deleteTask(listId: string, taskId: string) {
    return this.req<void>('DELETE', `/lists/${enc(listId)}/tasks/${enc(taskId)}`);
  }
  moveTask(listId: string, taskId: string, opts: { parent?: string; previous?: string; destinationTasklist?: string }) {
    return this.req<Task>('POST', `/lists/${enc(listId)}/tasks/${enc(taskId)}/move`, { query: opts });
  }
  clearCompleted(listId: string) {
    return this.req<void>('POST', `/lists/${enc(listId)}/clear`);
  }
}

const enc = encodeURIComponent;

/** "2026-11-24" or full RFC3339 -> RFC3339 at UTC midnight (Google ignores the time part anyway). */
export function toDue(date: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(date);
  if (!m) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  return `${m[1]}T00:00:00.000Z`;
}
