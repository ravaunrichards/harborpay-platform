-- DEVELOPMENT ONLY. This is an illustrative test record, not a real customer.
INSERT INTO app_users (email, display_name) VALUES ('jamie@example.test', 'Jamie Davis') ON CONFLICT (email) DO NOTHING;
