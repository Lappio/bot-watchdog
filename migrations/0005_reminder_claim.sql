-- Serialize reminder delivery independently of the successful-send timestamp.
ALTER TABLE incidents ADD COLUMN reminder_claim_until TEXT;
