-- Development-only test users (the real API service creates users).
-- Run:  docker compose exec -T db psql -U phonemail -d phonemail < mailsvc/scripts/seed.sql
INSERT INTO users (phone, display_name, created_via) VALUES
    ('+919876500001', 'Kavya', 'web'),
    ('+919876500002', 'Asha',  'web'),
    ('+919876500003', 'Ravi',  'mobile'),
    ('+919876500004', 'Meena', 'portal')
ON CONFLICT (phone) DO NOTHING;

INSERT INTO aliases (alias, user_id)
SELECT 'kavya@phonemail.com', id FROM users WHERE phone = '+919876500001'
ON CONFLICT DO NOTHING;

SELECT id, phone, phone_local || '@phonemail.com' AS address, display_name FROM users ORDER BY id;
