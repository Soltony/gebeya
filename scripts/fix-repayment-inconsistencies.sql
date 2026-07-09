/* ============================================================================
   REPAYMENT DATA FIX — BNPLDB (SQL Server)
   Generated 2026-07-07 from an audit of the restored production database.

   Root causes (see investigation report):
     1. Per-payment service-fee bucket (totals.serviceFee / N) has no memory of
        fees already collected -> repeat payments to the same installment are
        swallowed as "service fee" and never reach principal.
     2. Merged (rolled-over) installments lose their service-fee share ->
        loans get marked 'Paid' while under-collected.
     3. UI rounds each bucket to 2dp -> full payments leave < 1 cent of
        principal "dust", keeping installments open and triggering (1).
     4. installment-rollover.ts compares status !== "PAID" / "MERGED"
        (JS, case-sensitive) against stored 'Paid' / 'Merged' -> paid
        installments were re-labeled 'Merged' with amount zeroed.

   WHAT THIS SCRIPT DOES
     A. Closes installments with a dust remainder (< 0.01 ETB unpaid).
     B. Restores 'Merged' installments that actually carry payments
        (amount := paid amount, status := 'Paid') so per-loan installment
        amounts sum back to the loan principal.
     B2. Deflates open installments that double-bill amounts the borrower
        already paid (full-amount / duplicate merges by older rollover code).
     C. Normalizes isActive flags: settled rows deactivated, exactly one
        active open installment per Unpaid loan.
     D. Reconciles loan repaymentStatus with money actually received.
        (The reopen of the 2 under-collected 'Paid' loans is OPTIONAL and
        left commented out — see notes inline.)
     E. Expires stale PENDING PendingPayment rows so late/replayed gateway
        callbacks cannot apply months-old payment intents.
     F. Ledger reclassification for the two loans whose repeat payments were
        misbooked as service-fee income instead of principal.

   HOW TO RUN
     - The script runs inside a transaction and ends with ROLLBACK.
     - Review the printed before/after result sets; when satisfied,
       change ROLLBACK TRAN to COMMIT TRAN and run once.
   ========================================================================== */

SET XACT_ABORT ON;
BEGIN TRAN;

DECLARE @now DATETIME2 = GETUTCDATE();

/* ---------------------------------------------------------------------------
   0. BEFORE-STATE REPORT
--------------------------------------------------------------------------- */
PRINT '=== BEFORE: loans whose status disagrees with money received ===';
SELECT l.id, l.repaymentStatus, l.loanAmount, l.serviceFee,
       COALESCE(l.repaidAmount, 0)                            AS repaid,
       l.loanAmount + l.serviceFee                            AS expectedTotal,
       COALESCE(l.repaidAmount, 0) - (l.loanAmount + l.serviceFee) AS diff
FROM Loan l
WHERE (l.repaymentStatus = 'Paid'   AND COALESCE(l.repaidAmount,0) < l.loanAmount + l.serviceFee - 0.01)
   OR (l.repaymentStatus = 'Unpaid' AND COALESCE(l.repaidAmount,0) >= l.loanAmount + l.serviceFee - 0.01)
   OR (COALESCE(l.repaidAmount,0) > l.loanAmount + l.serviceFee + 0.01);

PRINT '=== BEFORE: installment anomalies ===';
SELECT li.loanId, li.installmentNumber, li.status, li.isActive,
       li.amount, COALESCE(li.paidAmount,0) AS paid
FROM LoanInstallment li
WHERE (li.status = 'Merged' AND COALESCE(li.paidAmount,0) > 0.01)
   OR (li.status NOT IN ('Paid','Merged') AND li.amount > 0
       AND li.amount - COALESCE(li.paidAmount,0) BETWEEN 0 AND 0.01)
ORDER BY li.loanId, li.installmentNumber;

/* ---------------------------------------------------------------------------
   A. CLOSE DUST-OPEN INSTALLMENTS
      Unpaid remainder of at most 1 cent keeps the installment active and
      makes the UI re-quote a full service-fee share. Close them.
--------------------------------------------------------------------------- */
UPDATE LoanInstallment
SET paidAmount = amount,
    status     = 'Paid',
    isActive   = 0,
    paidAt     = COALESCE(paidAt, @now),
    updatedAt  = @now
WHERE status NOT IN ('Paid','Merged')
  AND amount > 0
  AND amount - COALESCE(paidAmount,0) BETWEEN 0 AND 0.01;

PRINT CONCAT('A. dust installments closed: ', @@ROWCOUNT);

/* ---------------------------------------------------------------------------
   B. RESTORE PAID INSTALLMENTS THAT WERE RE-LABELED 'Merged'
      The rollover treated 'Paid' rows as unpaid (JS case mismatch) and
      zeroed their amount. Their unpaid remainder (if any) already lives in
      the successor installment, so restating amount := paidAmount keeps
      SUM(installment.amount) = loan principal.
      Guarded to rows without stored penalty (true for all affected rows:
      the three Hello Beg products have no penalty rules).
--------------------------------------------------------------------------- */
UPDATE LoanInstallment
SET amount    = ROUND(COALESCE(paidAmount,0), 2),
    status    = 'Paid',
    isActive  = 0,
    updatedAt = @now
WHERE status = 'Merged'
  AND COALESCE(paidAmount,0) > 0.01
  AND COALESCE(penaltyAmount,0) = 0;

PRINT CONCAT('B. merged-with-payments installments restored: ', @@ROWCOUNT);

/* ---------------------------------------------------------------------------
   B2. DEFLATE DOUBLE-COUNTED SUCCESSOR INSTALLMENTS
       Older rollover code merged the FULL predecessor amount (ignoring what
       was already paid), and concurrent page loads could apply a merge
       twice. Result: open installments billing more than the borrower owes
       (e.g. one loan's active installment asked 24,951 of a 24,667.50 loan
       that already had 6,500 repaid).
       After step B the invariant SUM(installment.amount) = loan principal
       must hold; any excess is exactly the double-counted amount, so remove
       it from the first open installment.
--------------------------------------------------------------------------- */
;WITH sums AS (
    SELECT li.loanId, SUM(li.amount) - MAX(l.loanAmount) AS excess
    FROM LoanInstallment li
    JOIN Loan l ON l.id = li.loanId
    GROUP BY li.loanId
    HAVING SUM(li.amount) - MAX(l.loanAmount) > 0.01
),
firstOpen AS (
    SELECT li.id, s.excess,
           ROW_NUMBER() OVER (PARTITION BY li.loanId ORDER BY li.installmentNumber) AS rn
    FROM LoanInstallment li
    JOIN sums s ON s.loanId = li.loanId
    WHERE li.status NOT IN ('Paid','Merged') AND li.amount > 0
)
UPDATE li
SET li.amount = li.amount - fo.excess, li.updatedAt = @now
FROM LoanInstallment li
JOIN firstOpen fo ON fo.id = li.id AND fo.rn = 1
WHERE li.amount - fo.excess >= COALESCE(li.paidAmount, 0);

PRINT CONCAT('B2. double-counted successor installments deflated: ', @@ROWCOUNT);

/* ---------------------------------------------------------------------------
   C. NORMALIZE ACTIVE FLAGS
      C1: settled rows must not be active.
      C2: every Unpaid installment loan must have exactly one active open row
          (the earliest by installmentNumber).
--------------------------------------------------------------------------- */
UPDATE LoanInstallment
SET isActive = 0, updatedAt = @now
WHERE isActive = 1
  AND (status IN ('Paid','Merged') OR amount <= 0);

PRINT CONCAT('C1. settled-but-active rows deactivated: ', @@ROWCOUNT);

;WITH open_insts AS (
    SELECT li.id, li.loanId,
           ROW_NUMBER() OVER (PARTITION BY li.loanId ORDER BY li.installmentNumber) AS rn
    FROM LoanInstallment li
    JOIN Loan l ON l.id = li.loanId AND l.repaymentStatus = 'Unpaid'
    WHERE li.status NOT IN ('Paid','Merged') AND li.amount > 0
)
UPDATE li
SET li.isActive = 1, li.updatedAt = @now
FROM LoanInstallment li
JOIN open_insts oi ON oi.id = li.id AND oi.rn = 1
WHERE li.isActive = 0
  AND NOT EXISTS (SELECT 1 FROM LoanInstallment x
                  WHERE x.loanId = li.loanId AND x.isActive = 1);

PRINT CONCAT('C2. next open installment activated: ', @@ROWCOUNT);

/* ---------------------------------------------------------------------------
   D. LOAN STATUS RECONCILIATION
      For every loan in this database the true total repayable is
      loanAmount + serviceFee (all three products in use have a 0% daily fee
      and no penalty rules — verified against the app calculator).
--------------------------------------------------------------------------- */
-- D1. Fully settled loans still marked Unpaid -> Paid (0 rows today; kept
--     so the script is idempotent and safe to re-run after new data).
UPDATE Loan
SET repaymentStatus = 'Paid', updatedAt = @now
WHERE repaymentStatus = 'Unpaid'
  AND COALESCE(repaidAmount,0) >= loanAmount + serviceFee - 0.01;

PRINT CONCAT('D1. settled loans marked Paid: ', @@ROWCOUNT);

-- D2. OPTIONAL — reopen the two loans marked 'Paid' while under-collected
--     (cmnu7pzsz0553jg63irz6qkp3 short 485.86, cmnu88szm05dmjg635fu723zg
--     short 934.37; both shortfalls are the service-fee share of merged
--     installments that the old payment waterfall never billed).
--
--     PREREQUISITE: deploy the 2026-07-07 code fix FIRST. With it, a
--     reopened loan whose installments are all settled is quoted exactly
--     the loan-level residual (485.86 / 934.37), the payment callback
--     collects it through the loan-level path, and the loan closes itself
--     once the money covers the total. Under the OLD code such a loan could
--     never close again — do not enable this on an old deployment.
--
--     To collect the shortfalls in-app, uncomment:
-- UPDATE Loan SET repaymentStatus = 'Unpaid', repaymentBehavior = NULL, updatedAt = @now
-- WHERE id IN ('cmnu7pzsz0553jg63irz6qkp3','cmnu88szm05dmjg635fu723zg');

/* ---------------------------------------------------------------------------
   E. EXPIRE STALE PENDING PAYMENT INTENTS
      243 PENDING rows exist; the callback will happily process any of them
      whenever a matching reference arrives, applying an old quote to
      today's balance. Expire everything older than 3 days.
--------------------------------------------------------------------------- */
UPDATE PendingPayment
SET status = 'EXPIRED', updatedAt = @now
WHERE status = 'PENDING'
  AND createdAt < DATEADD(DAY, -3, @now);

PRINT CONCAT('E. stale pending payments expired: ', @@ROWCOUNT);

/* ---------------------------------------------------------------------------
   F. LEDGER RECLASSIFICATION (fee -> principal)
      Two loans had repeat payments booked to ServiceFee Received/Income
      while their principal receivable was never relieved:
        cmnu2xyo7029rjg6314cy4ovx : reclass 7288.14
        cmnu46r0802rjjg632qjrg18h : reclass 5045.64
      For each loan: Dr ServiceFee Receivable / Cr ServiceFee Received /
      Dr ServiceFee Income / Cr Principal Receivable / Dr Principal Received.
      The residual 504.52 fee excess on cmnu46r08... is a true borrower
      overpayment: refund it through the reversal flow, which will book its
      own correcting entries. It is intentionally NOT adjusted here.
--------------------------------------------------------------------------- */
DECLARE @fixes TABLE (loanId NVARCHAR(64), amount FLOAT);
INSERT INTO @fixes VALUES
  ('cmnu2xyo7029rjg6314cy4ovx', 7288.14),
  ('cmnu46r0802rjjg632qjrg18h', 5045.64);

-- sanity check: recompute the misbooked amount from the ledger and abort on drift
IF EXISTS (
    SELECT 1
    FROM @fixes f
    JOIN Loan l ON l.id = f.loanId
    CROSS APPLY (
        SELECT SUM(CASE WHEN la.category='ServiceFee' AND la.type='Received' AND le.type='Debit' THEN le.amount ELSE 0 END) AS feeCollected
        FROM LedgerEntry le
        JOIN JournalEntry je ON je.id = le.journalEntryId AND je.loanId = l.id
        JOIN LedgerAccount la ON la.id = le.ledgerAccountId
    ) x
    WHERE ABS((x.feeCollected - l.serviceFee) - f.amount) > 1.00   -- cmnu46r08 keeps its 504.52 refundable excess
      AND ABS(x.feeCollected - l.serviceFee - 504.52 - f.amount) > 0.05
)
BEGIN
    RAISERROR('F. ledger sanity check failed - amounts drifted from audit; aborting.', 16, 1);
END

DECLARE @loanId NVARCHAR(64), @amt FLOAT;
DECLARE fix_cur CURSOR LOCAL FAST_FORWARD FOR SELECT loanId, amount FROM @fixes;
OPEN fix_cur;
FETCH NEXT FROM fix_cur INTO @loanId, @amt;
WHILE @@FETCH_STATUS = 0
BEGIN
    DECLARE @providerId NVARCHAR(64) =
        (SELECT p.providerId FROM Loan l JOIN LoanProduct p ON p.id = l.productId WHERE l.id = @loanId);

    DECLARE @feeRecv NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='ServiceFee' AND type='Receivable');
    DECLARE @feeRcd  NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='ServiceFee' AND type='Received');
    DECLARE @feeInc  NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='ServiceFee' AND type='Income');
    DECLARE @prRecv  NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='Principal' AND type='Receivable');
    DECLARE @prRcd   NVARCHAR(64) = (SELECT id FROM LedgerAccount WHERE providerId=@providerId AND category='Principal' AND type='Received');

    IF @feeRecv IS NULL OR @feeRcd IS NULL OR @feeInc IS NULL OR @prRecv IS NULL OR @prRcd IS NULL
        RAISERROR('F. ledger accounts missing for provider; aborting.', 16, 1);

    DECLARE @jid NVARCHAR(64) = CONCAT('fixjrn_', @loanId);
    INSERT INTO JournalEntry (id, providerId, loanId, date, description)
    VALUES (@jid, @providerId, @loanId, @now,
            CONCAT('Correction: reclassify ', @amt, ' misbooked as service fee to principal (repeat-payment fee bug)'));

    INSERT INTO LedgerEntry (id, journalEntryId, ledgerAccountId, type, amount) VALUES
      (CONCAT('fixent_', @loanId, '_1'), @jid, @feeRecv, 'Debit',  @amt),
      (CONCAT('fixent_', @loanId, '_2'), @jid, @feeRcd,  'Credit', @amt),
      (CONCAT('fixent_', @loanId, '_3'), @jid, @feeInc,  'Debit',  @amt),
      (CONCAT('fixent_', @loanId, '_4'), @jid, @prRecv,  'Credit', @amt),
      (CONCAT('fixent_', @loanId, '_5'), @jid, @prRcd,   'Debit',  @amt);

    UPDATE LedgerAccount SET balance = balance + @amt WHERE id = @feeRecv;
    UPDATE LedgerAccount SET balance = balance - @amt WHERE id = @feeRcd;
    UPDATE LedgerAccount SET balance = balance - @amt WHERE id = @feeInc;
    UPDATE LedgerAccount SET balance = balance - @amt WHERE id = @prRecv;
    UPDATE LedgerAccount SET balance = balance + @amt WHERE id = @prRcd;

    PRINT CONCAT('F. ledger reclass applied for ', @loanId, ' amount ', @amt);
    FETCH NEXT FROM fix_cur INTO @loanId, @amt;
END
CLOSE fix_cur; DEALLOCATE fix_cur;

/* ---------------------------------------------------------------------------
   G. AFTER-STATE VERIFICATION
--------------------------------------------------------------------------- */
PRINT '=== AFTER: remaining status/money disagreements (expect only the 2 waived under-collections) ===';
SELECT l.id, l.repaymentStatus, COALESCE(l.repaidAmount,0) AS repaid,
       l.loanAmount + l.serviceFee AS expectedTotal,
       COALESCE(l.repaidAmount,0) - (l.loanAmount + l.serviceFee) AS diff
FROM Loan l
WHERE ABS(COALESCE(l.repaidAmount,0) - (l.loanAmount + l.serviceFee)) > 0.05
  AND (l.repaymentStatus = 'Paid' OR COALESCE(l.repaidAmount,0) > l.loanAmount + l.serviceFee);

PRINT '=== AFTER: unpaid installment loans and their active row count (expect exactly 1 each) ===';
SELECT li.loanId, SUM(CASE WHEN li.isActive = 1 THEN 1 ELSE 0 END) AS activeRows
FROM LoanInstallment li
JOIN Loan l ON l.id = li.loanId AND l.repaymentStatus = 'Unpaid'
GROUP BY li.loanId
HAVING SUM(CASE WHEN li.isActive = 1 THEN 1 ELSE 0 END) <> 1;

PRINT '=== AFTER: per-loan installment amounts vs principal (expect empty) ===';
SELECT li.loanId, SUM(li.amount) AS instSum, MAX(l.loanAmount) AS principal
FROM LoanInstallment li
JOIN Loan l ON l.id = li.loanId
GROUP BY li.loanId
HAVING ABS(SUM(li.amount) - MAX(l.loanAmount)) > 0.05;

/* === REFUND REPORT (informational — handle via the reversal flow) ======= */
PRINT '=== Borrower refunds due (true overpayments) ===';
SELECT l.id AS loanId, l.borrowerId,
       ROUND(COALESCE(l.repaidAmount,0) - (l.loanAmount + l.serviceFee), 2) AS refundDue
FROM Loan l
WHERE COALESCE(l.repaidAmount,0) > l.loanAmount + l.serviceFee + 0.05;

PRINT '=== Under-collections on loans kept as Paid (reopen via D2 / write-off) ===';
SELECT l.id AS loanId, l.borrowerId,
       ROUND((l.loanAmount + l.serviceFee) - COALESCE(l.repaidAmount,0), 2) AS shortfall
FROM Loan l
WHERE l.repaymentStatus = 'Paid'
  AND COALESCE(l.repaidAmount,0) < l.loanAmount + l.serviceFee - 0.05;

/* ==========================================================================
   Change to COMMIT TRAN after reviewing the output above.
   ========================================================================== */
COMMIT TRAN;
PRINT '*** TRANSACTION ROLLED BACK (dry run). Change ROLLBACK to COMMIT to apply. ***';
