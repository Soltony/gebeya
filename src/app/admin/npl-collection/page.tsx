"use client";

import { useEffect, useMemo, useState } from "react";
import { useRequirePermission } from "@/hooks/use-require-permission";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  AlertTriangle,
  ArrowDownToLine,
  Banknote,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileSpreadsheet,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import * as ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import { cn } from "@/lib/utils";

interface UploadBatch {
  id: string;
  source: "MANUAL" | "SCHEDULED";
  status: "PENDING" | "SUCCESS" | "FAILED";
  accountsSentCount: number;
  totalReceived: number | null;
  insertedCount: number | null;
  alreadyExistsCount: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
  triggeredByUserId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface Notification {
  id: string;
  correlationId: string;
  externalReference: string | null;
  accountNumber: string;
  creditedAmount: number;
  providerId: string | null;
  processStatus: string;
  resultMessage: string | null;
  borrowerId: string | null;
  loanId: string | null;
  paymentId: string | null;
  repayHttpStatus: number | null;
  repayTransactionId: string | null;
  repayDebitAmount: number | null;
  repayDebitAccount: string | null;
  repayCreditAccount: string | null;
  attempts: number;
  receivedAt: string;
  lastAttemptAt: string | null;
}

interface NotificationSummary {
  total: number;
  byStatus: Record<string, number>;
  totalCredited: number;
  totalDebited: number;
}

interface Deletion {
  id: string;
  accountNumber: string;
  source: "MANUAL" | "AUTO";
  status: "PENDING" | "SUCCESS" | "FAILED";
  httpStatus: number | null;
  reason: string | null;
  borrowerId: string | null;
  triggeredByUserId: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const PAGE_SIZE = 20;

// Cap accounts per delete request to stay within the API limit (see route).
const DELETE_BATCH_SIZE = 200;

/** Statuses that mean the credit still needs a human or a retry. */
const ATTENTION_STATUSES = ["PENDING", "FAILED", "UNMATCHED_ACCOUNT"];

const formatAmount = (n: number | null | undefined) => {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
};

/** `UNMATCHED_ACCOUNT` -> `Unmatched account`, for card hints and spreadsheets. */
const prettyStatus = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

const statusBadgeVariant = (status: string) => {
  switch (status) {
    case "SUCCESS":
    case "REPAID":
      return "default" as const;
    case "PARTIAL_REPAID":
      return "secondary" as const;
    case "FAILED":
    case "UNMATCHED_ACCOUNT":
      return "destructive" as const;
    case "DUPLICATE":
    case "NO_OUTSTANDING":
      return "outline" as const;
    default:
      return "secondary" as const;
  }
};

type StatTone = "default" | "success" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<StatTone, string> = {
  default: "bg-muted text-foreground",
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  danger: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400",
};

/** Summary card shown above each tab's table. */
function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Inbox;
  tone?: StatTone;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="mt-2 h-7 w-24" />
          ) : (
            <p className="mt-1 truncate text-2xl font-bold" title={value}>
              {value}
            </p>
          )}
          {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", TONE_CLASSES[tone])}>
          <Icon className="h-4 w-4" />
        </div>
      </CardContent>
    </Card>
  );
}

/** From/To day filter shared by the three history tables. Values are `yyyy-MM-dd`. */
function DateRangeFilter({
  from,
  to,
  onFromChange,
  onToChange,
  onClear,
}: {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">From</span>
        <Input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => onFromChange(e.target.value)}
          className="w-[160px]"
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">To</span>
        <Input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => onToChange(e.target.value)}
          className="w-[160px]"
        />
      </div>
      {(from || to) && (
        <Button variant="ghost" size="sm" onClick={onClear} title="Clear date filter">
          <X className="mr-1 h-4 w-4" /> Clear
        </Button>
      )}
    </div>
  );
}

/** Export trigger used on every table; only one export runs at a time. */
function ExportButton({
  id,
  exporting,
  onClick,
  disabled,
}: {
  id: string;
  exporting: string | null;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled || exporting !== null}>
      {exporting === id ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <FileSpreadsheet className="mr-2 h-4 w-4" />
      )}
      Export Excel
    </Button>
  );
}

interface ExportColumn {
  header: string;
  key: string;
  width: number;
  numFmt?: string;
}

/** Builds a formatted .xlsx in the browser and triggers the download. */
async function downloadWorkbook(
  sheetName: string,
  columns: ExportColumn[],
  rows: Record<string, any>[],
  fileName: string,
) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1 }] });

  sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  columns.forEach((col, i) => {
    if (col.numFmt) sheet.getColumn(i + 1).numFmt = col.numFmt;
  });

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
  });

  rows.forEach((row) => sheet.addRow(row));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const buffer = await workbook.xlsx.writeBuffer();
  saveAs(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    fileName,
  );
}

/** `NPL_CBS_Uploads_20260730.xlsx`, with the filtered range in the name when one is set. */
const exportFileName = (base: string, from: string, to: string) => {
  const range = from || to ? `_${from || "start"}_to_${to || "today"}` : "";
  return `${base}${range}_${format(new Date(), "yyyyMMdd")}.xlsx`;
};

export default function NplCollectionPage() {
  useRequirePermission(["npl-collection", "npl"]);
  const { toast } = useToast();

  const [tab, setTab] = useState<"uploads" | "notifications" | "cleanup">("uploads");
  const [exporting, setExporting] = useState<string | null>(null);

  // Upload state
  const [uploads, setUploads] = useState<UploadBatch[]>([]);
  const [uploadsLoading, setUploadsLoading] = useState(true);
  const [uploadsPage, setUploadsPage] = useState(1);
  const [uploadsTotal, setUploadsTotal] = useState(0);
  const [uploadsTotalPages, setUploadsTotalPages] = useState(1);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadsFrom, setUploadsFrom] = useState("");
  const [uploadsTo, setUploadsTo] = useState("");

  // Notifications state
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [notifsLoading, setNotifsLoading] = useState(true);
  const [notifsPage, setNotifsPage] = useState(1);
  const [notifsTotal, setNotifsTotal] = useState(0);
  const [notifsTotalPages, setNotifsTotalPages] = useState(1);
  const [summary, setSummary] = useState<NotificationSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [notifsFrom, setNotifsFrom] = useState("");
  const [notifsTo, setNotifsTo] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Cleanup state
  const [stale, setStale] = useState<string[]>([]);
  const [staleTotal, setStaleTotal] = useState(0);
  const [staleLoading, setStaleLoading] = useState(true);
  const [stalePage, setStalePage] = useState(1);
  const [staleTotalPages, setStaleTotalPages] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manualAccount, setManualAccount] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);

  const [deletions, setDeletions] = useState<Deletion[]>([]);
  const [deletionsLoading, setDeletionsLoading] = useState(true);
  const [deletionsPage, setDeletionsPage] = useState(1);
  const [deletionsTotal, setDeletionsTotal] = useState(0);
  const [deletionsTotalPages, setDeletionsTotalPages] = useState(1);
  const [deletionsFrom, setDeletionsFrom] = useState("");
  const [deletionsTo, setDeletionsTo] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setNotifsPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const uploadsQuery = useMemo(() => {
    const p = new URLSearchParams({ page: String(uploadsPage), limit: String(PAGE_SIZE) });
    if (uploadsFrom) p.set("from", uploadsFrom);
    if (uploadsTo) p.set("to", uploadsTo);
    return p.toString();
  }, [uploadsPage, uploadsFrom, uploadsTo]);

  const notifsQuery = useMemo(() => {
    const p = new URLSearchParams({ page: String(notifsPage), limit: String(PAGE_SIZE) });
    if (statusFilter && statusFilter !== "all") p.set("status", statusFilter);
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (notifsFrom) p.set("from", notifsFrom);
    if (notifsTo) p.set("to", notifsTo);
    return p.toString();
  }, [notifsPage, statusFilter, debouncedSearch, notifsFrom, notifsTo]);

  const deletionsQuery = useMemo(() => {
    const p = new URLSearchParams({ page: String(deletionsPage), limit: String(PAGE_SIZE) });
    if (deletionsFrom) p.set("from", deletionsFrom);
    if (deletionsTo) p.set("to", deletionsTo);
    return p.toString();
  }, [deletionsPage, deletionsFrom, deletionsTo]);

  const fetchUploads = async () => {
    setUploadsLoading(true);
    try {
      const res = await fetch(`/api/cbs/npl/upload?${uploadsQuery}`);
      if (!res.ok) throw new Error("Failed to load uploads");
      const data = await res.json();
      setUploads(data.rows || []);
      setUploadsTotal(data.total || 0);
      setUploadsTotalPages(data.totalPages || 1);
    } catch (e: any) {
      toast({ title: "Error", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setUploadsLoading(false);
    }
  };

  const fetchNotifications = async () => {
    setNotifsLoading(true);
    try {
      const res = await fetch(`/api/cbs/notifications?${notifsQuery}`);
      if (!res.ok) throw new Error("Failed to load notifications");
      const data = await res.json();
      setNotifs(data.rows || []);
      setNotifsTotal(data.total || 0);
      setNotifsTotalPages(data.totalPages || 1);
      setSummary(data.summary ?? null);
    } catch (e: any) {
      toast({ title: "Error", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setNotifsLoading(false);
    }
  };

  const fetchStale = async () => {
    setStaleLoading(true);
    try {
      const params = new URLSearchParams({ page: String(stalePage), limit: String(PAGE_SIZE) });
      const res = await fetch(`/api/cbs/npl/stale?${params}`);
      if (!res.ok) throw new Error("Failed to load cleanup candidates");
      const data = await res.json();
      setStale(data.rows || []);
      setStaleTotal(data.total || 0);
      setStaleTotalPages(data.totalPages || 1);
      // Drop any selections that are no longer on the current page list.
      setSelected((prev) => {
        const next = new Set<string>();
        for (const acc of data.rows || []) if (prev.has(acc)) next.add(acc);
        return next;
      });
    } catch (e: any) {
      toast({ title: "Error", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setStaleLoading(false);
    }
  };

  const fetchDeletions = async () => {
    setDeletionsLoading(true);
    try {
      const res = await fetch(`/api/cbs/npl/delete?${deletionsQuery}`);
      if (!res.ok) throw new Error("Failed to load deletion history");
      const data = await res.json();
      setDeletions(data.rows || []);
      setDeletionsTotal(data.total || 0);
      setDeletionsTotalPages(data.totalPages || 1);
    } catch (e: any) {
      toast({ title: "Error", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setDeletionsLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "uploads") void fetchUploads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, uploadsQuery]);

  useEffect(() => {
    if (tab === "notifications") void fetchNotifications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, notifsQuery]);

  useEffect(() => {
    if (tab === "cleanup") void fetchStale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, stalePage]);

  useEffect(() => {
    if (tab === "cleanup") void fetchDeletions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, deletionsQuery]);

  const handleRunUpload = async () => {
    setIsUploading(true);
    try {
      const res = await fetch("/api/cbs/npl/upload", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || "Upload failed");
      toast({
        title: data?.success ? "Upload Successful" : "Upload Completed With Issues",
        description: `${data?.message ?? ""} (sent=${data?.accountsSentCount ?? 0}, inserted=${data?.insertedCount ?? "—"}, existing=${data?.alreadyExistsCount ?? "—"})`,
        variant: data?.success ? "default" : "destructive",
      });
      await fetchUploads();
    } catch (e: any) {
      toast({ title: "Upload Failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const handleRetry = async (id: string) => {
    setRetryingId(id);
    try {
      const res = await fetch(`/api/cbs/notifications/${id}/retry`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Retry failed");
      toast({
        title: "Retry Completed",
        description: `${data?.status ?? ""}: ${data?.message ?? ""}`,
      });
      await fetchNotifications();
    } catch (e: any) {
      toast({ title: "Retry Failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setRetryingId(null);
    }
  };

  /** POST account numbers to the delete endpoint, chunked to respect the API limit. */
  const runDelete = async (accountNumbers: string[], reason?: string) => {
    const accounts = Array.from(new Set(accountNumbers.map((a) => a.trim()).filter(Boolean)));
    if (accounts.length === 0) return;
    setDeleting(true);
    setDeleteProgress({ done: 0, total: accounts.length });
    let success = 0;
    let failed = 0;
    try {
      for (let i = 0; i < accounts.length; i += DELETE_BATCH_SIZE) {
        const chunk = accounts.slice(i, i + DELETE_BATCH_SIZE);
        const res = await fetch("/api/cbs/npl/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountNumbers: chunk, reason }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Delete request failed");
        success += data?.success ?? 0;
        failed += data?.failed ?? 0;
        setDeleteProgress({ done: Math.min(i + chunk.length, accounts.length), total: accounts.length });
      }
      toast({
        title: failed ? "Cleanup Completed With Errors" : "Cleanup Completed",
        description: `Deleted ${success} account(s) from CBS${failed ? `, ${failed} failed` : ""}.`,
        variant: failed ? "destructive" : "default",
      });
      setSelected(new Set());
      await Promise.all([fetchStale(), fetchDeletions()]);
    } catch (e: any) {
      toast({ title: "Cleanup Failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setDeleting(false);
      setDeleteProgress(null);
    }
  };

  const handleManualDelete = async () => {
    const acc = manualAccount.trim();
    if (!acc) return;
    await runDelete([acc], "Manual single-account deletion from NPL Collection page.");
    setManualAccount("");
  };

  const handleDeleteAll = async () => {
    try {
      const res = await fetch(`/api/cbs/npl/stale?all=1`);
      if (!res.ok) throw new Error("Failed to load cleanup candidates");
      const data = await res.json();
      const accounts: string[] = data.rows || [];
      if (accounts.length === 0) {
        toast({ title: "Nothing to clean up", description: "No stale accounts found." });
        return;
      }
      await runDelete(accounts, "Bulk cleanup of accounts that exited NPL.");
    } catch (e: any) {
      toast({ title: "Cleanup Failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  };

  const toggleSelectAll = () => {
    setSelected((prev) => (prev.size === stale.length ? new Set() : new Set(stale)));
  };

  const toggleSelect = (account: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(account)) next.delete(account);
      else next.add(account);
      return next;
    });
  };

  const runExport = async (key: string, build: () => Promise<void>) => {
    setExporting(key);
    try {
      await build();
      toast({ title: "Export Ready", description: "The spreadsheet has been downloaded." });
    } catch (e: any) {
      toast({ title: "Export Failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setExporting(null);
    }
  };

  /** Pulls every row matching the current filters, not just the visible page. */
  const fetchAllRows = async (path: string, query: string) => {
    const res = await fetch(`${path}?${query}&all=1`);
    if (!res.ok) throw new Error("Failed to load rows for export");
    const data = await res.json();
    if (data.truncated) {
      toast({
        title: "Export Truncated",
        description: "Only the first 10,000 rows were exported. Narrow the date range for a complete file.",
      });
    }
    return (data.rows || []) as any[];
  };

  const exportUploads = () =>
    runExport("uploads", async () => {
      const rows: UploadBatch[] = await fetchAllRows("/api/cbs/npl/upload", uploadsQuery);
      await downloadWorkbook(
        "CBS Uploads",
        [
          { header: "Started", key: "startedAt", width: 20, numFmt: "yyyy-mm-dd hh:mm:ss" },
          { header: "Finished", key: "finishedAt", width: 20, numFmt: "yyyy-mm-dd hh:mm:ss" },
          { header: "Source", key: "source", width: 12 },
          { header: "Status", key: "status", width: 12 },
          { header: "Accounts Sent", key: "accountsSentCount", width: 15, numFmt: "#,##0" },
          { header: "Received", key: "totalReceived", width: 12, numFmt: "#,##0" },
          { header: "Inserted", key: "insertedCount", width: 12, numFmt: "#,##0" },
          { header: "Already Existing", key: "alreadyExistsCount", width: 17, numFmt: "#,##0" },
          { header: "HTTP", key: "httpStatus", width: 8 },
          { header: "Error", key: "errorMessage", width: 60 },
        ],
        rows.map((u) => ({
          ...u,
          startedAt: new Date(u.startedAt),
          finishedAt: u.finishedAt ? new Date(u.finishedAt) : null,
        })),
        exportFileName("NPL_CBS_Uploads", uploadsFrom, uploadsTo),
      );
    });

  const exportNotifications = () =>
    runExport("notifications", async () => {
      const rows: Notification[] = await fetchAllRows("/api/cbs/notifications", notifsQuery);
      await downloadWorkbook(
        "Credit Notifications",
        [
          { header: "Received", key: "receivedAt", width: 20, numFmt: "yyyy-mm-dd hh:mm:ss" },
          { header: "Status", key: "processStatus", width: 20 },
          { header: "Account", key: "accountNumber", width: 20 },
          { header: "Credited", key: "creditedAmount", width: 15, numFmt: "#,##0.00" },
          { header: "Debited", key: "repayDebitAmount", width: 15, numFmt: "#,##0.00" },
          { header: "Borrower", key: "borrowerId", width: 22 },
          { header: "Loan", key: "loanId", width: 22 },
          { header: "Payment", key: "paymentId", width: 22 },
          { header: "CBS Txn", key: "repayTransactionId", width: 22 },
          { header: "Debit Account", key: "repayDebitAccount", width: 20 },
          { header: "Credit Account", key: "repayCreditAccount", width: 20 },
          { header: "Correlation ID", key: "correlationId", width: 38 },
          { header: "External Ref", key: "externalReference", width: 24 },
          { header: "Provider", key: "providerId", width: 12 },
          { header: "Repay HTTP", key: "repayHttpStatus", width: 12 },
          { header: "Attempts", key: "attempts", width: 10, numFmt: "#,##0" },
          { header: "Last Attempt", key: "lastAttemptAt", width: 20, numFmt: "yyyy-mm-dd hh:mm:ss" },
          { header: "Message", key: "resultMessage", width: 60 },
        ],
        rows.map((n) => ({
          ...n,
          processStatus: prettyStatus(n.processStatus),
          receivedAt: new Date(n.receivedAt),
          lastAttemptAt: n.lastAttemptAt ? new Date(n.lastAttemptAt) : null,
        })),
        exportFileName("NPL_Credit_Notifications", notifsFrom, notifsTo),
      );
    });

  const exportDeletions = () =>
    runExport("deletions", async () => {
      const rows: Deletion[] = await fetchAllRows("/api/cbs/npl/delete", deletionsQuery);
      await downloadWorkbook(
        "CBS Deletions",
        [
          { header: "Requested", key: "createdAt", width: 20, numFmt: "yyyy-mm-dd hh:mm:ss" },
          { header: "Finished", key: "finishedAt", width: 20, numFmt: "yyyy-mm-dd hh:mm:ss" },
          { header: "Account", key: "accountNumber", width: 20 },
          { header: "Source", key: "source", width: 12 },
          { header: "Status", key: "status", width: 12 },
          { header: "HTTP", key: "httpStatus", width: 8 },
          { header: "Borrower", key: "borrowerId", width: 22 },
          { header: "Reason", key: "reason", width: 45 },
          { header: "Error", key: "errorMessage", width: 60 },
        ],
        rows.map((d) => ({
          ...d,
          createdAt: new Date(d.createdAt),
          finishedAt: d.finishedAt ? new Date(d.finishedAt) : null,
        })),
        exportFileName("NPL_CBS_Deletions", deletionsFrom, deletionsTo),
      );
    });

  const exportStale = () =>
    runExport("stale", async () => {
      const res = await fetch(`/api/cbs/npl/stale?all=1`);
      if (!res.ok) throw new Error("Failed to load cleanup candidates");
      const data = await res.json();
      const accounts: string[] = data.rows || [];
      await downloadWorkbook(
        "Pending Cleanup",
        [{ header: "Account Number", key: "accountNumber", width: 24 }],
        accounts.map((accountNumber) => ({ accountNumber })),
        exportFileName("NPL_Pending_Cleanup", "", ""),
      );
    });

  const latestUpload = uploads[0];
  const attentionCount = summary
    ? ATTENTION_STATUSES.reduce((sum, s) => sum + (summary.byStatus[s] ?? 0), 0)
    : 0;
  const repaidCount = summary ? (summary.byStatus.REPAID ?? 0) + (summary.byStatus.PARTIAL_REPAID ?? 0) : 0;

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">NPL Collection</h2>
          <p className="text-muted-foreground">
            Digital loan repayment workflow with the Core Banking System (CBS). Upload daily NPL lists, receive credit notifications, and auto-debit borrowers when funds are available.
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "uploads" | "notifications" | "cleanup")}>
        <TabsList>
          <TabsTrigger value="uploads">CBS Uploads</TabsTrigger>
          <TabsTrigger value="notifications">Credit Notifications</TabsTrigger>
          <TabsTrigger value="cleanup">Account Cleanup</TabsTrigger>
        </TabsList>

        <TabsContent value="uploads" className="space-y-4 pt-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label="Batches in range"
              value={uploadsTotal.toLocaleString()}
              hint={uploadsFrom || uploadsTo ? "Matching the selected dates" : "All uploads to date"}
              icon={Upload}
              tone="info"
              loading={uploadsLoading}
            />
            <StatTile
              label="Last upload"
              value={latestUpload ? format(new Date(latestUpload.startedAt), "dd MMM, HH:mm") : "—"}
              hint={latestUpload ? prettyStatus(latestUpload.status) : "No uploads yet"}
              icon={Clock}
              tone={
                latestUpload?.status === "SUCCESS" ? "success" : latestUpload?.status === "FAILED" ? "danger" : "default"
              }
              loading={uploadsLoading}
            />
            <StatTile
              label="Accounts sent (last)"
              value={latestUpload ? latestUpload.accountsSentCount.toLocaleString() : "—"}
              hint={
                latestUpload
                  ? `${latestUpload.insertedCount ?? "—"} new · ${latestUpload.alreadyExistsCount ?? "—"} existing`
                  : undefined
              }
              icon={Send}
              loading={uploadsLoading}
            />
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Each day the system pushes the list of unpaid NPL accounts to the CBS for monitoring.
              You can also trigger an upload manually.
            </p>
            <Button onClick={handleRunUpload} disabled={isUploading}>
              {isUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {isUploading ? "Uploading…" : "Upload NPL List Now"}
            </Button>
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Recent Bulk Uploads</CardTitle>
                  <CardDescription>
                    Outbound calls to <code>POST /api/v1/notification/bulk</code>. The CBS echoes back how many accounts were newly registered vs. already monitored.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <DateRangeFilter
                    from={uploadsFrom}
                    to={uploadsTo}
                    onFromChange={(v) => { setUploadsFrom(v); setUploadsPage(1); }}
                    onToChange={(v) => { setUploadsTo(v); setUploadsPage(1); }}
                    onClear={() => { setUploadsFrom(""); setUploadsTo(""); setUploadsPage(1); }}
                  />
                  <ExportButton
                    id="uploads"
                    exporting={exporting}
                    onClick={() => void exportUploads()}
                    disabled={uploadsTotal === 0}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Started</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Sent</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      <TableHead className="text-right">Inserted</TableHead>
                      <TableHead className="text-right">Existing</TableHead>
                      <TableHead>HTTP</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {uploadsLoading ? (
                      <TableRow>
                        <TableCell colSpan={9} className="h-24 text-center">
                          <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                        </TableCell>
                      </TableRow>
                    ) : uploads.length ? (
                      uploads.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell className="whitespace-nowrap">{format(new Date(u.startedAt), "yyyy-MM-dd HH:mm:ss")}</TableCell>
                          <TableCell>
                            <Badge variant={u.source === "MANUAL" ? "secondary" : "outline"}>{u.source}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusBadgeVariant(u.status)}>{u.status}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono">{u.accountsSentCount}</TableCell>
                          <TableCell className="text-right font-mono">{u.totalReceived ?? "—"}</TableCell>
                          <TableCell className="text-right font-mono">{u.insertedCount ?? "—"}</TableCell>
                          <TableCell className="text-right font-mono">{u.alreadyExistsCount ?? "—"}</TableCell>
                          <TableCell className="font-mono">{u.httpStatus ?? "—"}</TableCell>
                          <TableCell className="max-w-[300px] truncate text-xs text-red-600">
                            {u.errorMessage || ""}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={9} className="h-24 text-center">
                          {uploadsFrom || uploadsTo
                            ? "No uploads in the selected date range."
                            : `No uploads yet. Click "Upload NPL List Now" to push the current list to the CBS.`}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <span className="text-sm text-muted-foreground">
                  Page {uploadsPage} of {uploadsTotalPages}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setUploadsPage((p) => Math.max(1, p - 1))} disabled={uploadsPage <= 1}>
                    <ChevronLeft className="h-4 w-4" /> Prev
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setUploadsPage((p) => Math.min(uploadsTotalPages, p + 1))} disabled={uploadsPage >= uploadsTotalPages}>
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4 pt-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Notifications"
              value={(summary?.total ?? notifsTotal).toLocaleString()}
              hint={
                notifsFrom || notifsTo || debouncedSearch || statusFilter !== "all"
                  ? "Matching the current filters"
                  : "All credits received"
              }
              icon={Inbox}
              tone="info"
              loading={notifsLoading}
            />
            <StatTile
              label="Credited by CBS"
              value={formatAmount(summary?.totalCredited ?? 0)}
              hint="Total deposits detected"
              icon={ArrowDownToLine}
              loading={notifsLoading}
            />
            <StatTile
              label="Recovered"
              value={formatAmount(summary?.totalDebited ?? 0)}
              hint={`${repaidCount.toLocaleString()} repayment(s) posted`}
              icon={Banknote}
              tone="success"
              loading={notifsLoading}
            />
            <StatTile
              label="Needs attention"
              value={attentionCount.toLocaleString()}
              hint="Pending, failed or unmatched"
              icon={AlertTriangle}
              tone={attentionCount > 0 ? "danger" : "success"}
              loading={notifsLoading}
            />
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="relative flex-1 min-w-[280px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by account, correlationId, loan, txn id…"
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setNotifsPage(1); }}>
              <SelectTrigger className="w-[210px]">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="REPAID">Repaid</SelectItem>
                <SelectItem value="PARTIAL_REPAID">Partial Repaid</SelectItem>
                <SelectItem value="NO_OUTSTANDING">No Outstanding</SelectItem>
                <SelectItem value="UNMATCHED_ACCOUNT">Unmatched Account</SelectItem>
                <SelectItem value="DUPLICATE">Duplicate</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
              </SelectContent>
            </Select>
            <DateRangeFilter
              from={notifsFrom}
              to={notifsTo}
              onFromChange={(v) => { setNotifsFrom(v); setNotifsPage(1); }}
              onToChange={(v) => { setNotifsTo(v); setNotifsPage(1); }}
              onClear={() => { setNotifsFrom(""); setNotifsTo(""); setNotifsPage(1); }}
            />
            <ExportButton
              id="notifications"
              exporting={exporting}
              onClick={() => void exportNotifications()}
              disabled={notifsTotal === 0}
            />
            <Button variant="outline" onClick={() => void fetchNotifications()} disabled={notifsLoading}>
              {notifsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Inbound Credit Notifications</CardTitle>
              <CardDescription>
                Notifications received from the CBS when a credit (deposit) is detected on a monitored NPL account.
                The system immediately calls <code>POST /api/v1/notification/repay</code> for up to the outstanding balance and posts the resulting payment in our ledgers.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Received</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Credited</TableHead>
                      <TableHead className="text-right">Debited</TableHead>
                      <TableHead>Loan</TableHead>
                      <TableHead>CBS Txn</TableHead>
                      <TableHead>Attempts</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {notifsLoading ? (
                      <TableRow>
                        <TableCell colSpan={10} className="h-24 text-center">
                          <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                        </TableCell>
                      </TableRow>
                    ) : notifs.length ? (
                      notifs.map((n) => {
                        const canRetry = ["PENDING", "FAILED", "UNMATCHED_ACCOUNT", "NO_OUTSTANDING"].includes(n.processStatus);
                        return (
                          <TableRow key={n.id}>
                            <TableCell className="whitespace-nowrap">{format(new Date(n.receivedAt), "yyyy-MM-dd HH:mm:ss")}</TableCell>
                            <TableCell>
                              <Badge variant={statusBadgeVariant(n.processStatus)}>{n.processStatus.replace(/_/g, " ")}</Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs">{n.accountNumber}</TableCell>
                            <TableCell className="text-right font-mono">{formatAmount(n.creditedAmount)}</TableCell>
                            <TableCell className="text-right font-mono">{formatAmount(n.repayDebitAmount)}</TableCell>
                            <TableCell className="font-mono text-xs">{n.loanId ?? "—"}</TableCell>
                            <TableCell className="font-mono text-xs">{n.repayTransactionId ?? "—"}</TableCell>
                            <TableCell className="font-mono text-center">{n.attempts}</TableCell>
                            <TableCell className={cn("max-w-[280px] truncate text-xs", n.processStatus === "FAILED" || n.processStatus === "UNMATCHED_ACCOUNT" ? "text-red-600" : "")}>{n.resultMessage ?? ""}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={!canRetry || retryingId === n.id}
                                onClick={() => handleRetry(n.id)}
                              >
                                {retryingId === n.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  "Retry"
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableRow>
                        <TableCell colSpan={10} className="h-24 text-center">
                          {notifsFrom || notifsTo || debouncedSearch || statusFilter !== "all"
                            ? "No credit notifications match the current filters."
                            : "No credit notifications received yet."}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <span className="text-sm text-muted-foreground">
                  Page {notifsPage} of {notifsTotalPages}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setNotifsPage((p) => Math.max(1, p - 1))} disabled={notifsPage <= 1}>
                    <ChevronLeft className="h-4 w-4" /> Prev
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setNotifsPage((p) => Math.min(notifsTotalPages, p + 1))} disabled={notifsPage >= notifsTotalPages}>
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cleanup" className="space-y-4 pt-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label="Pending cleanup"
              value={staleTotal.toLocaleString()}
              hint="Still monitored by CBS after exiting NPL"
              icon={AlertTriangle}
              tone={staleTotal > 0 ? "warning" : "success"}
              loading={staleLoading}
            />
            <StatTile
              label="Deletions in range"
              value={deletionsTotal.toLocaleString()}
              hint={deletionsFrom || deletionsTo ? "Matching the selected dates" : "All delete calls to date"}
              icon={Trash2}
              tone="info"
              loading={deletionsLoading}
            />
            <StatTile
              label="Selected"
              value={selected.size.toLocaleString()}
              hint="Accounts ticked on this page"
              icon={CheckCircle2}
            />
          </div>

          <p className="text-sm text-muted-foreground">
            Remove accounts from CBS NPL monitoring via <code>DELETE /api/v1/notification/delete/&#123;accountNumber&#125;</code>.
            Accounts are now deleted automatically when a borrower exits NPL (loan fully repaid). Use this tab to clean
            up accounts that left NPL before the delete integration existed, or to delete a specific account manually.
          </p>

          {/* Manual single-account delete */}
          <Card>
            <CardHeader>
              <CardTitle>Delete a Specific Account</CardTitle>
              <CardDescription>
                Enter an account number to remove it from CBS monitoring immediately.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={manualAccount}
                  onChange={(e) => setManualAccount(e.target.value)}
                  placeholder="Account number"
                  className="max-w-xs font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleManualDelete();
                  }}
                />
                <Button
                  variant="destructive"
                  onClick={() => void handleManualDelete()}
                  disabled={deleting || !manualAccount.trim()}
                >
                  {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                  Delete from CBS
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Stale candidates */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Accounts Pending Cleanup</CardTitle>
                  <CardDescription>
                    Previously uploaded to CBS, no longer in the active NPL set, and not yet deleted.
                    {staleTotal > 0 ? ` ${staleTotal} account(s) found.` : ""}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ExportButton
                    id="stale"
                    exporting={exporting}
                    onClick={() => void exportStale()}
                    disabled={staleTotal === 0}
                  />
                  <Button variant="outline" size="sm" onClick={() => void fetchStale()} disabled={staleLoading || deleting}>
                    {staleLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    Recompute
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void runDelete(Array.from(selected), "Bulk cleanup of accounts that exited NPL.")}
                    disabled={deleting || selected.size === 0}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete Selected ({selected.size})
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" size="sm" disabled={deleting || staleTotal === 0}>
                        {deleting && deleteProgress ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {deleteProgress.done}/{deleteProgress.total}
                          </>
                        ) : (
                          <>
                            <Trash2 className="mr-2 h-4 w-4" /> Delete All ({staleTotal})
                          </>
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete all {staleTotal} account(s) from CBS?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This removes every account pending cleanup from CBS monitoring. They will be re-added
                          on the next upload only if they return to NPL. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleDeleteAll()}>
                          Delete All
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="w-[48px]">
                        <Checkbox
                          checked={stale.length > 0 && selected.size === stale.length}
                          onCheckedChange={toggleSelectAll}
                          aria-label="Select all"
                        />
                      </TableHead>
                      <TableHead>Account Number</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {staleLoading ? (
                      <TableRow>
                        <TableCell colSpan={3} className="h-24 text-center">
                          <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                        </TableCell>
                      </TableRow>
                    ) : stale.length ? (
                      stale.map((acc) => (
                        <TableRow key={acc}>
                          <TableCell>
                            <Checkbox
                              checked={selected.has(acc)}
                              onCheckedChange={() => toggleSelect(acc)}
                              aria-label={`Select ${acc}`}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-sm">{acc}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={deleting}
                              onClick={() => void runDelete([acc], "Manual single-account deletion from NPL Collection page.")}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={3} className="h-24 text-center">
                          No accounts pending cleanup. CBS monitoring is in sync.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <span className="text-sm text-muted-foreground">
                  Page {stalePage} of {staleTotalPages}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setStalePage((p) => Math.max(1, p - 1))} disabled={stalePage <= 1}>
                    <ChevronLeft className="h-4 w-4" /> Prev
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setStalePage((p) => Math.min(staleTotalPages, p + 1))} disabled={stalePage >= staleTotalPages}>
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Deletion history */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <CardTitle>Recent Deletions</CardTitle>
                  <CardDescription>Outbound delete calls to the CBS (automatic and manual).</CardDescription>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <DateRangeFilter
                    from={deletionsFrom}
                    to={deletionsTo}
                    onFromChange={(v) => { setDeletionsFrom(v); setDeletionsPage(1); }}
                    onToChange={(v) => { setDeletionsTo(v); setDeletionsPage(1); }}
                    onClear={() => { setDeletionsFrom(""); setDeletionsTo(""); setDeletionsPage(1); }}
                  />
                  <ExportButton
                    id="deletions"
                    exporting={exporting}
                    onClick={() => void exportDeletions()}
                    disabled={deletionsTotal === 0}
                  />
                  <Button variant="outline" size="sm" onClick={() => void fetchDeletions()} disabled={deletionsLoading}>
                    {deletionsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>HTTP</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deletionsLoading ? (
                      <TableRow>
                        <TableCell colSpan={7} className="h-24 text-center">
                          <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                        </TableCell>
                      </TableRow>
                    ) : deletions.length ? (
                      deletions.map((d) => (
                        <TableRow key={d.id}>
                          <TableCell className="whitespace-nowrap">{format(new Date(d.createdAt), "yyyy-MM-dd HH:mm:ss")}</TableCell>
                          <TableCell className="font-mono text-xs">{d.accountNumber}</TableCell>
                          <TableCell>
                            <Badge variant={d.source === "MANUAL" ? "secondary" : "outline"}>{d.source}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusBadgeVariant(d.status)}>{d.status}</Badge>
                          </TableCell>
                          <TableCell className="font-mono">{d.httpStatus ?? "—"}</TableCell>
                          <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">{d.reason ?? ""}</TableCell>
                          <TableCell className="max-w-[260px] truncate text-xs text-red-600">{d.errorMessage ?? ""}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={7} className="h-24 text-center">
                          {deletionsFrom || deletionsTo
                            ? "No deletions in the selected date range."
                            : "No deletions yet."}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <span className="text-sm text-muted-foreground">
                  Page {deletionsPage} of {deletionsTotalPages}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setDeletionsPage((p) => Math.max(1, p - 1))} disabled={deletionsPage <= 1}>
                    <ChevronLeft className="h-4 w-4" /> Prev
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeletionsPage((p) => Math.min(deletionsTotalPages, p + 1))} disabled={deletionsPage >= deletionsTotalPages}>
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
