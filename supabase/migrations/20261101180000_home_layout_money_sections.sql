-- The money sections were fixed at the top of home for a while, and saved layouts did not
-- list them. They are ordinary widgets again, so saved layouts gain them at the top once.
update public.profiles p
   set home_layout = '[
         {"id": "safe", "size": "w"},
         {"id": "log", "size": "n"},
         {"id": "spending", "size": "w"},
         {"id": "alerts", "size": "n"}
       ]'::jsonb || coalesce(
         (
           select jsonb_agg(item order by position)
             from jsonb_array_elements(p.home_layout) with ordinality as t(item, position)
            where item ->> 'id' not in ('safe', 'log', 'spending', 'alerts')
         ),
         '[]'::jsonb
       )
 where jsonb_typeof(p.home_layout) = 'array';
