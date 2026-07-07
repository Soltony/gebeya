'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
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
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { PlusCircle, Upload, Building2, MapPin, Users, ChevronRight, FileSpreadsheet, Eye, EyeOff, RotateCcw, Send } from 'lucide-react';
import { useRequirePermission } from '@/hooks/use-require-permission';

type TabKey = 'districts-branches' | 'branch-user-access';

interface District {
  id: string;
  name: string;
  status: string;
  _count: { branches: number };
  createdAt: string;
}

interface Branch {
  id: string;
  name: string;
  districtId: string;
  status: string;
  district: { id: string; name: string };
  _count: { users: number };
}

interface BranchUser {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string;
  role: string;
  status: string;
  branchId: string | null;
  branchName: string | null;
  districtName: string | null;
}

export default function DistrictsPage() {
  useRequirePermission('branch');
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<TabKey>('districts-branches');

  // Districts state
  const [districts, setDistricts] = useState<District[]>([]);
  const [selectedDistrict, setSelectedDistrict] = useState<District | null>(null);
  const [districtDialogOpen, setDistrictDialogOpen] = useState(false);
  const [editingDistrict, setEditingDistrict] = useState<District | null>(null);
  const [districtName, setDistrictName] = useState('');
  const [districtStatus, setDistrictStatus] = useState('ACTIVE');

  // Branches state
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [branchName, setBranchName] = useState('');
  const [branchStatus, setBranchStatus] = useState('ACTIVE');

  // Bulk upload state
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const bulkFileInputRef = useRef<HTMLInputElement>(null);

  // Branch users state
  const [branchUsers, setBranchUsers] = useState<BranchUser[]>([]);
  const [allBranches, setAllBranches] = useState<Branch[]>([]);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [buFullName, setBuFullName] = useState('');
  const [buEmail, setBuEmail] = useState('');
  const [buPhone, setBuPhone] = useState('');
  const [buPassword, setBuPassword] = useState('');
  const [buRole, setBuRole] = useState('');
  const [buBranchId, setBuBranchId] = useState('');
  const [buDistrictId, setBuDistrictId] = useState('');
  const [editingBranchUser, setEditingBranchUser] = useState<BranchUser | null>(null);
  const [branchUserDialogOpen, setBranchUserDialogOpen] = useState(false);
  const [buEditBranchId, setBuEditBranchId] = useState('');
  const [buEditDistrictId, setBuEditDistrictId] = useState('');
  const [buEditFullName, setBuEditFullName] = useState('');
  const [buEditEmail, setBuEditEmail] = useState('');
  const [buEditPhone, setBuEditPhone] = useState('');
  const [buEditStatus, setBuEditStatus] = useState('Active');

  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // Pagination state
  const DISTRICTS_PAGE_SIZE = 10;
  const BRANCHES_PAGE_SIZE = 10;
  const [districtsPage, setDistrictsPage] = useState(1);
  const [branchesPage, setBranchesPage] = useState(1);

  // Pagination helpers
  const totalDistrictPages = Math.max(1, Math.ceil(districts.length / DISTRICTS_PAGE_SIZE));
  const paginatedDistricts = districts.slice((districtsPage - 1) * DISTRICTS_PAGE_SIZE, districtsPage * DISTRICTS_PAGE_SIZE);
  const totalBranchPages = Math.max(1, Math.ceil(branches.length / BRANCHES_PAGE_SIZE));
  const paginatedBranches = branches.slice((branchesPage - 1) * BRANCHES_PAGE_SIZE, branchesPage * BRANCHES_PAGE_SIZE);

  // ── fetch helpers ────────────────────────────────────────────────────────────

  const fetchDistricts = useCallback(async () => {
    try {
      const res = await fetch('/api/districts');
      if (res.ok) setDistricts(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchBranches = useCallback(async (districtId?: string) => {
    try {
      const url = districtId ? `/api/districts/branches?districtId=${districtId}` : '/api/districts/branches';
      const res = await fetch(url);
      if (res.ok) setBranches(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchAllBranches = useCallback(async () => {
    try {
      const res = await fetch('/api/districts/branches');
      if (res.ok) setAllBranches(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchBranchUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/districts/branch-users');
      if (res.ok) setBranchUsers(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchRoles = useCallback(async () => {
    try {
      const res = await fetch('/api/roles');
      if (res.ok) {
        const data = await res.json();
        setRoles(
          data
            .filter((r: any) => r.name === 'Branch')
            .map((r: any) => ({ id: r.id, name: r.name }))
        );
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchDistricts();
  }, [fetchDistricts]);

  useEffect(() => {
    if (activeTab === 'branch-user-access') {
      fetchBranchUsers();
      fetchAllBranches();
      fetchRoles();
    }
  }, [activeTab, fetchBranchUsers, fetchAllBranches, fetchRoles]);

  useEffect(() => {
    if (selectedDistrict) {
      fetchBranches(selectedDistrict.id);
      setBranchesPage(1);
    } else {
      setBranches([]);
    }
  }, [selectedDistrict, fetchBranches]);

  // ── District CRUD ────────────────────────────────────────────────────────────

  const resetDistrictForm = () => {
    setEditingDistrict(null);
    setDistrictName('');
    setDistrictStatus('ACTIVE');
  };

  const handleSaveDistrict = async () => {
    setLoading(true);
    try {
      const method = editingDistrict ? 'PUT' : 'POST';
      const body = editingDistrict
        ? { id: editingDistrict.id, name: districtName, status: districtStatus }
        : { name: districtName, status: districtStatus };

      const res = await fetch('/api/districts', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save district');
      }

      toast({ title: editingDistrict ? 'District updated' : 'District created' });
      setDistrictDialogOpen(false);
      resetDistrictForm();
      await fetchDistricts();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteDistrict = async (id: string) => {
    try {
      const res = await fetch(`/api/districts?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'District deleted' });
      if (selectedDistrict?.id === id) setSelectedDistrict(null);
      await fetchDistricts();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  // ── Branch CRUD ──────────────────────────────────────────────────────────────

  const resetBranchForm = () => {
    setEditingBranch(null);
    setBranchName('');
    setBranchStatus('ACTIVE');
  };

  const handleSaveBranch = async () => {
    if (!selectedDistrict) return;
    setLoading(true);
    try {
      const method = editingBranch ? 'PUT' : 'POST';
      const body = editingBranch
        ? { id: editingBranch.id, name: branchName, districtId: selectedDistrict.id, status: branchStatus }
        : { name: branchName, districtId: selectedDistrict.id, status: branchStatus };

      const res = await fetch('/api/districts/branches', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save branch');
      }

      toast({ title: editingBranch ? 'Branch updated' : 'Branch created' });
      setBranchDialogOpen(false);
      resetBranchForm();
      await fetchBranches(selectedDistrict.id);
      await fetchDistricts(); // refresh branch counts
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteBranch = async (id: string) => {
    try {
      const res = await fetch(`/api/districts/branches?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Branch deleted' });
      if (selectedDistrict) {
        await fetchBranches(selectedDistrict.id);
        await fetchDistricts();
      }
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  // ── Bulk Upload ──────────────────────────────────────────────────────────────

  const handleBulkUpload = async () => {
    if (!bulkFile || !selectedDistrict) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('file', bulkFile);
      formData.append('districtId', selectedDistrict.id);

      const res = await fetch('/api/districts/branches/bulk', { method: 'POST', body: formData });
      const result = await res.json();

      if (!res.ok) throw new Error(result.error || 'Upload failed');

      const skippedMsg = result.skipped?.length
        ? ` (${result.skipped.length} skipped as duplicates: ${result.skipped.join(', ')})`
        : '';
      toast({ title: `Uploaded: ${result.created} of ${result.total} branches created${skippedMsg}` });
      setBulkDialogOpen(false);
      setBulkFile(null);
      await fetchBranches(selectedDistrict.id);
      await fetchDistricts();
    } catch (e: any) {
      toast({ title: 'Upload Error', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  // ── Branch Users CRUD ────────────────────────────────────────────────────────

  const resetBranchUserForm = () => {
    setBuFullName('');
    setBuEmail('');
    setBuPhone('');
    setBuPassword('');
    setBuRole('');
    setBuBranchId('');
    setBuDistrictId('');
  };

  // Filtered branches based on selected district (create form)
  const filteredBranchesForCreate = buDistrictId
    ? allBranches.filter((b) => b.districtId === buDistrictId)
    : [];

  // Filtered branches based on selected district (edit dialog)
  const filteredBranchesForEdit = buEditDistrictId
    ? allBranches.filter((b) => b.districtId === buEditDistrictId)
    : [];

  const handleCreateBranchUser = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/districts/branch-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: buFullName,
          email: buEmail,
          phoneNumber: buPhone,
          password: buPassword || undefined,
          role: buRole,
          branchId: buBranchId,
          status: 'Active',
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create branch user');
      }
      toast({ title: 'Branch user created successfully' });
      resetBranchUserForm();
      await fetchBranchUsers();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateBranchUser = async () => {
    if (!editingBranchUser) return;
    setLoading(true);
    try {
      const res = await fetch('/api/districts/branch-users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingBranchUser.id,
          branchId: buEditBranchId,
          fullName: buEditFullName,
          email: buEditEmail,
          phoneNumber: buEditPhone,
          status: buEditStatus,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update branch user');
      }
      toast({ title: 'Branch user updated' });
      setBranchUserDialogOpen(false);
      setEditingBranchUser(null);
      await fetchBranchUsers();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteBranchUser = async (id: string) => {
    try {
      const res = await fetch(`/api/districts/branch-users?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Branch user removed' });
      await fetchBranchUsers();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  const handleResendSms = async (userId: string, userName: string) => {
    try {
      const res = await fetch('/api/districts/branch-users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, action: 'resend-sms' }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to resend SMS');
      }
      toast({ title: 'SMS Sent', description: `Login credentials resent to ${userName}` });
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  const handleResetPassword = async (userId: string, userName: string) => {
    try {
      const res = await fetch('/api/districts/branch-users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, action: 'reset-password' }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to reset password');
      }
      toast({ title: 'Password Reset', description: `New password sent via SMS to ${userName}` });
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  // ── Tabs config ──────────────────────────────────────────────────────────────

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'districts-branches', label: 'Districts & Branches', icon: <Building2 className="h-4 w-4" /> },
    { key: 'branch-user-access', label: 'Branch User Access', icon: <Users className="h-4 w-4" /> },
  ];

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Districts & Branches</h2>
        <p className="text-muted-foreground">Manage districts, branches, and branch user access.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab 1: Districts & Branches ── */}
      {activeTab === 'districts-branches' && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Districts Panel */}
          <div className="lg:col-span-2">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <MapPin className="h-5 w-5" />
                      Districts
                    </CardTitle>
                    <CardDescription>Select a district to manage its branches</CardDescription>
                  </div>
                  <Dialog
                    open={districtDialogOpen}
                    onOpenChange={(o) => {
                      setDistrictDialogOpen(o);
                      if (!o) resetDistrictForm();
                    }}
                  >
                    <DialogTrigger asChild>
                      <Button size="sm" className="bg-orange-500 hover:bg-orange-600">
                        <PlusCircle className="h-4 w-4 mr-1" />
                        Add
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{editingDistrict ? 'Edit District' : 'Add District'}</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div>
                          <Label>
                            Name <span className="text-red-500">*</span>
                          </Label>
                          <Input
                            value={districtName}
                            onChange={(e) => setDistrictName(e.target.value)}
                            placeholder="District name"
                          />
                        </div>
                        <div>
                          <Label>Status</Label>
                          <Select value={districtStatus} onValueChange={setDistrictStatus}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ACTIVE">Active</SelectItem>
                              <SelectItem value="INACTIVE">Inactive</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" onClick={() => setDistrictDialogOpen(false)}>
                            Cancel
                          </Button>
                          <Button
                            onClick={handleSaveDistrict}
                            disabled={loading || !districtName.trim()}
                          >
                            {loading ? 'Saving...' : 'Save'}
                          </Button>
                        </div>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {districts.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8 text-sm">
                    No districts found. Add your first district.
                  </p>
                ) : (
                  <div className="divide-y">
                    {paginatedDistricts.map((district) => (
                      <div
                        key={district.id}
                        onClick={() =>
                          setSelectedDistrict(selectedDistrict?.id === district.id ? null : district)
                        }
                        className={`flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors ${
                          selectedDistrict?.id === district.id ? 'bg-muted' : ''
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <ChevronRight
                            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                              selectedDistrict?.id === district.id ? 'rotate-90' : ''
                            }`}
                          />
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{district.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {district._count.branches} branch{district._count.branches !== 1 ? 'es' : ''}
                            </p>
                          </div>
                        </div>
                        <div
                          className="flex items-center gap-1 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Badge
                            variant={district.status === 'ACTIVE' ? 'default' : 'secondary'}
                            className="text-xs"
                          >
                            {district.status}
                          </Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              setEditingDistrict(district);
                              setDistrictName(district.name);
                              setDistrictStatus(district.status);
                              setDistrictDialogOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:text-destructive">
                                Delete
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete {district.name}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently delete this district and all its branches. This action
                                  cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleDeleteDistrict(district.id)}>
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {districts.length > DISTRICTS_PAGE_SIZE && (
                  <div className="flex items-center justify-between px-4 py-3 border-t">
                    <span className="text-xs text-muted-foreground">
                      Page {districtsPage} of {totalDistrictPages} ({districts.length} districts)
                    </span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={districtsPage <= 1} onClick={() => setDistrictsPage(p => p - 1)}>Prev</Button>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={districtsPage >= totalDistrictPages} onClick={() => setDistrictsPage(p => p + 1)}>Next</Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Branches Panel */}
          <div className="lg:col-span-3">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Building2 className="h-5 w-5" />
                      {selectedDistrict ? `Branches — ${selectedDistrict.name}` : 'Branches'}
                    </CardTitle>
                    <CardDescription>
                      {selectedDistrict
                        ? `Managing branches for ${selectedDistrict.name}`
                        : 'Select a district on the left to view and manage its branches'}
                    </CardDescription>
                  </div>
                  {selectedDistrict && (
                    <div className="flex gap-2">
                      {/* Bulk Upload */}
                      <Dialog
                        open={bulkDialogOpen}
                        onOpenChange={(o) => {
                          setBulkDialogOpen(o);
                          if (!o) setBulkFile(null);
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button size="sm" variant="outline">
                            <FileSpreadsheet className="h-4 w-4 mr-1" />
                            Bulk Upload
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Bulk Upload Branches</DialogTitle>
                          </DialogHeader>
                          <div className="space-y-4">
                            <div className="rounded-md border p-4 bg-muted/40 text-sm space-y-1">
                              <p className="font-medium">Excel file format:</p>
                              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                                <li>Row 1: Header row (ignored)</li>
                                <li>Column A: Branch Name (required)</li>
                                <li>Column B: Status — ACTIVE or INACTIVE (optional, defaults to ACTIVE)</li>
                              </ul>
                            </div>
                            <div>
                              <Label>Select Excel File (.xlsx)</Label>
                              <label className="mt-1 flex items-center gap-2 px-4 py-3 border border-dashed rounded-md cursor-pointer hover:bg-muted transition-colors text-sm text-muted-foreground">
                                <Upload className="h-4 w-4" />
                                {bulkFile ? bulkFile.name : 'Click to choose file'}
                                <input
                                  ref={bulkFileInputRef}
                                  type="file"
                                  accept=".xlsx,.xls"
                                  className="hidden"
                                  onChange={(e) => setBulkFile(e.target.files?.[0] || null)}
                                />
                              </label>
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>
                                Cancel
                              </Button>
                              <Button onClick={handleBulkUpload} disabled={loading || !bulkFile}>
                                {loading ? 'Uploading...' : 'Upload'}
                              </Button>
                            </div>
                          </div>
                        </DialogContent>
                      </Dialog>

                      {/* Add Branch */}
                      <Dialog
                        open={branchDialogOpen}
                        onOpenChange={(o) => {
                          setBranchDialogOpen(o);
                          if (!o) resetBranchForm();
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button size="sm" className="bg-orange-500 hover:bg-orange-600">
                            <PlusCircle className="h-4 w-4 mr-1" />
                            Add Branch
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>
                              {editingBranch ? 'Edit Branch' : `Add Branch to ${selectedDistrict?.name}`}
                            </DialogTitle>
                          </DialogHeader>
                          <div className="space-y-4">
                            <div>
                              <Label>
                                Name <span className="text-red-500">*</span>
                              </Label>
                              <Input
                                value={branchName}
                                onChange={(e) => setBranchName(e.target.value)}
                                placeholder="Branch name"
                              />
                            </div>
                            <div>
                              <Label>Status</Label>
                              <Select value={branchStatus} onValueChange={setBranchStatus}>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="ACTIVE">Active</SelectItem>
                                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button variant="outline" onClick={() => setBranchDialogOpen(false)}>
                                Cancel
                              </Button>
                              <Button
                                onClick={handleSaveBranch}
                                disabled={loading || !branchName.trim()}
                              >
                                {loading ? 'Saving...' : 'Save'}
                              </Button>
                            </div>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {!selectedDistrict ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                    <MapPin className="h-12 w-12 mb-4 opacity-30" />
                    <p className="text-sm">Select a district from the left panel to view its branches</p>
                  </div>
                ) : branches.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                    <Building2 className="h-12 w-12 mb-4 opacity-30" />
                    <p className="text-sm">No branches in this district yet.</p>
                    <p className="text-xs mt-1">Use the &quot;Add Branch&quot; or &quot;Bulk Upload&quot; buttons to add branches.</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Branch Name</TableHead>
                        <TableHead>Users</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedBranches.map((branch) => (
                        <TableRow key={branch.id}>
                          <TableCell className="font-medium">{branch.name}</TableCell>
                          <TableCell>
                            <span className="flex items-center gap-1 text-muted-foreground text-sm">
                              <Users className="h-3.5 w-3.5" />
                              {branch._count.users}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge variant={branch.status === 'ACTIVE' ? 'default' : 'secondary'}>
                              {branch.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right space-x-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEditingBranch(branch);
                                setBranchName(branch.name);
                                setBranchStatus(branch.status);
                                setBranchDialogOpen(true);
                              }}
                            >
                              Edit
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button size="sm" variant="destructive">
                                  Delete
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete {branch.name}?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This will permanently delete this branch. Users assigned to this branch
                                    will have their branch assignment removed.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => handleDeleteBranch(branch.id)}>
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {branches.length > BRANCHES_PAGE_SIZE && (
                  <div className="flex items-center justify-between px-4 py-3 border-t">
                    <span className="text-xs text-muted-foreground">
                      Page {branchesPage} of {totalBranchPages} ({branches.length} branches)
                    </span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={branchesPage <= 1} onClick={() => setBranchesPage(p => p - 1)}>Prev</Button>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={branchesPage >= totalBranchPages} onClick={() => setBranchesPage(p => p + 1)}>Next</Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ── Tab 2: Branch User Access ── */}
      {activeTab === 'branch-user-access' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Create Branch User form */}
          <Card>
            <CardHeader>
              <CardTitle>Register Branch User</CardTitle>
              <CardDescription>Create a platform user and assign them to a branch.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>
                  Full Name <span className="text-red-500">*</span>
                </Label>
                <Input value={buFullName} onChange={(e) => setBuFullName(e.target.value)} placeholder="Full name" />
              </div>
              <div>
                <Label>
                  Email <span className="text-red-500">*</span>
                </Label>
                <Input
                  type="email"
                  value={buEmail}
                  onChange={(e) => setBuEmail(e.target.value)}
                  placeholder="Email address"
                />
              </div>
              <div>
                <Label>
                  Phone Number <span className="text-red-500">*</span>
                </Label>
                <Input value={buPhone} onChange={(e) => setBuPhone(e.target.value)} placeholder="Phone number" />
              </div>
              <div>
                <Label>Password (optional — auto-generated if empty)</Label>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={buPassword}
                    onChange={(e) => setBuPassword(e.target.value)}
                    placeholder="Leave blank to auto-generate"
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                </div>
              </div>
              <div>
                <Label>
                  Role <span className="text-red-500">*</span>
                </Label>
                <Select value={buRole} onValueChange={setBuRole}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.name}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>
                  District <span className="text-red-500">*</span>
                </Label>
                <Select value={buDistrictId} onValueChange={(val) => { setBuDistrictId(val); setBuBranchId(''); }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select district" />
                  </SelectTrigger>
                  <SelectContent>
                    {districts.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>
                  Assign to Branch <span className="text-red-500">*</span>
                </Label>
                <Select value={buBranchId} onValueChange={setBuBranchId} disabled={!buDistrictId}>
                  <SelectTrigger>
                    <SelectValue placeholder={buDistrictId ? 'Select branch' : 'Select a district first'} />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredBranchesForCreate.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-sm text-muted-foreground">
                A temporary password will be generated if none is provided. The user will be required to change
                it on first login.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={resetBranchUserForm}
                  disabled={loading}
                >
                  Clear
                </Button>
                <Button
                  className="bg-amber-500 hover:bg-amber-600"
                  onClick={handleCreateBranchUser}
                  disabled={loading || !buFullName || !buEmail || !buPhone || !buRole || !buBranchId}
                >
                  {loading ? 'Creating...' : 'Create Branch User'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Branch Users list */}
          <Card>
            <CardHeader>
              <CardTitle>Existing Branch Users</CardTitle>
              <CardDescription>Users currently assigned to a branch.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>District</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {branchUsers.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium text-sm">{u.fullName}</p>
                          <p className="text-xs text-muted-foreground">{u.email}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{u.branchName ?? '-'}</TableCell>
                      <TableCell className="text-sm">{u.districtName ?? '-'}</TableCell>
                      <TableCell className="text-sm">{u.role}</TableCell>
                      <TableCell>
                        <Badge variant={u.status === 'Active' ? 'default' : 'secondary'} className="text-xs">
                          {u.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2"
                            title="Resend SMS"
                            onClick={() => handleResendSms(u.id, u.fullName)}
                          >
                            <Send className="h-3.5 w-3.5" />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button size="sm" variant="ghost" className="h-8 px-2" title="Reset Password">
                                <RotateCcw className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Reset password for {u.fullName}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  A new password will be generated and sent via SMS to {u.phoneNumber}.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleResetPassword(u.id, u.fullName)}>
                                  Reset Password
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8"
                            onClick={() => {
                              setEditingBranchUser(u);
                              setBuEditBranchId(u.branchId || '');
                              setBuEditFullName(u.fullName);
                              setBuEditEmail(u.email);
                              setBuEditPhone(u.phoneNumber);
                              setBuEditStatus(u.status);
                              const currentBranch = allBranches.find(b => b.id === u.branchId);
                              setBuEditDistrictId(currentBranch?.districtId || '');
                              setBranchUserDialogOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button size="sm" variant="destructive" className="h-8">
                                Remove
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remove {u.fullName}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently delete this user account. This action cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleDeleteBranchUser(u.id)}>
                                  Remove
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {branchUsers.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        No branch users found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Edit Branch User Dialog */}
      <Dialog
        open={branchUserDialogOpen}
        onOpenChange={(o) => {
          setBranchUserDialogOpen(o);
          if (!o) setEditingBranchUser(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Branch User — {editingBranchUser?.fullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Full Name <span className="text-red-500">*</span></Label>
              <Input value={buEditFullName} onChange={(e) => setBuEditFullName(e.target.value)} placeholder="Full name" />
            </div>
            <div>
              <Label>Email <span className="text-red-500">*</span></Label>
              <Input type="email" value={buEditEmail} onChange={(e) => setBuEditEmail(e.target.value)} placeholder="Email address" />
            </div>
            <div>
              <Label>Phone Number <span className="text-red-500">*</span></Label>
              <Input value={buEditPhone} onChange={(e) => setBuEditPhone(e.target.value)} placeholder="Phone number" />
            </div>
            <div>
              <Label>Status</Label>
              <Select value={buEditStatus} onValueChange={setBuEditStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>District</Label>
              <Select value={buEditDistrictId} onValueChange={(val) => { setBuEditDistrictId(val); setBuEditBranchId(''); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select district" />
                </SelectTrigger>
                <SelectContent>
                  {districts.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Assign to Branch</Label>
              <Select value={buEditBranchId} onValueChange={setBuEditBranchId} disabled={!buEditDistrictId}>
                <SelectTrigger>
                  <SelectValue placeholder={buEditDistrictId ? 'Select branch' : 'Select a district first'} />
                </SelectTrigger>
                <SelectContent>
                  {filteredBranchesForEdit.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setBranchUserDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleUpdateBranchUser} disabled={loading || !buEditBranchId || !buEditFullName || !buEditEmail || !buEditPhone}>
                {loading ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
