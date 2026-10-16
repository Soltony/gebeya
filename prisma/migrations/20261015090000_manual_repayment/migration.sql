BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[ManualRepayment] (
    [id] NVARCHAR(1000) NOT NULL,
    [loanId] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [amount] FLOAT(53) NOT NULL,
    [paymentSource] NVARCHAR(1000) NOT NULL,
    [referenceNumber] NVARCHAR(1000) NOT NULL,
    [referenceKey] NVARCHAR(1000) NOT NULL,
    [paymentDate] DATETIME2 NOT NULL,
    [remarks] NVARCHAR(max),
    [attachmentName] NVARCHAR(1000),
    [attachmentType] NVARCHAR(1000),
    [attachmentSize] INT,
    [attachmentData] NVARCHAR(max),
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [ManualRepayment_status_df] DEFAULT 'PENDING_APPROVAL',
    [balanceBefore] FLOAT(53) NOT NULL,
    [principalBefore] FLOAT(53) NOT NULL,
    [interestBefore] FLOAT(53) NOT NULL,
    [serviceFeeBefore] FLOAT(53) NOT NULL,
    [penaltyBefore] FLOAT(53) NOT NULL,
    [taxBefore] FLOAT(53) NOT NULL,
    [loanStatusBefore] NVARCHAR(1000) NOT NULL,
    [installmentNumber] INT,
    [balanceAfter] FLOAT(53),
    [loanStatusAfter] NVARCHAR(1000),
    [allocation] NVARCHAR(max),
    [paymentId] NVARCHAR(1000),
    [journalEntryId] NVARCHAR(1000),
    [postedAt] DATETIME2,
    [makerId] NVARCHAR(1000) NOT NULL,
    [makerIp] NVARCHAR(1000),
    [makerUserAgent] TEXT,
    [checkerId] NVARCHAR(1000),
    [checkerIp] NVARCHAR(1000),
    [decidedAt] DATETIME2,
    [rejectionReason] TEXT,
    [reversalReason] TEXT,
    [reversalRequestedById] NVARCHAR(1000),
    [reversalRequestedAt] DATETIME2,
    [reversedById] NVARCHAR(1000),
    [reversedAt] DATETIME2,
    [reversalJournalEntryId] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ManualRepayment_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ManualRepayment_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ManualRepayment_referenceKey_key] UNIQUE NONCLUSTERED ([referenceKey])
);

-- CreateTable
CREATE TABLE [dbo].[ManualRepaymentConfig] (
    [id] NVARCHAR(1000) NOT NULL CONSTRAINT [ManualRepaymentConfig_id_df] DEFAULT 'global',
    [makerApprovalLimit] FLOAT(53),
    [requireAttachment] BIT NOT NULL CONSTRAINT [ManualRepaymentConfig_requireAttachment_df] DEFAULT 0,
    [notifyCustomer] BIT NOT NULL CONSTRAINT [ManualRepaymentConfig_notifyCustomer_df] DEFAULT 1,
    [updatedById] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ManualRepaymentConfig_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ManualRepaymentConfig_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ManualRepayment_status_idx] ON [dbo].[ManualRepayment]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ManualRepayment_loanId_idx] ON [dbo].[ManualRepayment]([loanId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ManualRepayment_borrowerId_idx] ON [dbo].[ManualRepayment]([borrowerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ManualRepayment_paymentDate_idx] ON [dbo].[ManualRepayment]([paymentDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ManualRepayment_makerId_idx] ON [dbo].[ManualRepayment]([makerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ManualRepayment_checkerId_idx] ON [dbo].[ManualRepayment]([checkerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ManualRepayment_referenceNumber_idx] ON [dbo].[ManualRepayment]([referenceNumber]);

-- AddForeignKey
ALTER TABLE [dbo].[ManualRepayment] ADD CONSTRAINT [ManualRepayment_loanId_fkey] FOREIGN KEY ([loanId]) REFERENCES [dbo].[Loan]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ManualRepayment] ADD CONSTRAINT [ManualRepayment_makerId_fkey] FOREIGN KEY ([makerId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ManualRepayment] ADD CONSTRAINT [ManualRepayment_checkerId_fkey] FOREIGN KEY ([checkerId]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
