-- A GitHub App's name was its slug; the slug now lives in its settings, and the name is free to change.
UPDATE "apps" SET "settings" = "settings" || jsonb_build_object('slug', "name") WHERE "provider" = 'github' AND NOT "settings" ? 'slug';
