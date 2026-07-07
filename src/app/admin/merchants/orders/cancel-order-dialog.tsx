'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type CancelOrderDialogProps = {
  open: boolean;
  orderId: string;
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
};

const DEFAULT_REASON = 'Item not available';

export default function CancelOrderDialog({
  open,
  orderId,
  isSubmitting,
  onOpenChange,
  onConfirm,
}: CancelOrderDialogProps) {
  const [reasonType, setReasonType] = useState(DEFAULT_REASON);
  const [customReason, setCustomReason] = useState('');

  useEffect(() => {
    if (!open) {
      return;
    }

    setReasonType(DEFAULT_REASON);
    setCustomReason('');
  }, [open, orderId]);

  const resolvedReason = useMemo(
    () => (reasonType === 'Other' ? customReason.trim() : reasonType),
    [customReason, reasonType],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel Order</DialogTitle>
          <DialogDescription>
            Canceling order {orderId} will notify the borrower and cancel the linked loan application.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Reason for cancellation</label>
            <Select value={reasonType} onValueChange={setReasonType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Item not available">Item not available</SelectItem>
                <SelectItem value="Out of stock">Out of stock</SelectItem>
                <SelectItem value="Item discontinued">Item discontinued</SelectItem>
                <SelectItem value="Price changed">Price changed</SelectItem>
                <SelectItem value="Other">Other (custom reason)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {reasonType === 'Other' ? (
            <Textarea
              placeholder="Enter custom reason..."
              value={customReason}
              onChange={(event) => setCustomReason(event.target.value)}
              rows={3}
            />
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Go Back
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(resolvedReason || DEFAULT_REASON)}
            disabled={isSubmitting || !resolvedReason}
          >
            {isSubmitting ? 'Cancelling...' : 'Cancel Order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}