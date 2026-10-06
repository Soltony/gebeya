/* ============================================================================
   PACKAGE 1 SERVICE FEE FIX — BNPLDB (SQL Server)
   Written 2026-09-15.

   PROBLEM
     "Hello Beg Package 1" (0% service fee) was enabled by accident, so
     borrowers took BNPL loans with no service fee. Reports show 0 service fee
     for those loans.

   WHAT THIS SCRIPT DOES
     For every OPEN Package 1 loan (not Paid / not reversed) whose disbursement
     to the merchant SUCCEEDED:
       1. Moves the loan (and its application) to "Hello Beg Package 3"
          (10% fee, same 4-installment / 30-day schedule and penalty settings).
          The app bills the fee from the loan's product, so this is what makes
          the borrower's next installment include the fee.
       2. Stores the fee on the loan (Loan.serviceFee).
       3. Books the fee on the loan's original disbursement journal entry
          (Service Fee Receivable debit), exactly like a normal booking, and
          adds it to the Service Fee Receivable account balance.
          (Also books tax on the fee if a tax applies to service fees.)
       4. Writes an AuditLog row per loan.
     Plus:
       5. Moves Package 1 orders that are NOT yet delivered (PENDING_DELIVERY)
          to Package 3, so they get the fee when the loan is created.
       6. Disables Package 1 so no new no-fee loans are created.

     SKIPPED (listed in the results with the reason):
       - loans whose disbursement FAILED   -> handle on the Reversals page
       - loans already reversed or with a reversal waiting for approval
       - loans already Paid

   HOW TO RUN — pick ONE
     A. No SQL tools on the machine (uses the app's own Prisma setup):
          node scripts/run-package1-fee-fix.cjs            (dry run)
          node scripts/run-package1-fee-fix.cjs --commit   (apply)
        Leave the settings below as they are — the runner switches them.
     B. SSMS / sqlcmd:
        1. Run it as-is. It is a DRY RUN: it shows what it would change and
           then undoes everything. Check the "action" column in result set 2.
        2. If it looks right, change   DECLARE @Commit BIT = 0;   to   = 1;
           and run it once more.
        (The last result is the same report as one JSON value — used by A.)
     Running it again later is safe (nothing is fixed twice).
   ========================================================================== */

SET XACT_ABORT ON;
SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;

DECLARE @Commit BIT = 0;           -- 0 = dry run (nothing saved), 1 = apply the fix
DECLARE @DisablePackage1 BIT = 1;  -- 1 = also switch Package 1 off
DECLARE @ShowTables BIT = 1;       -- 1 = show step-by-step result tables (SSMS/sqlcmd); the Node runner sets 0

DECLARE @now DATETIME2 = SYSUTCDATETIME();
DECLARE @fixTag VARCHAR(100) = 'package1-service-fee-2026-09';

BEGIN TRAN;

/* ---------------------------------------------------------------------------
   1. PRODUCTS, FEE RULE AND LEDGER ACCOUNTS
--------------------------------------------------------------------------- */
DECLARE @pkg1Id NVARCHAR(1000), @pkg3Id NVARCHAR(1000), @providerId NVARCHAR(1000),
        @pkg3FeeEnabled BIT, @pkg3FeeRule NVARCHAR(MAX),
        @feeType NVARCHAR(50), @feeValue FLOAT,
        @principalReceivableId NVARCHAR(1000), @sfReceivableId NVARCHAR(1000),
        @taxReceivableId NVARCHAR(1000), @taxRateOnFee FLOAT;

IF (SELECT COUNT(*) FROM LoanProduct WHERE name = N'Hello Beg Package 1') <> 1
    THROW 50001, 'Expected exactly one product named "Hello Beg Package 1". Nothing was changed.', 1;

SELECT @pkg1Id = id, @providerId = providerId
FROM LoanProduct WHERE name = N'Hello Beg Package 1';

IF (SELECT COUNT(*) FROM LoanProduct WHERE name = N'Hello Beg Package 3' AND providerId = @providerId) <> 1
    THROW 50002, 'Expected exactly one "Hello Beg Package 3" under the same provider as Package 1. Nothing was changed.', 1;

SELECT @pkg3Id = id, @pkg3FeeEnabled = serviceFeeEnabled, @pkg3FeeRule = serviceFee
FROM LoanProduct WHERE name = N'Hello Beg Package 3' AND providerId = @providerId;

IF COALESCE(@pkg3FeeEnabled, 0) <> 1 OR COALESCE(ISJSON(@pkg3FeeRule), 0) <> 1
    THROW 50003, 'Package 3 service fee is not enabled or its fee setting is invalid. Nothing was changed.', 1;

SET @feeType  = JSON_VALUE(@pkg3FeeRule, '$.type');
SET @feeValue = TRY_CAST(JSON_VALUE(@pkg3FeeRule, '$.value') AS FLOAT);

IF COALESCE(@feeType, '') NOT IN ('percentage', 'fixed') OR COALESCE(@feeValue, 0) <= 0
    THROW 50004, 'Package 3 service fee must be a percentage or fixed amount greater than 0. Nothing was changed.', 1;

IF (SELECT COUNT(*) FROM LedgerAccount WHERE providerId = @providerId AND category = 'ServiceFee' AND type = 'Receivable') <> 1
    THROW 50005, 'Expected exactly one Service Fee Receivable ledger account for the provider. Nothing was changed.', 1;

SELECT @sfReceivableId = id FROM LedgerAccount
WHERE providerId = @providerId AND category = 'ServiceFee' AND type = 'Receivable';

SELECT TOP 1 @principalReceivableId = id FROM LedgerAccount
WHERE providerId = @providerId AND category = 'Principal' AND type = 'Receivable';

SELECT TOP 1 @taxReceivableId = id FROM LedgerAccount
WHERE providerId = @providerId AND category = 'Tax' AND type = 'Receivable';

IF @principalReceivableId IS NULL
    THROW 50006, 'Principal Receivable ledger account not found for the provider. Nothing was changed.', 1;

-- Same rule as the app: active taxes whose appliedTo includes "serviceFee".
SELECT @taxRateOnFee = COALESCE(SUM(rate), 0)
FROM Tax
WHERE status = 'ACTIVE' AND rate > 0 AND appliedTo LIKE '%serviceFee%';

DECLARE @sfBalanceBefore FLOAT = (SELECT balance FROM LedgerAccount WHERE id = @sfReceivableId);
DECLARE @pkg1StatusBefore NVARCHAR(1000) = (SELECT status FROM LoanProduct WHERE id = @pkg1Id);

IF @ShowTables = 1
BEGIN
    PRINT '=== 1. Settings used ===';
    SELECT @pkg1Id            AS package1Id,
           @pkg1StatusBefore  AS package1StatusNow,
           @pkg3Id            AS package3Id,
           @feeType           AS package3FeeType,
           @feeValue          AS package3FeeValue,
           @taxRateOnFee      AS taxRateOnServiceFee,
           @sfReceivableId    AS serviceFeeReceivableAccountId,
           @sfBalanceBefore   AS serviceFeeReceivableBalanceBefore;
END

/* ---------------------------------------------------------------------------
   2. FIND OPEN PACKAGE 1 LOANS WITHOUT A SERVICE FEE
--------------------------------------------------------------------------- */
DROP TABLE IF EXISTS #loans;

SELECT
    l.id                                        AS loanId,
    l.loanApplicationId,
    l.borrowerId,
    l.loanAmount,
    COALESCE(l.repaidAmount, 0)                 AS repaidAmount,
    l.repaymentStatus,
    l.disbursedDate,
    COALESCE(disb.successCount, 0)              AS successfulDisbursements,
    COALESCE(disb.otherCount, 0)                AS failedOrPendingDisbursements,
    je.id                                       AS journalEntryId,
    CAST(ROUND(CAST(CASE WHEN @feeType = 'percentage'
                         THEN l.loanAmount * @feeValue / 100.0
                         ELSE @feeValue END AS DECIMAL(19, 6)), 2) AS FLOAT) AS newServiceFee,
    CAST(0 AS FLOAT)                            AS taxOnFee,
    CAST(NULL AS NVARCHAR(200))                 AS skipReason
INTO #loans
FROM Loan l
OUTER APPLY (
    SELECT
        SUM(CASE WHEN d.disbursementStatus = 'SUCCESS'
                   OR (d.disbursementStatus <> 'FAILED' AND d.statusCode BETWEEN 200 AND 299)
                 THEN 1 ELSE 0 END) AS successCount,
        SUM(CASE WHEN d.disbursementStatus = 'SUCCESS'
                   OR (d.disbursementStatus <> 'FAILED' AND d.statusCode BETWEEN 200 AND 299)
                 THEN 0 ELSE 1 END) AS otherCount
    FROM DisbursementTransaction d
    WHERE d.loanId = l.id
) disb
OUTER APPLY (
    -- The original booking journal: no payment attached, principal booked in full.
    SELECT TOP 1 j.id
    FROM JournalEntry j
    WHERE j.loanId = l.id
      AND NOT EXISTS (SELECT 1 FROM Payment p WHERE p.journalEntryId = j.id)
      AND EXISTS (
          SELECT 1 FROM LedgerEntry e
          WHERE e.journalEntryId = j.id
            AND e.ledgerAccountId = @principalReceivableId
            AND e.type = 'Debit'
            AND ABS(e.amount - l.loanAmount) < 0.01)
    ORDER BY j.date ASC, j.id ASC
) je
WHERE l.productId = @pkg1Id
  AND l.repaymentStatus NOT IN ('Paid', 'REVERSED')
  AND COALESCE(l.serviceFee, 0) = 0;

UPDATE #loans
SET taxOnFee = CAST(ROUND(CAST(newServiceFee * @taxRateOnFee / 100.0 AS DECIMAL(19, 6)), 2) AS FLOAT);

UPDATE #loans
SET skipReason = 'SKIP: disbursement did not succeed (use the Reversals page)'
WHERE skipReason IS NULL AND successfulDisbursements = 0;

UPDATE c
SET skipReason = 'SKIP: loan reversed or reversal waiting for approval'
FROM #loans c
WHERE c.skipReason IS NULL
  AND (   EXISTS (SELECT 1 FROM AuditLog a
                  WHERE a.entity = 'Loan' AND a.entityId = c.loanId
                    AND a.action IN ('LOAN_REVERSED', 'LOAN_CANCELLED'))
       OR EXISTS (SELECT 1 FROM AuditLog a
                  JOIN DisbursementTransaction d ON d.id = a.entityId
                  WHERE d.loanId = c.loanId
                    AND a.entity = 'DisbursementTransaction' AND a.action = 'DISBURSEMENT_REVERSED')
       OR EXISTS (SELECT 1 FROM PendingChange pc
                  WHERE pc.status = 'PENDING' AND pc.entityId = c.loanId
                    AND pc.entityType IN ('LoanReversal', 'LoanCancel'))
       OR EXISTS (SELECT 1 FROM PendingChange pc
                  JOIN DisbursementTransaction d ON d.id = pc.entityId
                  WHERE d.loanId = c.loanId
                    AND pc.status = 'PENDING' AND pc.entityType = 'DisbursementReversal'));

UPDATE #loans
SET skipReason = 'SKIP: original disbursement journal entry not found'
WHERE skipReason IS NULL AND journalEntryId IS NULL;

UPDATE c
SET skipReason = 'SKIP: service fee already booked on the disbursement journal'
FROM #loans c
WHERE c.skipReason IS NULL
  AND EXISTS (SELECT 1 FROM LedgerEntry e
              WHERE e.journalEntryId = c.journalEntryId
                AND e.ledgerAccountId = @sfReceivableId
                AND e.type = 'Debit');

UPDATE #loans
SET skipReason = 'SKIP: calculated fee is 0'
WHERE skipReason IS NULL AND newServiceFee <= 0;

IF @ShowTables = 1
BEGIN
    PRINT '=== 2. Open Package 1 loans with no service fee ===';
    SELECT loanId, borrowerId, loanAmount, repaidAmount, repaymentStatus,
           CONVERT(date, disbursedDate)                               AS disbursedOn,
           successfulDisbursements, failedOrPendingDisbursements,
           COALESCE(skipReason, 'FIX')                                AS action,
           CASE WHEN skipReason IS NULL THEN newServiceFee END        AS serviceFeeToAdd,
           CASE WHEN skipReason IS NULL THEN taxOnFee END             AS taxOnFeeToAdd
    FROM #loans
    ORDER BY CASE WHEN skipReason IS NULL THEN 0 ELSE 1 END, disbursedDate;
END

/* Orders placed on Package 1 that are not delivered yet (no loan created). */
DROP TABLE IF EXISTS #apps;

SELECT la.id AS loanApplicationId, la.borrowerId, la.loanAmount, la.status, la.createdAt
INTO #apps
FROM LoanApplication la
WHERE la.productId = @pkg1Id
  AND la.status = 'PENDING_DELIVERY'
  AND NOT EXISTS (SELECT 1 FROM Loan l WHERE l.loanApplicationId = la.id);

IF @ShowTables = 1
BEGIN
    PRINT '=== 2b. Undelivered Package 1 orders that will move to Package 3 ===';
    SELECT * FROM #apps ORDER BY createdAt;
END

/* ---------------------------------------------------------------------------
   3. APPLY
--------------------------------------------------------------------------- */
DECLARE @loansFixed INT   = (SELECT COUNT(*) FROM #loans WHERE skipReason IS NULL);
DECLARE @feeTotal   FLOAT = COALESCE((SELECT SUM(newServiceFee) FROM #loans WHERE skipReason IS NULL), 0);
DECLARE @taxTotal   FLOAT = COALESCE((SELECT SUM(taxOnFee) FROM #loans WHERE skipReason IS NULL), 0);

-- 3a. Move loan + its application to Package 3 and store the fee.
UPDATE l
SET productId = @pkg3Id, serviceFee = c.newServiceFee, updatedAt = @now
FROM Loan l
JOIN #loans c ON c.loanId = l.id
WHERE c.skipReason IS NULL;

UPDATE la
SET productId = @pkg3Id, updatedAt = @now
FROM LoanApplication la
JOIN #loans c ON c.loanApplicationId = la.id
WHERE c.skipReason IS NULL;

-- 3b. Book the fee receivable on the original disbursement journal.
INSERT INTO LedgerEntry (id, journalEntryId, ledgerAccountId, type, amount)
SELECT CONCAT(N'sffix_', c.loanId), c.journalEntryId, @sfReceivableId, N'Debit', c.newServiceFee
FROM #loans c
WHERE c.skipReason IS NULL;

IF @feeTotal > 0
    UPDATE LedgerAccount SET balance = balance + @feeTotal WHERE id = @sfReceivableId;

-- 3c. Tax on the fee (only when a tax applies to service fees).
IF @taxTotal > 0 AND @taxReceivableId IS NOT NULL
BEGIN
    INSERT INTO LedgerEntry (id, journalEntryId, ledgerAccountId, type, amount)
    SELECT CONCAT(N'sffixtax_', c.loanId), c.journalEntryId, @taxReceivableId, N'Debit', c.taxOnFee
    FROM #loans c
    WHERE c.skipReason IS NULL AND c.taxOnFee > 0;

    UPDATE LedgerAccount SET balance = balance + @taxTotal WHERE id = @taxReceivableId;
END
ELSE IF @taxTotal > 0
    PRINT 'WARNING: a tax applies to service fees but no Tax Receivable account exists; tax was not booked (same as the app).';

-- 3d. Undelivered Package 1 orders -> Package 3.
UPDATE la
SET productId = @pkg3Id, updatedAt = @now
FROM LoanApplication la
JOIN #apps a ON a.loanApplicationId = la.id;

-- 3e. Switch Package 1 off.
IF @DisablePackage1 = 1
    UPDATE LoanProduct SET status = N'Disabled' WHERE id = @pkg1Id AND status <> N'Disabled';

-- 3f. Audit trail.
INSERT INTO AuditLog (id, actorId, action, entity, entityId, details, createdAt)
SELECT CONCAT(N'sffix_audit_', c.loanId),
       N'data-fix-operator',
       N'DATA_FIX_EXECUTED',
       N'LOAN',
       c.loanId,
       CAST(CONCAT('{"fix":"', @fixTag,
                   '","fromProductId":"', @pkg1Id,
                   '","toProductId":"', @pkg3Id,
                   '","serviceFee":', CONVERT(VARCHAR(40), CAST(c.newServiceFee AS DECIMAL(19, 2))),
                   ',"taxOnFee":', CONVERT(VARCHAR(40), CAST(c.taxOnFee AS DECIMAL(19, 2))),
                   ',"journalEntryId":"', c.journalEntryId,
                   '","ledgerEntryId":"sffix_', c.loanId, '"}') AS VARCHAR(MAX)),
       @now
FROM #loans c
WHERE c.skipReason IS NULL;

/* ---------------------------------------------------------------------------
   4. AFTER
--------------------------------------------------------------------------- */
IF @ShowTables = 1
BEGIN
    PRINT '=== 3. Loans after the fix ===';
    SELECT l.id AS loanId, p.name AS product, l.loanAmount, l.serviceFee,
           e.id AS ledgerEntryId, e.amount AS bookedServiceFee
    FROM #loans c
    JOIN Loan l        ON l.id = c.loanId
    JOIN LoanProduct p ON p.id = l.productId
    LEFT JOIN LedgerEntry e ON e.id = CONCAT(N'sffix_', c.loanId)
    WHERE c.skipReason IS NULL;

    PRINT '=== 4. Summary ===';
    SELECT CASE WHEN @Commit = 1 THEN 'APPLIED' ELSE 'DRY RUN - nothing saved' END   AS mode,
           @loansFixed                                                            AS loansFixed,
           @feeTotal                                                              AS totalServiceFeeAdded,
           @taxTotal                                                              AS totalTaxOnFeeAdded,
           (SELECT COUNT(*) FROM #loans WHERE skipReason IS NOT NULL)             AS loansSkipped,
           (SELECT COUNT(*) FROM #apps)                                           AS undeliveredOrdersMoved,
           (SELECT balance FROM LedgerAccount WHERE id = @sfReceivableId)         AS serviceFeeReceivableBalanceAfter,
           (SELECT status FROM LoanProduct WHERE id = @pkg1Id)                    AS package1StatusAfter;
END

/* ---------------------------------------------------------------------------
   5. SAME REPORT AS ONE JSON VALUE (read by scripts/run-package1-fee-fix.cjs,
      which runs with @ShowTables = 0 so this is the only result). Built
      before COMMIT/ROLLBACK because the temp tables disappear with a
      rollback; variables do not.
--------------------------------------------------------------------------- */
DECLARE @report NVARCHAR(MAX) = (
    SELECT
        CASE WHEN @Commit = 1 THEN 'APPLIED' ELSE 'DRY RUN - nothing saved' END AS mode,
        JSON_QUERY((
            SELECT @pkg1Id AS package1Id, @pkg1StatusBefore AS package1StatusBefore,
                   @pkg3Id AS package3Id, @feeType AS package3FeeType, @feeValue AS package3FeeValue,
                   @taxRateOnFee AS taxRateOnServiceFee,
                   @sfReceivableId AS serviceFeeReceivableAccountId,
                   @sfBalanceBefore AS serviceFeeReceivableBalanceBefore
            FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS settings,
        JSON_QUERY(COALESCE((
            SELECT loanId, borrowerId, loanAmount, repaidAmount, repaymentStatus,
                   CONVERT(date, disbursedDate) AS disbursedOn,
                   successfulDisbursements, failedOrPendingDisbursements,
                   COALESCE(skipReason, 'FIX') AS action,
                   CASE WHEN skipReason IS NULL THEN newServiceFee END AS serviceFeeToAdd,
                   CASE WHEN skipReason IS NULL THEN taxOnFee END AS taxOnFeeToAdd
            FROM #loans
            ORDER BY CASE WHEN skipReason IS NULL THEN 0 ELSE 1 END, disbursedDate
            FOR JSON PATH, INCLUDE_NULL_VALUES), '[]')) AS loans,
        JSON_QUERY(COALESCE((
            SELECT loanApplicationId, borrowerId, loanAmount, status, createdAt
            FROM #apps
            ORDER BY createdAt
            FOR JSON PATH), '[]')) AS undeliveredOrders,
        JSON_QUERY((
            SELECT @loansFixed AS loansFixed,
                   @feeTotal AS totalServiceFeeAdded,
                   @taxTotal AS totalTaxOnFeeAdded,
                   (SELECT COUNT(*) FROM #loans WHERE skipReason IS NOT NULL) AS loansSkipped,
                   (SELECT COUNT(*) FROM #apps) AS undeliveredOrdersMoved,
                   (SELECT balance FROM LedgerAccount WHERE id = @sfReceivableId) AS serviceFeeReceivableBalanceAfter,
                   (SELECT status FROM LoanProduct WHERE id = @pkg1Id) AS package1StatusAfter
            FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS summary
    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES
);

IF @Commit = 1
BEGIN
    COMMIT TRAN;
    PRINT '*** APPLIED - changes saved. ***';
END
ELSE
BEGIN
    ROLLBACK TRAN;
    PRINT '*** DRY RUN - nothing was saved. Set @Commit = 1 and run again to apply. ***';
END

SELECT @report AS report;

/* sqlcmd (from DATABASE_URL  sqlserver://HOST:PORT;database=DB;user=USER;password=PASS):
     sqlcmd -S HOST,PORT -d DB -U USER -P PASS -C -I -b -W -i scripts\fix-package1-service-fee.sql
*/
