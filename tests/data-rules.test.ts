import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hasLongNumber } from '../src/lib/longNumber.js';
import { db } from '../src/lib/supabase.js';
import { anonKey, browserClient, createPerson, setUp, type Person } from './helpers.js';

const POSTGRES = 'supabase_db_backend';

// The jobs are unreachable through the API by design, so these go straight to Postgres.
function psql(script: string): string {
  return execFileSync('docker', ['exec', '-i', POSTGRES, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const hasPostgres = (() => {
  try {
    return psql('select 1').trim() === '1';
  } catch {
    return false;
  }
})();

async function gated(): Promise<Person> {
  const person = await createPerson();
  await setUp(person);
  return person;
}

const one = async (client: Person['client'], table: string, row: object) => {
  const { data, error } = await client.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
};

describe('the long number rule', () => {
  it.each([
    '4111111111111111',
    '4111 1111 1111 1111',
    '4111-1111-1111-1111',
    '4111.1111.1111.1111',
    '4111/1111/1111/1111',
    '4111_1111_1111_1111',
    'card 4111:1111:1111:1111 thanks',
    '123456789012',
  ])('refuses %s', (value) => expect(hasLongNumber(value)).toBe(true));

  it.each([
    '2026-10-27',
    '27/10/2026',
    '2026-10-27 12:30:00',
    '27.10.2026 18:45',
    'Paid 1,00,000.50 on 2026-10-27',
    '12345678901',
    'Rent for flat 402',
    'Order 12 of 40',
  ])('allows %s', (value) => expect(hasLongNumber(value)).toBe(false));
});

describe.skipIf(!anonKey)('the long number rule in the database', () => {
  it('holds on names, notes and profile fields, and agrees with the code', async () => {
    const { client, id } = await gated();
    const card = '4111.1111.1111.1111';
    const account = await one(client, 'accounts', { name: 'Bank', kind: 'bank' });
    const refused: [string, object][] = [
      ['transactions', { kind: 'expense', amount: 1, account_id: account.id, notes: card }],
      ['transactions', { kind: 'expense', amount: 1, account_id: account.id, payment_app: card }],
      ['people', { name: card }],
      ['goals', { name: card, target: 10 }],
      ['categories', { name: card }],
      ['transaction_templates', { name: card, amount: 1 }],
      ['scheduled_items', { name: card, amount: 1, account_id: account.id, frequency: 'monthly', next_run: '2030-01-01' }],
      ['tasks', { title: card }],
      ['tasks', { title: 'ok', notes: card }],
      ['foods', { name: card }],
      ['meal_logs', { meal_type: 'lunch', name: card }],
    ];
    for (const [table, row] of refused) {
      expect((await client.from(table).insert(row)).error?.code, `${table} ${JSON.stringify(row)}`).toBe('23514');
    }
    expect((await client.from('profiles').update({ display_name: card }).eq('id', id)).error?.code).toBe('23514');

    const fine = await client.from('transactions').insert({
      kind: 'expense', amount: 1, account_id: account.id, notes: 'Settled 2026-10-27 12:30:00, 1,00,000.50',
    });
    expect(fine.error).toBeNull();
  });

  it('never lets a name break signing up', async () => {
    for (const name of ['4111 1111 1111 1111', 'x'.repeat(200)]) {
      const { data, error } = await db.auth.admin.createUser({
        email: `${randomUUID()}@serein.test`,
        password: 'correct-horse-battery',
        email_confirm: true,
        user_metadata: { name },
      });
      expect(error).toBeNull();
      const profile = await db.from('profiles').select('display_name').eq('id', data.user!.id).single();
      expect(profile.data!.display_name.length).toBeLessThanOrEqual(80);
      expect(hasLongNumber(profile.data!.display_name)).toBe(false);
    }
  });
});

describe.skipIf(!anonKey)('references stay inside one account', () => {
  it('refuses every row that points at someone else', async () => {
    const victim = await gated();
    const attacker = await gated();
    const { client } = attacker;

    const theirAccount = await one(victim.client, 'accounts', { name: 'V', kind: 'bank', balance: 500 });
    const theirCategory = await one(victim.client, 'categories', { name: 'V cat' });
    const theirPerson = await one(victim.client, 'people', { name: 'V person' });
    const theirDebt = await one(victim.client, 'debts', { person_id: theirPerson.id, direction: 'lent', amount: 500 });
    const theirTask = await one(victim.client, 'tasks', { title: 'V task' });
    const theirFood = await one(victim.client, 'foods', { name: 'V food' });
    const theirTx = await one(victim.client, 'transactions', { kind: 'expense', amount: 1, account_id: theirAccount.id });

    const mine = await one(client, 'accounts', { name: 'A', kind: 'bank', balance: 500 });
    const myPerson = await one(client, 'people', { name: 'A person' });
    const myDebt = await one(client, 'debts', { person_id: myPerson.id, direction: 'lent', amount: 500 });

    const attempts: [string, object][] = [
      ['debt_payments', { debt_id: theirDebt.id, amount: 400 }],
      ['debt_payments', { debt_id: myDebt.id, amount: 1, transaction_id: theirTx.id }],
      ['debts', { person_id: theirPerson.id, direction: 'lent', amount: 5 }],
      ['transactions', { kind: 'expense', amount: 1, account_id: mine.id, category_id: theirCategory.id }],
      ['transactions', { kind: 'expense', amount: 1, account_id: theirAccount.id }],
      ['transactions', { kind: 'transfer', amount: 1, account_id: mine.id, to_account_id: theirAccount.id }],
      ['budgets', { category_id: theirCategory.id, period: 'monthly', limit_amount: 5 }],
      ['scheduled_items', { name: 's', amount: 1, account_id: theirAccount.id, frequency: 'monthly', next_run: '2030-01-01' }],
      ['scheduled_items', { name: 's', amount: 1, account_id: mine.id, category_id: theirCategory.id, frequency: 'monthly', next_run: '2030-01-01' }],
      ['transaction_templates', { name: 't', amount: 1, account_id: theirAccount.id }],
      ['transaction_templates', { name: 't', amount: 1, category_id: theirCategory.id }],
      ['goals', { name: 'g', target: 5, account_id: theirAccount.id }],
      ['categories', { name: 'c', parent_id: theirCategory.id }],
      ['tasks', { title: 't', parent_id: theirTask.id }],
      ['meal_logs', { meal_type: 'lunch', name: 'm', food_id: theirFood.id }],
    ];
    for (const [table, row] of attempts) {
      expect((await client.from(table).insert(row)).error?.code, `${table} ${JSON.stringify(row)}`).toBe('23503');
    }
    const balance = await victim.client.from('accounts').select('balance').eq('id', theirAccount.id).single();
    expect(Number(balance.data!.balance)).toBe(499);
  });

  it('keeps the delete behaviour each reference had', async () => {
    const { client } = await gated();
    const account = await one(client, 'accounts', { name: 'Bank', kind: 'bank', balance: 100 });
    const parent = await one(client, 'categories', { name: 'Parent' });
    const child = await one(client, 'categories', { name: 'Child', parent_id: parent.id });
    const tx = await one(client, 'transactions', { kind: 'expense', amount: 1, account_id: account.id, category_id: parent.id });
    const budget = await one(client, 'budgets', { category_id: parent.id, period: 'monthly', limit_amount: 5 });
    const goal = await one(client, 'goals', { name: 'G', target: 5, account_id: account.id });
    const person = await one(client, 'people', { name: 'P' });
    const debt = await one(client, 'debts', { person_id: person.id, direction: 'lent', amount: 5 });
    const task = await one(client, 'tasks', { title: 'Parent' });
    const sub = await one(client, 'tasks', { title: 'Sub', parent_id: task.id });

    expect((await client.from('categories').delete().eq('id', parent.id)).error).toBeNull();
    expect((await client.from('categories').select('parent_id').eq('id', child.id).single()).data!.parent_id).toBeNull();
    const after = await client.from('transactions').select('category_id, user_id').eq('id', tx.id).single();
    expect(after.data!.category_id).toBeNull();
    expect(after.data!.user_id).toBeTruthy();
    expect((await client.from('budgets').select('id').eq('id', budget.id)).data).toEqual([]);

    expect((await client.from('accounts').delete().eq('id', account.id)).error?.code).toBe('23503');
    await client.from('transactions').delete().eq('id', tx.id);
    expect((await client.from('accounts').delete().eq('id', account.id)).error).toBeNull();
    expect((await client.from('goals').select('account_id').eq('id', goal.id).single()).data!.account_id).toBeNull();

    await client.from('people').delete().eq('id', person.id);
    expect((await client.from('debts').select('id').eq('id', debt.id)).data).toEqual([]);
    await client.from('tasks').delete().eq('id', task.id);
    expect((await client.from('tasks').select('id').eq('id', sub.id)).data).toEqual([]);
  });
});

describe.skipIf(!anonKey)('row-level security, table by table', () => {
  it('covers everything the API exposes', async () => {
    const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
    const spec = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    }).then((res) => res.json() as Promise<{ paths: Record<string, unknown> }>);
    const tables = Object.keys(spec.paths)
      .filter((path) => path !== '/' && !path.startsWith('/rpc/'))
      .map((path) => path.slice(1));
    expect(tables).toContain('reminder_runs');

    const owner = await gated();
    await one(owner.client, 'tasks', { title: 'private' });
    const stranger = await createPerson(); // Signed in, but never through the gate.
    const anon = browserClient();
    for (const table of tables) {
      const asAnon = await anon.from(table).select('*').limit(1);
      expect(asAnon.error, `anon can read ${table}`).not.toBeNull();
      const asStranger = await stranger.client.from(table).select('*').limit(50);
      const others = (asStranger.data ?? []).filter(
        (row: { id?: string; user_id?: string }) => (row.user_id ?? row.id) !== stranger.id,
      );
      expect(others, `a stranger can read ${table}`).toEqual([]);
    }
  });
});

describe.skipIf(!anonKey)('preferences and the local clock', () => {
  it('refuses preferences that would break the date functions', async () => {
    const { client, id } = await gated();
    const update = (preferences: object) => client.from('profiles').update({ preferences }).eq('id', id);
    for (const bad of [
      { timezone: 'Not/AZone' },
      { weekStart: 9 },
      { weekStart: 'monday' },
      { monthStart: 40 },
      { salaryDay: '1; drop' },
    ]) {
      expect((await update(bad)).error?.code, JSON.stringify(bad)).toBe('23514');
    }
    expect((await update({ timezone: 'America/New_York', weekStart: 0, monthStart: 25, salaryDay: 28, currency: 'USD' })).error).toBeNull();
    expect((await client.rpc('home_summary')).error).toBeNull();
    expect((await update({})).error).toBeNull();
    expect((await client.rpc('home_summary')).error).toBeNull();
  });

  it('uses the user timezone for today and for a meal time', async () => {
    const { client, id } = await gated();
    for (const timezone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      await client.from('profiles').update({ preferences: { timezone } }).eq('id', id);
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date());
      const part = (type: string) => parts.find((p) => p.type === type)!.value;

      const { data: summary } = await client.rpc('home_summary');
      expect(summary.today).toBe(`${part('year')}-${part('month')}-${part('day')}`);

      const meal = await one(client, 'meal_logs', { meal_type: 'lunch', name: 'Dal' });
      expect(meal.logged_on).toBe(summary.today);
      expect(meal.logged_time.slice(0, 2)).toBe(part('hour'));
    }
  });

  it('cuts task weeks at the user midnight, not the database one', async () => {
    const { client } = await gated();
    // 02:00 on this week's Monday in India is still Sunday evening in UTC.
    const { data: weeks } = await client.rpc('tasks_created_vs_completed', { p_weeks: 2 });
    const thisWeek = weeks[1].week as string;
    const before = weeks[1].created as number;
    const created_at = new Date(`${thisWeek}T02:00:00+05:30`).toISOString();
    expect((await client.from('tasks').insert({ title: 'early', created_at })).error).toBeNull();
    const { data: after } = await client.rpc('tasks_created_vs_completed', { p_weeks: 2 });
    expect(after[1].created).toBe(before + 1);
  });
});

describe.skipIf(!anonKey)('chart corrections', () => {
  it('leaves balance adjustments out of income and spending, but not out of the balance', async () => {
    const { client } = await gated();
    const bank = await one(client, 'accounts', { name: 'Bank', kind: 'bank', balance: 1000 });
    await one(client, 'transactions', { kind: 'expense', amount: 100, account_id: bank.id });
    await one(client, 'transactions', { kind: 'expense', amount: 300, account_id: bank.id, is_adjustment: true });
    await one(client, 'transactions', { kind: 'income', amount: 700, account_id: bank.id, is_adjustment: true });

    const { data: summary } = await client.rpc('home_summary');
    expect(Number(summary.spent_today)).toBe(100);

    const { data: months } = await client.rpc('income_vs_expense', { p_months: 1 });
    expect(Number(months[0].income)).toBe(0);
    expect(Number(months[0].expense)).toBe(100);

    const { data: days } = await client.rpc('daily_spending', { p_days: 1 });
    expect(Number(days[0].total)).toBe(100);

    const { data: trend } = await client.rpc('balance_trend', { p_days: 1 });
    expect(Number(trend[0].balance)).toBe(1300);
  });

  it('prorates what a goal sets aside to the days left until salary', async () => {
    const { client, id } = await gated();
    await client.from('profiles').update({ preferences: { timezone: 'Asia/Kolkata', salaryDay: 1 } }).eq('id', id);
    await one(client, 'accounts', { name: 'Bank', kind: 'bank', balance: 100000 });
    const today = new Date(Date.now() + 5.5 * 3_600_000);
    const deadline = new Date(today.getTime() + 90 * 86_400_000).toISOString().slice(0, 10);
    await one(client, 'goals', { name: 'Trip', target: 9000, deadline });

    const { data } = await client.rpc('safe_to_spend');
    const monthly = 9000 / 3;
    expect(Number(data[0].set_aside)).toBeCloseTo(monthly * Math.min(data[0].days_left / 30, 1), 0);
  });
});

describe.skipIf(!anonKey || !hasPostgres)('nightly jobs', () => {
  it('survive one bad row and still serve everyone else', async () => {
    const good = await gated();
    const bad = await gated();
    const goodBank = await one(good.client, 'accounts', { name: 'Good', kind: 'bank', balance: 100 });
    const badBank = await one(bad.client, 'accounts', { name: 'Bad', kind: 'bank', balance: 999_999_999_999 });
    await one(bad.client, 'accounts', { name: 'Bad 2', kind: 'bank', balance: 999_999_999_999 });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await one(good.client, 'scheduled_items', {
      name: 'Rent', amount: 10, account_id: goodBank.id, frequency: 'monthly', next_run: yesterday,
    });

    // Rows the current rules would refuse, as if they predate them. Rolled back at the end.
    const output = psql(`
      begin;
      alter table public.scheduled_items drop constraint scheduled_items_name_no_long_number;
      insert into public.scheduled_items (user_id, name, amount, account_id, frequency, next_run)
        values ('${bad.id}', '4111 1111 1111 1111', 1, '${badBank.id}', 'monthly', '${yesterday}');
      alter table public.profiles drop constraint profiles_preferences_valid;
      update public.profiles set preferences = '{"timezone":"Not/AZone"}' where id = '${bad.id}';
      select private.run_scheduled_items();
      select private.capture_all_net_worth();
      select 'posted=' || count(*) from public.transactions where account_id = '${goodBank.id}';
      select 'next=' || (next_run > '${yesterday}') from public.scheduled_items where user_id = '${good.id}';
      select 'snapshots=' || count(*) from public.net_worth_snapshots where user_id = '${good.id}';
      select 'bad_posted=' || count(*) from public.transactions where account_id = '${badBank.id}';
      rollback;
    `);
    expect(output).toContain('posted=1');
    expect(output).toContain('next=t');
    expect(output).toContain('snapshots=1');
    expect(output).toContain('bad_posted=0');
  });

  it('catch up on an ancient schedule a little at a time', async () => {
    const person = await gated();
    const bank = await one(person.client, 'accounts', { name: 'Bank', kind: 'bank', balance: 100 });
    await one(person.client, 'scheduled_items', {
      name: 'Old', amount: 1, account_id: bank.id, frequency: 'daily', next_run: '2000-01-01',
    });
    const output = psql(`
      begin;
      select private.run_scheduled_items();
      select 'posted=' || count(*) from public.transactions where account_id = '${bank.id}';
      rollback;
    `);
    expect(output).toContain('posted=366');
  });
});
