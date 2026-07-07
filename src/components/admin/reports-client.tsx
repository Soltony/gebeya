"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download, Loader2, Calendar as CalendarIcon, Search } from "lucide-react";
import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import { useToast } from "@/hooks/use-toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LoanProvider,
  type LoanReportData,
  type CollectionsReportData,
  ProviderReportData,
} from "@/lib/types";
import { Badge } from "../ui/badge";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Calendar } from "../ui/calendar";
import { DateRange } from "react-day-picker";

const formatCurrency = (amount: number | null | undefined) => {
  if (amount === null || amount === undefined || isNaN(amount)) return "0.00";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

const sanitizeCellValue = (value: any): any => {
  if (typeof value === "string") {
    if (["=", "+", "-", "@"].some((char) => value.startsWith(char))) {
      return `'${value}`;
    }
  }
  return value;
};

const TIMEFRAMES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "This Week" },
  { value: "monthly", label: "This Month" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semiAnnually", label: "Semi-Annually" },
  { value: "annually", label: "Annually" },
  { value: "custom", label: "Custom Range" },
  { value: "overall", label: "Overall" },
];

export function ReportsClient({ providers }: { providers: LoanProvider[] }) {
  const { toast } = useToast();
  const { currentUser, isLoading: isAuthLoading } = useAuth();

  const [timeframe, setTimeframe] = useState("overall");
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [providerId, setProviderId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("providerReport");
  
  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Paginated data states with metadata
  const [loansData, setLoansData] = useState<LoanReportData[]>([]);
  const [loansPagination, setLoansPagination] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 0 });
  
  const [collectionsData, setCollectionsData] = useState<CollectionsReportData[]>([]);
  const [collectionsPagination, setCollectionsPagination] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 0 });
  
  const [disbursementsData, setDisbursementsData] = useState<any[]>([]);
  const [disbursementsPagination, setDisbursementsPagination] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 0 });
  
  const [repaymentsData, setRepaymentsData] = useState<any[]>([]);
  const [repaymentsPagination, setRepaymentsPagination] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 0 });
  
  const [providerSummaryData, setProviderSummaryData] = useState<
    Record<string, ProviderReportData>
  >({});
  const [isExporting, setIsExporting] = useState(false);

  // Direct Payment state
  const [directPaymentData, setDirectPaymentData] = useState<any[]>([]);
  const [directPaymentPagination, setDirectPaymentPagination] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 0 });
  const [isDirectPaymentLoading, setIsDirectPaymentLoading] = useState(false);

  // Subscription Report state
  const [districts, setDistricts] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [branchSubData, setBranchSubData] = useState<any[]>([]);
  const [branchSubPagination, setBranchSubPagination] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 0 });
  const [isBranchSubLoading, setIsBranchSubLoading] = useState(false);
  const [branchSubSearch, setBranchSubSearch] = useState("");
  const [branchSubDistrict, setBranchSubDistrict] = useState("all");
  const [branchSubStatus, setBranchSubStatus] = useState("all");
  const [branchSubDate, setBranchSubDate] = useState("");
  const [selectedBranchId, setSelectedBranchId] = useState<string>("");
  const [merchantData, setMerchantData] = useState<any[]>([]);
  const [merchantPagination, setMerchantPagination] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 0 });
  const [isMerchantLoading, setIsMerchantLoading] = useState(false);

  const isSuperAdminOrRecon =
    currentUser?.role === "Super Admin" ||
    currentUser?.role === "Reconciliation";

  // Check if user can view all providers (either super admin/recon OR has reports permission with multiple providers)
  // Users with a loanProviderId are bound to a specific provider and should only see that provider's reports
  const canViewAllProviders =
    isSuperAdminOrRecon ||
    (!!currentUser?.permissions?.["reports"]?.read && providers.length > 1 && !currentUser?.loanProviderId);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  type SortDir = "asc" | "desc";
  type TableState = {
    sortBy?: string;
    sortDir: SortDir;
    page: number;
    pageSize: number;
  };

  const DEFAULT_PAGE_SIZE = 50;
  const EXPORT_PAGE_SIZE = 200;

  function compareValues(a: any, b: any, dir: SortDir) {
    if (a == null && b == null) return 0;
    if (a == null) return dir === "asc" ? -1 : 1;
    if (b == null) return dir === "asc" ? 1 : -1;

    if (typeof a === "number" && typeof b === "number") {
      return dir === "asc" ? a - b : b - a;
    }

    const aDate = new Date(a);
    const bDate = new Date(b);
    if (!isNaN(aDate.getTime()) && !isNaN(bDate.getTime())) {
      return dir === "asc"
        ? aDate.getTime() - bDate.getTime()
        : bDate.getTime() - aDate.getTime();
    }

    return dir === "asc"
      ? String(a).localeCompare(String(b))
      : String(b).localeCompare(String(a));
  }

  const [tableStates, setTableStates] = useState<Record<string, TableState>>({
    providerReport: {
      sortBy: "provider",
      sortDir: "asc",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    },
    disbursementsReport: {
      sortBy: "transactionDate",
      sortDir: "desc",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    },
    repaymentsReport: {
      sortBy: "transactionDate",
      sortDir: "desc",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    },
    collectionsReport: {
      sortBy: "date",
      sortDir: "desc",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    },

    utilizationReport: {
      sortBy: "Provider",
      sortDir: "asc",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    },
    agingReport: {
      sortBy: "Provider",
      sortDir: "asc",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    },
    borrowerReport: {
      sortBy: "borrowerId",
      sortDir: "asc",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    },
    borrowerAging: {
      sortBy: "borrowerId",
      sortDir: "asc",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    },
  });

  const setTableState = (
    tab: string,
    updater: Partial<TableState> | ((s: TableState) => TableState)
  ) => {
    setTableStates((prev) => {
      const cur = prev[tab] ?? {
        sortBy: undefined,
        sortDir: "asc",
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      };
      const next =
        typeof updater === "function" ? updater(cur) : { ...cur, ...updater };
      return { ...prev, [tab]: next };
    });
  };

  useEffect(() => {
    setTableState(activeTab, { page: 1 });
  }, [activeTab]);

  // Helper to build URL with pagination params
  const buildPaginatedUrl = useCallback((
    baseUrl: string,
    currentProviderId: string,
    currentTimeframe: string,
    currentDateRange?: DateRange,
    page: number = 1,
    pageSize: number = DEFAULT_PAGE_SIZE,
    search?: string
  ) => {
    const params = new URLSearchParams({
      providerId: currentProviderId,
      timeframe: currentTimeframe,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (currentDateRange?.from) {
      params.set("from", currentDateRange.from.toISOString());
    }
    if (currentDateRange?.to) {
      params.set("to", currentDateRange.to.toISOString());
    }
    if (search) {
      params.set("search", search);
    }
    return `${baseUrl}?${params.toString()}`;
  }, []);

  // Individual fetch functions for each report type
  const fetchLoansData = useCallback(async (page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE) => {
    if (!providerId || providerId === "none") return;
    try {
      const response = await fetch(buildPaginatedUrl("/api/reports/loans", providerId, timeframe, dateRange, page, pageSize, debouncedSearch));
      if (!response.ok) throw new Error("Failed to fetch loans data");
      const result = await response.json();
      setLoansData(result.data || []);
      setLoansPagination({ total: result.total || 0, page: result.page || 1, pageSize: result.pageSize || pageSize, totalPages: result.totalPages || 0 });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  }, [providerId, timeframe, dateRange, debouncedSearch, buildPaginatedUrl, toast]);

  const fetchCollectionsData = useCallback(async (page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE) => {
    if (!providerId || providerId === "none") return;
    try {
      const response = await fetch(
        buildPaginatedUrl(
          "/api/reports/collections",
          providerId,
          timeframe,
          dateRange,
          page,
          pageSize,
          debouncedSearch
        )
      );
      if (!response.ok) throw new Error("Failed to fetch collections data");
      const result = await response.json();
      setCollectionsData(result.data || []);
      setCollectionsPagination({ total: result.total || 0, page: result.page || 1, pageSize: result.pageSize || pageSize, totalPages: result.totalPages || 0 });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  }, [providerId, timeframe, dateRange, debouncedSearch, buildPaginatedUrl, toast]);

  const fetchDisbursementsData = useCallback(async (page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE) => {
    if (!providerId || providerId === "none") return;
    try {
      const url =
        buildPaginatedUrl(
          "/api/reports/transactions",
          providerId,
          timeframe,
          dateRange,
          page,
          pageSize,
          debouncedSearch
        ) + "&type=disbursement";
      const response = await fetch(url);
      if (!response.ok) throw new Error("Failed to fetch disbursements data");
      const result = await response.json();
      setDisbursementsData(result.data || []);
      setDisbursementsPagination({ total: result.total || 0, page: result.page || 1, pageSize: result.pageSize || pageSize, totalPages: result.totalPages || 0 });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  }, [providerId, timeframe, dateRange, debouncedSearch, buildPaginatedUrl, toast]);

  const fetchRepaymentsData = useCallback(async (page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE) => {
    if (!providerId || providerId === "none") return;
    try {
      const url =
        buildPaginatedUrl(
          "/api/reports/transactions",
          providerId,
          timeframe,
          dateRange,
          page,
          pageSize,
          debouncedSearch
        ) + "&type=repayment";
      const response = await fetch(url);
      if (!response.ok) throw new Error("Failed to fetch repayments data");
      const result = await response.json();
      setRepaymentsData(result.data || []);
      setRepaymentsPagination({ total: result.total || 0, page: result.page || 1, pageSize: result.pageSize || pageSize, totalPages: result.totalPages || 0 });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  }, [providerId, timeframe, dateRange, debouncedSearch, buildPaginatedUrl, toast]);

  // --- Direct Payment fetch ---
  const fetchDirectPaymentData = useCallback(async (page: number = 1, pageSize: number = 50) => {
    setIsDirectPaymentLoading(true);
    try {
      const params = new URLSearchParams({
        timeframe,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (dateRange?.from) params.set("from", dateRange.from.toISOString());
      if (dateRange?.to) params.set("to", dateRange.to.toISOString());
      if (debouncedSearch) params.set("search", debouncedSearch);
      const response = await fetch(`/api/reports/direct-payments?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch direct payments");
      const result = await response.json();
      setDirectPaymentData(result.data || []);
      setDirectPaymentPagination({ total: result.total || 0, page: result.page || 1, pageSize: result.pageSize || pageSize, totalPages: result.totalPages || 0 });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setIsDirectPaymentLoading(false);
    }
  }, [timeframe, dateRange, debouncedSearch, toast]);

  // --- Subscription: fetch districts list ---
  const fetchDistricts = useCallback(async () => {
    try {
      const response = await fetch("/api/districts");
      if (!response.ok) return;
      const data = await response.json();
      setDistricts(data || []);
    } catch {}
  }, []);

  // --- Subscription: fetch all branches for the branch selector ---
  const fetchAllBranches = useCallback(async () => {
    try {
      const response = await fetch("/api/districts/branches");
      if (!response.ok) return;
      const data = await response.json();
      setBranches(data || []);
    } catch {}
  }, []);

  // --- Subscription: fetch branch subscription data ---
  const fetchBranchSubscriptionData = useCallback(async (page: number = 1, pageSize: number = 50) => {
    setIsBranchSubLoading(true);
    try {
      const params = new URLSearchParams({
        type: "branches",
        page: String(page),
        pageSize: String(pageSize),
      });
      if (branchSubSearch) params.set("search", branchSubSearch);
      if (branchSubDistrict && branchSubDistrict !== "all") params.set("districtId", branchSubDistrict);
      if (branchSubStatus && branchSubStatus !== "all") params.set("status", branchSubStatus);
      if (branchSubDate) params.set("date", branchSubDate);
      const response = await fetch(`/api/reports/subscriptions?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch branch data");
      const result = await response.json();
      setBranchSubData(result.data || []);
      setBranchSubPagination({ total: result.total || 0, page: result.page || 1, pageSize: result.pageSize || pageSize, totalPages: result.totalPages || 0 });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setIsBranchSubLoading(false);
    }
  }, [branchSubSearch, branchSubDistrict, branchSubStatus, branchSubDate, toast]);

  // --- Subscription: fetch merchant details for a branch ---
  const fetchMerchantDetails = useCallback(async (branchId: string, page: number = 1, pageSize: number = 50) => {
    if (!branchId) return;
    setIsMerchantLoading(true);
    try {
      const params = new URLSearchParams({
        type: "merchants",
        branchId,
        page: String(page),
        pageSize: String(pageSize),
      });
      const response = await fetch(`/api/reports/subscriptions?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch merchants");
      const result = await response.json();
      setMerchantData(result.data || []);
      setMerchantPagination({ total: result.total || 0, page: result.page || 1, pageSize: result.pageSize || pageSize, totalPages: result.totalPages || 0 });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setIsMerchantLoading(false);
    }
  }, [toast]);

  // Load districts and branches on mount for subscription tab
  useEffect(() => {
    fetchDistricts();
    fetchAllBranches();
  }, [fetchDistricts, fetchAllBranches]);

  // Fetch branch subscription data when filters change
  useEffect(() => {
    fetchBranchSubscriptionData(1, branchSubPagination.pageSize);
  }, [branchSubSearch, branchSubDistrict, branchSubStatus, branchSubDate]);

  // Fetch direct payment data when the direct payment tab is active
  useEffect(() => {
    if (activeTab === "directPaymentReport") {
      fetchDirectPaymentData(1, directPaymentPagination.pageSize);
    }
  }, [activeTab, timeframe, dateRange, debouncedSearch]);

  // Fetch merchants when branch is selected
  useEffect(() => {
    if (selectedBranchId) {
      fetchMerchantDetails(selectedBranchId, 1, merchantPagination.pageSize);
    } else {
      setMerchantData([]);
      setMerchantPagination({ total: 0, page: 1, pageSize: 50, totalPages: 0 });
    }
  }, [selectedBranchId]);

  const fetchAllReportData = useCallback(
    async (
      currentProviderId: string,
      currentTimeframe: string,
      currentDateRange?: DateRange,
      currentSearch?: string
    ) => {
      setIsLoading(true);
      try {
        const fetchDataForTab = async (url: string) => {
          const response = await fetch(url);
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `Failed to fetch data.`);
          }
          return response.json();
        };

        const buildUrl = (baseUrl: string, page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE) => {
          const params = new URLSearchParams({
            providerId: currentProviderId,
            timeframe: currentTimeframe,
            page: String(page),
            pageSize: String(pageSize),
          });
          if (currentDateRange?.from) {
            params.set("from", currentDateRange.from.toISOString());
          }
          if (currentDateRange?.to) {
            params.set("to", currentDateRange.to.toISOString());
          }
          if (currentSearch) {
            params.set("search", currentSearch);
          }
          return `${baseUrl}?${params.toString()}`;
        };

        const loansPromise = fetchDataForTab(buildUrl("/api/reports/loans"));
        const collectionsPromise = fetchDataForTab(
          buildUrl("/api/reports/collections")
        );
        const disbursementsPromise = fetchDataForTab(
          buildUrl("/api/reports/transactions") + "&type=disbursement"
        );
        const repaymentsPromise = fetchDataForTab(
          buildUrl("/api/reports/transactions") + "&type=repayment"
        );

        const summaryProviders =
          currentProviderId === "all" &&
          providers.length > 1 &&
          canViewAllProviders
            ? providers
            : [providers.find((p) => p.id === currentProviderId)!].filter(
                Boolean
              );

        const summaryPromises = summaryProviders.map((p) =>
          fetchDataForTab(
            buildUrl(`/api/reports/provider-summary`).replace(
              `providerId=${currentProviderId}`,
              `providerId=${p.id}`
            )
          )
            .then((data) => ({ [p.id]: data }))
            .catch((err) => {
              console.error(
                `Failed to fetch summary for provider ${p.id}:`,
                err.message
              );
              return { [p.id]: null }; // Return null on error for this provider
            })
        );

        const [
          loansResult,
          collectionsResult,
          disbursementsResult,
          repaymentsResult,
          ...summaryResults
        ] = await Promise.all([
          loansPromise,
          collectionsPromise,
          disbursementsPromise,
          repaymentsPromise,
          ...summaryPromises,
        ]);

        // Handle paginated responses
        setLoansData(loansResult.data || []);
        setLoansPagination({ 
          total: loansResult.total || 0, 
          page: loansResult.page || 1, 
          pageSize: loansResult.pageSize || DEFAULT_PAGE_SIZE, 
          totalPages: loansResult.totalPages || 0 
        });

        setCollectionsData(collectionsResult.data || []);
        setCollectionsPagination({ 
          total: collectionsResult.total || 0, 
          page: collectionsResult.page || 1, 
          pageSize: collectionsResult.pageSize || DEFAULT_PAGE_SIZE, 
          totalPages: collectionsResult.totalPages || 0 
        });

        setDisbursementsData(disbursementsResult.data || []);
        setDisbursementsPagination({ 
          total: disbursementsResult.total || 0, 
          page: disbursementsResult.page || 1, 
          pageSize: disbursementsResult.pageSize || DEFAULT_PAGE_SIZE, 
          totalPages: disbursementsResult.totalPages || 0 
        });

        setRepaymentsData(repaymentsResult.data || []);
        setRepaymentsPagination({ 
          total: repaymentsResult.total || 0, 
          page: repaymentsResult.page || 1, 
          pageSize: repaymentsResult.pageSize || DEFAULT_PAGE_SIZE, 
          totalPages: repaymentsResult.totalPages || 0 
        });

        const newSummaryData = summaryResults.reduce(
          (acc, current) => ({ ...acc, ...current }),
          {} as Record<string, any>
        );
        // remove null entries returned when a provider summary failed to fetch
        for (const k of Object.keys(newSummaryData)) {
          if (newSummaryData[k] === null) delete newSummaryData[k];
        }
        setProviderSummaryData(newSummaryData as Record<string, any>);
      } catch (error: any) {
        toast({
          title: "Error fetching report data",
          description: error.message,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    },
    [toast, providers, canViewAllProviders]
  );

  // Effect to set the initial providerId and fetch data ONCE
  useEffect(() => {
    if (isAuthLoading) return; // Wait for user data to be available

    let initialProviderId: string | null = null;
    if (canViewAllProviders) {
      initialProviderId = "all";
    } else if (currentUser?.loanProviderId) {
      initialProviderId = currentUser.loanProviderId;
    } else if (providers.length === 1) {
      // Single provider available, select it
      initialProviderId = providers[0].id;
    } else if (providers.length > 0) {
      // Multiple providers available but user can't view all - select first one
      initialProviderId = providers[0].id;
    } else {
      initialProviderId = "none"; // No providers available
    }

    setProviderId(initialProviderId);

    if (initialProviderId && initialProviderId !== "none") {
      fetchAllReportData(initialProviderId, "overall", undefined);
    } else {
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthLoading, currentUser?.loanProviderId, canViewAllProviders, providers]);

  // Effect to refetch data when filters change, but not on initial load
  useEffect(() => {
    // This check prevents refetching on the initial render where providerId is still null
    if (providerId !== null) {
      fetchAllReportData(providerId, timeframe, dateRange, debouncedSearch);
    }
  }, [providerId, timeframe, dateRange, debouncedSearch, fetchAllReportData]);

  const handleExcelExport = async () => {
    if (!providerId || providerId === "none") {
      toast({
        description: "No provider selected for export.",
        variant: "destructive",
      });
      return;
    }

    setIsExporting(true);

    try {
      const wb = new ExcelJS.Workbook();
      const providerList = (
        providerId === "all"
          ? providers
          : [providers.find((p) => p.id === providerId)!]
      ).filter(Boolean);

      const addSanitizedRows = (worksheet: ExcelJS.Worksheet, data: any[]) => {
        if (data.length > 0) {
          worksheet.columns = Object.keys(data[0]).map((k) => ({
            header: k,
            key: k,
          }));
          data.forEach((row) => {
            const sanitizedRow: { [key: string]: any } = {};
            for (const key in row) {
              sanitizedRow[key] = sanitizeCellValue(row[key]);
            }
            worksheet.addRow(sanitizedRow);
          });
        }
      };

      const formatDateForExport = (value?: string | Date | null) => {
        if (!value) return "";
        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime())
          ? ""
          : format(date, "yyyy-MM-dd");
      };

      const fetchAllPages = async (
        buildUrl: (page: number, pageSize: number) => string
      ) => {
        const pageSize = EXPORT_PAGE_SIZE;
        let page = 1;
        let totalPages = 1;
        const all: any[] = [];

        do {
          const url = buildUrl(page, pageSize);
          const resp = await fetch(url);
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(
              errData.error || `Failed to fetch data for export.`
            );
          }
          const result = await resp.json();
          const data = result.data || [];
          all.push(...data);
          totalPages = result.totalPages || 1;
          page += 1;
        } while (page <= totalPages);

        return all;
      };

      const buildBaseUrl = (base: string) => (page: number, pageSize: number) =>
        buildPaginatedUrl(
          base,
          providerId,
          timeframe,
          dateRange,
          page,
          pageSize,
          debouncedSearch
        );

      const [allLoans, allCollections, allDisbursements, allRepayments] =
        await Promise.all([
          fetchAllPages(buildBaseUrl("/api/reports/loans")),
          fetchAllPages(buildBaseUrl("/api/reports/collections")),
          fetchAllPages((page, pageSize) =>
            buildBaseUrl("/api/reports/transactions")(page, pageSize) +
            "&type=disbursement"
          ),
          fetchAllPages((page, pageSize) =>
            buildBaseUrl("/api/reports/transactions")(page, pageSize) +
            "&type=repayment"
          ),
        ]);

      // 1. Provider Loans
      if (allLoans.length > 0) {
        const providerLoanData = allLoans.map((d: any) => ({
          Provider: d.provider,
          "Loan ID": d.loanId,
          Borrower: d.borrowerName,
          "Principal Disbursed": d.principalDisbursed,
          "Principal Outstanding": d.principalOutstanding,
          "Interest (Daily Fee) Outstanding": d.interestOutstanding,
          "Service Fee Outstanding": d.serviceFeeOutstanding,
          "Penalty Outstanding": d.penaltyOutstanding,
          "Total Outstanding": d.totalOutstanding,
          Status: d.status,
        }));
        const wsProvider = wb.addWorksheet("Provider Loans");
        addSanitizedRows(wsProvider, providerLoanData);
      }

      // 2. Collections
      if (allCollections.length > 0) {
        const collectionsExportData = allCollections.map((d: any) => ({
          Provider: d.provider,
          Date: format(new Date(d.date), "yyyy-MM-dd"),
          "Principal Received": d.principal,
          "Interest Received": d.interest,
          "Service Fee Received": d.serviceFee,
          "Penalty Received": d.penalty,
          "Tax Received": d.tax,
          "Total Collected": d.total,
        }));
        const ws = wb.addWorksheet("Collections");
        addSanitizedRows(ws, collectionsExportData);
      }

      // 4. Fund Utilization
      const utilizationExportData = providerList
        .map((p) => {
          const data = providerSummaryData[p.id];
          if (!data) return null;
          const availableFund =
            p.startingCapital - data.portfolioSummary.outstanding;
          return {
            Provider: p.name,
            "Provider Fund": p.startingCapital,
            "Loans Disbursed": data.portfolioSummary.disbursed,
            "Outstanding Principal": data.portfolioSummary.outstanding,
            "Available Fund": availableFund,
            "Utilization %": data.fundUtilization,
          };
        })
        .filter(Boolean);
      if (utilizationExportData.length > 0) {
        const ws = wb.addWorksheet("Fund Utilization");
        addSanitizedRows(ws, utilizationExportData as any[]);
      }

      // 5. Disbursements
      if (allDisbursements.length > 0) {
        const disbExport = allDisbursements.map((r: any) => {
          const loanAmt = r.principalDisbursed || 0;
          const interestFee = r.interestOutstanding || 0;
          const serviceFee = r.serviceFeeOutstanding || 0;
          const netDisbursed =
            r.netDisbursed != null ? r.netDisbursed : loanAmt;
          const cbsCredit = r.cbsCreditAmount ?? 0;
          const diff = netDisbursed - cbsCredit;
          return {
            Provider: r.provider,
            Date: formatDateForExport(r.transactionDate),
            "Loan ID": r.loanId,
            "Customer Name":
              r.customerName ||
              r.borrowerName ||
              r.borrowerAccount ||
              r.borrowerId ||
              "",
            "Debit Account": r.debitAccount,
            "Credit Account":
              r.disbursementCreditAccount || r.creditAccount,
            "Customer Account":
              r.borrowerAccount || r.borrowerId || "",
            "Txn Status":
              r.disbursementOutcome ||
              r.disbursementStatusText ||
              r.transactionStatus,
            "CBS Reference": r.cbsReference || r.reference,
            "Loan Amount (MLS)": loanAmt,
            "Interest Fee (MLS)": interestFee,
            "Service Fee (MLS)": serviceFee,
            "Net Disbursed (MLS)": netDisbursed,
            "CBS Credit Amount": cbsCredit,
            "Due Date": formatDateForExport(r.dueDate),
            Difference: diff,
          };
        });
        const ws = wb.addWorksheet("Disbursements");
        addSanitizedRows(ws, disbExport);
      }

      // 6. Repayments
      if (allRepayments.length > 0) {
        const repExport = allRepayments.map((r: any) => ({
          Provider: r.provider,
          "Loan ID": r.loanId,
          "Customer Name":
            r.customerName ||
            r.borrowerName ||
            r.borrowerAccount ||
            r.borrowerId ||
            "",
          "Transaction Date": formatDateForExport(r.transactionDate),
          "Due Date": formatDateForExport(r.dueDate),
          "Debit Account": r.debitAccount,
          "Credit Account": r.borrowerAccount || r.creditAccount,
          "Txn Status": r.transactionStatus,
          Reference: r.reference,
          "Product Type": r.productType,
          Borrower: r.borrowerId,
          "Principal Disbursed": r.principalDisbursed,
          "Principal Outstanding": r.principalOutstanding,
          "Interest Outstanding": r.interestOutstanding,
          "Service Fee Outstanding": r.serviceFeeOutstanding,
          "Penalty Outstanding": r.penaltyOutstanding,
          "Total Outstanding": r.totalOutstanding,
          Status: r.status,
        }));
        const ws = wb.addWorksheet("Repayments");
        addSanitizedRows(ws, repExport);
      }

      // 5. Aging Report
      const agingExportData = providerList
        .map((p) => {
          const data = providerSummaryData[p.id];
          if (!data) return null;
          const aging = data.agingReport;
          return {
            Provider: p.name,
            "Pass (0-29 Days)": aging?.buckets?.Pass || 0,
            "Special Mention (30-89 Days)":
              aging?.buckets?.["Special Mention"] || 0,
            "Substandard (90-179 Days)": aging?.buckets?.Substandard || 0,
            "Doubtful (180-359 Days)": aging?.buckets?.Doubtful || 0,
            "Loss (360+ Days)": aging?.buckets?.Loss || 0,
            "Total Overdue": aging?.totalOverdue || 0,
          };
        })
        .filter(Boolean);
      if (agingExportData.length > 0) {
        const ws = wb.addWorksheet("Aging Report");
        addSanitizedRows(ws, agingExportData as any[]);
      }

      // Borrower-level Aging export (flattened across providers)
      const borrowerAgingExport: any[] = [];
      providerList.forEach((p) => {
        const data = providerSummaryData[p.id];
        const borrowers = data?.agingReport?.byBorrower || [];
        borrowers.forEach((b: any) => {
          borrowerAgingExport.push({
            Provider: p.name,
            Borrower: b.borrowerId,
            "Borrower Account": b.borrowerAccount || "",
            "Borrower Name": b.borrowerName || "",
            "Days Overdue": b.daysOverdue ?? "",
            Category: b.classification || "",
            "Principal Outstanding": b.principalOutstanding || 0,
            "Interest Outstanding": b.interestOutstanding || 0,
            "Service Fee Outstanding": b.serviceFeeOutstanding || 0,
            "Penalty Outstanding": b.penaltyOutstanding || 0,
            "Total Outstanding": b.classificationAmount || b.totalOverdue || 0,
          });
        });
      });
      if (borrowerAgingExport.length > 0) {
        const wsB = wb.addWorksheet("Borrower Aging");
        addSanitizedRows(wsB, borrowerAgingExport);
      }

      // 6. Borrower Performance
      if (allLoans.length > 0) {
        const borrowerPerfData = allLoans.map((d: any) => ({
          "Borrower ID": d.borrowerId,
          "Borrower Name": d.borrowerName,
          "Loan ID": d.loanId,
          "Principal Disbursed": d.principalDisbursed,
          "Principal Outstanding": d.principalOutstanding,
          "Interest Outstanding": d.interestOutstanding,
          "Service Fee Outstanding": d.serviceFeeOutstanding,
          "Penalty Outstanding": d.penaltyOutstanding,
          "Days in Arrears": d.daysInArrears,
          Status: d.status,
        }));
        const wsBorrower = wb.addWorksheet("Borrower Performance");
        addSanitizedRows(wsBorrower, borrowerPerfData);
      }

      // If workbook has no worksheets (no data), inform the user
      if (wb.worksheets.length === 0) {
        toast({
          description: "No data available to export.",
          variant: "destructive",
        });
        return;
      }

      const buffer = await wb.xlsx.writeBuffer();
      saveAs(
        new Blob([buffer], { type: "application/octet-stream" }),
        `LoanFlow_Report_${timeframe}_${
          new Date().toISOString().split("T")[0]
        }.xlsx`
      );
    } catch (err: any) {
      console.error("Failed to generate Excel file", err);
      toast({
        title: "Export Failed",
        description: err?.message || "Could not generate Excel file.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  // Generic helpers: sort + paginate for current tab
  const getTableState = (tab: string) =>
    tableStates[tab] ?? {
      sortBy: undefined,
      sortDir: "asc" as SortDir,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    };

  const applySortAndPaginate = (tab: string, data: any[]) => {
    const state = getTableState(tab);
    const { sortBy, sortDir, page, pageSize } = state;
    let sorted = [...data];
    if (sortBy) {
      sorted.sort((a, b) => compareValues(a?.[sortBy], b?.[sortBy], sortDir));
    }
    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const start = (currentPage - 1) * pageSize;
    const items = sorted.slice(start, start + pageSize);
    return { items, total, totalPages, page: currentPage, pageSize };
  };

  const toggleSort = (tab: string, key: string) => {
    const s = getTableState(tab);
    if (s.sortBy === key) {
      setTableState(tab, {
        sortDir: s.sortDir === "asc" ? "desc" : "asc",
        page: 1,
      });
    } else {
      setTableState(tab, { sortBy: key, sortDir: "asc", page: 1 });
    }
  };

  const renderSortIcon = (tab: string, key: string) => {
    const s = getTableState(tab);
    if (s.sortBy !== key) return <span className="opacity-50 ml-2">↕</span>;
    return s.sortDir === "asc" ? (
      <span className="ml-2">▲</span>
    ) : (
      <span className="ml-2">▼</span>
    );
  };

  const PaginationControls = ({
    tab,
    meta,
    onPageChange,
    onPageSizeChange,
  }: {
    tab: string;
    meta: { total: number; totalPages: number; page: number; pageSize: number };
    onPageChange?: (page: number) => void;
    onPageSizeChange?: (pageSize: number) => void;
  }) => {
    if (meta.total === 0) return null;
    return (
      <div className="flex items-center justify-between p-2 border-t">
        <div className="text-sm text-muted-foreground">
          Showing {(meta.page - 1) * meta.pageSize + 1} -{" "}
          {Math.min(meta.page * meta.pageSize, meta.total)} of {meta.total}
        </div>
        <div className="flex items-center space-x-2">
          <select
            value={meta.pageSize}
            onChange={(e) => {
              const newPageSize = Number(e.target.value);
              if (onPageSizeChange) {
                onPageSizeChange(newPageSize);
              } else {
                setTableState(tab, { pageSize: newPageSize, page: 1 });
              }
            }}
            className="border rounded px-2 py-1"
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <div className="flex items-center space-x-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const newPage = Math.max(1, meta.page - 1);
                if (onPageChange) {
                  onPageChange(newPage);
                } else {
                  setTableState(tab, (s) => ({ ...s, page: newPage }));
                }
              }}
              disabled={meta.page <= 1}
            >
              Prev
            </Button>
            <div className="px-2">
              {meta.page} / {meta.totalPages}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const newPage = Math.min(meta.totalPages, meta.page + 1);
                if (onPageChange) {
                  onPageChange(newPage);
                } else {
                  setTableState(tab, (s) => ({ ...s, page: newPage }));
                }
              }}
              disabled={meta.page >= meta.totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    );
  };

  // derive processed datasets - for server-paginated tabs, just return the data directly
  const providerTable = useMemo(
    () => ({
      items: loansData,
      ...loansPagination,
    }),
    [loansData, loansPagination]
  );
  const disbursementTable = useMemo(
    () => ({
      items: disbursementsData,
      ...disbursementsPagination,
    }),
    [disbursementsData, disbursementsPagination]
  );
  const repaymentTable = useMemo(
    () => ({
      items: repaymentsData,
      ...repaymentsPagination,
    }),
    [repaymentsData, repaymentsPagination]
  );
  const collectionsTable = useMemo(
    () => ({
      items: collectionsData,
      ...collectionsPagination,
    }),
    [collectionsData, collectionsPagination]
  );

  const utilizationTable = useMemo(() => {
    const rows = providers
      .filter((p) => providerId === "all" || p.id === providerId)
      .map((provider) => {
        const data = providerSummaryData[provider.id];
        const availableFund = data
          ? provider.startingCapital - data.portfolioSummary.outstanding
          : 0;
        return {
          Provider: provider.name,
          ProviderFund: provider.startingCapital,
          LoansDisbursed: data?.portfolioSummary.disbursed || 0,
          AvailableFund: availableFund,
          Utilization: data?.fundUtilization || 0,
          providerId: provider.id,
        };
      });
    return applySortAndPaginate("utilizationReport", rows);
  }, [
    providers,
    providerSummaryData,
    providerId,
    tableStates.utilizationReport,
  ]);
  const agingTable = useMemo(() => {
    const rows = providers
      .filter((p) => providerId === "all" || p.id === providerId)
      .map((provider) => {
        const data = providerSummaryData[provider.id];
        const aging = data?.agingReport;
        return {
          Provider: provider.name,
          Pass: aging?.buckets?.Pass || 0,
          Special: aging?.buckets?.["Special Mention"] || 0,
          Substandard: aging?.buckets?.Substandard || 0,
          Doubtful: aging?.buckets?.Doubtful || 0,
          Loss: aging?.buckets?.Loss || 0,
          TotalOverdue: aging?.totalOverdue || 0,
          providerId: provider.id,
        };
      });
    return applySortAndPaginate("agingReport", rows);
  }, [providers, providerSummaryData, providerId, tableStates.agingReport]);
  const borrowerTable = useMemo(
    () => applySortAndPaginate("borrowerReport", loansData),
    [loansData, tableStates.borrowerReport]
  );

  // Only block the whole page on initial auth/provider resolution.
  // During data refetches (e.g. typing in search), keep controls mounted to avoid losing focus.
  if (isAuthLoading || providerId === null) {
    return (
      <div className="flex-1 space-y-4 p-8 pt-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between space-y-2 md:space-y-0">
          <h2 className="text-3xl font-bold tracking-tight">Reports</h2>
        </div>
        <div className="flex justify-center items-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  if (providerId === "none") {
    return (
      <div className="flex-1 space-y-4 p-8 pt-6">
        <h2 className="text-3xl font-bold tracking-tight">Reports</h2>
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Access Restricted</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              You are not currently associated with a loan provider. Please
              contact an administrator to get access to reports.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between space-y-2 md:space-y-0">
        <h2 className="text-3xl font-bold tracking-tight">Reports</h2>
        <div className="flex items-center space-x-2">
          <Select
            onValueChange={(value) => {
              setTimeframe(value);
              setDateRange(undefined);
            }}
            value={timeframe}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select Timeframe" />
            </SelectTrigger>
            <SelectContent>
              {TIMEFRAMES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                id="date"
                variant={"outline"}
                className={cn(
                  "w-[300px] justify-start text-left font-normal",
                  !dateRange && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {dateRange?.from ? (
                  dateRange.to ? (
                    <>
                      {format(dateRange.from, "LLL dd, y")} -{" "}
                      {format(dateRange.to, "LLL dd, y")}
                    </>
                  ) : (
                    format(dateRange.from, "LLL dd, y")
                  )
                ) : (
                  <span>Pick a date</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                initialFocus
                mode="range"
                defaultMonth={dateRange?.from}
                selected={dateRange}
                onSelect={(range) => {
                  setDateRange(range);
                  if (range?.from) setTimeframe("custom");
                }}
                numberOfMonths={2}
              />
            </PopoverContent>
          </Popover>
          {canViewAllProviders && (
            <Select onValueChange={setProviderId} value={providerId || ""}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Select Provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Providers</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            onClick={handleExcelExport}
            disabled={isExporting || providerId === "none"}
          >
            {isExporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {isExporting ? "Exporting..." : "Excel"}
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search by account number or phone number..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        {isLoading && (
          <div className="flex items-center text-sm text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}
        {searchQuery && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSearchQuery("")}
          >
            Clear
          </Button>
        )}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="providerReport">Provider Loans</TabsTrigger>
          <TabsTrigger value="disbursementsReport">Disbursements</TabsTrigger>
          <TabsTrigger value="repaymentsReport">Repayments</TabsTrigger>
          <TabsTrigger value="collectionsReport">Collections</TabsTrigger>
          <TabsTrigger value="directPaymentReport">Direct Payment</TabsTrigger>
          <TabsTrigger value="subscriptionReport">Subscription Report</TabsTrigger>
          <TabsTrigger value="utilizationReport">Fund Utilization</TabsTrigger>
          <TabsTrigger value="agingReport">Aging</TabsTrigger>
          <TabsTrigger value="borrowerReport">Borrower Performance</TabsTrigger>
        </TabsList>
              {/* Direct Payment Report Tab */}
              <TabsContent value="directPaymentReport">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead>Transaction ID</TableHead>
                      <TableHead>Order ID</TableHead>
                      <TableHead>Borrower</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Merchant Account</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Payment Status</TableHead>
                      <TableHead>Order Status</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isDirectPaymentLoading ? (
                      <TableRow>
                        <TableCell colSpan={10} className="h-24 text-center">
                          <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                        </TableCell>
                      </TableRow>
                    ) : directPaymentData.length > 0 ? (
                      directPaymentData.map((row: any) => (
                        <TableRow key={row.id}>
                          <TableCell className="font-mono text-xs">{row.transactionId?.slice(-12)}</TableCell>
                          <TableCell className="font-mono text-xs">{row.orderId?.slice(-8)}</TableCell>
                          <TableCell>{row.borrowerName}</TableCell>
                          <TableCell>{row.borrowerPhone}</TableCell>
                          <TableCell>{row.merchantName}</TableCell>
                          <TableCell className="font-mono">{row.merchantAccount}</TableCell>
                          <TableCell className="text-right font-mono">{formatCurrency(row.amount)}</TableCell>
                          <TableCell>
                            <Badge variant={row.status === "COMPLETED" ? "default" : row.status === "FAILED" ? "destructive" : "secondary"}
                              className={cn(row.status === "COMPLETED" && "bg-green-600 text-white")}>{row.status}</Badge>
                          </TableCell>
                          <TableCell>{row.orderStatus}</TableCell>
                          <TableCell>{row.createdAt ? format(new Date(row.createdAt), "yyyy-MM-dd HH:mm") : ""}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={10} className="h-24 text-center">No direct payment records found.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                <PaginationControls
                  tab="directPaymentReport"
                  meta={{
                    total: directPaymentPagination.total,
                    totalPages: directPaymentPagination.totalPages,
                    page: directPaymentPagination.page,
                    pageSize: directPaymentPagination.pageSize,
                  }}
                  onPageChange={(page) => fetchDirectPaymentData(page, directPaymentPagination.pageSize)}
                  onPageSizeChange={(pageSize) => fetchDirectPaymentData(1, pageSize)}
                />
              </TabsContent>

              {/* Subscription Report Tabs */}
              <TabsContent value="subscriptionReport">
                <div className="p-4">
                  <h3 className="text-lg font-bold mb-2">Subscription Report</h3>
                  <Tabs defaultValue="branchSubscription" className="space-y-4">
                    <TabsList>
                      <TabsTrigger value="branchSubscription">Branch Subscription Report</TabsTrigger>
                      <TabsTrigger value="merchantDetails">Merchant Details per Branch</TabsTrigger>
                    </TabsList>
                    {/* Branch Subscription Report Tab */}
                    <TabsContent value="branchSubscription">
                      <div className="overflow-auto rounded-md border h-[50vh]">
                        {/* Filters: Search, District, Status, Date */}
                        <div className="flex flex-wrap gap-2 p-2">
                          <div className="relative max-w-xs">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              placeholder="Search Branch Name or Code"
                              className="pl-9 max-w-xs"
                              value={branchSubSearch}
                              onChange={(e) => setBranchSubSearch(e.target.value)}
                            />
                          </div>
                          <Select value={branchSubDistrict} onValueChange={setBranchSubDistrict}>
                            <SelectTrigger className="w-[160px]"><SelectValue placeholder="District" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">All Districts</SelectItem>
                              {districts.map((d: any) => (
                                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select value={branchSubStatus} onValueChange={setBranchSubStatus}>
                            <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">All</SelectItem>
                              <SelectItem value="active">Active</SelectItem>
                              <SelectItem value="inactive">Inactive</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input type="date" className="w-[160px]" value={branchSubDate} onChange={(e) => setBranchSubDate(e.target.value)} />
                          {(branchSubSearch || branchSubDistrict !== "all" || branchSubStatus !== "all" || branchSubDate) && (
                            <Button variant="ghost" size="sm" onClick={() => { setBranchSubSearch(""); setBranchSubDistrict("all"); setBranchSubStatus("all"); setBranchSubDate(""); }}>
                              Clear Filters
                            </Button>
                          )}
                        </div>
                        <Table>
                          <TableHeader className="sticky top-0 bg-card z-10">
                            <TableRow>
                              <TableHead>Branch Name</TableHead>
                              <TableHead>Branch Code</TableHead>
                              <TableHead>District</TableHead>
                              <TableHead>Subscription Date</TableHead>
                              <TableHead className="text-right">Number of Merchants</TableHead>
                              <TableHead>Status</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {isBranchSubLoading ? (
                              <TableRow>
                                <TableCell colSpan={6} className="h-24 text-center">
                                  <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                                </TableCell>
                              </TableRow>
                            ) : branchSubData.length > 0 ? (
                              branchSubData.map((row: any) => (
                                <TableRow key={row.branchId}>
                                  <TableCell>{row.branchName}</TableCell>
                                  <TableCell className="font-mono text-xs">{row.branchCode?.slice(-8)}</TableCell>
                                  <TableCell>{row.districtName}</TableCell>
                                  <TableCell>{row.subscriptionDate ? format(new Date(row.subscriptionDate), "yyyy-MM-dd") : ""}</TableCell>
                                  <TableCell className="text-right">{row.merchantCount}</TableCell>
                                  <TableCell>
                                    <Badge variant={row.status === "ACTIVE" ? "default" : "secondary"}
                                      className={cn(row.status === "ACTIVE" && "bg-green-600 text-white")}>{row.status}</Badge>
                                  </TableCell>
                                </TableRow>
                              ))
                            ) : (
                              <TableRow>
                                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No branches found.</TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                        <PaginationControls
                          tab="branchSubscription"
                          meta={{
                            total: branchSubPagination.total,
                            totalPages: branchSubPagination.totalPages,
                            page: branchSubPagination.page,
                            pageSize: branchSubPagination.pageSize,
                          }}
                          onPageChange={(page) => fetchBranchSubscriptionData(page, branchSubPagination.pageSize)}
                          onPageSizeChange={(pageSize) => fetchBranchSubscriptionData(1, pageSize)}
                        />
                      </div>
                    </TabsContent>
                    {/* Merchant Details per Branch Tab */}
                    <TabsContent value="merchantDetails">
                      <div className="overflow-auto rounded-md border h-[50vh]">
                        <div className="flex flex-wrap gap-2 p-2">
                          <Select value={selectedBranchId} onValueChange={setSelectedBranchId}>
                            <SelectTrigger className="w-[280px]"><SelectValue placeholder="Select Branch" /></SelectTrigger>
                            <SelectContent>
                              {branches.map((b: any) => (
                                <SelectItem key={b.id} value={b.id}>{b.name} ({b.district?.name})</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {selectedBranchId && merchantPagination.total > 0 && (
                            <span className="text-sm text-muted-foreground self-center">
                              Total merchants: {merchantPagination.total}
                            </span>
                          )}
                        </div>
                        <Table>
                          <TableHeader className="sticky top-0 bg-card z-10">
                            <TableRow>
                              <TableHead>Merchant Name</TableHead>
                              <TableHead>Merchant ID</TableHead>
                              <TableHead>Registration Date</TableHead>
                              <TableHead>Status</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {!selectedBranchId ? (
                              <TableRow>
                                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">Select a branch to view merchants.</TableCell>
                              </TableRow>
                            ) : isMerchantLoading ? (
                              <TableRow>
                                <TableCell colSpan={4} className="h-24 text-center">
                                  <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                                </TableCell>
                              </TableRow>
                            ) : merchantData.length > 0 ? (
                              merchantData.map((row: any) => (
                                <TableRow key={row.merchantId}>
                                  <TableCell>{row.merchantName}</TableCell>
                                  <TableCell className="font-mono text-xs">{row.merchantId?.slice(-8)}</TableCell>
                                  <TableCell>{row.registrationDate ? format(new Date(row.registrationDate), "yyyy-MM-dd") : ""}</TableCell>
                                  <TableCell>
                                    <Badge variant={row.status === "ACTIVE" ? "default" : row.status === "PENDING_APPROVAL" ? "secondary" : "destructive"}
                                      className={cn(row.status === "ACTIVE" && "bg-green-600 text-white")}>{row.status}</Badge>
                                  </TableCell>
                                </TableRow>
                              ))
                            ) : (
                              <TableRow>
                                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No merchants found for this branch.</TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                        <PaginationControls
                          tab="merchantDetails"
                          meta={{
                            total: merchantPagination.total,
                            totalPages: merchantPagination.totalPages,
                            page: merchantPagination.page,
                            pageSize: merchantPagination.pageSize,
                          }}
                          onPageChange={(page) => fetchMerchantDetails(selectedBranchId, page, merchantPagination.pageSize)}
                          onPageSizeChange={(pageSize) => fetchMerchantDetails(selectedBranchId, 1, pageSize)}
                        />
                      </div>
                    </TabsContent>
                  </Tabs>
                </div>
              </TabsContent>
        <div className="overflow-auto rounded-md border h-[60vh]">
          <TabsContent value="providerReport" className="space-y-4 m-0">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>
                    <button
                      onClick={() => toggleSort("providerReport", "provider")}
                      className="flex items-center"
                    >
                      {"Provider"}
                      {renderSortIcon("providerReport", "provider")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      onClick={() => toggleSort("providerReport", "loanId")}
                      className="flex items-center"
                    >
                      {"Loan ID"}
                      {renderSortIcon("providerReport", "loanId")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      onClick={() =>
                        toggleSort("providerReport", "borrowerName")
                      }
                      className="flex items-center"
                    >
                      {"Borrower"}
                      {renderSortIcon("providerReport", "borrowerName")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={() =>
                        toggleSort("providerReport", "principalDisbursed")
                      }
                      className="flex items-center"
                    >
                      {"Principal Disbursed"}
                      {renderSortIcon("providerReport", "principalDisbursed")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={() =>
                        toggleSort("providerReport", "principalOutstanding")
                      }
                      className="flex items-center"
                    >
                      {"Principal Outstanding"}
                      {renderSortIcon("providerReport", "principalOutstanding")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={() =>
                        toggleSort("providerReport", "interestOutstanding")
                      }
                      className="flex items-center"
                    >
                      {"Interest Outstanding"}
                      {renderSortIcon("providerReport", "interestOutstanding")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={() =>
                        toggleSort("providerReport", "serviceFeeOutstanding")
                      }
                      className="flex items-center"
                    >
                      {"Service Fee Outstanding"}
                      {renderSortIcon(
                        "providerReport",
                        "serviceFeeOutstanding"
                      )}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={() =>
                        toggleSort("providerReport", "penaltyOutstanding")
                      }
                      className="flex items-center"
                    >
                      {"Penalty Outstanding"}
                      {renderSortIcon("providerReport", "penaltyOutstanding")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={() =>
                        toggleSort("providerReport", "totalOutstanding")
                      }
                      className="flex items-center"
                    >
                      {"Total Outstanding"}
                      {renderSortIcon("providerReport", "totalOutstanding")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      onClick={() => toggleSort("providerReport", "status")}
                      className="flex items-center"
                    >
                      {"Status"}
                      {renderSortIcon("providerReport", "status")}
                    </button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="h-24 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : providerTable.items.length > 0 ? (
                  providerTable.items.map((row: any) => (
                    <TableRow key={row.loanId}>
                      <TableCell>{row.provider}</TableCell>
                      <TableCell>{row.loanId?.slice(-8)}</TableCell>
                      <TableCell>{row.borrowerName}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.principalDisbursed)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.principalOutstanding)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.interestOutstanding)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.serviceFeeOutstanding)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.penaltyOutstanding)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {formatCurrency(row.totalOutstanding)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.status === "Overdue" ||
                            row.status === "Defaulted"
                              ? "destructive"
                              : row.status === "Paid"
                              ? "default"
                              : "secondary"
                          }
                          className={cn(
                            row.status === "Paid" && "bg-green-600 text-white"
                          )}
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={10} className="h-24 text-center">
                      No results found for the selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <PaginationControls
              tab="providerReport"
              meta={{
                total: providerTable.total,
                totalPages: providerTable.totalPages,
                page: providerTable.page,
                pageSize: providerTable.pageSize,
              }}
              onPageChange={(page) => fetchLoansData(page, providerTable.pageSize)}
              onPageSizeChange={(pageSize) => fetchLoansData(1, pageSize)}
            />
          </TabsContent>
          <TabsContent value="disbursementsReport">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>
                    <button
                      onClick={() =>
                        toggleSort("disbursementsReport", "transactionDate")
                      }
                      className="flex items-center"
                    >
                      Date
                      {renderSortIcon("disbursementsReport", "transactionDate")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      onClick={() =>
                        toggleSort("disbursementsReport", "loanId")
                      }
                      className="flex items-center"
                    >
                      Loan ID{renderSortIcon("disbursementsReport", "loanId")}
                    </button>
                  </TableHead>
                  <TableHead>Customer Name</TableHead>
                  <TableHead>Debit Account</TableHead>
                  <TableHead>Credit Account</TableHead>
                  <TableHead>Customer Account</TableHead>
                  <TableHead>Txn Status</TableHead>
                  <TableHead>CBS Reference</TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={() =>
                        toggleSort("disbursementsReport", "principalDisbursed")
                      }
                      className="flex items-center"
                    >
                      Loan Amount (MLS)
                      {renderSortIcon(
                        "disbursementsReport",
                        "principalDisbursed"
                      )}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    Interest Fee (MLS)
                  </TableHead>
                  <TableHead className="text-right">
                    Service Fee (MLS)
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={() =>
                        toggleSort("disbursementsReport", "netDisbursed")
                      }
                      className="flex items-center"
                    >
                      Net Disbursed (MLS)
                      {renderSortIcon("disbursementsReport", "netDisbursed")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    CBS Credit Amount
                  </TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={14} className="h-24 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : disbursementTable.items.length > 0 ? (
                  disbursementTable.items.map((row: any) => {
                    const loanAmt = row.principalDisbursed || 0;
                    const interestFee = row.interestOutstanding || 0;
                    const serviceFee = row.serviceFeeOutstanding || 0;
                    const netDisbursed =
                      row.netDisbursed != null ? row.netDisbursed : loanAmt;
                    const cbsCredit = row.cbsCreditAmount ?? 0;
                    const diff = netDisbursed - cbsCredit;
                    return (
                      <TableRow key={row.reference || row.loanId}>
                        <TableCell>
                          {row.transactionDate
                            ? format(
                                new Date(row.transactionDate),
                                "yyyy-MM-dd"
                              )
                            : ""}
                        </TableCell>
                        <TableCell>{row.loanId?.slice(-8)}</TableCell>
                        <TableCell>
                          {row.customerName ||
                            row.borrowerName ||
                            row.borrowerAccount ||
                            row.borrowerId ||
                            ""}
                        </TableCell>
                        <TableCell className="font-mono">
                          {row.debitAccount}
                        </TableCell>
                        <TableCell className="font-mono">
                          {row.disbursementCreditAccount || row.creditAccount}
                        </TableCell>
                        <TableCell className="font-mono">
                          {row.borrowerAccount || row.borrowerId}
                        </TableCell>
                        <TableCell>
                          {row.disbursementOutcome ||
                            row.disbursementStatusText ||
                            row.transactionStatus}
                        </TableCell>
                        <TableCell>
                          {row.cbsReference || row.reference}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(loanAmt)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(interestFee)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(serviceFee)}
                        </TableCell>
                        <TableCell className="text-right font-mono font-bold">
                          {formatCurrency(netDisbursed)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(cbsCredit)}
                        </TableCell>
                        <TableCell>
                          {row.dueDate
                            ? format(new Date(row.dueDate), "yyyy-MM-dd")
                            : ""}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(diff)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={14} className="h-24 text-center">
                      No results found for the selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <PaginationControls
              tab="disbursementsReport"
              meta={{
                total: disbursementTable.total,
                totalPages: disbursementTable.totalPages,
                page: disbursementTable.page,
                pageSize: disbursementTable.pageSize,
              }}
              onPageChange={(page) => fetchDisbursementsData(page, disbursementTable.pageSize)}
              onPageSizeChange={(pageSize) => fetchDisbursementsData(1, pageSize)}
            />
          </TabsContent>
          <TabsContent value="repaymentsReport">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>
                    <button
                      onClick={() => toggleSort("repaymentsReport", "loanId")}
                      className="flex items-center"
                    >
                      Loan ID{renderSortIcon("repaymentsReport", "loanId")}
                    </button>
                  </TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>
                    <button
                      onClick={() =>
                        toggleSort("repaymentsReport", "transactionDate")
                      }
                      className="flex items-center"
                    >
                      Transaction Date
                      {renderSortIcon("repaymentsReport", "transactionDate")}
                    </button>
                  </TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Debit Account</TableHead>
                  <TableHead>Credit Account</TableHead>
                  <TableHead>Txn Status</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Product Type</TableHead>
                  <TableHead>Borrower</TableHead>
                  <TableHead className="text-right">
                    Principal Disbursed
                  </TableHead>
                  <TableHead className="text-right">Principal Paid</TableHead>
                  <TableHead className="text-right">Interest Paid</TableHead>
                  <TableHead className="text-right">Service Fee Paid</TableHead>
                  <TableHead className="text-right">Penalty Paid</TableHead>
                  <TableHead className="text-right">Total Paid</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={18} className="h-24 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : repaymentTable.items.length > 0 ? (
                  repaymentTable.items.map((row: any) => (
                    <TableRow key={row.reference || row.loanId}>
                      <TableCell>{row.provider}</TableCell>
                      <TableCell>{row.loanId?.slice(-8)}</TableCell>
                      <TableCell>
                        {row.customerName ||
                          row.borrowerName ||
                          row.borrowerAccount ||
                          row.borrowerId ||
                          ""}
                      </TableCell>
                      <TableCell>
                        {row.transactionDate
                          ? format(new Date(row.transactionDate), "yyyy-MM-dd")
                          : ""}
                      </TableCell>
                      <TableCell>
                        {row.dueDate
                          ? format(new Date(row.dueDate), "yyyy-MM-dd")
                          : ""}
                      </TableCell>
                      <TableCell>{row.debitAccount}</TableCell>
                      <TableCell>
                        {row.borrowerAccount || row.creditAccount}
                      </TableCell>
                      <TableCell>{row.transactionStatus}</TableCell>
                      <TableCell>{row.reference}</TableCell>
                      <TableCell>{row.productType}</TableCell>
                      <TableCell>{row.borrowerId?.slice(-8)}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.principalDisbursed)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.principalPaid)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.interestPaid)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.serviceFeePaid)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.penaltyPaid)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {formatCurrency(row.totalPaid)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.status === "Overdue" ||
                            row.status === "Defaulted"
                              ? "destructive"
                              : row.status === "Paid"
                              ? "default"
                              : "secondary"
                          }
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={18} className="h-24 text-center">
                      No results found for the selected filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <PaginationControls
              tab="repaymentsReport"
              meta={{
                total: repaymentTable.total,
                totalPages: repaymentTable.totalPages,
                page: repaymentTable.page,
                pageSize: repaymentTable.pageSize,
              }}
              onPageChange={(page) => fetchRepaymentsData(page, repaymentTable.pageSize)}
              onPageSizeChange={(pageSize) => fetchRepaymentsData(1, pageSize)}
            />
          </TabsContent>
          <TabsContent value="collectionsReport">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>
                    <button
                      onClick={() => toggleSort("collectionsReport", "date")}
                      className="flex items-center"
                    >
                      Date{renderSortIcon("collectionsReport", "date")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    Principal Received
                  </TableHead>
                  <TableHead className="text-right">
                    Interest Received
                  </TableHead>
                  <TableHead className="text-right">
                    Service Fee Received
                  </TableHead>
                  <TableHead className="text-right">Penalty Received</TableHead>
                  <TableHead className="text-right">Tax Received</TableHead>
                  <TableHead className="text-right font-bold">
                    Total Collected
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : collectionsTable.items.length > 0 ? (
                  collectionsTable.items.map((row: any) => (
                    <TableRow key={`${row.provider}-${row.date}`}>
                      <TableCell>{row.provider}</TableCell>
                      <TableCell>
                        {format(new Date(row.date), "yyyy-MM-dd")}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.principal)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.interest)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.serviceFee)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.penalty)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.tax)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {formatCurrency(row.total)}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center">
                      No results found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <PaginationControls
              tab="collectionsReport"
              meta={{
                total: collectionsTable.total,
                totalPages: collectionsTable.totalPages,
                page: collectionsTable.page,
                pageSize: collectionsTable.pageSize,
              }}
              onPageChange={(page) => fetchCollectionsData(page, collectionsTable.pageSize)}
              onPageSizeChange={(pageSize) => fetchCollectionsData(1, pageSize)}
            />
          </TabsContent>

          <TabsContent value="utilizationReport">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>
                    <button
                      onClick={() =>
                        toggleSort("utilizationReport", "Provider")
                      }
                      className="flex items-center"
                    >
                      Provider{renderSortIcon("utilizationReport", "Provider")}
                    </button>
                  </TableHead>
                  <TableHead className="text-right">Provider Fund</TableHead>
                  <TableHead className="text-right">Loans Disbursed</TableHead>
                  <TableHead className="text-right">Available Fund</TableHead>
                  <TableHead className="text-right">Utilization %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : utilizationTable.items.length > 0 ? (
                  utilizationTable.items.map((row: any) => (
                    <TableRow key={row.providerId}>
                      <TableCell>{row.Provider}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.ProviderFund)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.LoansDisbursed)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.AvailableFund)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {(row.Utilization || 0).toFixed(2)}%
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center">
                      No results found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <PaginationControls
              tab="utilizationReport"
              meta={{
                total: utilizationTable.total,
                totalPages: utilizationTable.totalPages,
                page: utilizationTable.page,
                pageSize: utilizationTable.pageSize,
              }}
            />
          </TabsContent>
          <TabsContent value="agingReport">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Pass (0-29 Days)</TableHead>
                  <TableHead className="text-right">
                    Special Mention (30-89 Days)
                  </TableHead>
                  <TableHead className="text-right">
                    Substandard (90-179 Days)
                  </TableHead>
                  <TableHead className="text-right">
                    Doubtful (180-359 Days)
                  </TableHead>
                  <TableHead className="text-right">Loss (360+ Days)</TableHead>
                  <TableHead className="text-right">Total Overdue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : agingTable.items.length > 0 ? (
                  agingTable.items.map((row: any) => (
                    <TableRow key={row.providerId}>
                      <TableCell>{row.Provider}</TableCell>
                      <TableCell className="text-right font-mono">
                        {row.Pass}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.Special}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.Substandard}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.Doubtful}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.Loss}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {row.TotalOverdue}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">
                      No results found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <PaginationControls
              tab="agingReport"
              meta={{
                total: agingTable.total,
                totalPages: agingTable.totalPages,
                page: agingTable.page,
                pageSize: agingTable.pageSize,
              }}
            />
            {/* Borrower-level aging breakdown when a single provider is selected */}
            {providerId &&
              providerId !== "all" &&
              (() => {
                const pdata = providerSummaryData[providerId];
                const borrowers = pdata?.agingReport?.byBorrower || [];
                const borrowerMeta = applySortAndPaginate(
                  "borrowerAging",
                  borrowers
                );
                return (
                  <div className="mt-6">
                    <h3 className="text-lg font-medium mb-2">
                      Borrower-level Aging
                    </h3>
                    <Table>
                      <TableHeader className="sticky top-0 bg-card z-10">
                        <TableRow>
                          <TableHead className="text-left">Borrower</TableHead>
                          <TableHead className="text-center">
                            Account Number
                          </TableHead>
                          <TableHead className="text-center">
                            Days Overdue
                          </TableHead>
                          <TableHead className="text-center">
                            Category
                          </TableHead>
                          <TableHead className="text-right">
                            Principal Outstanding
                          </TableHead>
                          <TableHead className="text-right">
                            Interest Outstanding
                          </TableHead>
                          <TableHead className="text-right">
                            Service Fee Outstanding
                          </TableHead>
                          <TableHead className="text-right">
                            Penalty Outstanding
                          </TableHead>
                          <TableHead className="text-right">
                            Total Outstanding
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {borrowers.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={9} className="h-24 text-center">
                              No borrower-level aging data.
                            </TableCell>
                          </TableRow>
                        ) : (
                          borrowerMeta.items.map((b: any) => (
                            <TableRow key={b.borrowerId}>
                              <TableCell className="font-medium">
                                {b.borrowerId}
                              </TableCell>
                              <TableCell className="text-center font-mono text-sm">
                                {b.borrowerAccount || ""}
                              </TableCell>
                              <TableCell className="text-center">
                                {b.daysOverdue ?? "-"}
                              </TableCell>
                              <TableCell className="text-center">
                                {b.classification || "N/A"}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatCurrency(b.principalOutstanding || 0)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatCurrency(b.interestOutstanding || 0)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatCurrency(b.serviceFeeOutstanding || 0)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatCurrency(b.penaltyOutstanding || 0)}
                              </TableCell>
                              <TableCell className="text-right font-mono font-bold">
                                {formatCurrency(
                                  b.classificationAmount || b.totalOverdue || 0
                                )}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                    <PaginationControls
                      tab="borrowerAging"
                      meta={{
                        total: borrowerMeta.total,
                        totalPages: borrowerMeta.totalPages,
                        page: borrowerMeta.page,
                        pageSize: borrowerMeta.pageSize,
                      }}
                    />
                  </div>
                );
              })()}
          </TabsContent>
          <TabsContent value="borrowerReport">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>
                    <button
                      onClick={() => toggleSort("borrowerReport", "borrowerId")}
                      className="flex items-center"
                    >
                      Borrower ID
                      {renderSortIcon("borrowerReport", "borrowerId")}
                    </button>
                  </TableHead>
                  <TableHead>Borrower Name</TableHead>
                  <TableHead>Loan ID</TableHead>
                  <TableHead className="text-right">
                    Principal Disbursed
                  </TableHead>
                  <TableHead className="text-right">
                    Principal Outstanding
                  </TableHead>
                  <TableHead className="text-right">
                    Interest Outstanding
                  </TableHead>
                  <TableHead className="text-right">
                    Service Fee Outstanding
                  </TableHead>
                  <TableHead className="text-right">
                    Penalty Outstanding
                  </TableHead>
                  <TableHead className="text-right">Days in Arrears</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="h-24 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : borrowerTable.items.length > 0 ? (
                  borrowerTable.items.map((row: any) => (
                    <TableRow key={row.loanId}>
                      <TableCell>{row.borrowerId?.slice(-8)}</TableCell>
                      <TableCell>{row.borrowerName}</TableCell>
                      <TableCell>{row.loanId?.slice(-8)}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.principalDisbursed)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.principalOutstanding)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.interestOutstanding)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.serviceFeeOutstanding)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(row.penaltyOutstanding)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.daysInArrears}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.status === "Overdue" ||
                            row.status === "Defaulted"
                              ? "destructive"
                              : row.status === "Paid"
                              ? "default"
                              : "secondary"
                          }
                          className={cn(
                            row.status === "Paid" && "bg-green-600 text-white"
                          )}
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={10} className="h-24 text-center">
                      No results found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <PaginationControls
              tab="borrowerReport"
              meta={{
                total: borrowerTable.total,
                totalPages: borrowerTable.totalPages,
                page: borrowerTable.page,
                pageSize: borrowerTable.pageSize,
              }}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
