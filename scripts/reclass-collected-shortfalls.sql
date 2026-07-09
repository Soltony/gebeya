/* ============================================================================
   OPTIONAL LEDGER RECLASS — run ONCE, only AFTER the two reopened loans
   (cmnu7pzsz0553jg63irz6qkp3, cmnu88szm05dmjg635fu723zg) have paid their
   shortfall in the app and are 'Paid' again.

   Why: the loan-level payment waterfall derives already-paid buckets by
   priority (penalty -> fee -> interest -> tax -> principal), so the residual
   collection books as PRINCIPAL. In reality principal was already fully
   collected on these loans and the outstanding receivable was the SERVICE
   FEE share of their merged installments. This entry moves the collected
   amount from Principal to ServiceFee and recognizes the fee income.

   Runs inside a transaction and ends in ROLLBACK — review the output, then
   change ROLLBACK to COMMIT.
   ========================================================================== */
SET XACT_ABORT ON;
BEGIN TRAN;

DECLARE @now DATETIME2 = GETUTCDATE();
DECLARE @fixes TABLE (loanId NVARCHAR(64), amount FLOAT);
INSERT INTO @fixes VALUES
  ('cmnu7pzsz0553jg63irz6qkp3', 485.86),
  ('cmnu88szm05dmjg635fu723zg', 934.37);

-- Guard: only proceed for loans that are Paid again with the money received.
DELETE f FROM @fixes f
WHERE NOT EXISTS (
    SELECT 1 FROM Loan l
    WHERE l.id = f.loanId
      AND l.repaymentStatus = 'Paid'
      AND COALESCE(l.repaidAmount,0) >= l.loanAmount + l.serviceFee - 0.10
);
IF NOT EXISTS (SELECT 1 FROM @fixes)
BEGIN
    PRINT 'Nothing to reclass: loans are not yet collected/Paid. No changes made.';
END

DECLARE @loanId NVARCHAR(64), @amt FLOAT;
DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT loanId, amount FROM @fixes;
OPEN c; FETCH NEXT FROM c INTO @loanId, @amt;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF EXISTS (SELECT 1 FROM JournalEntry WHERE id = CONCAT('reclsjrn_', @loanId))
    BEGIN
        PRINT CONCAT('Already reclassed: ', @loanId, ' — skipping.');
        FETCH NEXT FROM c INTO @loanId, @amt; CONTINUE;
    END

    DECLARE @providerId NVARCHAR(64) =
        (SELECT p.providerId FROM Loan l JOIN LoanProduct p ON p.id = l.productId WHERE l.id = @loanId);
    DECLARE @prRecv NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='Principal'  AND type='Receivable');
    DECLARE @prRcd  NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='Principal'  AND type='Received');
    DECLARE @feRecv NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='ServiceFee' AND type='Receivable');
    DECLARE @feRcd  NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='ServiceFee' AND type='Received');
    DECLARE @feInc  NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='ServiceFee' AND type='Income');
    IF @prRecv IS NULL OR @prRcd IS NULL OR @feRecv IS NULL OR @feRcd IS NULL OR @feInc IS NULL
        RAISERROR('Ledger accounts missing; aborting.', 16, 1);

    DECLARE @jid NVARCHAR(64) = CONCAT('reclsjrn_', @loanId);
    INSERT INTO JournalEntry (id, providerId, loanId, date, description)
    VALUES (@jid, @providerId, @loanId, @now,
            CONCAT('Correction: reclassify shortfall collection of ', @amt, ' from principal to service fee'));

    INSERT INTO LedgerEntry (id, journalEntryId, ledgerAccountId, type, amount) VALUES
      (CONCAT('reclsent_', @loanId, '_1'), @jid, @prRecv, 'Debit',  @amt),
      (CONCAT('reclsent_', @loanId, '_2'), @jid, @prRcd,  'Credit', @amt),
      (CONCAT('reclsent_', @loanId, '_3'), @jid, @feRecv, 'Credit', @amt),
      (CONCAT('reclsent_', @loanId, '_4'), @jid, @feRcd,  'Debit',  @amt),
      (CONCAT('reclsent_', @loanId, '_5'), @jid, @feInc,  'Credit', @amt);

    UPDATE LedgerAccount SET balance = balance + @amt WHERE id = @prRecv;
    UPDATE LedgerAccount SET balance = balance - @amt WHERE id = @prRcd;
    UPDATE LedgerAccount SET balance = balance - @amt WHERE id = @feRecv;
    UPDATE LedgerAccount SET balance = balance + @amt WHERE id = @feRcd;
    UPDATE LedgerAccount SET balance = balance + @amt WHERE id = @feInc;

    PRINT CONCAT('Reclassed ', @amt, ' fee<-principal for loan ', @loanId);
    FETCH NEXT FROM c INTO @loanId, @amt;
END
CLOSE c; DEALLOCATE c;

ROLLBACK TRAN;
PRINT '*** ROLLED BACK (dry run). Change ROLLBACK to COMMIT to apply. ***';
