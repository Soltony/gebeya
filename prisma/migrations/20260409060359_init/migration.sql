BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[User] (
    [id] NVARCHAR(1000) NOT NULL,
    [fullName] NVARCHAR(1000) NOT NULL,
    [email] NVARCHAR(1000) NOT NULL,
    [phoneNumber] NVARCHAR(1000) NOT NULL,
    [password] NVARCHAR(1000) NOT NULL,
    [passwordChangeRequired] BIT NOT NULL CONSTRAINT [User_passwordChangeRequired_df] DEFAULT 1,
    [status] NVARCHAR(1000) NOT NULL,
    [roleId] NVARCHAR(1000) NOT NULL,
    [loanProviderId] NVARCHAR(1000),
    [branchId] NVARCHAR(1000),
    [merchantId] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [User_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [User_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [User_email_key] UNIQUE NONCLUSTERED ([email]),
    CONSTRAINT [User_phoneNumber_key] UNIQUE NONCLUSTERED ([phoneNumber])
);

-- CreateTable
CREATE TABLE [dbo].[Role] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [permissions] NVARCHAR(max) NOT NULL,
    CONSTRAINT [Role_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Role_name_key] UNIQUE NONCLUSTERED ([name])
);

-- CreateTable
CREATE TABLE [dbo].[Session] (
    [id] NVARCHAR(1000) NOT NULL,
    [userId] NVARCHAR(1000) NOT NULL,
    [refreshToken] NVARCHAR(1000) NOT NULL,
    [jti] NVARCHAR(1000),
    [revoked] BIT NOT NULL CONSTRAINT [Session_revoked_df] DEFAULT 0,
    [expiresAt] DATETIME2 NOT NULL,
    [lastActivity] DATETIME2 NOT NULL CONSTRAINT [Session_lastActivity_df] DEFAULT CURRENT_TIMESTAMP,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Session_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [Session_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Session_refreshToken_key] UNIQUE NONCLUSTERED ([refreshToken])
);

-- CreateTable
CREATE TABLE [dbo].[DisbursementControl] (
    [id] NVARCHAR(1000) NOT NULL CONSTRAINT [DisbursementControl_id_df] DEFAULT 'global',
    [enabled] BIT NOT NULL CONSTRAINT [DisbursementControl_enabled_df] DEFAULT 1,
    [updatedById] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DisbursementControl_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [DisbursementControl_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[LoanProvider] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [icon] TEXT NOT NULL,
    [colorHex] NVARCHAR(1000) NOT NULL,
    [displayOrder] INT NOT NULL,
    [accountNumber] NVARCHAR(1000),
    [collectionAccount] NVARCHAR(1000),
    [startingCapital] FLOAT(53) NOT NULL,
    [initialBalance] FLOAT(53) NOT NULL,
    [allowCrossProviderLoans] BIT NOT NULL CONSTRAINT [LoanProvider_allowCrossProviderLoans_df] DEFAULT 0,
    [nplThresholdDays] INT NOT NULL CONSTRAINT [LoanProvider_nplThresholdDays_df] DEFAULT 60,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [LoanProvider_status_df] DEFAULT 'ACTIVE',
    CONSTRAINT [LoanProvider_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [LoanProvider_name_key] UNIQUE NONCLUSTERED ([name])
);

-- CreateTable
CREATE TABLE [dbo].[ProviderDistribution] (
    [id] NVARCHAR(1000) NOT NULL,
    [providerId] NVARCHAR(1000) NOT NULL,
    [externalProviderId] NVARCHAR(1000),
    [distributionDate] DATETIME2 NOT NULL,
    [interestAmount] FLOAT(53) NOT NULL CONSTRAINT [ProviderDistribution_interestAmount_df] DEFAULT 0,
    [serviceFeeAmount] FLOAT(53) NOT NULL CONSTRAINT [ProviderDistribution_serviceFeeAmount_df] DEFAULT 0,
    [penaltyAmount] FLOAT(53) NOT NULL CONSTRAINT [ProviderDistribution_penaltyAmount_df] DEFAULT 0,
    [taxAmount] FLOAT(53) NOT NULL CONSTRAINT [ProviderDistribution_taxAmount_df] DEFAULT 0,
    [totalDistributedAmount] FLOAT(53) NOT NULL CONSTRAINT [ProviderDistribution_totalDistributedAmount_df] DEFAULT 0,
    [distributionReference] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ProviderDistribution_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [ProviderDistribution_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ProviderDistribution_providerId_distributionDate_key] UNIQUE NONCLUSTERED ([providerId],[distributionDate])
);

-- CreateTable
CREATE TABLE [dbo].[LoanProduct] (
    [id] NVARCHAR(1000) NOT NULL,
    [providerId] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [description] NVARCHAR(1000) NOT NULL,
    [icon] TEXT NOT NULL,
    [minLoan] FLOAT(53),
    [maxLoan] FLOAT(53),
    [isSalaryAdvance] BIT NOT NULL CONSTRAINT [LoanProduct_isSalaryAdvance_df] DEFAULT 0,
    [advancePercent] INT,
    [salaryAdvanceMappings] NVARCHAR(max),
    [duration] INT NOT NULL,
    [installments] INT,
    [repaymentIntervalDays] INT,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [LoanProduct_status_df] DEFAULT 'Active',
    [allowConcurrentLoans] BIT NOT NULL CONSTRAINT [LoanProduct_allowConcurrentLoans_df] DEFAULT 0,
    [serviceFee] NVARCHAR(1000) NOT NULL,
    [serviceFeeEnabled] BIT,
    [dailyFee] NVARCHAR(1000) NOT NULL,
    [dailyFeeEnabled] BIT,
    [penaltyRules] NVARCHAR(1000) NOT NULL,
    [penaltyRulesEnabled] BIT,
    [penaltyPerInstallment] BIT CONSTRAINT [LoanProduct_penaltyPerInstallment_df] DEFAULT 0,
    [dataProvisioningEnabled] BIT,
    [dataProvisioningConfigId] NVARCHAR(1000),
    [eligibilityFilter] TEXT,
    [eligibilityUploadId] NVARCHAR(1000),
    CONSTRAINT [LoanProduct_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [LoanProduct_name_providerId_key] UNIQUE NONCLUSTERED ([name],[providerId])
);

-- CreateTable
CREATE TABLE [dbo].[LoanCycleConfig] (
    [id] NVARCHAR(1000) NOT NULL,
    [productId] NVARCHAR(1000) NOT NULL,
    [metric] NVARCHAR(1000) NOT NULL,
    [enabled] BIT NOT NULL CONSTRAINT [LoanCycleConfig_enabled_df] DEFAULT 1,
    [cycleRanges] NVARCHAR(max),
    [grades] NVARCHAR(max),
    [cycles] NVARCHAR(max),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [LoanCycleConfig_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [LoanCycleConfig_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [LoanCycleConfig_productId_key] UNIQUE NONCLUSTERED ([productId])
);

-- CreateTable
CREATE TABLE [dbo].[Loan] (
    [id] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [productId] NVARCHAR(1000) NOT NULL,
    [loanApplicationId] NVARCHAR(1000) NOT NULL,
    [loanAmount] FLOAT(53) NOT NULL,
    [serviceFee] FLOAT(53) NOT NULL,
    [penaltyAmount] FLOAT(53) NOT NULL,
    [disbursedDate] DATETIME2 NOT NULL,
    [dueDate] DATETIME2 NOT NULL,
    [repaymentStatus] NVARCHAR(1000) NOT NULL,
    [repaymentBehavior] NVARCHAR(1000),
    [repaidAmount] FLOAT(53),
    [interestAccruedAmount] FLOAT(53) NOT NULL CONSTRAINT [Loan_interestAccruedAmount_df] DEFAULT 0,
    [interestAccruedThroughDate] DATETIME2,
    [penaltyAccruedAmount] FLOAT(53) NOT NULL CONSTRAINT [Loan_penaltyAccruedAmount_df] DEFAULT 0,
    [penaltyAccruedThroughDate] DATETIME2,
    [taxDeducted] FLOAT(53) NOT NULL CONSTRAINT [Loan_taxDeducted_df] DEFAULT 0,
    [netDisbursedAmount] FLOAT(53),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Loan_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Loan_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Loan_loanApplicationId_key] UNIQUE NONCLUSTERED ([loanApplicationId])
);

-- CreateTable
CREATE TABLE [dbo].[Payment] (
    [id] NVARCHAR(1000) NOT NULL,
    [loanId] NVARCHAR(1000) NOT NULL,
    [installmentId] NVARCHAR(1000),
    [amount] FLOAT(53) NOT NULL,
    [date] DATETIME2 NOT NULL,
    [outstandingBalanceBeforePayment] FLOAT(53),
    [journalEntryId] NVARCHAR(1000),
    CONSTRAINT [Payment_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Payment_journalEntryId_key] UNIQUE NONCLUSTERED ([journalEntryId])
);

-- CreateTable
CREATE TABLE [dbo].[LoanInstallment] (
    [id] NVARCHAR(1000) NOT NULL,
    [loanId] NVARCHAR(1000) NOT NULL,
    [installmentNumber] INT NOT NULL,
    [dueDate] DATETIME2 NOT NULL,
    [amount] FLOAT(53) NOT NULL,
    [paidAmount] FLOAT(53) CONSTRAINT [LoanInstallment_paidAmount_df] DEFAULT 0,
    [paidAt] DATETIME2,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [LoanInstallment_status_df] DEFAULT 'PENDING',
    [penaltyAmount] FLOAT(53) NOT NULL CONSTRAINT [LoanInstallment_penaltyAmount_df] DEFAULT 0,
    [isActive] BIT NOT NULL CONSTRAINT [LoanInstallment_isActive_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [LoanInstallment_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [LoanInstallment_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Borrower] (
    [id] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Borrower_status_df] DEFAULT 'Active',
    CONSTRAINT [Borrower_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[LoanApplication] (
    [id] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [productId] NVARCHAR(1000) NOT NULL,
    [loanAmount] FLOAT(53),
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [LoanApplication_status_df] DEFAULT 'PENDING_DOCUMENTS',
    [rejectionReason] TEXT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [LoanApplication_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [LoanApplication_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[RequiredDocument] (
    [id] NVARCHAR(1000) NOT NULL,
    [productId] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [description] NVARCHAR(1000),
    CONSTRAINT [RequiredDocument_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[UploadedDocument] (
    [id] NVARCHAR(1000) NOT NULL,
    [loanApplicationId] NVARCHAR(1000) NOT NULL,
    [requiredDocumentId] NVARCHAR(1000) NOT NULL,
    [fileName] NVARCHAR(1000) NOT NULL,
    [fileType] NVARCHAR(1000) NOT NULL,
    [fileContent] TEXT NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [UploadedDocument_status_df] DEFAULT 'PENDING',
    [reviewedBy] NVARCHAR(1000),
    [reviewedAt] DATETIME2,
    CONSTRAINT [UploadedDocument_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UploadedDocument_loanApplicationId_requiredDocumentId_key] UNIQUE NONCLUSTERED ([loanApplicationId],[requiredDocumentId])
);

-- CreateTable
CREATE TABLE [dbo].[DataProvisioningConfig] (
    [id] NVARCHAR(1000) NOT NULL,
    [providerId] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [columns] NVARCHAR(max) NOT NULL,
    CONSTRAINT [DataProvisioningConfig_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[DataProvisioningUpload] (
    [id] NVARCHAR(1000) NOT NULL,
    [configId] NVARCHAR(1000) NOT NULL,
    [fileName] NVARCHAR(1000) NOT NULL,
    [rowCount] INT NOT NULL,
    [uploadedBy] NVARCHAR(1000) NOT NULL,
    [uploadedAt] DATETIME2 NOT NULL CONSTRAINT [DataProvisioningUpload_uploadedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [DataProvisioningUpload_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ProvisionedData] (
    [id] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [configId] NVARCHAR(1000) NOT NULL,
    [uploadId] NVARCHAR(1000),
    [data] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ProvisionedData_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ProvisionedData_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ProvisionedData_borrowerId_configId_uploadId_key] UNIQUE NONCLUSTERED ([borrowerId],[configId],[uploadId])
);

-- CreateTable
CREATE TABLE [dbo].[ScoringParameter] (
    [id] NVARCHAR(1000) NOT NULL,
    [providerId] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [weight] INT NOT NULL,
    CONSTRAINT [ScoringParameter_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Rule] (
    [id] NVARCHAR(1000) NOT NULL,
    [parameterId] NVARCHAR(1000) NOT NULL,
    [field] NVARCHAR(1000) NOT NULL,
    [condition] NVARCHAR(1000) NOT NULL,
    [value] NVARCHAR(1000) NOT NULL,
    [score] INT NOT NULL,
    CONSTRAINT [Rule_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[LoanAmountTier] (
    [id] NVARCHAR(1000) NOT NULL,
    [productId] NVARCHAR(1000) NOT NULL,
    [fromScore] INT NOT NULL,
    [toScore] INT NOT NULL,
    [loanAmount] FLOAT(53) NOT NULL,
    CONSTRAINT [LoanAmountTier_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ScoringConfigurationHistory] (
    [id] NVARCHAR(1000) NOT NULL,
    [providerId] NVARCHAR(1000) NOT NULL,
    [parameters] NVARCHAR(max) NOT NULL,
    [savedAt] DATETIME2 NOT NULL CONSTRAINT [ScoringConfigurationHistory_savedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [ScoringConfigurationHistory_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ScoringConfigurationProduct] (
    [id] NVARCHAR(1000) NOT NULL,
    [configId] NVARCHAR(1000) NOT NULL,
    [productId] NVARCHAR(1000) NOT NULL,
    [assignedAt] DATETIME2 NOT NULL CONSTRAINT [ScoringConfigurationProduct_assignedAt_df] DEFAULT CURRENT_TIMESTAMP,
    [assignedBy] NVARCHAR(1000) NOT NULL,
    CONSTRAINT [ScoringConfigurationProduct_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ScoringConfigurationProduct_configId_productId_key] UNIQUE NONCLUSTERED ([configId],[productId])
);

-- CreateTable
CREATE TABLE [dbo].[LedgerAccount] (
    [id] NVARCHAR(1000) NOT NULL,
    [providerId] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [category] NVARCHAR(1000) NOT NULL,
    [balance] FLOAT(53) NOT NULL CONSTRAINT [LedgerAccount_balance_df] DEFAULT 0,
    CONSTRAINT [LedgerAccount_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [LedgerAccount_providerId_name_key] UNIQUE NONCLUSTERED ([providerId],[name])
);

-- CreateTable
CREATE TABLE [dbo].[JournalEntry] (
    [id] NVARCHAR(1000) NOT NULL,
    [providerId] NVARCHAR(1000) NOT NULL,
    [loanId] NVARCHAR(1000),
    [date] DATETIME2 NOT NULL,
    [description] NVARCHAR(1000) NOT NULL,
    CONSTRAINT [JournalEntry_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[LedgerEntry] (
    [id] NVARCHAR(1000) NOT NULL,
    [journalEntryId] NVARCHAR(1000) NOT NULL,
    [ledgerAccountId] NVARCHAR(1000) NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [amount] FLOAT(53) NOT NULL,
    CONSTRAINT [LedgerEntry_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[TermsAndConditions] (
    [id] NVARCHAR(1000) NOT NULL,
    [providerId] NVARCHAR(1000) NOT NULL,
    [content] TEXT NOT NULL,
    [version] INT NOT NULL,
    [isActive] BIT NOT NULL CONSTRAINT [TermsAndConditions_isActive_df] DEFAULT 0,
    [publishedAt] DATETIME2 NOT NULL,
    CONSTRAINT [TermsAndConditions_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [TermsAndConditions_providerId_version_key] UNIQUE NONCLUSTERED ([providerId],[version])
);

-- CreateTable
CREATE TABLE [dbo].[BorrowerAgreement] (
    [id] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [termsId] NVARCHAR(1000) NOT NULL,
    [acceptedAt] DATETIME2 NOT NULL CONSTRAINT [BorrowerAgreement_acceptedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [BorrowerAgreement_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [BorrowerAgreement_borrowerId_termsId_key] UNIQUE NONCLUSTERED ([borrowerId],[termsId])
);

-- CreateTable
CREATE TABLE [dbo].[Tax] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000),
    [rate] FLOAT(53) NOT NULL CONSTRAINT [Tax_rate_df] DEFAULT 0,
    [appliedTo] NVARCHAR(1000) NOT NULL,
    [isInclusive] BIT NOT NULL CONSTRAINT [Tax_isInclusive_df] DEFAULT 0,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Tax_status_df] DEFAULT 'ACTIVE',
    CONSTRAINT [Tax_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AuditLog] (
    [id] NVARCHAR(1000) NOT NULL,
    [actorId] NVARCHAR(1000) NOT NULL,
    [action] NVARCHAR(1000) NOT NULL,
    [entity] NVARCHAR(1000),
    [entityId] NVARCHAR(1000),
    [details] TEXT,
    [ipAddress] NVARCHAR(1000),
    [userAgent] TEXT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [AuditLog_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AuditLog_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[PendingChange] (
    [id] NVARCHAR(1000) NOT NULL,
    [entityType] NVARCHAR(1000) NOT NULL,
    [entityId] NVARCHAR(1000),
    [changeType] NVARCHAR(1000) NOT NULL,
    [payload] NVARCHAR(max) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [PendingChange_status_df] DEFAULT 'PENDING',
    [createdById] NVARCHAR(1000) NOT NULL,
    [approvedById] NVARCHAR(1000),
    [approvedAt] DATETIME2,
    [rejectionReason] TEXT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PendingChange_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [PendingChange_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[PendingPayment] (
    [id] NVARCHAR(1000) NOT NULL,
    [transactionId] NVARCHAR(1000) NOT NULL,
    [loanId] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [amount] FLOAT(53) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [PendingPayment_status_df] DEFAULT 'PENDING',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PendingPayment_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [PendingPayment_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [PendingPayment_transactionId_key] UNIQUE NONCLUSTERED ([transactionId])
);

-- CreateTable
CREATE TABLE [dbo].[PaymentTransaction] (
    [id] NVARCHAR(1000) NOT NULL,
    [transactionId] NVARCHAR(1000) NOT NULL,
    [txnRef] NVARCHAR(1000),
    [paymentType] NVARCHAR(1000) NOT NULL CONSTRAINT [PaymentTransaction_paymentType_df] DEFAULT 'BNPL',
    [status] NVARCHAR(1000) NOT NULL,
    [payload] NVARCHAR(max) NOT NULL,
    [receivedAt] DATETIME2 NOT NULL CONSTRAINT [PaymentTransaction_receivedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [PaymentTransaction_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [PaymentTransaction_transactionId_key] UNIQUE NONCLUSTERED ([transactionId])
);

-- CreateTable
CREATE TABLE [dbo].[DisbursementTransaction] (
    [id] NVARCHAR(1000) NOT NULL,
    [transactionId] NVARCHAR(1000),
    [loanId] NVARCHAR(1000),
    [providerId] NVARCHAR(1000) NOT NULL,
    [originalProviderId] NVARCHAR(1000),
    [creditAccount] NVARCHAR(1000) NOT NULL,
    [amount] FLOAT(53),
    [disbursementStatus] NVARCHAR(1000) NOT NULL CONSTRAINT [DisbursementTransaction_disbursementStatus_df] DEFAULT 'PENDING',
    [requestPayload] NVARCHAR(max) NOT NULL,
    [responsePayload] NVARCHAR(max),
    [rawResponse] NVARCHAR(max),
    [statusCode] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DisbursementTransaction_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [DisbursementTransaction_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[PhoneAccount] (
    [id] NVARCHAR(1000) NOT NULL,
    [phoneNumber] NVARCHAR(1000) NOT NULL,
    [accountNumber] NVARCHAR(1000) NOT NULL,
    [customerName] NVARCHAR(1000),
    [isActive] BIT NOT NULL CONSTRAINT [PhoneAccount_isActive_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [PhoneAccount_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [PhoneAccount_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [PhoneAccount_phoneNumber_accountNumber_key] UNIQUE NONCLUSTERED ([phoneNumber],[accountNumber])
);

-- CreateTable
CREATE TABLE [dbo].[AccountStatement] (
    [id] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [accountNumber] NVARCHAR(1000) NOT NULL,
    [customerName] NVARCHAR(1000),
    [currency] NVARCHAR(1000),
    [openingBalance] NVARCHAR(1000),
    [closingBalance] NVARCHAR(1000),
    [startDate] NVARCHAR(1000),
    [endDate] NVARCHAR(1000),
    [raw] NVARCHAR(max) NOT NULL,
    [fetchedAt] DATETIME2 NOT NULL CONSTRAINT [AccountStatement_fetchedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AccountStatement_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AccountStatement_borrowerId_accountNumber_startDate_endDate_key] UNIQUE NONCLUSTERED ([borrowerId],[accountNumber],[startDate],[endDate])
);

-- CreateTable
CREATE TABLE [dbo].[AccountStatementLine] (
    [id] NVARCHAR(1000) NOT NULL,
    [statementId] NVARCHAR(1000) NOT NULL,
    [bookDate] NVARCHAR(1000),
    [reference] NVARCHAR(1000),
    [description] NVARCHAR(1000),
    [narrative] NVARCHAR(1000),
    [valueDate] NVARCHAR(1000),
    [debit] FLOAT(53),
    [credit] FLOAT(53),
    [closingBalance] FLOAT(53),
    CONSTRAINT [AccountStatementLine_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[AccountStatementMetrics] (
    [id] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [accountNumber] NVARCHAR(1000) NOT NULL,
    [periodStart] NVARCHAR(1000) NOT NULL,
    [periodEnd] NVARCHAR(1000) NOT NULL,
    [monthsAtEbirr] INT,
    [txCountRelevant] INT,
    [billPaymentsCount] INT,
    [avgMonthlyDeposit] FLOAT(53),
    [avgUniqueDepositSources] FLOAT(53),
    [avgMonthlyAirtimeCount] FLOAT(53),
    [avgMonthlyAirtimeValue] FLOAT(53),
    [withdrawalToDepositRatio] FLOAT(53),
    [avgBalance] FLOAT(53),
    [derived] NVARCHAR(max) NOT NULL,
    [computedAt] DATETIME2 NOT NULL CONSTRAINT [AccountStatementMetrics_computedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [AccountStatementMetrics_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [AccountStatementMetrics_borrowerId_accountNumber_periodStart_periodEnd_key] UNIQUE NONCLUSTERED ([borrowerId],[accountNumber],[periodStart],[periodEnd])
);

-- CreateTable
CREATE TABLE [dbo].[SmsTemplate] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [content] NVARCHAR(max) NOT NULL,
    [description] NVARCHAR(max),
    [isActive] BIT NOT NULL CONSTRAINT [SmsTemplate_isActive_df] DEFAULT 1,
    [createdById] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [SmsTemplate_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [SmsTemplate_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [SmsTemplate_name_key] UNIQUE NONCLUSTERED ([name])
);

-- CreateTable
CREATE TABLE [dbo].[SmsLog] (
    [id] NVARCHAR(1000) NOT NULL,
    [templateId] NVARCHAR(1000),
    [campaignId] NVARCHAR(1000),
    [recipientPhone] NVARCHAR(1000) NOT NULL,
    [recipientName] NVARCHAR(1000),
    [loanId] NVARCHAR(1000),
    [productId] NVARCHAR(1000),
    [productName] NVARCHAR(1000),
    [messageContent] NVARCHAR(max) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [SmsLog_status_df] DEFAULT 'PENDING',
    [errorMessage] NVARCHAR(max),
    [sentAt] DATETIME2,
    [deliveredAt] DATETIME2,
    [retryCount] INT NOT NULL CONSTRAINT [SmsLog_retryCount_df] DEFAULT 0,
    [lastRetryAt] DATETIME2,
    [parentSmsId] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [SmsLog_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [SmsLog_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[SmsCampaign] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [templateId] NVARCHAR(1000),
    [targetCriteria] NVARCHAR(max) NOT NULL,
    [customMessage] NVARCHAR(max),
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [SmsCampaign_status_df] DEFAULT 'DRAFT',
    [scheduleType] NVARCHAR(1000) NOT NULL CONSTRAINT [SmsCampaign_scheduleType_df] DEFAULT 'IMMEDIATE',
    [scheduledAt] DATETIME2,
    [startedAt] DATETIME2,
    [completedAt] DATETIME2,
    [totalRecipients] INT NOT NULL CONSTRAINT [SmsCampaign_totalRecipients_df] DEFAULT 0,
    [sentCount] INT NOT NULL CONSTRAINT [SmsCampaign_sentCount_df] DEFAULT 0,
    [deliveredCount] INT NOT NULL CONSTRAINT [SmsCampaign_deliveredCount_df] DEFAULT 0,
    [failedCount] INT NOT NULL CONSTRAINT [SmsCampaign_failedCount_df] DEFAULT 0,
    [createdById] NVARCHAR(1000),
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [SmsCampaign_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [SmsCampaign_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[District] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [District_status_df] DEFAULT 'ACTIVE',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [District_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [District_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [District_name_key] UNIQUE NONCLUSTERED ([name])
);

-- CreateTable
CREATE TABLE [dbo].[Branch] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [districtId] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Branch_status_df] DEFAULT 'ACTIVE',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Branch_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Branch_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Branch_name_districtId_key] UNIQUE NONCLUSTERED ([name],[districtId])
);

-- CreateTable
CREATE TABLE [dbo].[Merchant] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [accountNumber] NVARCHAR(1000),
    [branchId] NVARCHAR(1000),
    [iconUrl] TEXT,
    [contactPersonName] NVARCHAR(1000),
    [contactPersonPhone] NVARCHAR(1000),
    [contactPersonEmail] NVARCHAR(1000),
    [additionalContactInfo] TEXT,
    [bnplEnabled] BIT NOT NULL CONSTRAINT [Merchant_bnplEnabled_df] DEFAULT 1,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Merchant_status_df] DEFAULT 'PENDING_APPROVAL',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Merchant_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Merchant_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [Merchant_name_key] UNIQUE NONCLUSTERED ([name]),
    CONSTRAINT [Merchant_accountNumber_key] UNIQUE NONCLUSTERED ([accountNumber])
);

-- CreateTable
CREATE TABLE [dbo].[ProductCategory] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [ProductCategory_status_df] DEFAULT 'ACTIVE',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ProductCategory_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ProductCategory_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [ProductCategory_name_key] UNIQUE NONCLUSTERED ([name])
);

-- CreateTable
CREATE TABLE [dbo].[Item] (
    [id] NVARCHAR(1000) NOT NULL,
    [merchantId] NVARCHAR(1000) NOT NULL,
    [categoryId] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [description] TEXT,
    [price] FLOAT(53) NOT NULL,
    [imageUrl] TEXT,
    [videoUrl] TEXT,
    [currency] NVARCHAR(1000) NOT NULL CONSTRAINT [Item_currency_df] DEFAULT 'ETB',
    [sellingOption] NVARCHAR(1000) NOT NULL CONSTRAINT [Item_sellingOption_df] DEFAULT 'BNPL_ONLY',
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Item_status_df] DEFAULT 'ACTIVE',
    [stockQuantity] INT NOT NULL CONSTRAINT [Item_stockQuantity_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Item_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Item_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ItemVariant] (
    [id] NVARCHAR(1000) NOT NULL,
    [itemId] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [size] NVARCHAR(1000),
    [color] NVARCHAR(1000),
    [material] NVARCHAR(1000),
    [price] FLOAT(53) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [ItemVariant_status_df] DEFAULT 'ACTIVE',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ItemVariant_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ItemVariant_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ItemOptionGroup] (
    [id] NVARCHAR(1000) NOT NULL,
    [itemId] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ItemOptionGroup_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ItemOptionGroup_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[ItemOptionValue] (
    [id] NVARCHAR(1000) NOT NULL,
    [groupId] NVARCHAR(1000) NOT NULL,
    [label] NVARCHAR(1000) NOT NULL,
    [priceDelta] FLOAT(53) NOT NULL CONSTRAINT [ItemOptionValue_priceDelta_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [ItemOptionValue_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [ItemOptionValue_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[DiscountRule] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [type] NVARCHAR(1000) NOT NULL,
    [value] FLOAT(53) NOT NULL CONSTRAINT [DiscountRule_value_df] DEFAULT 0,
    [buyX] INT,
    [getY] INT,
    [merchantId] NVARCHAR(1000),
    [itemId] NVARCHAR(1000),
    [categoryId] NVARCHAR(1000),
    [minQuantity] INT NOT NULL CONSTRAINT [DiscountRule_minQuantity_df] DEFAULT 1,
    [startDate] DATETIME2,
    [endDate] DATETIME2,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [DiscountRule_status_df] DEFAULT 'ACTIVE',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DiscountRule_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [DiscountRule_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[Order] (
    [id] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [merchantId] NVARCHAR(1000) NOT NULL,
    [loanApplicationId] NVARCHAR(1000),
    [loanId] NVARCHAR(1000),
    [paymentType] NVARCHAR(1000) NOT NULL CONSTRAINT [Order_paymentType_df] DEFAULT 'BNPL',
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [Order_status_df] DEFAULT 'PENDING_MERCHANT_CONFIRMATION',
    [cancelReason] NVARCHAR(1000),
    [cancelledBy] NVARCHAR(1000),
    [totalAmount] FLOAT(53) NOT NULL CONSTRAINT [Order_totalAmount_df] DEFAULT 0,
    [currency] NVARCHAR(1000) NOT NULL CONSTRAINT [Order_currency_df] DEFAULT 'ETB',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [Order_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [Order_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[OrderItem] (
    [id] NVARCHAR(1000) NOT NULL,
    [orderId] NVARCHAR(1000) NOT NULL,
    [itemId] NVARCHAR(1000) NOT NULL,
    [variantId] NVARCHAR(1000),
    [quantity] INT NOT NULL CONSTRAINT [OrderItem_quantity_df] DEFAULT 1,
    [unitPrice] FLOAT(53) NOT NULL,
    [lineTotal] FLOAT(53) NOT NULL,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [OrderItem_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [OrderItem_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[OrderItemOptionSelection] (
    [id] NVARCHAR(1000) NOT NULL,
    [orderItemId] NVARCHAR(1000) NOT NULL,
    [optionValueId] NVARCHAR(1000) NOT NULL,
    [priceDelta] FLOAT(53) NOT NULL CONSTRAINT [OrderItemOptionSelection_priceDelta_df] DEFAULT 0,
    CONSTRAINT [OrderItemOptionSelection_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[StockLocation] (
    [id] NVARCHAR(1000) NOT NULL,
    [name] NVARCHAR(1000) NOT NULL,
    [address] NVARCHAR(1000),
    [contactInfo] NVARCHAR(1000),
    [branchId] NVARCHAR(1000),
    [merchantId] NVARCHAR(1000),
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [StockLocation_status_df] DEFAULT 'ACTIVE',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [StockLocation_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [StockLocation_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[InventoryLevel] (
    [id] NVARCHAR(1000) NOT NULL,
    [itemId] NVARCHAR(1000) NOT NULL,
    [stockLocationId] NVARCHAR(1000) NOT NULL,
    [quantity] INT NOT NULL CONSTRAINT [InventoryLevel_quantity_df] DEFAULT 0,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [InventoryLevel_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [InventoryLevel_itemId_stockLocationId_key] UNIQUE NONCLUSTERED ([itemId],[stockLocationId])
);

-- CreateTable
CREATE TABLE [dbo].[CombinationInventoryLevel] (
    [id] NVARCHAR(1000) NOT NULL,
    [itemId] NVARCHAR(1000) NOT NULL,
    [locationId] NVARCHAR(1000) NOT NULL,
    [combinationKey] NVARCHAR(1000) NOT NULL,
    [optionValueIds] NVARCHAR(max) NOT NULL,
    [quantityAvailable] INT NOT NULL CONSTRAINT [CombinationInventoryLevel_quantityAvailable_df] DEFAULT 0,
    [reservedQuantity] INT NOT NULL CONSTRAINT [CombinationInventoryLevel_reservedQuantity_df] DEFAULT 0,
    [lowStockThreshold] INT,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [CombinationInventoryLevel_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [CombinationInventoryLevel_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CombinationInventoryLevel_itemId_locationId_combinationKey_key] UNIQUE NONCLUSTERED ([itemId],[locationId],[combinationKey])
);

-- CreateTable
CREATE TABLE [dbo].[DirectPendingPayment] (
    [id] NVARCHAR(1000) NOT NULL,
    [transactionId] NVARCHAR(1000) NOT NULL,
    [orderId] NVARCHAR(1000) NOT NULL,
    [borrowerId] NVARCHAR(1000) NOT NULL,
    [merchantId] NVARCHAR(1000) NOT NULL,
    [amount] FLOAT(53) NOT NULL,
    [status] NVARCHAR(1000) NOT NULL CONSTRAINT [DirectPendingPayment_status_df] DEFAULT 'PENDING',
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DirectPendingPayment_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    [updatedAt] DATETIME2 NOT NULL,
    CONSTRAINT [DirectPendingPayment_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DirectPendingPayment_transactionId_key] UNIQUE NONCLUSTERED ([transactionId])
);

-- CreateTable
CREATE TABLE [dbo].[DirectPaymentTransaction] (
    [id] NVARCHAR(1000) NOT NULL,
    [transactionId] NVARCHAR(1000) NOT NULL,
    [txnRef] NVARCHAR(1000),
    [orderId] NVARCHAR(1000),
    [status] NVARCHAR(1000) NOT NULL,
    [payload] NVARCHAR(max) NOT NULL,
    [receivedAt] DATETIME2 NOT NULL CONSTRAINT [DirectPaymentTransaction_receivedAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [DirectPaymentTransaction_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DirectPaymentTransaction_transactionId_key] UNIQUE NONCLUSTERED ([transactionId])
);

-- CreateTable
CREATE TABLE [dbo].[DeliveryAgreementTemplate] (
    [id] NVARCHAR(1000) NOT NULL,
    [providerId] NVARCHAR(1000) NOT NULL,
    [content] TEXT NOT NULL,
    [version] INT NOT NULL,
    [isActive] BIT NOT NULL CONSTRAINT [DeliveryAgreementTemplate_isActive_df] DEFAULT 0,
    [publishedAt] DATETIME2 NOT NULL,
    CONSTRAINT [DeliveryAgreementTemplate_pkey] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [DeliveryAgreementTemplate_providerId_version_key] UNIQUE NONCLUSTERED ([providerId],[version])
);

-- CreateTable
CREATE TABLE [dbo].[DeliveryOtp] (
    [id] NVARCHAR(1000) NOT NULL,
    [orderId] NVARCHAR(1000) NOT NULL,
    [code] NVARCHAR(1000) NOT NULL,
    [expiresAt] DATETIME2 NOT NULL,
    [verified] BIT NOT NULL CONSTRAINT [DeliveryOtp_verified_df] DEFAULT 0,
    [createdAt] DATETIME2 NOT NULL CONSTRAINT [DeliveryOtp_createdAt_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [DeliveryOtp_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Session_userId_idx] ON [dbo].[Session]([userId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Session_jti_idx] ON [dbo].[Session]([jti]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DisbursementControl_updatedById_idx] ON [dbo].[DisbursementControl]([updatedById]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ProviderDistribution_distributionDate_idx] ON [dbo].[ProviderDistribution]([distributionDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [LoanInstallment_loanId_idx] ON [dbo].[LoanInstallment]([loanId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [LoanInstallment_dueDate_idx] ON [dbo].[LoanInstallment]([dueDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditLog_actorId_idx] ON [dbo].[AuditLog]([actorId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditLog_action_idx] ON [dbo].[AuditLog]([action]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AuditLog_entity_entityId_idx] ON [dbo].[AuditLog]([entity], [entityId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PendingChange_status_idx] ON [dbo].[PendingChange]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PendingChange_entityType_idx] ON [dbo].[PendingChange]([entityType]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DisbursementTransaction_loanId_idx] ON [dbo].[DisbursementTransaction]([loanId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DisbursementTransaction_providerId_idx] ON [dbo].[DisbursementTransaction]([providerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DisbursementTransaction_transactionId_idx] ON [dbo].[DisbursementTransaction]([transactionId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DisbursementTransaction_disbursementStatus_idx] ON [dbo].[DisbursementTransaction]([disbursementStatus]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [PhoneAccount_phoneNumber_idx] ON [dbo].[PhoneAccount]([phoneNumber]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AccountStatement_borrowerId_idx] ON [dbo].[AccountStatement]([borrowerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AccountStatement_accountNumber_idx] ON [dbo].[AccountStatement]([accountNumber]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AccountStatementMetrics_borrowerId_idx] ON [dbo].[AccountStatementMetrics]([borrowerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [AccountStatementMetrics_accountNumber_idx] ON [dbo].[AccountStatementMetrics]([accountNumber]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SmsLog_status_idx] ON [dbo].[SmsLog]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SmsLog_recipientPhone_idx] ON [dbo].[SmsLog]([recipientPhone]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SmsLog_loanId_idx] ON [dbo].[SmsLog]([loanId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SmsLog_productId_idx] ON [dbo].[SmsLog]([productId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SmsLog_campaignId_idx] ON [dbo].[SmsLog]([campaignId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SmsLog_createdAt_idx] ON [dbo].[SmsLog]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SmsCampaign_status_idx] ON [dbo].[SmsCampaign]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SmsCampaign_scheduledAt_idx] ON [dbo].[SmsCampaign]([scheduledAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [SmsCampaign_createdAt_idx] ON [dbo].[SmsCampaign]([createdAt]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ItemVariant_itemId_idx] ON [dbo].[ItemVariant]([itemId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ItemOptionGroup_itemId_idx] ON [dbo].[ItemOptionGroup]([itemId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [ItemOptionValue_groupId_idx] ON [dbo].[ItemOptionValue]([groupId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DiscountRule_merchantId_idx] ON [dbo].[DiscountRule]([merchantId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DiscountRule_itemId_idx] ON [dbo].[DiscountRule]([itemId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DiscountRule_categoryId_idx] ON [dbo].[DiscountRule]([categoryId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DiscountRule_startDate_endDate_idx] ON [dbo].[DiscountRule]([startDate], [endDate]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Order_borrowerId_idx] ON [dbo].[Order]([borrowerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Order_merchantId_idx] ON [dbo].[Order]([merchantId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [Order_status_idx] ON [dbo].[Order]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OrderItem_orderId_idx] ON [dbo].[OrderItem]([orderId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OrderItem_itemId_idx] ON [dbo].[OrderItem]([itemId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [OrderItemOptionSelection_orderItemId_idx] ON [dbo].[OrderItemOptionSelection]([orderItemId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [StockLocation_merchantId_idx] ON [dbo].[StockLocation]([merchantId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CombinationInventoryLevel_itemId_idx] ON [dbo].[CombinationInventoryLevel]([itemId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [CombinationInventoryLevel_locationId_idx] ON [dbo].[CombinationInventoryLevel]([locationId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DirectPendingPayment_orderId_idx] ON [dbo].[DirectPendingPayment]([orderId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DirectPendingPayment_borrowerId_idx] ON [dbo].[DirectPendingPayment]([borrowerId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DirectPaymentTransaction_orderId_idx] ON [dbo].[DirectPaymentTransaction]([orderId]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [DeliveryOtp_orderId_idx] ON [dbo].[DeliveryOtp]([orderId]);

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_roleId_fkey] FOREIGN KEY ([roleId]) REFERENCES [dbo].[Role]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_loanProviderId_fkey] FOREIGN KEY ([loanProviderId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_branchId_fkey] FOREIGN KEY ([branchId]) REFERENCES [dbo].[Branch]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[User] ADD CONSTRAINT [User_merchantId_fkey] FOREIGN KEY ([merchantId]) REFERENCES [dbo].[Merchant]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Session] ADD CONSTRAINT [Session_userId_fkey] FOREIGN KEY ([userId]) REFERENCES [dbo].[User]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[DisbursementControl] ADD CONSTRAINT [DisbursementControl_updatedById_fkey] FOREIGN KEY ([updatedById]) REFERENCES [dbo].[User]([id]) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ProviderDistribution] ADD CONSTRAINT [ProviderDistribution_providerId_fkey] FOREIGN KEY ([providerId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[LoanProduct] ADD CONSTRAINT [LoanProduct_providerId_fkey] FOREIGN KEY ([providerId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[LoanProduct] ADD CONSTRAINT [LoanProduct_dataProvisioningConfigId_fkey] FOREIGN KEY ([dataProvisioningConfigId]) REFERENCES [dbo].[DataProvisioningConfig]([id]) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[LoanProduct] ADD CONSTRAINT [LoanProduct_eligibilityUploadId_fkey] FOREIGN KEY ([eligibilityUploadId]) REFERENCES [dbo].[DataProvisioningUpload]([id]) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[LoanCycleConfig] ADD CONSTRAINT [LoanCycleConfig_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[LoanProduct]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Loan] ADD CONSTRAINT [Loan_borrowerId_fkey] FOREIGN KEY ([borrowerId]) REFERENCES [dbo].[Borrower]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Loan] ADD CONSTRAINT [Loan_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[LoanProduct]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Loan] ADD CONSTRAINT [Loan_loanApplicationId_fkey] FOREIGN KEY ([loanApplicationId]) REFERENCES [dbo].[LoanApplication]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Payment] ADD CONSTRAINT [Payment_loanId_fkey] FOREIGN KEY ([loanId]) REFERENCES [dbo].[Loan]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Payment] ADD CONSTRAINT [Payment_installmentId_fkey] FOREIGN KEY ([installmentId]) REFERENCES [dbo].[LoanInstallment]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Payment] ADD CONSTRAINT [Payment_journalEntryId_fkey] FOREIGN KEY ([journalEntryId]) REFERENCES [dbo].[JournalEntry]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[LoanInstallment] ADD CONSTRAINT [LoanInstallment_loanId_fkey] FOREIGN KEY ([loanId]) REFERENCES [dbo].[Loan]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[LoanApplication] ADD CONSTRAINT [LoanApplication_borrowerId_fkey] FOREIGN KEY ([borrowerId]) REFERENCES [dbo].[Borrower]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[LoanApplication] ADD CONSTRAINT [LoanApplication_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[LoanProduct]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[RequiredDocument] ADD CONSTRAINT [RequiredDocument_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[LoanProduct]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[UploadedDocument] ADD CONSTRAINT [UploadedDocument_loanApplicationId_fkey] FOREIGN KEY ([loanApplicationId]) REFERENCES [dbo].[LoanApplication]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[UploadedDocument] ADD CONSTRAINT [UploadedDocument_requiredDocumentId_fkey] FOREIGN KEY ([requiredDocumentId]) REFERENCES [dbo].[RequiredDocument]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DataProvisioningConfig] ADD CONSTRAINT [DataProvisioningConfig_providerId_fkey] FOREIGN KEY ([providerId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DataProvisioningUpload] ADD CONSTRAINT [DataProvisioningUpload_configId_fkey] FOREIGN KEY ([configId]) REFERENCES [dbo].[DataProvisioningConfig]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ProvisionedData] ADD CONSTRAINT [ProvisionedData_borrowerId_fkey] FOREIGN KEY ([borrowerId]) REFERENCES [dbo].[Borrower]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ProvisionedData] ADD CONSTRAINT [ProvisionedData_configId_fkey] FOREIGN KEY ([configId]) REFERENCES [dbo].[DataProvisioningConfig]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ProvisionedData] ADD CONSTRAINT [ProvisionedData_uploadId_fkey] FOREIGN KEY ([uploadId]) REFERENCES [dbo].[DataProvisioningUpload]([id]) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ScoringParameter] ADD CONSTRAINT [ScoringParameter_providerId_fkey] FOREIGN KEY ([providerId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Rule] ADD CONSTRAINT [Rule_parameterId_fkey] FOREIGN KEY ([parameterId]) REFERENCES [dbo].[ScoringParameter]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[LoanAmountTier] ADD CONSTRAINT [LoanAmountTier_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[LoanProduct]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ScoringConfigurationHistory] ADD CONSTRAINT [ScoringConfigurationHistory_providerId_fkey] FOREIGN KEY ([providerId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ScoringConfigurationProduct] ADD CONSTRAINT [ScoringConfigurationProduct_configId_fkey] FOREIGN KEY ([configId]) REFERENCES [dbo].[ScoringConfigurationHistory]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ScoringConfigurationProduct] ADD CONSTRAINT [ScoringConfigurationProduct_productId_fkey] FOREIGN KEY ([productId]) REFERENCES [dbo].[LoanProduct]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[LedgerAccount] ADD CONSTRAINT [LedgerAccount_providerId_fkey] FOREIGN KEY ([providerId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[JournalEntry] ADD CONSTRAINT [JournalEntry_providerId_fkey] FOREIGN KEY ([providerId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[JournalEntry] ADD CONSTRAINT [JournalEntry_loanId_fkey] FOREIGN KEY ([loanId]) REFERENCES [dbo].[Loan]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[LedgerEntry] ADD CONSTRAINT [LedgerEntry_journalEntryId_fkey] FOREIGN KEY ([journalEntryId]) REFERENCES [dbo].[JournalEntry]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[LedgerEntry] ADD CONSTRAINT [LedgerEntry_ledgerAccountId_fkey] FOREIGN KEY ([ledgerAccountId]) REFERENCES [dbo].[LedgerAccount]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[TermsAndConditions] ADD CONSTRAINT [TermsAndConditions_providerId_fkey] FOREIGN KEY ([providerId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[BorrowerAgreement] ADD CONSTRAINT [BorrowerAgreement_borrowerId_fkey] FOREIGN KEY ([borrowerId]) REFERENCES [dbo].[Borrower]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[BorrowerAgreement] ADD CONSTRAINT [BorrowerAgreement_termsId_fkey] FOREIGN KEY ([termsId]) REFERENCES [dbo].[TermsAndConditions]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[PendingChange] ADD CONSTRAINT [PendingChange_createdById_fkey] FOREIGN KEY ([createdById]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PendingChange] ADD CONSTRAINT [PendingChange_approvedById_fkey] FOREIGN KEY ([approvedById]) REFERENCES [dbo].[User]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PendingPayment] ADD CONSTRAINT [PendingPayment_loanId_fkey] FOREIGN KEY ([loanId]) REFERENCES [dbo].[Loan]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[PendingPayment] ADD CONSTRAINT [PendingPayment_borrowerId_fkey] FOREIGN KEY ([borrowerId]) REFERENCES [dbo].[Borrower]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DisbursementTransaction] ADD CONSTRAINT [DisbursementTransaction_loanId_fkey] FOREIGN KEY ([loanId]) REFERENCES [dbo].[Loan]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[AccountStatement] ADD CONSTRAINT [AccountStatement_borrowerId_fkey] FOREIGN KEY ([borrowerId]) REFERENCES [dbo].[Borrower]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[AccountStatementLine] ADD CONSTRAINT [AccountStatementLine_statementId_fkey] FOREIGN KEY ([statementId]) REFERENCES [dbo].[AccountStatement]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[AccountStatementMetrics] ADD CONSTRAINT [AccountStatementMetrics_borrowerId_fkey] FOREIGN KEY ([borrowerId]) REFERENCES [dbo].[Borrower]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[SmsLog] ADD CONSTRAINT [SmsLog_templateId_fkey] FOREIGN KEY ([templateId]) REFERENCES [dbo].[SmsTemplate]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[SmsLog] ADD CONSTRAINT [SmsLog_campaignId_fkey] FOREIGN KEY ([campaignId]) REFERENCES [dbo].[SmsCampaign]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[SmsCampaign] ADD CONSTRAINT [SmsCampaign_templateId_fkey] FOREIGN KEY ([templateId]) REFERENCES [dbo].[SmsTemplate]([id]) ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Branch] ADD CONSTRAINT [Branch_districtId_fkey] FOREIGN KEY ([districtId]) REFERENCES [dbo].[District]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Merchant] ADD CONSTRAINT [Merchant_branchId_fkey] FOREIGN KEY ([branchId]) REFERENCES [dbo].[Branch]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Item] ADD CONSTRAINT [Item_merchantId_fkey] FOREIGN KEY ([merchantId]) REFERENCES [dbo].[Merchant]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[Item] ADD CONSTRAINT [Item_categoryId_fkey] FOREIGN KEY ([categoryId]) REFERENCES [dbo].[ProductCategory]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[ItemVariant] ADD CONSTRAINT [ItemVariant_itemId_fkey] FOREIGN KEY ([itemId]) REFERENCES [dbo].[Item]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ItemOptionGroup] ADD CONSTRAINT [ItemOptionGroup_itemId_fkey] FOREIGN KEY ([itemId]) REFERENCES [dbo].[Item]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[ItemOptionValue] ADD CONSTRAINT [ItemOptionValue_groupId_fkey] FOREIGN KEY ([groupId]) REFERENCES [dbo].[ItemOptionGroup]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[DiscountRule] ADD CONSTRAINT [DiscountRule_merchantId_fkey] FOREIGN KEY ([merchantId]) REFERENCES [dbo].[Merchant]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DiscountRule] ADD CONSTRAINT [DiscountRule_itemId_fkey] FOREIGN KEY ([itemId]) REFERENCES [dbo].[Item]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[DiscountRule] ADD CONSTRAINT [DiscountRule_categoryId_fkey] FOREIGN KEY ([categoryId]) REFERENCES [dbo].[ProductCategory]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Order] ADD CONSTRAINT [Order_borrowerId_fkey] FOREIGN KEY ([borrowerId]) REFERENCES [dbo].[Borrower]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Order] ADD CONSTRAINT [Order_merchantId_fkey] FOREIGN KEY ([merchantId]) REFERENCES [dbo].[Merchant]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[Order] ADD CONSTRAINT [Order_loanApplicationId_fkey] FOREIGN KEY ([loanApplicationId]) REFERENCES [dbo].[LoanApplication]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OrderItem] ADD CONSTRAINT [OrderItem_orderId_fkey] FOREIGN KEY ([orderId]) REFERENCES [dbo].[Order]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[OrderItem] ADD CONSTRAINT [OrderItem_itemId_fkey] FOREIGN KEY ([itemId]) REFERENCES [dbo].[Item]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OrderItem] ADD CONSTRAINT [OrderItem_variantId_fkey] FOREIGN KEY ([variantId]) REFERENCES [dbo].[ItemVariant]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[OrderItemOptionSelection] ADD CONSTRAINT [OrderItemOptionSelection_orderItemId_fkey] FOREIGN KEY ([orderItemId]) REFERENCES [dbo].[OrderItem]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[OrderItemOptionSelection] ADD CONSTRAINT [OrderItemOptionSelection_optionValueId_fkey] FOREIGN KEY ([optionValueId]) REFERENCES [dbo].[ItemOptionValue]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[StockLocation] ADD CONSTRAINT [StockLocation_branchId_fkey] FOREIGN KEY ([branchId]) REFERENCES [dbo].[Branch]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[StockLocation] ADD CONSTRAINT [StockLocation_merchantId_fkey] FOREIGN KEY ([merchantId]) REFERENCES [dbo].[Merchant]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryLevel] ADD CONSTRAINT [InventoryLevel_itemId_fkey] FOREIGN KEY ([itemId]) REFERENCES [dbo].[Item]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[InventoryLevel] ADD CONSTRAINT [InventoryLevel_stockLocationId_fkey] FOREIGN KEY ([stockLocationId]) REFERENCES [dbo].[StockLocation]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CombinationInventoryLevel] ADD CONSTRAINT [CombinationInventoryLevel_itemId_fkey] FOREIGN KEY ([itemId]) REFERENCES [dbo].[Item]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[CombinationInventoryLevel] ADD CONSTRAINT [CombinationInventoryLevel_locationId_fkey] FOREIGN KEY ([locationId]) REFERENCES [dbo].[StockLocation]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[DirectPendingPayment] ADD CONSTRAINT [DirectPendingPayment_orderId_fkey] FOREIGN KEY ([orderId]) REFERENCES [dbo].[Order]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DirectPendingPayment] ADD CONSTRAINT [DirectPendingPayment_borrowerId_fkey] FOREIGN KEY ([borrowerId]) REFERENCES [dbo].[Borrower]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DirectPendingPayment] ADD CONSTRAINT [DirectPendingPayment_merchantId_fkey] FOREIGN KEY ([merchantId]) REFERENCES [dbo].[Merchant]([id]) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE [dbo].[DeliveryAgreementTemplate] ADD CONSTRAINT [DeliveryAgreementTemplate_providerId_fkey] FOREIGN KEY ([providerId]) REFERENCES [dbo].[LoanProvider]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[DeliveryOtp] ADD CONSTRAINT [DeliveryOtp_orderId_fkey] FOREIGN KEY ([orderId]) REFERENCES [dbo].[Order]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
