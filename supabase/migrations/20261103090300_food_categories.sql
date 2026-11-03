-- Sorts saved foods into pick lists: proteins, carbs and ready-made meal combos.

alter table public.foods
  add column category  text not null default 'other' check (category in ('protein', 'carb', 'combo', 'other')),
  add column diet_type text check (diet_type in ('veg', 'nonveg')),
  add column meal_type text check (meal_type in ('breakfast', 'lunch', 'snack', 'dinner')),
  add column position  int not null default 0;

-- Portions such as "150 g cooked, grilled or curry with 1 tsp oil" need more than 40 characters.
alter table public.foods drop constraint foods_serving_check;
alter table public.foods add constraint foods_serving_check check (char_length(serving) <= 80);

create index foods_user_category_idx on public.foods (user_id, category, position);
