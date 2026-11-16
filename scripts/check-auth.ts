// Exit 0 if the saved Google refresh token still works, 2 if (re)auth is needed, 1 on other errors.
import { GoogleTasksClient, loadCreds } from '../src/google-tasks.ts';

try {
  const lists = await new GoogleTasksClient(loadCreds()).listTaskLists();
  console.log(`✔ Google Tasks OK — ${lists.length} lists: ${lists.map((l) => l.title).join(', ')}`);
} catch (e) {
  const msg = (e as Error).message;
  console.error(`✖ ${msg}`);
  process.exit(/Missing Google credentials|invalid_grant|Token refresh failed/.test(msg) ? 2 : 1);
}
