"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LoanProvider, LoanDetails, Tax } from "@/lib/types";
import { Loader2 } from "lucide-react";
import { LoanOfferAndCalculator } from "@/components/loan/loan-offer-and-calculator";
import { LoanDetailsView } from "@/components/loan/loan-details-view";
import { useToast } from "@/hooks/use-toast";
import AccountSelector from "@/components/loan/account-selector";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type Step = "calculator" | "details";

export function ApplyClient({
  provider,
  taxConfigs,
}: {
  provider: LoanProvider;
  taxConfigs: Tax[] | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const productId = searchParams.get("product");
  const borrowerId = searchParams.get("borrowerId");

  const selectedProduct = useMemo(() => {
    if (!provider || !productId) return null;
    return provider.products.find((p) => p.id === productId) || null;
  }, [provider, productId]);

  const initialStep: Step = (searchParams.get("step") as Step) || "calculator";

  const [step, setStep] = useState<Step>(initialStep);
  const [loanDetails, setLoanDetails] = useState<LoanDetails | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<any | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // When the super-app provides a borrowerId (phone), check for an active associated account.
    // If none exists, open a blocking modal to force the user to select one.
    const checkActive = async () => {
      if (!borrowerId) return;
      try {
        const res = await fetch(
          `/api/phone-accounts?phoneNumber=${encodeURIComponent(borrowerId)}`
        );
        if (!res.ok) {
          setShowAccountModal(true);
          return;
        }
        const items = await res.json();
        const active = items && items.find((i: any) => i.isActive);
        if (active) {
          setSelectedAccount(active);
          // Ensure customer info is provisioned for this active account
          try {
            fetch("/api/phone-accounts/fetch-customer", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                phoneNumber: borrowerId,
                accountNumber: active.accountNumber,
                providerId: provider?.id,
              }),
            })
              .then(() => {
                /* fire-and-forget */
              })
              .catch(() => {
                /* ignore */
              });
          } catch (e) {
            // ignore
          }
        } else {
          setShowAccountModal(true);
        }
      } catch (err) {
        setShowAccountModal(true);
      }
    };

    checkActive();
  }, [borrowerId]);

  const eligibilityResult = useMemo(() => {
    const min = searchParams.get("min");
    const max = searchParams.get("max");

    return {
      isEligible: true,
      suggestedLoanAmountMin: min
        ? parseFloat(min)
        : selectedProduct?.minLoan ?? 0,
      suggestedLoanAmountMax: max
        ? parseFloat(max)
        : selectedProduct?.maxLoan ?? 0,
      reason: "You are eligible for a loan.",
    };
  }, [searchParams, selectedProduct]);

  const handleLoanAccept = async (
    details: Omit<
      LoanDetails,
      "id" | "providerName" | "productName" | "payments"
    >
  ) => {
    if (!selectedProduct || !borrowerId) {
      toast({
        title: "Error",
        description: "Missing required information.",
        variant: "destructive",
      });
      return;
    }

    // Prevent double-submission
    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);

    try {
      const itemId = searchParams.get("itemId");
      const isBnplOrder = !!itemId;

      if (isBnplOrder) {
        // ── BNPL Flow: NO loan creation here. Just create the order. ──
        // The loan will be created when borrower confirms delivery.
        const qty = parseInt(searchParams.get("qty") || "1", 10) || 1;
        const optionValueIds = searchParams.get("optionValueIds");
        const optionSelections = optionValueIds
          ? optionValueIds.split(",").map((vid) => ({ optionValueId: vid }))
          : [];

        // Fetch item to get merchantId
        const itemRes = await fetch(`/api/shop/${itemId}`);
        if (!itemRes.ok) throw new Error("Failed to fetch item details.");
        const itemData = await itemRes.json();

        const orderRes = await fetch("/api/bnpl/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            borrowerId,
            merchantId: itemData.merchantId || itemData.merchant?.id,
            productId: selectedProduct.id,
            loanAmount: details.loanAmount,
            creditAccount: selectedAccount?.accountNumber || "",
            items: [{ itemId, quantity: qty, optionSelections }],
          }),
        });

        if (!orderRes.ok) {
          const err = await orderRes.json().catch(() => ({}));
          throw new Error(err.error || "Failed to place order.");
        }

        // Build display-only details (no real loan exists yet)
        const displayLoan: LoanDetails = {
          id: "pending-bnpl",
          loanAmount: details.loanAmount,
          serviceFee: details.serviceFee || 0,
          disbursedDate: new Date(details.disbursedDate),
          dueDate: new Date(details.dueDate),
          repaymentStatus: "Unpaid",
          payments: [],
          productName: selectedProduct.name,
          providerName: provider.name,
          repaidAmount: 0,
          penaltyAmount: 0,
          product: selectedProduct,
        };
        setLoanDetails(displayLoan);
        setStep("details");
        toast({
          title: "Order placed!",
          description:
            "Your order has been placed. The loan will be disbursed once you confirm delivery.",
        });
      } else {
        // ── Regular Loan Flow: Create loan and disburse immediately ──
        const finalDetails = {
          borrowerId,
          productId: selectedProduct.id,
          loanAmount: details.loanAmount,
          disbursedDate: details.disbursedDate,
          dueDate: details.dueDate,
          creditAccount: selectedAccount?.accountNumber || undefined,
        };

        const response = await fetch("/api/loans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(finalDetails),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to save the loan.");
        }

        const savedLoan = await response.json();

        const displayLoan: LoanDetails = {
          ...savedLoan,
          providerName: provider.name,
          productName: selectedProduct.name,
          disbursedDate: new Date(savedLoan.disbursedDate),
          dueDate: new Date(savedLoan.dueDate),
          payments: [],
        };
        setLoanDetails(displayLoan);
        setStep("details");
        toast({ title: "Success!", description: "Your loan has been saved." });

        // Disburse immediately
        try {
          if (selectedAccount && selectedAccount.accountNumber) {
            const disRes = await fetch("/api/external/disbursement", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                creditAccount: selectedAccount.accountNumber,
                providerId: provider.id,
                amount: savedLoan.netDisbursedAmount ?? savedLoan.loanAmount,
                loanId: savedLoan.id,
              }),
            });

            if (!disRes.ok) {
              const err = await disRes.json().catch(() => null);
              toast({
                title: "Disbursement failed",
                description:
                  err?.error ||
                  JSON.stringify(err) ||
                  "Upstream disbursement failed",
                variant: "destructive",
              });
            } else {
              toast({
                title: "Disbursement sent",
                description: "External disbursement request was sent.",
              });
            }
          } else {
            toast({
              title: "No account selected",
              description:
                "No disbursement account was selected; external transfer was not attempted.",
              variant: "warning",
            });
          }
        } catch (err: any) {
          toast({
            title: "Disbursement error",
            description: String(err?.message ?? err),
            variant: "destructive",
          });
        }
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("product");
    params.delete("step");
    router.push(`/loan?${params.toString()}`);
  };

  const handleReset = () => {
    const bp = searchParams.get("borrowerId") || "";
    const itemId = searchParams.get("itemId");
    if (itemId) {
      // BNPL: go to orders page
      router.push(`/bnpl/orders?borrowerId=${encodeURIComponent(bp)}`);
    } else {
      // Regular loan: go back to dashboard
      router.push(`/loan?borrowerId=${encodeURIComponent(bp)}`);
    }
  };

  const renderStep = () => {
    switch (step) {
      case "calculator":
        if (selectedProduct) {
          return (
            <LoanOfferAndCalculator
              product={selectedProduct}
              taxConfigs={taxConfigs || []}
              isLoading={false}
              eligibilityResult={eligibilityResult}
              onAccept={handleLoanAccept}
              providerColor={provider.colorHex}
              isSubmitting={isSubmitting}
              isBnplOrder={!!searchParams.get("itemId")}
              bnplAmount={searchParams.get("amount") ? parseFloat(searchParams.get("amount")!) : undefined}
            />
          );
        }
        if (productId && !selectedProduct) {
          return (
            <div className="text-center">
              Product not found. Please{" "}
              <button
                onClick={() => router.push("/loan")}
                className="underline"
                style={{ color: "hsl(var(--primary))" }}
              >
                start over
              </button>
              .
            </div>
          );
        }
        return (
          <div className="flex justify-center items-center h-48">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        );

      case "details":
        if (loanDetails && selectedProduct) {
          return (
            <LoanDetailsView
              details={loanDetails}
              product={selectedProduct}
              onReset={handleReset}
              providerColor={provider.colorHex}
              isBnplOrder={!!searchParams.get("itemId")}
            />
          );
        }
        return (
          <div className="flex justify-center items-center h-48">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        );
      default:
        return <div className="text-center">Invalid step.</div>;
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <main className="flex-1">
        <div className="container py-8 md:py-12">
          {/* If borrowerId is provided by the super-app, automatically show account selector */}
          {/* Show selected account summary when available */}
          {selectedAccount ? (
            <div className="mb-6 mx-auto max-w-2xl">
              <div className="flex items-center gap-3 rounded-xl border bg-gradient-to-r from-slate-50 to-white p-4 shadow-sm">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-muted-foreground">Selected Account</p>
                  <p className="truncate text-sm font-semibold">{selectedAccount.customerName}</p>
                  <p className="font-mono text-xs text-muted-foreground tracking-wide">{selectedAccount.accountNumber}</p>
                </div>
              </div>
            </div>
          ) : null}

          {renderStep()}

          {/* Blocking modal: forces account selection when there is no active account */}
          <Dialog
            open={showAccountModal}
            onOpenChange={(open) => {
              // prevent closing unless an account is selected
              if (!open && !selectedAccount) return;
              setShowAccountModal(open);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Select disbursement account</DialogTitle>
                <DialogDescription>
                  Please choose the account to receive disbursements for this
                  loan. This selection is required.
                </DialogDescription>
              </DialogHeader>
              {borrowerId && (
                <div className="mt-4">
                  <AccountSelector
                    phoneNumber={borrowerId}
                    onSelected={(acc) => {
                      (async () => {
                        setSelectedAccount(acc);
                        try {
                          const res = await fetch(
                            "/api/phone-accounts/fetch-customer",
                            {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                phoneNumber: borrowerId,
                                accountNumber: acc.accountNumber,
                                providerId: provider?.id,
                              }),
                            }
                          );
                          const data = await res.json();
                          if (!res.ok) {
                            toast({
                              title: "Provisioning failed",
                              description: data?.error || JSON.stringify(data),
                              variant: "destructive",
                            });
                          } else {
                            toast({
                              title: "Customer data saved",
                              description:
                                "Customer details were saved for scoring.",
                            });
                          }
                        } catch (err: any) {
                          toast({
                            title: "Provisioning error",
                            description: String(err?.message ?? err),
                            variant: "destructive",
                          });
                        }
                        setShowAccountModal(false);
                      })();
                    }}
                  />
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </main>
    </div>
  );
}
