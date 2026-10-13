/* ============================================================================
   UNWIND THE 1% INCLUSIVE TAX ON LOANS THAT WERE PAID IN FULL — BNPLDB
   Written 2026-10-06.

   BACKGROUND
     Until part-way through 2026-09-10 a 1% "inclusive tax" was withheld at
     booking: a 22,000 loan recorded taxDeducted = 220 and only 21,780 was
     sent to the merchant. That setting was switched off, and the failed
     2026-09-10 disbursements were retried paying the FULL loan amount.
     For those loans the withheld tax never actually happened.

   WHAT THIS SCRIPT DOES
     For every loan that still records a tax deduction AND has a successful
     disbursement for the FULL loan amount:
       1. Removes the three tax entries written at booking (Tax Receivable
          debit + credit, Tax Received debit) from the booking journal.
       2. Reduces the Tax Received account balance by the same amount
          (it was never collected).
       3. Clears the loan's taxDeducted and sets netDisbursedAmount to the
          full loan amount.
       4. Reduces the provider's available fund by the extra amount actually
          paid out (booking only deducted the net amount).
       5. Writes an AuditLog row per loan.

     SKIPPED (shown with the reason):
       - loans not yet paid, or paid an amount other than the full loan amount
       - loans whose booking journal or tax entries cannot be found

   RUN IT ONLY AFTER the retry script has actually paid the loans in full.

   HOW TO RUN — pick ONE
     A. node scripts/run-sql-fix.cjs --file fix-inclusive-tax-on-gross-paid-loans.sql
        (add --commit to apply)
     B. SSMS / sqlcmd: run as-is for a DRY RUN, then set @Commit = 1.
     Running it again later is safe (nothing is unwound twice).
   ========================================================================== */

SET XACT_ABORT ON;
SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;

DECLARE @Commit BIT = 0;      -- 0 = dry run (nothing saved), 1 = apply
DECLARE @ShowTables BIT = 1;  -- 1 = step-by-step tables (SSMS/sqlcmd); the runner sets 0

DECLARE @now DATETIME2 = SYSUTCDATETIME();
DECLARE @fixTag VARCHAR(100) = 'inclusive-tax-unwind-2026-10';

BEGIN TRAN;

/* ---------------------------------------------------------------------------
   1. FIND LOANS THAT RECORD A TAX DEDUCTION BUT WERE PAID IN FULL
--------------------------------------------------------------------------- */
DROP TABLE IF EXISTS #tax;

SELECT
    l.id                                AS loanId,
    l.borrowerId,
    l.loanAmount,
    COALESCE(l.taxDeducted, 0)          AS taxDeducted,
    l.netDisbursedAmount,
    pr.id                               AS providerId,
    pr.name                             AS providerName,
    je.id                               AS journalEntryId,
    trcv.id                             AS taxReceivableId,
    trcd.id                             AS taxReceivedId,
    paid.amount                         AS paidAmount,
    CAST(NULL AS NVARCHAR(200))         AS skipReason
INTO #tax
FROM Loan l
JOIN LoanProduct p   ON p.id = l.productId
JOIN LoanProvider pr ON pr.id = p.providerId
OUTER APPLY (
    SELECT TOP 1 dt.amount
    FROM DisbursementTransaction dt
    WHERE dt.loanId = l.id
      AND (dt.disbursementStatus = 'SUCCESS'
           OR (dt.disbursementStatus <> 'FAILED' AND dt.statusCode BETWEEN 200 AND 299))
    ORDER BY dt.createdAt DESC
) paid
OUTER APPLY (
    SELECT TOP 1 j.id
    FROM JournalEntry j
    WHERE j.loanId = l.id
      AND NOT EXISTS (SELECT 1 FROM Payment pm WHERE pm.journalEntryId = j.id)
      AND EXISTS (SELECT 1 FROM LedgerEntry e
                  JOIN LedgerAccount a ON a.id = e.ledgerAccountId
                  WHERE e.journalEntryId = j.id AND a.category = 'Principal'
                    AND a.type = 'Receivable' AND e.type = 'Debit'
                    AND ABS(e.amount - l.loanAmount) < 0.01)
    ORDER BY j.date ASC, j.id ASC
) je
OUTER APPLY (SELECT TOP 1 id FROM LedgerAccount a WHERE a.providerId = pr.id AND a.category = 'Tax' AND a.type = 'Receivable') trcv
OUTER APPLY (SELECT TOP 1 id FROM LedgerAccount a WHERE a.providerId = pr.id AND a.category = 'Tax' AND a.type = 'Received') trcd
WHERE COALESCE(l.taxDeducted, 0) > 0
  AND l.repaymentStatus <> 'REVERSED';

UPDATE #tax SET skipReason = 'SKIP: no successful disbursement yet'
WHERE skipReason IS NULL AND paidAmount IS NULL;

UPDATE #tax SET skipReason = 'SKIP: paid amount is not the full loan amount'
WHERE skipReason IS NULL AND ABS(paidAmount - loanAmount) > 0.01;

UPDATE #tax SET skipReason = 'SKIP: booking journal entry not found'
WHERE skipReason IS NULL AND journalEntryId IS NULL;

UPDATE #tax SET skipReason = 'SKIP: tax ledger accounts not found for the provider'
WHERE skipReason IS NULL AND (taxReceivableId IS NULL OR taxReceivedId IS NULL);

UPDATE t SET skipReason = 'SKIP: tax entries not found on the booking journal'
FROM #tax t
WHERE t.skipReason IS NULL
  AND NOT EXISTS (SELECT 1 FROM LedgerEntry e
                  WHERE e.journalEntryId = t.journalEntryId
                    AND e.ledgerAccountId = t.taxReceivedId
                    AND e.type = 'Debit'
                    AND ABS(e.amount - t.taxDeducted) < 0.01);

IF @ShowTables = 1
BEGIN
    PRINT '=== 1. Loans with a recorded tax deduction ===';
    SELECT loanId, borrowerId, loanAmount, taxDeducted, netDisbursedAmount, paidAmount,
           providerName, COALESCE(skipReason, 'FIX') AS action
    FROM #tax
    ORDER BY CASE WHEN skipReason IS NULL THEN 0 ELSE 1 END, loanId;
END

/* ---------------------------------------------------------------------------
   2. APPLY
--------------------------------------------------------------------------- */
DECLARE @loansFixed INT   = (SELECT COUNT(*) FROM #tax WHERE skipReason IS NULL);
DECLARE @taxUnwound FLOAT = COALESCE((SELECT SUM(taxDeducted) FROM #tax WHERE skipReason IS NULL), 0);

-- 2a. Audit first, so the removed entries are recorded before they are deleted.
INSERT INTO AuditLog (id, actorId, action, entity, entityId, details, createdAt)
SELECT CONCAT(N'taxfix_audit_', t.loanId),
       N'data-fix-operator',
       N'DATA_FIX_EXECUTED',
       N'LOAN',
       t.loanId,
       CAST(CONCAT('{"fix":"', @fixTag,
                   '","taxUnwound":', CONVERT(VARCHAR(40), CAST(t.taxDeducted AS DECIMAL(19, 2))),
                   ',"loanAmount":', CONVERT(VARCHAR(40), CAST(t.loanAmount AS DECIMAL(19, 2))),
                   ',"paidAmount":', CONVERT(VARCHAR(40), CAST(t.paidAmount AS DECIMAL(19, 2))),
                   ',"journalEntryId":"', t.journalEntryId,
                   '","removedEntryIds":"',
                   STUFF((SELECT ',' + e.id FROM LedgerEntry e
                          WHERE e.journalEntryId = t.journalEntryId
                            AND e.ledgerAccountId IN (t.taxReceivableId, t.taxReceivedId)
                            AND ABS(e.amount - t.taxDeducted) < 0.01
                          FOR XML PATH('')), 1, 1, ''),
                   '"}') AS VARCHAR(MAX)),
       @now
FROM #tax t
WHERE t.skipReason IS NULL;

-- 2b. Remove the tax entries written at booking.
DELETE e
FROM LedgerEntry e
JOIN #tax t ON t.journalEntryId = e.journalEntryId
WHERE t.skipReason IS NULL
  AND e.ledgerAccountId IN (t.taxReceivableId, t.taxReceivedId)
  AND ABS(e.amount - t.taxDeducted) < 0.01;

-- 2c. The Tax Received balance was increased at booking; take it back off.
UPDATE a
SET balance = a.balance - x.total
FROM LedgerAccount a
JOIN (SELECT taxReceivedId AS accountId, SUM(taxDeducted) AS total
      FROM #tax WHERE skipReason IS NULL GROUP BY taxReceivedId) x ON x.accountId = a.id;

-- 2d. The loan no longer has anything withheld.
UPDATE l
SET taxDeducted = 0, netDisbursedAmount = l.loanAmount, updatedAt = @now
FROM Loan l
JOIN #tax t ON t.loanId = l.id
WHERE t.skipReason IS NULL;

-- 2e. Booking only deducted the net amount from the fund; the rest went out too.
UPDATE pr
SET initialBalance = pr.initialBalance - x.total
FROM LoanProvider pr
JOIN (SELECT providerId, SUM(taxDeducted) AS total
      FROM #tax WHERE skipReason IS NULL GROUP BY providerId) x ON x.providerId = pr.id;

/* ---------------------------------------------------------------------------
   3. AFTER
--------------------------------------------------------------------------- */
IF @ShowTables = 1
BEGIN
    PRINT '=== 2. Loans after the correction ===';
    SELECT l.id AS loanId, l.loanAmount, l.taxDeducted, l.netDisbursedAmount
    FROM #tax t JOIN Loan l ON l.id = t.loanId
    WHERE t.skipReason IS NULL;

    PRINT '=== 3. Summary ===';
    SELECT CASE WHEN @Commit = 1 THEN 'APPLIED' ELSE 'DRY RUN - nothing saved' END AS mode,
           @loansFixed AS loansFixed,
           @taxUnwound AS taxUnwound,
           (SELECT COUNT(*) FROM #tax WHERE skipReason IS NOT NULL) AS loansSkipped;
END

DECLARE @report NVARCHAR(MAX) = (
    SELECT
        CASE WHEN @Commit = 1 THEN 'APPLIED' ELSE 'DRY RUN - nothing saved' END AS mode,
        JSON_QUERY(COALESCE((
            SELECT loanId, borrowerId, loanAmount, taxDeducted, netDisbursedAmount, paidAmount,
                   providerName, COALESCE(skipReason, 'FIX') AS action
            FROM #tax
            ORDER BY CASE WHEN skipReason IS NULL THEN 0 ELSE 1 END, loanId
            FOR JSON PATH, INCLUDE_NULL_VALUES), '[]')) AS loans,
        JSON_QUERY((
            SELECT @loansFixed AS loansFixed,
                   @taxUnwound AS taxUnwound,
                   (SELECT COUNT(*) FROM #tax WHERE skipReason IS NOT NULL) AS loansSkipped,
                   (SELECT SUM(balance) FROM LedgerAccount WHERE id IN (SELECT taxReceivedId FROM #tax)) AS taxReceivedBalanceAfter,
                   (SELECT SUM(initialBalance) FROM LoanProvider WHERE id IN (SELECT providerId FROM #tax)) AS providerFundAfter
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
