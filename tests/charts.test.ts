import { describe, expect, it } from 'vitest';
import { anonKey, createPerson, setUp } from './helpers.js';

const dayOffset = (offset: number) =>
  new Date(Date.now() + 5.5 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!anonKey)('chart helpers', () => {
  it('walks the balance back through income, spending and transfers', async () => {
    const person = await createPerson();
    await setUp(person);
    const { client } = person;
    const account = async (name: string, balance: number, hidden = false) =>
      (await client.from('accounts').insert({ name, kind: 'bank', balance, hidden }).select().single()).data;
    const bank = await account('Bank', 1000);
    const wallet = await account('Wallet', 0);
    const stash = await account('Stash', 0, true);

    await client.from('transactions').insert([
      { kind: 'expense', amount: 100, account_id: bank.id, occurred_on: dayOffset(-3) },
      // Between two visible accounts: the total does not move.
      { kind: 'transfer', amount: 50, account_id: bank.id, to_account_id: wallet.id, occurred_on: dayOffset(-2) },
      // Into a hidden account: the visible total drops.
      { kind: 'transfer', amount: 200, account_id: bank.id, to_account_id: stash.id, occurred_on: dayOffset(-1) },
    ]);

    const { data, error } = await client.rpc('balance_trend', { p_days: 5 });
    expect(error).toBeNull();
    const byDay = new Map(data.map((row: { day: string; balance: number }) => [row.day, Number(row.balance)]));
    expect(byDay.get(dayOffset(-4))).toBe(1000);
    expect(byDay.get(dayOffset(-3))).toBe(900);
    expect(byDay.get(dayOffset(-2))).toBe(900);
    expect(byDay.get(dayOffset(-1))).toBe(700);
    expect(byDay.get(dayOffset(0))).toBe(700);
  });

  it('summarises today on the home screen', async () => {
    const person = await createPerson();
    await setUp(person);
    const { client } = person;
    const bank = (await client.from('accounts').insert({ name: 'Bank', kind: 'bank', balance: 1000 }).select().single()).data;
    await client.from('transactions').insert([
      { kind: 'expense', amount: 75, account_id: bank.id },
      { kind: 'expense', amount: 500, account_id: bank.id, occurred_on: dayOffset(-2) },
    ], { defaultToNull: false });
    await client.from('meal_logs').insert({ meal_type: 'lunch', name: 'Dal', calories: 400, protein: 20 });
    await client.from('tasks').insert([
      { title: 'today', due_on: dayOffset(0) },
      { title: 'carried over', due_on: dayOffset(-3) },
      { title: 'later', due_on: dayOffset(3) },
    ]);

    const { data, error } = await client.rpc('home_summary');
    expect(error).toBeNull();
    expect(Number(data.spent_today)).toBe(75);
    expect(Number(data.nutrition.calories)).toBe(400);
    expect(data.tasks.due).toBe(2);
  });
});
