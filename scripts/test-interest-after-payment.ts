/**
 * Test script to verify interest calculation after partial repayment
 * 
 * Run with: npx ts-node scripts/test-interest-after-payment.ts
 */

import { startOfDay, addDays } from 'date-fns';
import { calculateInterestWithPayments, simulateDailyInterestAccrual } from '../src/lib/interest-accrual.js';

// Test scenario from user:
// Principal: 10,000
// Daily fee: 0.1%
// Installments: 3

const principal = 10000;
const dailyFeePercent = 0.1;
const loanStartDate = startOfDay(new Date('2026-01-01'));

console.log('=== Interest Calculation Test ===\n');

// Test 1: Day 1 with no payment
console.log('Test 1: Day 1 (no payment)');
const day1EndDate = addDays(loanStartDate, 1);
const day1Interest = calculateInterestWithPayments({
  principal,
  loanStartDate,
  interestEndDate: day1EndDate,
  dailyFeeRule: { type: 'percentage', value: dailyFeePercent, calculationBase: 'principal' },
  serviceFee: 0,
  payments: [],
});
console.log(`  Interest for 1 day: ${day1Interest} (expected: 10)`);
console.log(`  First installment: ${(principal / 3).toFixed(2)}`);
console.log(`  Total due: ${(principal / 3 + day1Interest).toFixed(2)}\n`);

// Test 2: Day 1 with partial payment of 2,030 (payment on Day 1, after 1 day of interest)
console.log('Test 2: Day 1 with partial payment of 2,030 (payment on Day 1)');
const day1 = addDays(loanStartDate, 1); // Payment on Day 1
const payment1 = { amount: 2030, date: day1 };
const day2EndDate = addDays(loanStartDate, 2);
const day2WithPayment = calculateInterestWithPayments({
  principal,
  loanStartDate,
  interestEndDate: day2EndDate,
  dailyFeeRule: { type: 'percentage', value: dailyFeePercent, calculationBase: 'principal' },
  serviceFee: 0,
  payments: [payment1],
});
console.log(`  Interest through Day 2: ${day2WithPayment}`);
console.log(`  Expected: Day 0 = 10, Day 1 (after payment) = 7.98 => Total = 17.98`);
console.log(`  Payment breakdown: interest paid = 10 (accrued day 0), principal paid = 2,020`);
console.log(`  Remaining principal: ${principal - 2020} = 7,980\n`);

// Test 3: Day 5 with partial payment on day 1
console.log('Test 3: Day 5 with partial payment on day 1');
const day5EndDate = addDays(loanStartDate, 5);
const day5WithPayment = calculateInterestWithPayments({
  principal,
  loanStartDate,
  interestEndDate: day5EndDate,
  dailyFeeRule: { type: 'percentage', value: dailyFeePercent, calculationBase: 'principal' },
  serviceFee: 0,
  payments: [payment1], // payment1 is on day1 now
});

// Manual calculation:
// Day 0: Interest = 10,000 * 0.1% = 10, then payment 2,030 (pays 10 interest + 2,020 principal)
// Day 1: Principal = 7,980, Interest = 7.98
// Day 2: Principal = 7,980, Interest = 7.98
// Day 3: Principal = 7,980, Interest = 7.98
// Day 4: Principal = 7,980, Interest = 7.98
// Total = 10 + 7.98 + 7.98 + 7.98 + 7.98 = 41.92

console.log(`  Interest after 5 days: ${day5WithPayment}`);
console.log(`  Expected: 10 (day 0) + 4 * 7.98 (days 1-4) = ${10 + 4 * 7.98}`);

// Show day-by-day breakdown
console.log('\n  Day-by-day breakdown:');
const accruals = simulateDailyInterestAccrual({
  principal,
  loanStartDate,
  interestEndDate: day5EndDate,
  dailyFeeRule: { type: 'percentage', value: dailyFeePercent, calculationBase: 'principal' },
  serviceFee: 0,
  payments: [payment1],
});
accruals.forEach((a, i) => {
  console.log(`    Day ${i}: ${a.date.toISOString().slice(0, 10)} - Interest: ${a.interest}`);
});

// Test 4: Interest capped at due date
console.log('\n\nTest 4: Interest capped at due date');
const dueDate = addDays(loanStartDate, 3); // 3 day loan
const day10EndDate = addDays(loanStartDate, 10);
const day10Interest = calculateInterestWithPayments({
  principal,
  loanStartDate,
  interestEndDate: day10EndDate > dueDate ? dueDate : day10EndDate, // Simulating loan-calculator behavior
  dailyFeeRule: { type: 'percentage', value: dailyFeePercent, calculationBase: 'principal' },
  serviceFee: 0,
  payments: [],
});
console.log(`  Due date: ${dueDate.toISOString().slice(0, 10)}`);
console.log(`  As-of date: ${day10EndDate.toISOString().slice(0, 10)}`);
console.log(`  Interest (capped at due date): ${day10Interest} (only 3 days: ${3 * 10})`);
console.log(`  This is why advancing date past due date shows no additional interest!`);

console.log('\n=== Test Complete ===');
