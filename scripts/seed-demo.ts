import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { hash } from '@node-rs/argon2';

// Creates a confirmed demo account full of believable data, so every screen can be
// checked at a glance. Refuses to run against anything but a local stack.
const url = process.env.SUPABASE_URL ?? '';
if (!/127\.0\.0\.1|localhost/.test(url)) {
  throw new Error('The demo seed only runs against a local Supabase stack.');
}

const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const EMAIL = 'demo@serein.test';
const PASSWORD = 'correct-horse-battery';

const day = (offset: number) => {
  const date = new Date(Date.now() + 5.5 * 3_600_000 + offset * 86_400_000);
  return date.toISOString().slice(0, 10);
};
const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));
const pick = <T,>(items: T[]): T => items[rand(0, items.length - 1)] as T;

// Rows in one batch can differ; columns they leave out should get their defaults, not null.
const insert = (table: string, rows: Record<string, unknown>[]) => db.from(table).insert(rows, { defaultToNull: false });

async function must<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<NonNullable<T>> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data as NonNullable<T>;
}

const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
const existing = list.users.find((user) => user.email === EMAIL);
if (existing) await db.auth.admin.deleteUser(existing.id);

const { data: created, error } = await db.auth.admin.createUser({
  email: EMAIL,
  password: PASSWORD,
  email_confirm: true,
  user_metadata: { name: 'Mani' },
});
if (error) throw error;
const user_id = created.user.id;

await must(
  db.rpc('replace_security_questions', {
    p_user_id: user_id,
    p_questions: await Promise.all(
      [
        ['What was the first street you lived on?', 'serein street'],
        ['What was your first pet called?', 'biscuit'],
        ['Which teacher do you still think about?', 'mrs rao'],
      ].map(async ([question, answer]) => ({ question, answer_hash: await hash(answer!) })),
    ),
  }),
);

await must(
  db
    .from('profiles')
    .update({
      onboarded_at: new Date().toISOString(),
      role: 'admin',
      home_layout: [
        { id: 'safe', size: 'm' },
        { id: 'balance', size: 'm' },
        { id: 'tasks', size: 's' },
        { id: 'calories', size: 's' },
        { id: 'mood', size: 's' },
        { id: 'spending', size: 'm' },
        { id: 'alerts', size: 'm' },
      ],
    })
    .eq('id', user_id),
);

const accounts = await must(
  insert('accounts', [
      { user_id, name: 'Salary', kind: 'bank', bank_name: 'HDFC', last_four: '4092', balance: 212000 },
      { user_id, name: 'Savings', kind: 'bank', bank_name: 'Axis', last_four: '7781', balance: 186000 },
      { user_id, name: 'Paytm', kind: 'wallet', balance: 2400 },
      { user_id, name: 'Cash', kind: 'cash', balance: 3100 },
      { user_id, name: 'Mutual funds', kind: 'investment', balance: 96000 },
      { user_id, name: 'Axis Ace', kind: 'card', bank_name: 'Axis', last_four: '1180', balance: 8200, credit_limit: 150000, statement_day: 12, due_day: 2 },
    ])
    .select('id, name'),
);
const account = (name: string) => accounts.find((a) => a.name === name)!.id;

const categories = await must(db.from('categories').select('id, name').eq('user_id', user_id));
const category = (name: string) => categories.find((c) => c.name === name)!.id;

const SPENDS: [string, string, number, number, string][] = [
  ['Food', 'Swiggy', 180, 620, 'GPay'],
  ['Food', 'Groceries', 300, 1400, 'Paytm'],
  ['Metro', 'Metro top-up', 100, 300, 'GPay'],
  ['Rapido', 'Rapido', 70, 220, 'GPay'],
  ['Uber', 'Uber', 180, 480, 'Card'],
  ['Shopping', 'Amazon', 400, 2800, 'Card'],
  ['Entertainment', 'BookMyShow', 250, 900, 'GPay'],
  ['Health', 'Pharmacy', 120, 700, 'Paytm'],
];

const transactions: Record<string, unknown>[] = [];
for (let offset = -75; offset <= 0; offset++) {
  for (let i = 0, count = rand(0, 3); i < count; i++) {
    const [name, payee, min, max, app] = pick(SPENDS);
    transactions.push({
      user_id,
      kind: 'expense',
      amount: rand(min, max),
      category_id: category(name),
      account_id: app === 'Card' ? account('Axis Ace') : app === 'Paytm' ? account('Paytm') : account('Salary'),
      payment_app: app,
      occurred_on: day(offset),
      occurred_time: `${String(rand(8, 22)).padStart(2, '0')}:${String(rand(0, 59)).padStart(2, '0')}`,
      payee,
      checked: offset < -20,
    });
  }
}
for (const offset of [-61, -31, -1]) {
  transactions.push({ user_id, kind: 'income', amount: 82000, category_id: category('Salary'), account_id: account('Salary'), occurred_on: day(offset), payee: 'Acme Corp', checked: true });
  transactions.push({ user_id, kind: 'expense', amount: 18000, category_id: category('Rent'), account_id: account('Salary'), occurred_on: day(offset + 1), payee: 'Landlord', payment_app: 'Netbanking', checked: true });
}
await must(insert('transactions', transactions));

await must(
  insert('budgets', [
    { user_id, category_id: category('Food'), period: 'monthly', limit_amount: 9000 },
    { user_id, category_id: category('Transport'), period: 'monthly', limit_amount: 3500 },
    { user_id, category_id: category('Shopping'), period: 'monthly', limit_amount: 6000 },
    { user_id, category_id: category('Entertainment'), period: 'weekly', limit_amount: 800 },
  ]),
);

await must(
  insert('scheduled_items', [
    { user_id, name: 'Netflix', amount: 649, account_id: account('Axis Ace'), category_id: category('Entertainment'), frequency: 'monthly', next_run: day(6), is_subscription: true },
    { user_id, name: 'Claude', amount: 1700, account_id: account('Axis Ace'), category_id: category('Bills'), frequency: 'monthly', next_run: day(12), is_subscription: true },
    { user_id, name: 'Spotify', amount: 119, account_id: account('Axis Ace'), category_id: category('Entertainment'), frequency: 'monthly', next_run: day(3), is_subscription: true },
    { user_id, name: 'Rent', amount: 18000, account_id: account('Salary'), category_id: category('Rent'), frequency: 'monthly', next_run: day(29), auto_post: false },
    { user_id, name: 'Electricity', amount: 1400, account_id: account('Salary'), category_id: category('Bills'), frequency: 'monthly', next_run: day(2), auto_post: false },
  ]),
);

const [ravi, asha] = await must(
  insert('people', [{ user_id, name: 'Ravi' }, { user_id, name: 'Asha' }]).select('id'),
);
const [lent, borrowed] = await must(
  insert('debts', [
      { user_id, person_id: ravi!.id, direction: 'lent', amount: 5000, opened_on: day(-40), due_on: day(4), notes: 'Trip to Hampi' },
      { user_id, person_id: asha!.id, direction: 'borrowed', amount: 2000, opened_on: day(-12), due_on: day(9) },
    ])
    .select('id'),
);
await must(
  insert('debt_payments', [
    { user_id, debt_id: lent!.id, amount: 3000, paid_on: day(-10) },
    { user_id, debt_id: borrowed!.id, amount: 800, paid_on: day(-3) },
  ]),
);

await must(
  insert('goals', [
    { user_id, name: 'Emergency fund', target: 300000, saved: 186000, deadline: day(240), account_id: account('Savings') },
    { user_id, name: 'New laptop', target: 120000, saved: 42000, deadline: day(150) },
    { user_id, name: 'Japan trip', target: 250000, saved: 30000, deadline: day(420) },
  ]),
);

await must(
  insert('transaction_templates', [
    { user_id, name: 'Tea', amount: 20, category_id: category('Food'), account_id: account('Cash'), payee: 'Tea' },
    { user_id, name: 'Metro', amount: 45, category_id: category('Metro'), account_id: account('Paytm'), payee: 'Metro', payment_app: 'Paytm' },
    { user_id, name: 'Gym', amount: 150, category_id: category('Health'), account_id: account('Salary'), payee: 'Gym', payment_app: 'GPay' },
  ]),
);

await must(
  insert('net_worth_snapshots', 
    Array.from({ length: 90 }, (_, index) => {
      const offset = index - 90;
      const growth = 400_000 + (index / 90) * 90_000 + Math.sin(index / 6) * 7_000;
      return { user_id, taken_on: day(offset), assets: Math.round(growth + 12_000), liabilities: 12_000 };
    }),
  ),
);

const TASKS = ['Ship gate screen', 'Review budget', 'Call landlord', 'Tax docs', 'Update resume', 'Book dentist', 'Renew insurance', 'Plan Hampi photos', 'Fix bike', 'Reply to Asha'];
const tasks: Record<string, unknown>[] = [];
for (let offset = -35; offset <= -1; offset++) {
  for (let i = 0, count = rand(1, 3); i < count; i++) {
    const late = Math.random() < 0.22;
    const iso = new Date(`${day(offset + (late ? 1 : 0))}T${String(rand(10, 20)).padStart(2, '0')}:00:00+05:30`).toISOString();
    tasks.push({ user_id, title: pick(TASKS), due_on: day(offset), status: 'done', completed_at: iso, category: pick(['Work', 'Home', 'Money', 'Health']), created_at: iso, priority: pick(['low', 'medium', 'high']) });
  }
}
await must(insert('tasks', tasks));
await must(
  insert('tasks', [
    { user_id, title: 'Ship gate screen', due_on: day(0), priority: 'high', category: 'Work', estimate_minutes: 90 },
    { user_id, title: 'Review budget', due_on: day(0), category: 'Money' },
    { user_id, title: 'Morning walk', due_on: day(0), recurrence: 'daily', category: 'Health', priority: 'low' },
    { user_id, title: 'Call landlord', due_on: day(-1), category: 'Home' },
    { user_id, title: 'Tax docs', due_on: day(-1), priority: 'high', category: 'Money', notes: 'Form 16, rent receipts and the 80C proofs.' },
    { user_id, title: 'Rent', due_on: day(2), category: 'Money' },
    { user_id, title: 'Resume', due_on: day(5), category: 'Work', assigned: true },
    { user_id, title: 'Renew bike insurance', due_on: day(20), category: 'Home' },
  ]),
);

const foods = await must(
  insert('foods', [
      { user_id, name: 'Poha', serving: '1 plate', calories: 320, protein: 8, carbs: 55, fat: 7 },
      { user_id, name: 'Curd bowl', serving: '1 bowl', calories: 180, protein: 11, carbs: 14, fat: 8 },
      { user_id, name: 'Dal + rice', serving: '1 plate', calories: 610, protein: 21, carbs: 98, fat: 13 },
      { user_id, name: 'Whey shake', serving: '1 scoop', calories: 150, protein: 25, carbs: 5, fat: 2 },
      { user_id, name: 'Paneer roti', serving: '2 rotis', calories: 540, protein: 24, carbs: 48, fat: 26 },
    ])
    .select('*'),
);

const SLOTS: ['breakfast' | 'lunch' | 'snack' | 'dinner', number, string][] = [
  ['breakfast', 8, 'Poha'],
  ['lunch', 13, 'Dal + rice'],
  ['snack', 17, 'Whey shake'],
  ['dinner', 21, 'Paneer roti'],
];
const meals: Record<string, unknown>[] = [];
const water: Record<string, unknown>[] = [];
const weights: Record<string, unknown>[] = [];
for (let offset = -30; offset <= 0; offset++) {
  for (const [meal_type, hour, name] of SLOTS) {
    if (offset === 0 && hour > 13) continue;
    if (Math.random() < 0.08) continue;
    const food = foods.find((f) => f.name === name)!;
    meals.push({
      user_id, logged_on: day(offset), logged_time: `${hour + rand(-1, 1)}:${String(rand(0, 59)).padStart(2, '0')}`,
      meal_type, food_id: food.id, name, quantity: 1, calories: food.calories, protein: food.protein, carbs: food.carbs, fat: food.fat,
    });
  }
  for (let i = 0, glasses = offset === 0 ? 3 : rand(5, 10); i < glasses; i++) {
    water.push({ user_id, logged_on: day(offset), amount_ml: 250 });
  }
  if (offset % 3 === 0) weights.push({ user_id, logged_on: day(offset), weight_kg: 74 - (offset + 30) * 0.05 + Math.random() * 0.5 });
}
await must(insert('meal_logs', meals));
await must(insert('water_logs', water));
await must(insert('weight_logs', weights));

await must(
  insert('meal_plans', 
    [1, 2, 3, 4, 5].flatMap((weekday) => [
      { user_id, weekday, meal_type: 'breakfast', items: pick(['Poha', 'Curd bowl', 'Oats']) },
      { user_id, weekday, meal_type: 'lunch', items: pick(['Dal + rice', 'Paneer roti']) },
    ]),
  ),
);

const NOTES = [
  ['Rain', 'Walked home slowly. The rain made the street quiet, and I stayed out longer than I needed to.'],
  ['A small win', 'Finally shipped the thing. Nobody noticed, which was its own kind of nice.'],
  ['Tired', 'Too many meetings. I need a day that belongs to nobody.'],
  ['Call with Amma', 'She laughed at my cooking again. I miss that kitchen more than I admit.'],
  ['Restless', 'Could not settle on anything. Cleaned the desk instead, and that helped more than it should have.'],
  ['Morning light', 'Up early by accident. The light on the balcony made it worth it.'],
];
const moods = ['bright', 'settled', 'settled', 'restless', 'tired', 'low', 'bright', 'settled'];
const entries: Record<string, unknown>[] = [];
for (let offset = -32; offset <= -1; offset++) {
  if (Math.random() < 0.2 && offset < -9) continue;
  const [title, body] = pick(NOTES);
  entries.push({ user_id, entry_on: day(offset), title, body, mood: pick(moods), tags: offset % 5 === 0 ? ['work'] : [] });
}
await must(insert('diary_entries', entries));

console.log(`Seeded ${EMAIL} / ${PASSWORD}. Answers: serein street, biscuit, mrs rao.`);
