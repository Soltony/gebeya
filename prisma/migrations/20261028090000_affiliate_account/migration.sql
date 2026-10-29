BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[AffiliatePayout] ADD [fundsReserved] BIT NOT NULL CONSTRAINT [AffiliatePayout_fundsReserved_df] DEFAULT 0;

-- CreateTable
CREATE TABLE [dbo].[AffiliateAccount] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [accountNumber] NVARCHAR(1000),
    [cbsProviderId] NVARCHAR(1000),
    [balance] FLOAT(53) NOT NULL CONSTRAINT [AffiliateAccount_balance_df] DEFAULT 0,
    [reserved] FLOAT(53) NOT NULL CONSTRAINT [AffiliateAccount_reserved_df] DEFAULT 0,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliateAccount_status_df] DEFAULT 'ACTIVE',
    [frozenReason] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AffiliateAccount_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [AffiliateAccount_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AffiliateAccountEntry] (
    [id] NVARCHAR(1000) NOT NULL,
    [accountId] NVARCHAR(1000) NOT NULL,
    [idempotencyKey] NVARCHAR(1000) NOT NULL,
    [reference] NVARCHAR(1000) NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [direction] NVARCHAR(1000) NOT NULL,
    [amount] FLOAT(53) NOT NULL,
    [balanceAfter] FLOAT(53) NOT NULL,
    [counterpartyAccount] NVARCHAR(1000),
    [bankReference] NVARCHAR(1000),
    [transferId] NVARCHAR(1000),
    [payoutId] NVARCHAR(1000),
    [description] NVARCHAR(max) NOT NULL,
    [createdById] NVARCHAR(1000),
    [approvedById] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AffiliateAccountEntry_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AffiliateAccountEntry_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AffiliateAccountEntry_idempotencyKey_key] UNIQUE NONCLUSTERED ([idempotencyKey]),
    CONSTRAINT [AffiliateAccountEntry_reference_key] UNIQUE NONCLUSTERED ([reference])
);

-- CreateTable
CREATE TABLE [dbo].[AffiliateTransfer] (
    [id] NVARCHAR(1000) NOT NULL,
    [reference] NVARCHAR(1000) NOT NULL,
    [idempotencyKey] NVARCHAR(1000) NOT NULL,
    [purpose] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL,
    [phone] NVARCHAR(1000) NOT NULL,
    [affiliateId] NVARCHAR(1000),
    [points] INT NOT NULL,
    [pointValue] FLOAT(53) NOT NULL,
    [amount] FLOAT(53) NOT NULL,
    [creditAccount] NVARCHAR(1000) NOT NULL,
    [creditAccountName] NVARCHAR(1000),
    [orderId] NVARCHAR(1000),
    [loanId] NVARCHAR(1000),
    [paymentId] NVARCHAR(1000),
    [journalEntryId] NVARCHAR(1000),
    [cbsProviderId] NVARCHAR(1000),
    [transactionId] NVARCHAR(1000),
    [requestPayload] NVARCHAR(max),
    [responsePayload] NVARCHAR(max),
    [statusCode] INT,
    [errorMessage] NVARCHAR(max),
    [attempts] INT NOT NULL CONSTRAINT [AffiliateTransfer_attempts_df] DEFAULT 0,
    [lastAttemptAt] DATETIME2,
    [reviewedById] NVARCHAR(1000),
    [reviewedAt] DATETIME2,
    [cancelReason] NVARCHAR(max),
    [completedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AffiliateTransfer_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [AffiliateTransfer_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AffiliateTransfer_reference_key] UNIQUE NONCLUSTERED ([reference]),
    CONSTRAINT [AffiliateTransfer_idempotencyKey_key] UNIQUE NONCLUSTERED ([idempotencyKey])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateAccountEntry_accountId_createdAt_idx] ON [dbo].[AffiliateAccountEntry]([accountId], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateAccountEntry_type_idx] ON [dbo].[AffiliateAccountEntry]([type]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateAccountEntry_bankReference_idx] ON [dbo].[AffiliateAccountEntry]([bankReference]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateTransfer_phone_purpose_createdAt_idx] ON [dbo].[AffiliateTransfer]([phone], [purpose], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateTransfer_status_idx] ON [dbo].[AffiliateTransfer]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateTransfer_orderId_idx] ON [dbo].[AffiliateTransfer]([orderId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateTransfer_loanId_idx] ON [dbo].[AffiliateTransfer]([loanId]);

-- AddForeignKey
ALTER TABLE [dbo].[AffiliateAccountEntry] ADD CONSTRAINT [AffiliateAccountEntry_accountId_fkey] FOREIGN KEY ([accountId]) REFERENCES [dbo].[AffiliateAccount]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

