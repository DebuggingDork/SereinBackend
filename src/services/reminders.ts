import { sendMail } from '../lib/email.js';
import { must } from '../lib/errors.js';
import { db } from '../lib/supabase.js';

interface DueItem {
  user_id: string;
  email: string;
  local_day: string;
  kind: 'bill' | 'task' | 'loan';
  title: string;
  due_on: string;
  amount: number | null;
}

const HEADINGS = { bill: 'Bills', task: 'Tasks', loan: 'Loans' } as const;

export function reminderText(items: Pick<DueItem, 'kind' | 'title' | 'due_on' | 'amount'>[]): string {
  const sections = (['bill', 'task', 'loan'] as const)
    .map((kind) => {
      const lines = items
        .filter((item) => item.kind === kind)
        .map((item) => `${item.title}, due ${item.due_on}${item.amount === null ? '' : ` (${item.amount})`}`);
      return lines.length > 0 ? `${HEADINGS[kind]}\n${lines.join('\n')}` : null;
    })
    .filter((section) => section !== null);
  return ['Here is what needs you today.', ...sections].join('\n\n');
}

// A person is claimed before their mail goes out, so a repeated or overlapping run can
// never send it twice. A mail that fails is not retried that day.
export async function sendDailyReminders(): Promise<{ people: number; sent: number }> {
  const items = must(await db.rpc('due_reminders')) as DueItem[];
  const byPerson = new Map<string, DueItem[]>();
  for (const item of items) byPerson.set(item.user_id, [...(byPerson.get(item.user_id) ?? []), item]);

  let sent = 0;
  for (const [userId, due] of byPerson) {
    const [first] = due;
    const claimed = must(
      await db
        .from('reminder_runs')
        .upsert({ user_id: userId, sent_on: first!.local_day }, { ignoreDuplicates: true })
        .select('user_id'),
    );
    if (claimed.length === 0) continue;
    await sendMail({ to: first!.email, subject: 'Due today on Serein', text: reminderText(due) });
    sent += 1;
  }
  return { people: byPerson.size, sent };
}
