# Affiliate Program: User Manual

This manual has two parts:

- **Part 1 – Using the affiliate program** is for admins who create programs, manage affiliates and pay commissions.
- **Part 2 – Testing on dev** is for developers and testers. It shows how to test the mini-app side and the full flow on a local machine without moving real money.

---

## How it works in one picture

```
Program ──► Affiliate gets a code ──► Customer enters the code in the mini-app
            (added by an admin, or a          │
             customer taps "Get my code"      │
             on the Earn page)                │
                                              ▼
              Customer takes a loan / BNPL order / direct order
                                              │
                         (daily job)          ▼
                Commission recorded ──► On hold ──► Ready to pay
                                                         │
                                                         ▼
              Payout batch ──► Approval ──► Money sent through CBS ──► Paid
```

| Word | Meaning |
|---|---|
| **Program** | A set of settings and commission rules, for example "Agent Network" or "Refer a Friend". |
| **Version** | Every approved change to a program creates a new version. Old versions are never changed. |
| **Affiliate** | A person who brings customers: agent, borrower, merchant, partner/influencer or staff. Each affiliate has a unique **code**. Admins add affiliates; customers can also get their own code on the mini-app's **Earn** page. |
| **Referral** | The link between one customer and the affiliate whose code they entered. A customer can be referred only once. |
| **Commission** | A reward earned by an affiliate (or a welcome bonus for the new customer) when a rule matches an event. Rules always work it out in Birr. |
| **Points** | In a program that pays rewards as points, the Birr reward is turned into points and added to the person's **points wallet** instead of being paid out. See [section 8](#8-points). |
| **Payout batch** | A group of payouts, one bank transfer per person, approved together. |

---

# Part 1 – Using the affiliate program

## 1. One-time setup

### 1.1 Give people access

Go to **Access Control → Roles**, click **⋯** next to a role, then **Edit**, and tick the boxes in the **Affiliates** row:

| Permission | Allows |
|---|---|
| **R** (read) | See the Affiliates page and all its tabs. |
| **C** (create) | Submit new programs and new affiliates. |
| **U** (update) | Edit programs and affiliates, pause programs, suspend affiliates, reject referrals, prepare and submit payouts, retry or release failed payouts. |

The **checker** who approves requests needs **Update** on **Approvals**, the same as for other approvals. The maker and the checker must be **different people**: the system does not let anyone approve their own request.

### 1.2 Start the background job

Commissions are recorded by a background job, not at the moment a loan is taken. Start it next to the app:

```bash
npm run run:worker -- affiliate-service
```

It runs every 24 hours by default. To run it more often, set `AFFILIATE_JOB_INTERVAL_MINUTES` (for example `60`).

You can also run each part once by hand:

| Command | What it does |
|---|---|
| `npm run run:worker -- affiliate-commissions` | Records new commissions, takes back reversed/NPL ones, releases held ones, prepares scheduled payout drafts. |
| `npm run run:worker -- affiliate-payouts` | Sends approved payouts that were not sent yet (for example because disbursements were switched off). |

### 1.3 Optional settings (`.env`)

| Setting | Default | Use |
|---|---|---|
| `AFFILIATE_PAYOUT_URL` | `EXTERNAL_DISBURSEMENT_URL` | Send affiliate payouts to a different CBS endpoint. |
| `AFFILIATE_PAYOUT_PROVIDER_ID` | `FORCE_PROVIDER_ID`, then `PRO0002` | The CBS provider (pool account) the payouts are paid from. |
| `AFFILIATE_JOB_INTERVAL_MINUTES` | `1440` | How often `affiliate-service` runs. |
| `AFFILIATE_PAYOUT_SMS` | off | Set to `true` to text people when a payout or withdrawal reaches their account. It uses `SMS_URL`, the bank's real SMS gateway, so leave it off on dev. |

## 2. Create a program

1. Open **Affiliates → Programs** and click **New program**.
2. Under **Start from**, choose a template: **Agent Network**, **Refer a Friend**, **Shop Promoters** or **Blank program**. The amounts in templates are only examples.
3. Go through the four tabs (explained below).
4. Click **Submit for approval**. If the button is grey, the red box at the bottom says what to fix.
5. A checker opens **Approvals**, finds the **AffiliateProgram** request and approves it. The plain-language summary on the approval screen describes every rule.

The program works only after approval.

### Tab "Basics & referrals"

| Setting | Meaning |
|---|---|
| **Program name / Description** | Shown to admins only. |
| **Who can join** | Which affiliate types can be added to this program. |
| **Pay rewards as** | **Money** (paid out in Birr through payouts and withdrawals) or **Points** (added to the person's points wallet). New programs start with Points; programs created before points existed stay on Money. |
| **Points per 1 ETB of reward** | Points programs only: the earning rate. A 50 ETB reward at 10 points per ETB gives 500 points. It applies to rewards recorded after approval; points already given never change. The builder shows what the example reward is worth at today's point value. |
| **Customers can get their own code in the mini-app** | Customers get a code on the **Earn** page by themselves, with **no approval for each one**: the sign-up rules below are approved once, with the program. Needs **Borrower** under "Who can join". Only **one** program can have this on (paused programs count too). See [section 5.2](#52-the-earn-page). |
| **Fully repaid loans needed** | How many loans a customer must have fully repaid before they can get a code. Default 1; 0 lets any customer join. |
| **Not while a payment is overdue** | Customers with an overdue loan or installment can't get a code until they pay. Customers flagged **NPL** can never get one. |
| **Let customers change their code once** | The customer may replace the generated code once: 4–12 letters or digits with at least one letter. Words like NIB, BANK or ADMIN are blocked. The old code stops working. |
| **Accept referral codes in the mini-app** | Turn off to stop new referrals, while existing referrals keep earning. |
| **New customers only** | If on, a customer who already had a loan or an order cannot use a code. |
| **Referral valid for (days)** | Loans and orders started more than this many days after the code was entered don't earn. Empty = no limit. |
| **Max new referrals per affiliate per day** | Slows down fake sign-ups. Empty = no limit. |

### Tab "Commission rules"

A program has one or more rules. Each rule pays **one person**. To reward both the affiliate and the new customer, use two rules (the Refer a Friend template shows this).

| Field | Options |
|---|---|
| **When** | Loan disbursed · Loan fully repaid · BNPL order delivered · Direct-payment order paid |
| **Pay** | Affiliate · New customer (welcome bonus) |
| **Paid by** | Platform · Loan provider (see [section 10](#10-accounting)) |
| **Amount type** | Fixed amount, or Percentage of: loan amount · service fee · fees actually collected · order total. A percentage rule can have a min and max per commission. |
| **How often** (per referred customer) | First time only · First N times · Every time |
| **Only count when…** | Optional filters: loan provider, loan product, loan type (personal/BNPL), merchant, item category, repaid early/on time/late, minimum loan amount or order total. Empty = all. |

Notes:

- **"First time only"** means the first event that matches **this rule's filters**. For example, "first loan repaid on time" pays for the first on-time repayment, even if an earlier loan was repaid late.
- **"Fees actually collected"** is the interest, service fee and penalty really paid on the loan, read from the ledger. If nothing was collected, the rule pays nothing.
- **A BNPL purchase creates two events**: "BNPL order delivered" and "Loan disbursed" (for a BNPL loan). Use the **Loan type** filter if a loan rule should only count personal loans.
- Each rule shows a sentence under it, for example: *"When a referred customer's loan is fully repaid (on time), pay the affiliate 150 ETB, first time only. Paid by the platform."*

### Tab "Limits & payouts"

| Setting | Meaning |
|---|---|
| **Hold period (days)** | A new commission waits this long before it can be paid, so reversals can be caught first. |
| **Take back when the customer becomes NPL** | If on, commissions earned in the last N days are taken back when the referred customer becomes NPL. Reversed loans are **always** taken back. |
| **Max per referred customer** | The most one affiliate can earn from one customer. |
| **Max per affiliate per month** | Counted by the month the event happened. |
| **Program budget** | Total of all commissions in the program, including welcome bonuses. |
| **Prepare payouts** | Weekly or Monthly creates a **draft** batch automatically. Manual only means someone clicks "Prepare payouts now". |
| **Minimum payout** | Smaller balances wait for a later batch. |
| **Withholding tax (%)** | Deducted from each payout and each withdrawal; the net amount is sent. |
| **People can withdraw their earnings in the mini-app** | Affiliates and customers withdraw their available earnings on the **Earn** page themselves, always to their own account. Payout batches keep working alongside. See [section 9](#9-payouts). |
| **Minimum withdrawal** | The smallest amount one withdrawal can send. |
| **Max per day / Max per month** | How much one person can withdraw. Empty = no limit. Earnings can't be split, so one bigger than the room left waits. |
| **Send automatically up to** | Withdrawals up to this net amount are sent at once. Larger ones wait for a checker in **Affiliates → Payouts**. 0 = a checker approves every withdrawal. |

When a cap is reached, the commission is **lowered** to fit. If nothing fits, no commission is recorded.

### Tab "Preview"

Enter a sample event, for example "Loan fully repaid, 5,000 ETB, on time", and see exactly what each rule would pay, which rules don't match and why, and when the money would be ready. The preview uses the same rules engine as the real job, so use it before you submit.

## 3. Change, pause or resume a program

- **Edit:** opens the same builder. Saving sends a request for approval. When approved, it becomes a **new version**.
  - Customers who were referred earlier **keep the version they joined under** for the rules, the "valid for" days, the per-customer cap, the hold period and the take-back settings. Money already earned never changes.
  - The **monthly cap, program budget and payout settings** always follow the latest version.
- **Pause:** takes effect **immediately**, with no approval needed. No new referrals are accepted. Loans and orders that happen while the program is paused **never** earn, not even after resuming. Commissions earned before the pause are still paid.
- **Resume:** needs approval, because it starts spending again.

While a change is waiting for approval, the program shows **Waiting for approval** and **Edit** is grey.

## 4. Manage affiliates

### Add an affiliate

1. **Affiliates → Affiliates → Add affiliate.**
2. Fill in:
   - full name and phone (for example `0911223344`);
   - the program, and a type allowed by that program;
   - optionally an email and your own code (4–16 letters/digits, for example `ABEBE10`). Otherwise a code is generated.
   - **Payout account:** required for every type except **Borrower**. Borrowers are paid into the active account linked to their phone.
3. **Submit for approval.** After a checker approves, the affiliate appears in the list with their code. Click the code to copy it.
4. Give the code to the affiliate to share with customers.

### Other actions

| Action | How it works |
|---|---|
| **Edit** (pencil) | Changes go through approval, including the payout account. |
| **Suspend** (shield) | **Immediate.** Needs a reason. The code stops working, no new commissions are recorded and their payouts are held. |
| **Reactivate** | Needs approval. Commissions for loans and orders that happened during the suspension are caught up on the next job run. |

Customers who got their own code show **joined in the mini-app** under their name. They are **Borrower** affiliates of the program with customer sign-up on. Edit, suspend or reactivate them like any other affiliate.

## 5. The mini-app: code box and Earn page

### 5.1 Entering a code

On the **Shop** page and on the loan dashboard, a customer who can still use a code sees **"Have a referral code?"**. They tap it, type the code and press **Apply**. When it works, they see *"Referral code applied. You were invited by …"*.

The box is hidden when:

- no active program accepts codes;
- the customer was already referred;
- every program is "new customers only" and the customer already has a loan or an order;
- the customer closed it with **X** (it comes back on the next visit).

Messages the customer can see:

| Message | Reason |
|---|---|
| This code is not valid. Please check it and try again. | Wrong code, or the affiliate is suspended. |
| You have already used a referral code. | One code per customer; it can't be changed. |
| This code is not accepting new customers right now. | The program is paused or not accepting codes. |
| You can't use your own referral code. | The customer is the affiliate (same phone or a linked phone), or the affiliate's payout account belongs to the customer. |
| This code is only for new customers. | The program is "new customers only" and the customer already had a loan or order. |
| This code has reached its limit for today… | The affiliate reached "max new referrals per day". |
| Too many attempts. Please wait a minute… | 5 failed tries within 15 minutes. |

### 5.2 The Earn page

Customers and agents open **Earn** from the shop header (next to **Orders**) or the loan dashboard (next to **Shop BNPL**). The link shows only when the person is an affiliate, has rewards, or can get a code because a program has customer sign-up on. A red dot means money is available.

People are recognised by their phone number, as everywhere else in the mini-app. Agents open the same page with their own phone and need no other login.

| Part | Shown to | Content |
|---|---|---|
| **Get my code** | Customers who aren't affiliates yet, when a program has customer sign-up on | The offer, and either the **Get my code** button or what is still missing, for example *Fully repay your first loan to get your code.* |
| **Your code** | Affiliates | The code with **Copy** and **Share**. Share opens the phone's share menu; when the app can't share, it copies a ready-made message instead. Customers who joined by themselves also see **Change code**, once. |
| **Your points** | People in a points program, or who have points | The points balance with its value in Birr (*≈ 245 ETB*), points **on hold** with the next release date, and a note that ways to use points are coming soon. In a points program, rewards, caps and history are all shown in points. |
| **Balance** | People with money rewards | **Available** (negative while a take-back is being recovered), **On hold** (with the next release date), **Paid to you**, and when payouts happen. Hidden in a points program unless money was earned before switching. |
| **Withdraw** | Everyone whose program allows withdrawals | **Withdraw [amount]** sends all available earnings (within the limits) to their own account. A confirmation shows the earnings, tax, the amount they receive and the account (last 4 digits). When nothing can be withdrawn, the button is grey with the reason. |
| **This month** | Affiliates | Earned this month (with the monthly cap, if there is one) and how many friends joined. |
| **Friends** | Affiliates | Each invited customer by the **last 4 digits** of their phone, with their progress (Joined, Ordered, Has a loan, Repaid, or Not counted for a rejected referral) and what the affiliate earned from them. Latest 200, searchable by digits. |
| **Earnings** | Everyone with commissions | Latest 50 commissions: on hold until a date, available, being paid, paid, cancelled, or taken back with a plain reason. Admins' rejection notes are never shown. |
| **Payments** | Everyone who was paid or withdrew | Payouts and withdrawals: processing, being checked (waiting for a checker), paid, delayed (a failed transfer the bank is checking), declined, or not sent (released after a failure). Declined and not-sent money is back in the balance. |
| **How it works** | Affiliates, and customers who can sign up | The program's rules in plain words. |

Getting a code **never needs approval**: the program's sign-up settings were approved with the program. The customer becomes a **Borrower** affiliate of that program, named as on their bank account, and is paid into the account linked to their phone. Friends who enter the code see only the first name and initial, for example *Abebe K.*

Earnings come from the background job, so new ones show after its next run.

Messages on the Earn page:

| Message | Reason |
|---|---|
| Fully repay your first loan to get your code. *(or "Fully repay N loans…")* | Fewer fully repaid loans than the program needs. |
| You have an overdue payment. Pay it to get your code. | "Not while a payment is overdue" is on, and a loan or installment is past its due date. |
| One of your loans is long overdue. Repay it to get your code. | The customer is flagged NPL. |
| Invites are paused right now. Please check again later. | The sign-up program is paused or not accepting codes. |
| This code is reserved. Please choose another one. | The new code contains a blocked word such as NIB, BANK or ADMIN. |
| That code is taken. Please try another one. | Another affiliate already has it. |
| You have already changed your code once. | Only one change is allowed. |
| Your code was set by the bank and can't be changed here. | Agents and other affiliates added by an admin. |
| Too many attempts. Please wait a minute… | Too many failed code changes. |
| You can withdraw from 50 ETB. | Available earnings are below the program's minimum withdrawal. |
| You can't withdraw more today. Please try again tomorrow. *(or "…this month")* | The daily or monthly limit has no room left for the next earning. |
| One of your earnings is above the withdrawal limit, so it is paid to you in a regular payout. | A single earning is bigger than the daily or monthly maximum. |
| Your last withdrawal is still being processed. | One withdrawal at a time: the last one is being sent, waiting for a checker, or failed and being checked. |
| A take-back is being recovered from your next earnings. | Take-backs are bigger than the available earnings. |
| We couldn't find an account linked to your phone. Please contact the bank. | No active account is linked to the customer's phone. |
| Your earnings are on hold while the bank reviews your account. | The affiliate is suspended. |

## 6. Referrals

**Affiliates → Referrals** lists every referred customer, their affiliate, program version, date and earned commissions.

**Reject** a referral when it is fraud or a mistake. This is **immediate** and **cannot be undone**:

- every commission of that customer is taken back;
- unpaid ones are cancelled;
- paid ones are deducted from the affiliate's next payout.

## 7. Commissions

**Affiliates → Commissions** shows every commission, with totals per status:

| Status | Meaning |
|---|---|
| **On hold** | Waiting for the hold period; "Ready from" shows the date. |
| **Ready to pay** | Will go into the next payout batch. |
| **In a payout** | Part of a batch that is not paid yet. |
| **Paid** | Money sent. |
| **Reversed** | Cancelled before payment (loan reversed, customer NPL, referral rejected). |

A **negative amount marked "taken back"** is a commission taken back after it was paid. It is deducted from the next payout.

The job records a commission only when **all** of these are true:

- the event happened after the code was entered (for BNPL, the order was placed after the code was entered);
- the event falls within "valid for" days;
- the program was not paused when the event happened;
- the affiliate is active;
- the customer is not NPL (when NPL take-back is on);
- the rule's filters match, the "how often" limit allows it, and a cap still has room.

## 8. Points

A program set to **Pay rewards as: Points** gives points instead of money. Nothing else about the program changes: the rules, caps, budget, hold and take-backs still work in Birr, and only the reward is turned into points.

**How points are earned**

1. The job records the reward as usual and keeps its points with it: Birr × the program's **points per 1 ETB**, at the rate in force at that moment.
2. When the hold period ends, the commission becomes **Added as points** and the points are added to the person's wallet: the affiliate's, or the new customer's for a welcome bonus.
3. A take-back before that cancels the reward. A take-back after it removes the points straight away. If the person's balance drops below zero, their next points fill the gap.

Switching a program between Money and Points only affects rewards recorded after the change is approved. Money already earned is still paid as money.

**Affiliates → Points**

| Part | What it does |
|---|---|
| **Totals** | Points outstanding (with their value in Birr), and points earned, taken back and adjusted this month. |
| **Points settings** | **Value of 1 point (ETB)**, one value for every program, so a point is worth the same whichever program gave it. It is shown to people next to their balance and used to value points in reports. **Change** sends it for approval; only one change can wait at a time. |
| **Adjustments** | **Adjust points** adds or removes points for one person (by phone), with a reason. A checker approves it on the **Approvals** page (**AffiliatePointAdjustment**). Points can't be removed below a balance of zero. |
| **History** | Every change to anyone's points, newest first, with a `PTS-…` reference: Earned, Taken back or Adjusted. Search by phone (shows that person's balance), affiliate code or reference, and filter by type. Rows are never edited. |

**Not yet:** using points (shop, loan repayment, cash) comes in a later step, after review. Until then the Earn page tells people their points are kept, and no money moves. Points aren't booked on provider ledgers either; finance decides how points are accounted for before they can be used.

## 9. Payouts

1. **Prepare.** Choose the program and click **Prepare payouts now**, or wait for the weekly/monthly draft. The system groups all "Ready to pay" commissions into one transfer per person.
   - It **skips** people with no payout account, people below the minimum, and suspended affiliates. The toast says how many were skipped; their commissions wait for a later batch.
2. **Check the draft.** Open the batch to see each person, account, gross, tax and net. **Cancel draft** puts the commissions back.
3. **Submit for approval.**
4. **Approve.** A checker approves the **AffiliatePayoutBatch** on the Approvals page. The transfers are **sent right away** through CBS.
5. **Results:**
   - **Completed:** all transfers succeeded.
   - **Partial:** some failed. A failed transfer is **never retried automatically**, because the bank may have paid it even if we got an error. First **check with the bank**, then:
     - **Retry:** send it again (only if the bank did not pay it);
     - **Release:** give up on this transfer; its commissions go into the next batch.

If **Disbursement Control** is switched off, approved payouts wait as **Approved**. They are sent when it is switched back on: by the background job, or right away with `npm run run:worker -- affiliate-payouts`.

### Withdrawals

When a program allows withdrawals, people withdraw their available earnings themselves on the mini-app's **Earn** page. Each withdrawal shows in **Affiliates → Payouts** as **Withdrawal · [name]**. Use the filter to see only withdrawals or only payout batches.

- The money always goes to the person's **own** account: customers to the account linked to their phone, other affiliates to their registered payout account. Nobody can type an account number.
- One withdrawal takes **all** available earnings within the daily and monthly limits. Take-backs are always deducted first. The withholding tax applies.
- Up to **Send automatically up to**, it is sent at once. Larger ones show **Waiting for approval**, and the blue box at the top counts them.
- **Approve** or **Decline** needs **Update on Approvals** (the checker permission), not only access to Affiliates. Nobody can review their own withdrawal: a staff member who is an affiliate is blocked by phone number.
  - **Approve:** the money is sent right away.
  - **Decline:** asks for a reason, which goes to the audit log. Nothing is paid, the earnings become available again, and the customer sees *Declined*.
- A failed withdrawal is handled like any failed payout: check with the bank, then **Retry** or **Release**. While it is unresolved, the person can't start another withdrawal.
- A withdrawal waiting for review never blocks **Prepare payouts now**.

## 10. Accounting

- **Paid by: Loan provider.** When the commission becomes "Ready to pay", it is booked in that provider's ledger: Debit **Commission Expense**, Credit **Commission Payable**. When it is paid, Commission Payable is debited. These two accounts are created automatically the first time they are needed.
- **Paid by: Platform.** Not booked in any provider ledger. The commission and payout tables and the reports are the record.
- These commission journals are not linked to a loan, so they don't appear in loan transaction reports.

## 11. Reports

**Affiliates → Reports** shows, per program and per affiliate:

- referred customers, how many have a loan, and how many are now NPL;
- the **default rate**: NPL ÷ customers with a loan. **10% or more is shown in red.** This is the best sign of low-quality or fake referrals;
- earned, welcome bonuses, cancelled / taken back, paid, not yet paid.

Use **From / To** to filter (referrals by referral date, money by event date) and **Export to Excel** for both tables.

## 12. Troubleshooting

| Problem | What to check |
|---|---|
| "Affiliates" is not in the menu | The role needs **R** on Affiliates. Refresh the page after changing the role. |
| No **Earn** link in the mini-app | The person isn't an affiliate, has no rewards, and no active program has **Customers can get their own code** on. |
| *Customers can already get their own code in "…"* | Only one program can have customer sign-up on. Turn it off in the other program first (that edit needs approval). |
| "Submit for approval" is grey | Read the red box in the dialog; it lists each problem. |
| "You cannot approve or reject your own changes" | Another user must approve. |
| **Edit** is grey | A change for this item is already waiting for approval. |
| No commission after a loan/order | Did the job run? Then check the list in [section 7](#7-commissions). Try the case in **Preview**. |
| Commission stays "On hold" | It is waiting for the hold period; the next job run after that date releases it. |
| Person missing from a payout batch | No payout account (or no active linked account for borrowers and new customers), below the minimum, or affiliate suspended. |
| Payout stays "Approved" | Disbursement Control is off. Turn it on and run `npm run run:worker -- affiliate-payouts`. |
| Payout "Failed" | Check with the bank first, then **Retry** or **Release**. |
| No **Approve / Decline** on a withdrawal | You need **Update on Approvals**. *You can't review your own withdrawal* means your phone number is the affiliate's. |
| Customer has money but **Withdraw** is grey | The reason is shown under the balance; see the messages in [section 5.2](#52-the-earn-page). |
| No points after a reward in a points program | Did the job run? The commission stays **On hold** until the hold ends, then shows **Added as points**. Rewards recorded before the program switched to Points stay money. |
| *This would take the balance below zero* | A points adjustment can't remove more points than the person has. |

---

# Part 2 – Testing on dev

On dev you don't need the super-app: the mini-app logs you in as a test customer.

> ⚠️ Dev only. Never set `ALLOW_MINIAPP_BYPASS=true` on a server that real customers use.

## 1. Set up

### 1.1 Make all money movement fake

`EXTERNAL_DISBURSEMENT_URL` points to the bank's integration server. Loan disbursements, BNPL merchant payments and affiliate payouts all use it. While testing, use the mock bank in `scripts/mock-cbs.js` instead.

In `.env`, comment out the real line (keep it to restore later) and add:

```env
# EXTERNAL_DISBURSEMENT_URL="http://192.168.100.56:8280/..."   <- real one, restore after testing
EXTERNAL_DISBURSEMENT_URL="http://localhost:4010/transfer"
```

If you want only affiliate payouts to be fake, set `AFFILIATE_PAYOUT_URL="http://localhost:4010/payout"` instead and leave `EXTERNAL_DISBURSEMENT_URL` as it is.

### 1.2 Choose the test customer

```env
ALLOW_MINIAPP_BYPASS=true
DEV_BORROWER_ID=251901246565
```

`DEV_BORROWER_ID` is the customer you are "logged in" as in the mini-app. Use a **new customer** (no loans or orders) to test codes. These customers in the dev database have eligibility data and a linked account, but no loans yet:

- `251901246565`
- `251909773024`
- `251910157363`
- `251910342834`
- `251910344498`

`251949385646` (the old default) already has loans, so it counts as an **existing** customer.

**Restart `npm run dev` after every `.env` change.**

### 1.3 Start everything (three terminals)

```bash
node scripts/mock-cbs.js                           # 1. fake bank on http://localhost:4010
npm run dev                                        # 2. app on http://localhost:9002
npm run run:worker -- affiliate-commissions        # 3. run the job when you need it
```

- **Admin:** http://localhost:9002/admin. Use two users so you can make and approve requests: **Super Admin** (`0900000000`) as maker and **Approver** (`0900000001`) as checker. Use a normal window for one and a private window for the other.
- **Mini-app:** http://localhost:9002/loan. **Earn page:** http://localhost:9002/earn.

> **After pulling a database change** (for example the one for the Earn page): stop `npm run dev` and the worker, run `npx prisma migrate deploy` and `npx prisma generate`, then start them again. A running app keeps the old database client in memory, and on Windows `prisma generate` fails while they hold its files.

### 1.4 Give the maker access

As Super Admin: **Access Control → Roles → Super Admin → ⋯ → Edit**, then tick **C R U** for **Affiliates** and save. Optionally give the Approver **R** so they can see the page too.

## 2. Create a test program and affiliate

A program that pays immediately makes testing fast:

1. As **Super Admin**: **Affiliates → Programs → New program → Blank program**, then:
   - **Name:** `Dev test`.
   - **Who can join:** Agent.
   - **Referrals:** accept codes **on**, new customers only **on**.
   - **Rule 1:** When **Loan disbursed** → Pay **Affiliate** → Fixed **50** → **Every time**.
   - **Rule 2 (Add rule):** When **BNPL order delivered** → Pay **New customer** → Fixed **20** → **First time only**.
   - **Limits & payouts:** Hold period **0**, Prepare payouts **Manual only**, Minimum payout **0**.
   - **Preview:** choose "BNPL order delivered" and check that it says the new customer gets 20 ETB.
   - Click **Submit for approval**.
2. As **Approver**: **Approvals** → the **AffiliateProgram** request → **Approve**.
3. As **Super Admin**: **Affiliates → Affiliates → Add affiliate**:
   - name `Dev Agent`, phone `0911000001`;
   - program `Dev test`, type Agent, payout account `TEST0001`;
   - **Submit for approval**.
4. As **Approver**: approve the **Affiliate** request.
5. As **Super Admin**: copy the new code from the Affiliates list.

## 3. Test the code box

With `DEV_BORROWER_ID=251901246565`:

1. Open http://localhost:9002/loan. The shop shows **Have a referral code?**.
2. Enter `WRONG123`. Expected: *This code is not valid…*
3. Enter the real code. Expected: *Referral code applied. You were invited by Dev Agent.*
4. Reload. The box is gone. **Admin → Affiliates → Referrals** shows `251901246565`.

More cases (change `DEV_BORROWER_ID`, restart `npm run dev`, reload):

| Case | Set up | Expected |
|---|---|---|
| Existing customer | `DEV_BORROWER_ID=251949385646` | No box (program is "new customers only"). |
| Own code | `DEV_BORROWER_ID=251911000001` (the affiliate's phone) | *You can't use your own referral code.* |
| Paused program | Pause `Dev test`, use a fresh customer | No box. |
| Suspended affiliate | Suspend `Dev Agent`, use a fresh customer (with the program active) | *This code is not valid…* |
| Too many tries | Enter a wrong code 5 times | *Too many attempts…* for one minute. |
| Daily limit | Set "Max new referrals per affiliate per day" to 1, refer two fresh customers | Second one: *…reached its limit for today…* |

## 4. Test the Earn page

1. **Turn on customer sign-up.** As Super Admin, edit `Dev test`: under **Who can join** tick **Borrower**, turn on **Customers can get their own code in the mini-app**, and keep **Fully repaid loans needed** at 1. Submit, then approve as Approver.
2. **A customer who can join.** Set `DEV_BORROWER_ID=251900063755` (one repaid loan, nothing unpaid) and restart `npm run dev`. Open http://localhost:9002/loan: the shop header shows **Earn**. Open it.
   Expected: *Invite friends, earn rewards*, the offer, and **Get my code**.
3. Tap **Get my code**. Your code appears, and you can **Copy** or **Share** it. **Admin → Affiliates** lists the customer as *Borrower · … · joined in the mini-app*. No approval request is created.
4. **Change the code.** Tap **Change code** and try `MYBANK1`: *This code is reserved…* Then try a free code such as `TEWODROS1`. The new code is shown and **Change code** disappears.
5. **A friend uses the code.** Set `DEV_BORROWER_ID=251909773024` (a new customer), restart, and enter the new code in **Have a referral code?**. Expected: *You were invited by* followed by the first name and initial only. The **old** code gives *This code is not valid…*
6. **See the friend.** Switch back to `251900063755`. **Earn → Friends** shows `•••• 3024` as **Joined**. After the friend's BNPL order and a job run ([section 5](#5-test-commissions-real-bnpl-flow)), the friend shows **Has a loan**, and the earnings and balance update.

More cases (change `DEV_BORROWER_ID`, restart `npm run dev`, open http://localhost:9002/earn):

| Case | Set up | Expected |
|---|---|---|
| No repaid loan | `DEV_BORROWER_ID=251910157363` | *Fully repay your first loan to get your code.* No button. |
| Overdue payment | `DEV_BORROWER_ID=251949443175` | *You have an overdue payment…* |
| Paused | Pause `Dev test`, use a customer who can join | *Invites are paused right now…* |
| Agent view | `DEV_BORROWER_ID=251911000001` (Dev Agent's phone) | The agent's code marked *Agent code.*, no **Change code**, plus friends and earnings. |
| Welcome bonus | `DEV_BORROWER_ID=251901246565` after its BNPL order and a job run | **Available** includes the 20 ETB bonus, with a **Welcome bonus** row. |
| Second sign-up program | Turn on sign-up in another program | Submitting fails: *Customers can already get their own code in "Dev test"…* |

## 5. Test commissions (real BNPL flow)

With the customer who applied the code (`251901246565`):

1. **Mini-app:** open an item in the shop, choose **BNPL**, pick a loan product and place the order.
2. **Admin → Merchants → Orders:** if the order waits for the merchant, click **Confirm availability**.
3. **Mini-app → Orders:** confirm delivery and accept the agreement. The OTP goes by SMS; on dev, read it from the database:

   ```sql
   SELECT TOP 1 d.code, d.expiresAt
   FROM DeliveryOtp d JOIN [Order] o ON o.id = d.orderId
   WHERE o.borrowerId = '251901246565' AND d.verified = 0
   ORDER BY d.createdAt DESC;
   ```

   After the OTP, the order is **Delivered** and the BNPL loan is created. The merchant payment goes to the mock bank.
4. **Run the job:** `npm run run:worker -- affiliate-commissions`. The output should show `commissionsCreated: 2`.
5. **Admin → Affiliates → Commissions:** you should see **50 ETB** for Dev Agent (Loan disbursed) and **20 ETB** for the new customer (BNPL order delivered), both **Ready to pay** because the hold is 0.
6. **Run the job again:** it records nothing new. Running it twice never pays twice.

**Shortcut** (if the test customer can't get a BNPL loan in your dev data): only loans and orders started **after** the code was entered count. To test with a customer who already has loans:

1. Use a program with **New customers only off**.
2. Apply the code as that customer (for example `251949385646`).
3. Make the referral older, on the **dev database only**:

   ```sql
   UPDATE AffiliateReferral SET attributedAt = '2020-01-01' WHERE borrowerId = '251949385646';
   ```

4. Run the job. Their existing loans now count.

## 6. Test payouts

1. Stop the mock bank and start it in **fail** mode: `node scripts/mock-cbs.js fail`.
2. **Affiliates → Payouts:** choose `Dev test`, then **Prepare payouts now**. A draft with 2 payouts is created: Dev Agent to `TEST0001`, and the customer to their linked account.
3. **Submit for approval**. As Approver, approve the **AffiliatePayoutBatch** request.
4. Back in **Payouts**, both transfers are **Failed** and the batch is **Partial**. The mock bank's console shows the two requests.
5. Stop the mock and start it normally: `node scripts/mock-cbs.js`.
6. Click **Retry** on each payout and confirm. They become **Success** with a `MOCK-…` transaction id, and the batch becomes **Completed**. In **Commissions**, they are **Paid**.
7. Optional:
   - **Release** instead of Retry puts the commissions back to **Ready to pay**.
   - With **Disbursement Control** switched off, approved payouts stay **Approved** until it is on again and `npm run run:worker -- affiliate-payouts` runs.

## 7. Test withdrawals

You need earnings that are **Ready to pay** and not paid yet: run this before section 6, or create new ones with section 5. Keep the mock bank running normally.

1. **Turn on withdrawals.** As Super Admin, edit `Dev test`. In **Limits & payouts**, turn on **People can withdraw their earnings in the mini-app**, set **Minimum withdrawal** to 10, leave the maximums empty, and set **Send automatically up to** to 30. Submit, then approve as Approver.
2. **A small withdrawal, sent at once.** Set `DEV_BORROWER_ID=251901246565` (it has the 20 ETB welcome bonus from section 5) and restart. Open http://localhost:9002/earn and tap **Withdraw 20 ETB**. The dialog shows the account's last 4 digits. Confirm.
   Expected: *Withdrawal on its way*, a request in the mock bank's console, and after a few seconds **Payments** shows **Withdrawal · Paid**. **Admin → Affiliates → Payouts → Withdrawals** shows it **Completed**.
3. **A large withdrawal, checked first.** Set `DEV_BORROWER_ID=251911000001` (Dev Agent, 50 ETB) and restart. Withdraw: *Withdrawal requested*, and **Payments** shows **Being checked**.
4. **Review it.** In **Payouts**, a blue box says *1 withdrawal is waiting for review*. As **Approver**, click **Approve**: the money goes to the mock bank and the agent's payment becomes **Paid**. Or click **Decline** and give a reason: the agent sees **Declined**, and **Withdraw** is available again.

More cases:

| Case | Set up | Expected |
|---|---|---|
| Transfer fails | Start the mock in **fail** mode, then withdraw | **Payments**: *Delayed*. **Withdraw** says *Your last withdrawal is still being processed.* In **Payouts**, **Retry** (after starting the mock normally) or **Release** (*Not sent*, the money is back in the balance). |
| Daily limit | Set **Max per day** to 30, withdraw 50 ETB as the agent | *One of your earnings is above the withdrawal limit…* |
| Disbursements off | Switch **Disbursement Control** off, make a small withdrawal | Stays *Processing* until it is on again and `npm run run:worker -- affiliate-payouts` runs. |
| Not a checker | Log in with a role without **Update on Approvals** | No **Approve / Decline** buttons. |

## 8. Test points

1. **Switch Dev test to points.** As Super Admin, edit `Dev test`. In **Basics & referrals → Rewards**, choose **Points** with **10** points per 1 ETB. The builder shows that a 50 ETB reward gives 500 points. Submit, then approve as Approver.
2. **Check the point value.** Open **Affiliates → Points**. The settings card says *1 point is worth 0.1 ETB* (the default). Optionally click **Change**, set 0.2 and approve it.
3. **Earn points.** Refer a new customer and run their BNPL order and the job, as in [section 5](#5-test-commissions-real-bnpl-flow). In **Commissions**, the new rows show their points under the amount and become **Added as points** (hold 0). **Points → History** shows **Earned** rows with `PTS-…` references.
4. **See them in the mini-app.** Set `DEV_BORROWER_ID=251911000001` (Dev Agent) and open http://localhost:9002/earn. **Your points** shows the balance with its Birr value. The friends list, this month's total and the history are in points, and **How it works** describes the rules in points.
5. **Adjust.** In **Points**, click **Adjust points**: phone `0911000001`, add 1000, give a reason. Approve the **AffiliatePointAdjustment** request as Approver. The balance goes up by 1000, the history shows **Adjusted**, and the Earn page shows *Points added by the bank*.
6. **Take back.** Reject the referral in **Referrals**. The credited points are removed (**Taken back** in the history), and the balance can go below zero.

| Case | How | Expected |
|---|---|---|
| Remove too many | Adjust: remove more points than the balance | *This would take the balance below zero…* |
| Two settings changes | Submit a settings change while one is waiting | *There is already a change waiting for approval…* |
| Money before the switch | Rewards recorded before step 1 | Still money: payouts and withdrawals as before. |
| Search | Search **Points** by phone, affiliate code or `PTS-…` reference | A phone or code shows that person's balance and their rows. |

## 9. Test take-backs (optional)

| Case | How | Expected after the job runs |
|---|---|---|
| Reject referral | **Referrals → Reject** | Immediately: unpaid → **Reversed**, paid → a negative "taken back" row. |
| Reversed loan | Reverse the test loan with the normal Reversals flow, then run the job. | Its commissions are taken back. |
| NPL | Customer becomes NPL (NPL job), then run the job. | If "take back when NPL" is on: commissions from the last N days are taken back, and no new ones are recorded while NPL. |

## 10. Reset the test data

Run this on the **dev database only**. It removes every affiliate program, affiliate, referral, commission and payout, plus their approval requests:

```sql
-- DEV ONLY
DELETE FROM AffiliatePointTransaction;
DELETE FROM AffiliatePointsSettingsVersion;
DELETE FROM AffiliateCommission;
DELETE FROM AffiliatePayout;
DELETE FROM AffiliatePayoutBatch;
DELETE FROM AffiliateReferral;
DELETE FROM Affiliate;
DELETE FROM AffiliateProgramVersion;
DELETE FROM AffiliateProgram;
DELETE FROM PendingChange WHERE entityType IN ('AffiliateProgram', 'Affiliate', 'AffiliatePayoutBatch', 'AffiliatePointsSettings', 'AffiliatePointAdjustment');
```

It does not remove loans, orders or ledger entries. Use **Paid by: Platform** rules on dev, so nothing is booked in the provider ledgers.

**When you finish testing:** restore the real `EXTERNAL_DISBURSEMENT_URL` in `.env`, and set `DEV_BORROWER_ID` back if needed.

## 11. Where the code is

| Part | Location |
|---|---|
| Settings schema, templates, rule sentences | `src/lib/affiliate/config.ts` |
| Earn page: sign-up rules, custom codes, balances, plain-words program text | `src/lib/affiliate/earn-rules.ts` (tests: `earn-rules.test.ts`) |
| Earn page: data, getting a code, changing it | `src/lib/affiliate/earn.ts`, API `src/app/api/earn` |
| Earn page screens | `src/app/earn/page.tsx`, `src/components/earn/*` |
| Withdrawals: what one would pay, requesting, review | `src/lib/affiliate/withdrawals.ts` (limits and messages in `earn-rules.ts`) |
| Points wallet: history rows, settings, approvals, admin history | `src/lib/affiliate/points.ts`, requests in `points-admin.ts`, API `src/app/api/affiliates/points`, screen `src/components/admin/affiliates/points-tab.tsx` |
| Points earning and take-backs in the job | `releaseHeldCommissions` and `takeBackCommission` in `src/lib/affiliate/commissions.ts` |
| Rules engine (used by the job and the Preview) | `src/lib/affiliate/engine.ts` (tests: `engine.test.ts`) |
| Daily job | `src/lib/affiliate/commissions.ts` |
| Payouts | `src/lib/affiliate/payouts.ts` |
| Code entry and referral rejection | `src/lib/affiliate/referrals.ts` |
| Approvals hook | `src/lib/affiliate/approvals.ts`, used in `src/app/api/approvals/route.ts` |
| Admin APIs / page | `src/app/api/affiliates/*`, `src/app/admin/affiliates`, `src/components/admin/affiliates/*` |
| Mini-app API / box | `src/app/api/referral-code`, `src/components/loan/referral-code-card.tsx` |
| Mock bank | `scripts/mock-cbs.js` |
| Unit tests | `npx vitest run src/lib/affiliate` |
