BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[DirectPendingPayment] ADD [completedAt] DATETIME2,
[customerPhone] NVARCHAR(1000),
[method] NVARCHAR(1000) NOT NULL CONSTRAINT [DirectPendingPayment_method_df] DEFAULT 'GATEWAY',
[payerAccount] NVARCHAR(1000),
[sharedSecret] NVARCHAR(1000),
[statusCheckedAt] DATETIME2,
[statusDesc] NVARCHAR(500);

-- CreateTable
CREATE TABLE [dbo].[DirectPaymentFt] (
    [cbsReference] NVARCHAR(1000) NOT NULL,
    [directPendingPaymentId] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DirectPaymentFt_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [DirectPaymentFt_pkey] PRIMARY KEY CLUSTERED ([cbsReference]),
    CONSTRAINT [DirectPaymentFt_directPendingPaymentId_key] UNIQUE NONCLUSTERED ([directPendingPaymentId])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DirectPendingPayment_method_status_createdAt_idx] ON [dbo].[DirectPendingPayment]([method], [status], [createdAt]);

-- AddForeignKey
ALTER TABLE [dbo].[DirectPaymentFt] ADD CONSTRAINT [DirectPaymentFt_directPendingPaymentId_fkey] FOREIGN KEY ([directPendingPaymentId]) REFERENCES [dbo].[DirectPendingPayment]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH

