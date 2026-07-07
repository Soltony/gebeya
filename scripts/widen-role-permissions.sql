-- =============================================
-- Fix: Role.permissions too small
-- Error: "The provided value for the column is too long" (Column: permissions)
-- Action: Widen [dbo].[Role].[permissions] to NVARCHAR(MAX)
-- =============================================

ALTER TABLE [dbo].[Role]
ALTER COLUMN [permissions] NVARCHAR(MAX) NOT NULL;

-- Optional: verify
-- SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
-- FROM INFORMATION_SCHEMA.COLUMNS
-- WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Role' AND COLUMN_NAME = 'permissions';
