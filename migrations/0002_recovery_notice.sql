-- NULL means no recovery notice has been attempted. Preserve original alert results.
ALTER TABLE incidents ADD COLUMN recovery_notice_status TEXT CHECK (recovery_notice_status IN ('sent', 'failed'));
ALTER TABLE incidents ADD COLUMN recovery_notice_error TEXT;
