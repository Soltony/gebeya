/** Response shapes of /api/tg/*. */

export type CatalogItem = {
  id: string;
  name: string;
  price: number;
  currency: string;
  discountedPrice: number | null;
  bestDiscount: { type: string; value: number; name: string } | null;
  image: string | null;
  merchant: { id: string; name: string };
  category: { id: string; name: string } | null;
};

/** The Telegram catalog only lists items that can be paid for directly (DIRECT_ONLY, BOTH). */
export type CatalogResponse = {
  items: CatalogItem[];
  categories: Array<{ id: string; name: string }>;
  merchants: Array<{ id: string; name: string }>;
};

export type ItemDetail = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  images: Array<{ large: string; thumb: string }>;
  merchant: { id: string; name: string };
  category: { id: string; name: string } | null;
  bestDiscount: { type: string; value: number; name: string } | null;
  optionGroups: Array<{ id: string; name: string; values: Array<{ id: string; label: string; priceDelta: number }> }>;
  requiresMerchantConfirmation: boolean;
  shareLink: string | null;
};

export type OrderQuote = {
  merchant: { id: string; name: string };
  lines: Array<{ itemId: string; name: string; quantity: number; unitPrice: number; discountAmount: number; lineTotal: number }>;
  totalAmount: number;
  currency: string;
  requiresMerchantConfirmation: boolean;
};

export type CustomerOrder = {
  id: string;
  status: string;
  paymentType: string;
  totalAmount: number;
  currency: string;
  cancelReason: string | null;
  cancelledBy: string | null;
  createdAt: string;
  updatedAt: string;
  merchant: { id: string; name: string; contactPersonName: string | null; contactPersonPhone: string | null } | null;
  orderItems: Array<{
    id: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    item: { id: string; name: string };
    variant: { name: string } | null;
    optionSelections: Array<{ optionValue: { label: string; group: { name: string } } }>;
  }>;
};
