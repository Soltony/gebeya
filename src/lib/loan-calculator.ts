
import { differenceInDays, startOfDay } from 'date-fns';
import type { LoanDetails, LoanProduct, PenaltyRule, Tax } from './types';
import { calculateInterestWithPayments, calculateInterestWithPaymentsDetailed, normalizePayments, roundCurrency } from './interest-accrual';

interface CalculatedRepayment {
    total: number;
    principal: number;
    interest: number;
    penalty: number;
    serviceFee: number;
    tax: number;
}

export interface CalculatedRepaymentDetailed extends CalculatedRepayment {
    interestPaid: number;
    serviceFeePaid: number;
    principalPaidFromInterestCalc: number;
}



export const calculateTotalRepayable = (loanDetails: LoanDetails, loanProduct: LoanProduct, taxConfigs: Tax[], asOfDate: Date = new Date()): CalculatedRepayment => {
    const loanStartDate = startOfDay(new Date(loanDetails.disbursedDate));
    const finalDate = startOfDay(asOfDate);
    const dueDate = startOfDay(new Date(loanDetails.dueDate));

    const principal = loanDetails.loanAmount;
    let serviceFee = 0;
    let interestComponent = 0;
    let penaltyComponent = 0;
    let taxComponent = 0;

    // Safely parse JSON fields from the product, as they might be strings from the DB
    const safeParse = (field: any, defaultValue: any) => {
        if (typeof field === 'string') {
            try {
                return JSON.parse(field);
            } catch (e) {
                return defaultValue;
            }
        }
        return field ?? defaultValue;
    };

    const serviceFeeRule = safeParse(loanProduct.serviceFee, undefined);
    const dailyFeeRule = safeParse(loanProduct.dailyFee, undefined);
    const penaltyRules = safeParse(loanProduct.penaltyRules, []);


    // 1. Service Fee (One-time charge)
    if (loanProduct.serviceFeeEnabled && serviceFeeRule && serviceFeeRule.value > 0) {
        const feeValue = typeof serviceFeeRule.value === 'string' ? parseFloat(serviceFeeRule.value) : serviceFeeRule.value;
        if (serviceFeeRule.type === 'fixed') {
            serviceFee = feeValue;
        } else if (serviceFeeRule.type === 'percentage') {
            serviceFee = principal * (feeValue / 100);
        }
    }
    serviceFee = roundCurrency(serviceFee);
    
    // 2. Daily Fee (Interest) - Calculated only up to the due date.
    if (loanProduct.dailyFeeEnabled && dailyFeeRule && dailyFeeRule.value > 0) {
        const feeValue = typeof dailyFeeRule.value === 'string' ? parseFloat(dailyFeeRule.value) : dailyFeeRule.value;
        const interestEndDate = finalDate > dueDate ? dueDate : finalDate;
        const payments = normalizePayments((loanDetails as any).payments);

        interestComponent = calculateInterestWithPayments({
            principal,
            loanStartDate,
            interestEndDate,
            dailyFeeRule: {
                type: dailyFeeRule.type,
                value: feeValue,
                calculationBase: dailyFeeRule.calculationBase,
            },
            serviceFee,
            payments,
        });
    }
    interestComponent = roundCurrency(interestComponent);
    
    const runningBalanceForPenalty = principal + interestComponent + serviceFee;

    // 3. Penalty - Calculated only if overdue.
    if (loanProduct.penaltyRulesEnabled && penaltyRules && penaltyRules.length > 0) {
        // If penaltyPerInstallment is enabled, compute penalty per-installment
        if ((loanProduct as any).penaltyPerInstallment && Array.isArray(loanDetails.installments) && loanDetails.installments.length > 0) {
            // Sum penalties for each installment that is overdue as of finalDate
            for (const inst of loanDetails.installments) {
                const instDue = startOfDay(new Date(inst.dueDate));
                if (finalDate <= instDue) continue;
                const daysOverdue = differenceInDays(finalDate, instDue);
                const principalForInst = Math.max(0, (inst.amount || 0) - (inst.paidAmount || 0));
                if (principalForInst <= 0) continue;

                penaltyRules.forEach((rule: PenaltyRule) => {
                    const fromDay = rule.fromDay === '' ? 1 : Number(rule.fromDay);
                    const toDayRaw = rule.toDay === '' || rule.toDay === null ? Infinity : Number(rule.toDay);
                    const toDay = isNaN(toDayRaw) ? Infinity : toDayRaw;
                    const value = rule.value === '' ? 0 : Number(rule.value);

                    if (daysOverdue >= fromDay) {
                        const applicableDaysInTier = Math.min(daysOverdue, toDay) - fromDay + 1;
                        const isOneTime = rule.frequency === 'one-time';
                        const daysToCalculate = isOneTime ? 1 : applicableDaysInTier;
                        if (daysToCalculate > 0) {
                            let penaltyForThisRule = 0;
                            if (rule.type === 'fixed') {
                                penaltyForThisRule = value * daysToCalculate;
                            } else if (rule.type === 'percentageOfPrincipal') {
                                penaltyForThisRule = principalForInst * (value / 100) * daysToCalculate;
                            } else if (rule.type === 'percentageOfCompound') {
                                let compoundPenaltyBase = principalForInst;
                                for (let i = 0; i < daysToCalculate; i++) {
                                    const dailyPenalty = roundCurrency(compoundPenaltyBase * (value / 100));
                                    penaltyForThisRule += dailyPenalty;
                                    if (!isOneTime) compoundPenaltyBase += dailyPenalty;
                                }
                            }
                            penaltyComponent += penaltyForThisRule;
                        }
                    }
                });
            }
        } else {
            // Loan-level penalty calculation (legacy behavior)
            if (finalDate > dueDate) {
                const penaltyStartDate = loanProduct.duration === 0 ? startOfDay(new Date(loanDetails.disbursedDate.getTime() + 86400000)) : dueDate;
                const daysOverdueTotal = differenceInDays(finalDate, penaltyStartDate);

                penaltyRules.forEach((rule: PenaltyRule) => {
                    const fromDay = rule.fromDay === '' ? 1 : Number(rule.fromDay);
                    const toDayRaw = rule.toDay === '' || rule.toDay === null ? Infinity : Number(rule.toDay);
                    const toDay = isNaN(toDayRaw) ? Infinity : toDayRaw;
                    const value = rule.value === '' ? 0 : Number(rule.value);

                    if (daysOverdueTotal >= fromDay) {
                        const applicableDaysInTier = Math.min(daysOverdueTotal, toDay) - fromDay + 1;
                        const isOneTime = rule.frequency === 'one-time';

                        if (applicableDaysInTier > 0) {
                            let penaltyForThisRule = 0;
                            const daysToCalculate = isOneTime ? 1 : applicableDaysInTier;

                            if (rule.type === 'fixed') {
                                penaltyForThisRule = value * daysToCalculate;
                            } else if (rule.type === 'percentageOfPrincipal') {
                                penaltyForThisRule = principal * (value / 100) * daysToCalculate;
                            } else if (rule.type === 'percentageOfCompound') {
                                let compoundPenaltyBase = runningBalanceForPenalty + penaltyComponent;
                                for (let i = 0; i < daysToCalculate; i++) {
                                    const dailyPenalty = roundCurrency(compoundPenaltyBase * (value / 100));
                                    penaltyForThisRule += dailyPenalty;
                                    if (!isOneTime) {
                                        compoundPenaltyBase += dailyPenalty;
                                    }
                                }
                            }
                            penaltyComponent += penaltyForThisRule;
                        }
                    }
                });
            }
        }
    }
    penaltyComponent = roundCurrency(penaltyComponent);

    // 4. Tax Calculation for all configured taxes
    taxConfigs.forEach(taxConfig => {
        const taxRate = taxConfig.rate;
        const taxAppliedTo = JSON.parse(taxConfig.appliedTo);
        
        if (taxRate > 0) {
            let taxableAmount = 0;
            if (taxAppliedTo.includes('serviceFee')) {
                taxableAmount += serviceFee;
            }
            if (taxAppliedTo.includes('interest')) {
                taxableAmount += interestComponent;
            }
            if (taxAppliedTo.includes('penalty')) {
                taxableAmount += penaltyComponent;
            }
            taxComponent += taxableAmount * (taxRate / 100);
        }
    });
    taxComponent = roundCurrency(taxComponent);

    const totalDebt = roundCurrency(principal + serviceFee + interestComponent + penaltyComponent + taxComponent);

    return {
        total: totalDebt,
        principal: principal,
        serviceFee: serviceFee,
        interest: interestComponent,
        penalty: penaltyComponent,
        tax: taxComponent,
    };
};

/**
 * Same as calculateTotalRepayable but also returns how much of interest/serviceFee/principal
 * has been paid based on the payments array in loanDetails.
 */
export const calculateTotalRepayableDetailed = (loanDetails: LoanDetails, loanProduct: LoanProduct, taxConfigs: Tax[], asOfDate: Date = new Date()): CalculatedRepaymentDetailed => {
    const loanStartDate = startOfDay(new Date(loanDetails.disbursedDate));
    const finalDate = startOfDay(asOfDate);
    const dueDate = startOfDay(new Date(loanDetails.dueDate));

    const principal = loanDetails.loanAmount;
    let serviceFee = 0;
    let interestComponent = 0;
    let penaltyComponent = 0;
    let taxComponent = 0;
    let interestPaid = 0;
    let serviceFeePaid = 0;
    let principalPaidFromInterestCalc = 0;

    const safeParse = (field: any, defaultValue: any) => {
        if (typeof field === 'string') {
            try {
                return JSON.parse(field);
            } catch (e) {
                return defaultValue;
            }
        }
        return field ?? defaultValue;
    };

    const serviceFeeRule = safeParse(loanProduct.serviceFee, undefined);
    const dailyFeeRule = safeParse(loanProduct.dailyFee, undefined);
    const penaltyRules = safeParse(loanProduct.penaltyRules, []);

    // 1. Service Fee
    if (loanProduct.serviceFeeEnabled && serviceFeeRule && serviceFeeRule.value > 0) {
        const feeValue = typeof serviceFeeRule.value === 'string' ? parseFloat(serviceFeeRule.value) : serviceFeeRule.value;
        if (serviceFeeRule.type === 'fixed') {
            serviceFee = feeValue;
        } else if (serviceFeeRule.type === 'percentage') {
            serviceFee = principal * (feeValue / 100);
        }
    }
    serviceFee = roundCurrency(serviceFee);
    
    // 2. Daily Fee (Interest) with detailed breakdown
    if (loanProduct.dailyFeeEnabled && dailyFeeRule && dailyFeeRule.value > 0) {
        const feeValue = typeof dailyFeeRule.value === 'string' ? parseFloat(dailyFeeRule.value) : dailyFeeRule.value;
        const interestEndDate = finalDate > dueDate ? dueDate : finalDate;
        const payments = normalizePayments((loanDetails as any).payments);

        const detailed = calculateInterestWithPaymentsDetailed({
            principal,
            loanStartDate,
            interestEndDate,
            dailyFeeRule: {
                type: dailyFeeRule.type,
                value: feeValue,
                calculationBase: dailyFeeRule.calculationBase,
            },
            serviceFee,
            payments,
        });
        
        interestComponent = detailed.totalInterest;
        interestPaid = detailed.interestPaid;
        serviceFeePaid = detailed.serviceFeePaid;
        principalPaidFromInterestCalc = detailed.principalPaid;
    }
    interestComponent = roundCurrency(interestComponent);
    
    const runningBalanceForPenalty = principal + interestComponent + serviceFee;

    // 3. Penalty (same logic as calculateTotalRepayable)
    if (loanProduct.penaltyRulesEnabled && penaltyRules && penaltyRules.length > 0) {
        if ((loanProduct as any).penaltyPerInstallment && Array.isArray(loanDetails.installments) && loanDetails.installments.length > 0) {
            for (const inst of loanDetails.installments) {
                const instDue = startOfDay(new Date(inst.dueDate));
                if (finalDate <= instDue) continue;
                const daysOverdue = differenceInDays(finalDate, instDue);
                const principalForInst = Math.max(0, (inst.amount || 0) - (inst.paidAmount || 0));
                if (principalForInst <= 0) continue;

                penaltyRules.forEach((rule: PenaltyRule) => {
                    const fromDay = rule.fromDay === '' ? 1 : Number(rule.fromDay);
                    const toDayRaw = rule.toDay === '' || rule.toDay === null ? Infinity : Number(rule.toDay);
                    const toDay = isNaN(toDayRaw) ? Infinity : toDayRaw;
                    const value = rule.value === '' ? 0 : Number(rule.value);

                    if (daysOverdue >= fromDay) {
                        const applicableDaysInTier = Math.min(daysOverdue, toDay) - fromDay + 1;
                        const isOneTime = rule.frequency === 'one-time';
                        const daysToCalculate = isOneTime ? 1 : applicableDaysInTier;
                        if (daysToCalculate > 0) {
                            let penaltyForThisRule = 0;
                            if (rule.type === 'fixed') {
                                penaltyForThisRule = value * daysToCalculate;
                            } else if (rule.type === 'percentageOfPrincipal') {
                                penaltyForThisRule = principalForInst * (value / 100) * daysToCalculate;
                            } else if (rule.type === 'percentageOfCompound') {
                                let compoundPenaltyBase = principalForInst;
                                for (let i = 0; i < daysToCalculate; i++) {
                                    const dailyPenalty = roundCurrency(compoundPenaltyBase * (value / 100));
                                    penaltyForThisRule += dailyPenalty;
                                    if (!isOneTime) compoundPenaltyBase += dailyPenalty;
                                }
                            }
                            penaltyComponent += penaltyForThisRule;
                        }
                    }
                });
            }
        } else {
            if (finalDate > dueDate) {
                const penaltyStartDate = loanProduct.duration === 0 ? startOfDay(new Date(loanDetails.disbursedDate.getTime() + 86400000)) : dueDate;
                const daysOverdueTotal = differenceInDays(finalDate, penaltyStartDate);

                penaltyRules.forEach((rule: PenaltyRule) => {
                    const fromDay = rule.fromDay === '' ? 1 : Number(rule.fromDay);
                    const toDayRaw = rule.toDay === '' || rule.toDay === null ? Infinity : Number(rule.toDay);
                    const toDay = isNaN(toDayRaw) ? Infinity : toDayRaw;
                    const value = rule.value === '' ? 0 : Number(rule.value);

                    if (daysOverdueTotal >= fromDay) {
                        const applicableDaysInTier = Math.min(daysOverdueTotal, toDay) - fromDay + 1;
                        const isOneTime = rule.frequency === 'one-time';

                        if (applicableDaysInTier > 0) {
                            let penaltyForThisRule = 0;
                            const daysToCalculate = isOneTime ? 1 : applicableDaysInTier;

                            if (rule.type === 'fixed') {
                                penaltyForThisRule = value * daysToCalculate;
                            } else if (rule.type === 'percentageOfPrincipal') {
                                penaltyForThisRule = principal * (value / 100) * daysToCalculate;
                            } else if (rule.type === 'percentageOfCompound') {
                                let compoundPenaltyBase = runningBalanceForPenalty + penaltyComponent;
                                for (let i = 0; i < daysToCalculate; i++) {
                                    const dailyPenalty = roundCurrency(compoundPenaltyBase * (value / 100));
                                    penaltyForThisRule += dailyPenalty;
                                    if (!isOneTime) {
                                        compoundPenaltyBase += dailyPenalty;
                                    }
                                }
                            }
                            penaltyComponent += penaltyForThisRule;
                        }
                    }
                });
            }
        }
    }
    penaltyComponent = roundCurrency(penaltyComponent);

    // 4. Tax
    taxConfigs.forEach(taxConfig => {
        const taxRate = taxConfig.rate;
        const taxAppliedTo = JSON.parse(taxConfig.appliedTo);
        
        if (taxRate > 0) {
            let taxableAmount = 0;
            if (taxAppliedTo.includes('serviceFee')) {
                taxableAmount += serviceFee;
            }
            if (taxAppliedTo.includes('interest')) {
                taxableAmount += interestComponent;
            }
            if (taxAppliedTo.includes('penalty')) {
                taxableAmount += penaltyComponent;
            }
            taxComponent += taxableAmount * (taxRate / 100);
        }
    });
    taxComponent = roundCurrency(taxComponent);

    const totalDebt = roundCurrency(principal + serviceFee + interestComponent + penaltyComponent + taxComponent);

    return {
        total: totalDebt,
        principal: principal,
        serviceFee: serviceFee,
        interest: interestComponent,
        penalty: penaltyComponent,
        tax: taxComponent,
        interestPaid: interestPaid,
        serviceFeePaid: serviceFeePaid,
        principalPaidFromInterestCalc: principalPaidFromInterestCalc,
    };
};

/**
 * Calculate inclusive tax amount that should be deducted upfront from principal.
 * Only active taxes with isInclusive=true are considered.
 * The tax is calculated on the gross loan amount.
 */
export function calculateInclusiveTax(grossAmount: number, taxConfigs: Tax[]): number {
    let inclusiveTax = 0;
    for (const config of taxConfigs) {
        if (config.isInclusive && config.rate > 0) {
            inclusiveTax += grossAmount * (config.rate / 100);
        }
    }
    return roundCurrency(inclusiveTax);
}
