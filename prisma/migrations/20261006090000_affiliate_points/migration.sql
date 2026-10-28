BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[AffiliateCommission] ADD [points] INT,
[rewardType] NVARCHAR(1000) NOT NULL CONSTRAINT [AffiliateCommission_rewardType_df] DEFAULT 'MONEY';

-- CreateTable
CREATE TABLE [dbo].[AffiliatePointTransaction] (
    [id] NVARCHAR(1000) NOT NULL,
    [idempotencyKey] NVARCHAR(1000) NOT NULL,
    [reference] NVARCHAR(1000) NOT NULL,
    [phone] NVARCHAR(1000) NOT NULL,
    [affiliateId] NVARCHAR(1000),
    [type] NVARCHAR(1000) NOT NULL,
    [points] INT NOT NULL,
    [birrValue] FLOAT(53) NOT NULL CONSTRAINT [AffiliatePointTransaction_birrValue_df] DEFAULT 0,
    [commissionId] NVARCHAR(1000),
    [programId] NVARCHAR(1000),
    [note] NVARCHAR(max),
    [createdById] NVARCHAR(1000),
    [approvedById] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AffiliatePointTransaction_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AffiliatePointTransaction_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AffiliatePointTransaction_idempotencyKey_key] UNIQUE NONCLUSTERED ([idempotencyKey]),
    CONSTRAINT [AffiliatePointTransaction_reference_key] UNIQUE NONCLUSTERED ([reference])
);

-- CreateTable
CREATE TABLE [dbo].[AffiliatePointsSettingsVersion] (
    [id] NVARCHAR(1000) NOT NULL,
    [version] INT NOT NULL,
    [config] NVARCHAR(max) NOT NULL,
    [publishedAt] DATETIME2 NOT NULL CONSTRAINT [AffiliatePointsSettingsVersion_publishedAt_df] DEFAULT CURRENT_TIMESTAMP,
    [publishedById] NVARCHAR(1000),
    CONSTRAINT [AffiliatePointsSettingsVersion_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AffiliatePointsSettingsVersion_version_key] UNIQUE NONCLUSTERED ([version])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliatePointTransaction_phone_idx] ON [dbo].[AffiliatePointTransaction]([phone]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliatePointTransaction_affiliateId_idx] ON [dbo].[AffiliatePointTransaction]([affiliateId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliatePointTransaction_type_createdAt_idx] ON [dbo].[AffiliatePointTransaction]([type], [createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AffiliatePointTransaction_commissionId_idx] ON [dbo].[AffiliatePointTransaction]([commissionId]);

-- AddForeignKey
ALTER TABLE [dbo].[AffiliatePointTransaction] ADD CONSTRAINT [AffiliatePointTransaction_affiliateId_fkey] FOREIGN KEY ([affiliateId]) REFERENCES [dbo].[Affiliate]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

