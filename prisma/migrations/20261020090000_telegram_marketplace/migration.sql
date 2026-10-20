BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Order] ADD [channel] NVARCHAR(1000) NOT NULL CONSTRAINT [Order_channel_df] DEFAULT 'SUPER_APP';

-- CreateTable
CREATE TABLE [dbo].[TelegramUser] (
    [id] NVARCHAR(1000) NOT NULL,
    [telegramUserId] NVARCHAR(1000) NOT NULL,
    [chatId] NVARCHAR(1000),
    [username] NVARCHAR(1000),
    [firstName] NVARCHAR(1000),
    [lastName] NVARCHAR(1000),
    [languageCode] NVARCHAR(1000),
    [borrowerId] NVARCHAR(1000),
    [phoneLinkedAt] DATETIME2,
    [botBlockedAt] DATETIME2,
    [lastSeenAt] DATETIME2 NOT NULL CONSTRAINT [TelegramUser_lastSeenAt_df] DEFAULT CURRENT_TIMESTAMP,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [TelegramUser_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [TelegramUser_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [TelegramUser_telegramUserId_key] UNIQUE NONCLUSTERED ([telegramUserId])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [TelegramUser_borrowerId_idx] ON [dbo].[TelegramUser]([borrowerId]);

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
