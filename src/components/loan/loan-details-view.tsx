
'use client';

import type { LoanDetails, LoanProduct, PenaltyRule } from '@/lib/types';
import { format } from 'date-fns';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

interface LoanDetailsViewProps {
  details: LoanDetails;
  product: LoanProduct;
  onReset: () => void;
  providerColor?: string;
  isBnplOrder?: boolean;
}

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' ETB';
};

const formatPenaltyRule = (rule: PenaltyRule): string => {
    const value = rule.value === '' ? 0 : Number(rule.value);
    let valueString = '';
    let conditionString = '';

    if (rule.type === 'fixed') {
        valueString = formatCurrency(value);
    } else if (rule.type === 'percentageOfPrincipal') {
        valueString = `${value}% of principal`;
    } else if (rule.type === 'percentageOfCompound') {
        valueString = `${value}% of outstanding balance`;
    }
    
    const fromDay = rule.fromDay === '' ? 1 : Number(rule.fromDay);
    const toDay = rule.toDay === '' || rule.toDay === null ? Infinity : Number(rule.toDay);

    if (toDay === Infinity) {
        conditionString = `from day ${fromDay} onwards`;
    } else {
        conditionString = `from day ${fromDay} to day ${toDay}`;
    }

    return `${valueString} ${conditionString}`;
}


export function LoanDetailsView({ details, product, onReset, providerColor = 'hsl(var(--primary))', isBnplOrder = false }: LoanDetailsViewProps) {
  
  return (
    <div className="max-w-2xl mx-auto">
       <div className="text-center mb-8">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl" style={{color: providerColor}}>
          {isBnplOrder ? 'Order Placed Successfully!' : 'Loan Disbursed Successfully!'}
        </h1>
        <p className="text-lg text-muted-foreground mt-2">
          {isBnplOrder
            ? 'Your BNPL order has been placed. The loan will be disbursed after you confirm delivery.'
            : 'Here is a summary of your new loan.'}
        </p>
      </div>
      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle>{details.productName}</CardTitle>
          <CardDescription>from {details.providerName}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-between items-baseline p-4 bg-secondary rounded-lg">
            <span className="text-muted-foreground">Loan Amount</span>
            <span className="text-4xl font-bold" style={{color: providerColor}}>{formatCurrency(details.loanAmount)}</span>
          </div>

          <Separator />
          
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
                <div className="text-muted-foreground">Repayment Status</div>
                <div className="text-right font-medium">
                  <Badge variant={details.repaymentStatus === 'Unpaid' ? 'destructive' : 'default'}>
                    {details.repaymentStatus}
                  </Badge>
                </div>
            </div>
            
             <div className="flex justify-between">
                <div className="text-muted-foreground">Service Fee Applied</div>
                <div className="text-right font-medium">{formatCurrency(details.serviceFee)}</div>
            </div>

             <div className="flex justify-between">
                <div className="text-muted-foreground">Daily Fee Rule</div>
                <div className="text-right font-medium">
                    {product.dailyFee.value ? `${product.dailyFee.value}${product.dailyFee.type === 'percentage' ? '%' : ''}` : 'N/A'}
                </div>
            </div>
            
            <div>
                <div className="text-muted-foreground mb-1">Penalty Rules</div>
                {product.penaltyRulesEnabled && product.penaltyRules.length > 0 ? (
                     <div className="mt-1 space-y-1 text-xs text-muted-foreground/80 pl-4 bg-secondary p-2 rounded-md">
                        {(product.penaltyRules || []).map(rule => (
                            <p key={rule.id}>- {formatPenaltyRule(rule)}</p>
                        ))}
                    </div>
                ) : (
                    <div className="text-right font-medium">N/A</div>
                )}
            </div>
            
             <div className="flex justify-between">
                <div className="text-muted-foreground">Due Date</div>
                <div className="text-right font-medium">{format(details.dueDate, 'PPP')}</div>
            </div>
            
          </div>
        </CardContent>
        <CardFooter>
          <Button className="w-full text-white" onClick={onReset} style={{backgroundColor: providerColor}}>
            {isBnplOrder ? 'View My Orders' : 'Start New Application'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
