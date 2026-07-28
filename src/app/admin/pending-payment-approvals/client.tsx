"use client";

import { useState } from "react";
import { useRequirePermission } from "@/hooks/use-require-permission";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Loader2, Check, X, ChevronLeft, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow, format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type {
  PendingPaymentApproval,
  PaginatedPendingPaymentApprovals,
} from "./page";
import type { User } from "@/lib/types";
import { usePermissions } from "@/hooks/use-permissions";

export function PendingPaymentApprovalsClient({
  paginatedData: initialData,
  currentUser,
}: {
  paginatedData: PaginatedPendingPaymentApprovals;
  currentUser: User;
}) {
  useRequirePermission(["payment-approvals", "approvals"]);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [processingId, setProcessingId] = useState<string | null>(null);

  const changes = initialData.data.filter((c) => !removedIds.has(c.id));
  const [rejectionReason, setRejectionReason] = useState("");
  const [changeToReject, setChangeToReject] =
    useState<PendingPaymentApproval | null>(null);
  const { toast } = useToast();
  const router = useRouter();
  const { canModule } = usePermissions();
  const canProcessApprovals =
    canModule("payment-approvals", "update") ||
    canModule("approvals", "update") ||
    canModule("reversal-approval", "update");

  const handleProcessChange = async (
    changeId: string,
    approved: boolean,
    reason?: string
  ) => {
    if (!canProcessApprovals) {
      toast({
        title: "Not authorized",
        description: "You are not authorized to approve or reject changes.",
        variant: "destructive",
      });
      return;
    }

    setProcessingId(changeId);
    try {
      const response = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeId, approved, rejectionReason: reason }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            `Failed to ${approved ? "approve" : "reject"} request.`
        );
      }

      setRemovedIds((prev) => new Set([...prev, changeId]));
      toast({
        title: "Success",
        description: `Payment resolve request has been ${
          approved ? "approved" : "rejected"
        }.`,
      });

      if (approved) {
        router.refresh();
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setProcessingId(null);
      setChangeToReject(null);
      setRejectionReason("");
    }
  };

  const handlePageChange = (page: number) => {
    router.push(`?page=${page}`);
  };

  // Payload fields the maker submitted; the row only stores them as JSON.
  const getFtReference = (change: PendingPaymentApproval): string | null => {
    try {
      const data = JSON.parse(change.payload);
      return data?.created?.ftReference || null;
    } catch {
      return null;
    }
  };

  const getAmount = (change: PendingPaymentApproval): number | null => {
    try {
      const data = JSON.parse(change.payload);
      return data?.created?.amount ?? null;
    } catch {
      return null;
    }
  };

  const getPaymentDate = (change: PendingPaymentApproval): string | null => {
    try {
      const data = JSON.parse(change.payload);
      return data?.created?.paymentDate || null;
    } catch {
      return null;
    }
  };

  return (
    <>
      <div className="flex-1 space-y-4 p-8 pt-6">
        <h2 className="text-3xl font-bold tracking-tight">
          Pending Payment Approvals
        </h2>
        <Card>
          <CardHeader>
            <CardTitle>Payment Resolve Requests</CardTitle>
            <CardDescription>
              Review and approve or reject pending payment resolve requests.
              Approving will record the repayment and mark the pending payment
              as successful.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Request</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>FT Reference</TableHead>
                  <TableHead>Payment Date</TableHead>
                  <TableHead>Requested By</TableHead>
                  <TableHead>Requested At</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {changes.length > 0 ? (
                  changes.map((change) => {
                    const ftRef = getFtReference(change);
                    const amount = getAmount(change);
                    const pDate = getPaymentDate(change);
                    return (
                      <TableRow key={change.id}>
                        <TableCell className="font-medium">
                          <div>Mark Payment Successful</div>
                          <div className="text-sm text-muted-foreground">
                            {change.entityName}
                          </div>
                          {change.providerName && (
                            <div className="text-xs text-muted-foreground">
                              ({change.providerName})
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {amount != null ? `${amount} ETB` : "—"}
                        </TableCell>
                        <TableCell className="font-mono">
                          {ftRef || "—"}
                        </TableCell>
                        <TableCell>
                          {pDate ? format(new Date(pDate), "yyyy-MM-dd") : "—"}
                        </TableCell>
                        <TableCell>
                          {change.createdBy?.fullName || "Unknown User"}
                        </TableCell>
                        <TableCell>
                          {formatDistanceToNow(new Date(change.createdAt), {
                            addSuffix: true,
                          })}
                        </TableCell>
                        <TableCell className="text-right space-x-2">
                          {canProcessApprovals && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  handleProcessChange(change.id, true)
                                }
                                disabled={
                                  processingId === change.id ||
                                  change.createdById === currentUser.id
                                }
                                className="text-green-600 border-green-600 hover:bg-green-50 hover:text-green-700"
                              >
                                {processingId === change.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Check className="h-4 w-4" />
                                )}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setChangeToReject(change)}
                                disabled={
                                  processingId === change.id ||
                                  change.createdById === currentUser.id
                                }
                                className="text-red-600 border-red-600 hover:bg-red-50 hover:text-red-700"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">
                      No pending payment approval requests.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
          {initialData.totalPages > 1 && (
            <CardFooter className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                Page {initialData.page} of {initialData.totalPages}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(initialData.page - 1)}
                  disabled={initialData.page <= 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(initialData.page + 1)}
                  disabled={initialData.page >= initialData.totalPages}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </CardFooter>
          )}
        </Card>
      </div>

      <Dialog
        open={!!changeToReject}
        onOpenChange={() => setChangeToReject(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Payment Resolve</DialogTitle>
            <DialogDescription>
              Please provide a reason for rejecting this payment resolve
              request.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g., Invalid FT reference number..."
              disabled={!canProcessApprovals}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangeToReject(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                handleProcessChange(changeToReject!.id, false, rejectionReason)
              }
              disabled={!canProcessApprovals || !rejectionReason.trim()}
            >
              Confirm Rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
