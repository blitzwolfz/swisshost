-- Add PBKDF2 password hash column for password-based admin and optional user accounts
ALTER TABLE users ADD COLUMN password_hash TEXT;
