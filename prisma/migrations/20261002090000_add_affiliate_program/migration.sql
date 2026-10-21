BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[AffiliateProgram] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [description] NVARCHAR(max),
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliateProgram_status_df] DEFAULT 'ACTIVE',
    [currentVersion] INT NOT NULL CONSTRAINT [AffiliateProgram_currentVersion_df] DEFAULT 1,
    [pausedAt] DATETIME2,
    [pausedPeriods] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AffiliateProgram_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [AffiliateProgram_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AffiliateProgram_name_key] UNIQUE NONCLUSTERED ([name])
);

-- CreateTable
CREATE TABLE [dbo].[AffiliateProgramVersion] (
    [id] NVARCHAR(1000) NOT NULL,
    [programId] NVARCHAR(1000) NOT NULL,
    [version] INT NOT NULL,
    [config] NVARCHAR(max) NOT NULL,
    [publishedAt] DATETIME2 NOT NULL CONSTRAINT [AffiliateProgramVersion_publishedAt_df] DEFAULT CURRENT_TIMESTAMP,
    [publishedById] NVARCHAR(1000),
    CONSTRAINT [AffiliateProgramVersion_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AffiliateProgramVersion_programId_version_key] UNIQUE NONCLUSTERED ([programId],[version])
);

-- CreateTable
CREATE TABLE [dbo].[Affiliate] (
    [id] NVARCHAR(1000) NOT NULL,
    [code] NVARCHAR(1000) NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [phoneNumber] NVARCHAR(1000) NOT NULL,
    [email] NVARCHAR(1000),
    [payoutAccount] NVARCHAR(1000),
    [programId] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Affiliate_status_df] DEFAULT 'ACTIVE',
    [suspendedReason] NVARCHAR(max),
    [suspendedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Affiliate_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Affiliate_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Affiliate_code_key] UNIQUE NONCLUSTERED ([code]),
    CONSTRAINT [Affiliate_phoneNumber_key] UNIQUE NONCLUSTERED ([phoneNumber])
);

-- CreateTable
CREATE TABLE [dbo].[AffiliateReferral] (
    [id] NVARCHAR(1000) NOT NULL,
    [affiliateId] NVARCHAR(1000) NOT NULL,
    [programVersionId] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [source] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliateReferral_source_df] DEFAULT 'CODE',
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliateReferral_status_df] DEFAULT 'ACTIVE',
    [rejectedReason] NVARCHAR(max),
    [rejectedAt] DATETIME2,
    [rejectedById] NVARCHAR(1000),
    [attributedAt] DATETIME2 NOT NULL CONSTRAINT [AffiliateReferral_attributedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AffiliateReferral_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AffiliateReferral_borrowerId_key] UNIQUE NONCLUSTERED ([borrowerId])
);

-- CreateTable
CREATE TABLE [dbo].[AffiliateCommission] (
    [id] NVARCHAR(1000) NOT NULL,
    [idempotencyKey] NVARCHAR(1000) NOT NULL,
    [kind] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliateCommission_kind_df] DEFAULT 'EARNED',
    [clawbackOfId] NVARCHAR(1000),
    [referralId] NVARCHAR(1000) NOT NULL,
    [affiliateId] NVARCHAR(1000) NOT NULL,
    [beneficiary] NVARCHAR(1000) NOT NULL,
    [beneficiaryPhone] NVARCHAR(1000) NOT NULL,
    [ruleId] NVARCHAR(1000) NOT NULL,
    [ruleName] NVARCHAR(1000),
    [eventType] NVARCHAR(1000) NOT NULL,
    [sourceType] NVARCHAR(1000) NOT NULL,
    [sourceId] NVARCHAR(1000) NOT NULL,
    [loanId] NVARCHAR(1000),
    [orderId] NVARCHAR(1000),
    [providerId] NVARCHAR(1000),
    [fundedBy] NVARCHAR(1000) NOT NULL,
    [baseAmount] FLOAT(53) NOT NULL CONSTRAINT [AffiliateCommission_baseAmount_df] DEFAULT 0,
    [amount] FLOAT(53) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliateCommission_status_df] DEFAULT 'PENDING',
    [eventDate] DATETIME2 NOT NULL,
    [holdUntil] DATETIME2 NOT NULL,
    [payableAt] DATETIME2,
    [ruleSnapshot] NVARCHAR(max) NOT NULL,
    [ledgerPosted] BIT NOT NULL CONSTRAINT [AffiliateCommission_ledgerPosted_df] DEFAULT 0,
    [reversedReason] NVARCHAR(max),
    [reversedAt] DATETIME2,
    [payoutId] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AffiliateCommission_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [AffiliateCommission_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AffiliateCommission_idempotencyKey_key] UNIQUE NONCLUSTERED ([idempotencyKey])
);

-- CreateTable
CREATE TABLE [dbo].[AffiliatePayoutBatch] (
    [id] NVARCHAR(1000) NOT NULL,
    [programId] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliatePayoutBatch_status_df] DEFAULT 'DRAFT',
    [source] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliatePayoutBatch_source_df] DEFAULT 'MANUAL',
    [totalGross] FLOAT(53) NOT NULL CONSTRAINT [AffiliatePayoutBatch_totalGross_df] DEFAULT 0,
    [totalTax] FLOAT(53) NOT NULL CONSTRAINT [AffiliatePayoutBatch_totalTax_df] DEFAULT 0,
    [totalNet] FLOAT(53) NOT NULL CONSTRAINT [AffiliatePayoutBatch_totalNet_df] DEFAULT 0,
    [payoutCount] INT NOT NULL CONSTRAINT [AffiliatePayoutBatch_payoutCount_df] DEFAULT 0,
    [createdById] NVARCHAR(1000),
    [submittedById] NVARCHAR(1000),
    [submittedAt] DATETIME2,
    [pendingChangeId] NVARCHAR(1000),
    [approvedById] NVARCHAR(1000),
    [approvedAt] DATETIME2,
    [completedAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AffiliatePayoutBatch_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [AffiliatePayoutBatch_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AffiliatePayout] (
    [id] NVARCHAR(1000) NOT NULL,
    [batchId] NVARCHAR(1000) NOT NULL,
    [beneficiary] NVARCHAR(1000) NOT NULL,
    [affiliateId] NVARCHAR(1000),
    [beneficiaryPhone] NVARCHAR(1000) NOT NULL,
    [creditAccount] NVARCHAR(1000) NOT NULL,
    [grossAmount] FLOAT(53) NOT NULL,
    [taxAmount] FLOAT(53) NOT NULL CONSTRAINT [AffiliatePayout_taxAmount_df] DEFAULT 0,
    [netAmount] FLOAT(53) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliatePayout_status_df] DEFAULT 'DRAFT',
    [transactionId] NVARCHAR(1000),
    [requestPayload] NVARCHAR(max),
    [responsePayload] NVARCHAR(max),
    [statusCode] INT,
    [errorMessage] NVARCHAR(max),
    [attempts] INT NOT NULL CONSTRAINT [AffiliatePayout_attempts_df] DEFAULT 0,
    [lastAttemptAt] DATETIME2,
    [paidAt] DATETIME2,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AffiliatePayout_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [AffiliatePayout_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Affiliate_programId_idx] ON [dbo].[Affiliate]([programId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Affiliate_status_idx] ON [dbo].[Affiliate]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateReferral_affiliateId_idx] ON [dbo].[AffiliateReferral]([affiliateId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateReferral_programVersionId_idx] ON [dbo].[AffiliateReferral]([programVersionId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateReferral_status_idx] ON [dbo].[AffiliateReferral]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateCommission_affiliateId_status_idx] ON [dbo].[AffiliateCommission]([affiliateId], [status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateCommission_referralId_idx] ON [dbo].[AffiliateCommission]([referralId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateCommission_status_holdUntil_idx] ON [dbo].[AffiliateCommission]([status], [holdUntil]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateCommission_loanId_idx] ON [dbo].[AffiliateCommission]([loanId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateCommission_payoutId_idx] ON [dbo].[AffiliateCommission]([payoutId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliateCommission_clawbackOfId_idx] ON [dbo].[AffiliateCommission]([clawbackOfId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliatePayoutBatch_programId_idx] ON [dbo].[AffiliatePayoutBatch]([programId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliatePayoutBatch_status_idx] ON [dbo].[AffiliatePayoutBatch]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliatePayout_batchId_idx] ON [dbo].[AffiliatePayout]([batchId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliatePayout_status_idx] ON [dbo].[AffiliatePayout]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliatePayout_affiliateId_idx] ON [dbo].[AffiliatePayout]([affiliateId]);

-- AddForeignKey
ALTER TABLE [dbo].[AffiliateProgramVersion] ADD CONSTRAINT [AffiliateProgramVersion_programId_fkey] FOREIGN KEY ([programId]) REFERENCES [dbo].[AffiliateProgram]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Affiliate] ADD CONSTRAINT [Affiliate_programId_fkey] FOREIGN KEY ([programId]) REFERENCES [dbo].[AffiliateProgram]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AffiliateReferral] ADD CONSTRAINT [AffiliateReferral_affiliateId_fkey] FOREIGN KEY ([affiliateId]) REFERENCES [dbo].[Affiliate]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AffiliateReferral] ADD CONSTRAINT [AffiliateReferral_programVersionId_fkey] FOREIGN KEY ([programVersionId]) REFERENCES [dbo].[AffiliateProgramVersion]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AffiliateCommission] ADD CONSTRAINT [AffiliateCommission_referralId_fkey] FOREIGN KEY ([referralId]) REFERENCES [dbo].[AffiliateReferral]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AffiliateCommission] ADD CONSTRAINT [AffiliateCommission_affiliateId_fkey] FOREIGN KEY ([affiliateId]) REFERENCES [dbo].[Affiliate]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AffiliateCommission] ADD CONSTRAINT [AffiliateCommission_payoutId_fkey] FOREIGN KEY ([payoutId]) REFERENCES [dbo].[AffiliatePayout]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AffiliatePayoutBatch] ADD CONSTRAINT [AffiliatePayoutBatch_programId_fkey] FOREIGN KEY ([programId]) REFERENCES [dbo].[AffiliateProgram]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AffiliatePayout] ADD CONSTRAINT [AffiliatePayout_batchId_fkey] FOREIGN KEY ([batchId]) REFERENCES [dbo].[AffiliatePayoutBatch]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AffiliatePayout] ADD CONSTRAINT [AffiliatePayout_affiliateId_fkey] FOREIGN KEY ([affiliateId]) REFERENCES [dbo].[Affiliate]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

