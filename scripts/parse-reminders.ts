// Parse the exported Apple Reminders markdown into lists/tasks for Google Tasks.
import { readFileSync } from 'node:fs';

export type ParsedTask = { title: string; notes?: string; dueDate?: string; children?: ParsedTask[] };
export type ParsedList = { title: string; tasks: ParsedTask[] };

const clean = (s: string) => s.replace(/\*\*/g, '').trim();
// "Gmail kiểm tra lại *(note)*" -> { title, note }
function splitNote(s: string): { title: string; note?: string } {
  const m = /^(.*?)\s*\*\((.+)\)\*\s*$/.exec(s);
  return m ? { title: clean(m[1]), note: m[2].trim() } : { title: clean(s) };
}
// "## 📋 Todo (17), không có hạn" -> "Todo"
const sectionName = (h: string) =>
  h.replace(/^#+\s*/, '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s*\(\d+\).*$/, '').replace(/,.*$/, '').trim();

export function parseReminders(path: string): ParsedList[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const lists = new Map<string, ParsedList>();
  const list = (title: string) => {
    if (!lists.has(title)) lists.set(title, { title, tasks: [] });
    return lists.get(title)!;
  };

  let section = '';
  let group: string | undefined; // ### heading inside Reminder
  let groupParent: ParsedTask | undefined; // real parent task (Hermes Agent)
  let lastTop: ParsedTask | undefined;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      section = line;
      group = groupParent = lastTop = undefined;
      continue;
    }
    if (line.startsWith('### ')) {
      group = line.slice(4).trim();
      // The file says sub-headings are suggestions, except Hermes Agent which is a real group in the app.
      if (/^Hermes Agent/i.test(group)) {
        groupParent = { title: group, children: [] };
        list(sectionName(section)).tasks.push(groupParent);
      } else groupParent = undefined;
      continue;
    }

    // Dated table: | Ngày | Nhắc nhở | Danh sách | Lặp lại |
    if (section.includes('Có hạn') && line.startsWith('|') && !/^\|\s*(Ngày|---)/.test(line)) {
      const [dateCell, title, listName, repeat] = line.split('|').slice(1, -1).map((c) => c.trim());
      const m = /(\d{2})\/(\d{2})\/(\d{4})(?:,\s*(\d{1,2}:\d{2}))?/.exec(dateCell);
      if (!m) continue;
      const notes = [
        m[4] && `Giờ: ${m[4]}`,
        repeat && repeat !== '—' && `Lặp lại: ${repeat}`,
        /quá hạn/.test(dateCell) && 'Đã quá hạn lúc export (16/11/2026)',
        'Nguồn: Apple Reminders',
      ].filter(Boolean);
      list(listName).tasks.push({ title, dueDate: `${m[3]}-${m[2]}-${m[1]}`, notes: notes.join(' · ') });
      continue;
    }

    const item = /^(\s*)- \[ \] (.+)$/.exec(line);
    if (!item || !section) continue;
    const indented = item[1].length >= 2;
    const { title, note } = splitNote(item[2]);
    const notes = [note, !groupParent && group && `Nhóm: ${group}`].filter(Boolean).join(' · ') || undefined;
    const task: ParsedTask = { title, notes };
    const target = list(sectionName(section));
    if (indented && lastTop) (lastTop.children ??= []).push(task);
    else if (groupParent) groupParent.children!.push(task);
    else {
      target.tasks.push(task);
      lastTop = task;
    }
  }
  return [...lists.values()];
}

export const countTasks = (ts: ParsedTask[]): number => ts.reduce((n, t) => n + 1 + countTasks(t.children ?? []), 0);

if (import.meta.main) {
  const lists = parseReminders(process.argv[2] ?? 'data/reminders.md');
  console.log(JSON.stringify(lists, null, 2));
  for (const l of lists) console.error(`${l.title}: ${countTasks(l.tasks)}`);
}
