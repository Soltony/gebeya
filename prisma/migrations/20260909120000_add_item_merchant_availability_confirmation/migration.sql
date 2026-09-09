BEGIN TRY

BEGIN TRAN;

-- AlterTable
ALTER TABLE [dbo].[Item] ADD [requiresMerchantAvailabilityConfirmation] BIT NOT NULL CONSTRAINT [Item_requiresMerchantAvailabilityConfirmation_df] DEFAULT 1;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
