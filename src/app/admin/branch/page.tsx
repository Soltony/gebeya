'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { PlusCircle, Upload, Pencil, Trash2, Eye, EyeOff, RotateCcw, Send } from 'lucide-react';
import { useRequirePermission } from '@/hooks/use-require-permission';

type TabKey = 'merchants' | 'merchant-users' | 'product-categories';

// --- Validation helpers ---
const PHONE_REGEX = /^(09\d{8}|9\d{8}|\+2519\d{8})$/;
const ACCOUNT_NUMBER_REGEX = /^7\d{12}$/;

function validateAccountNumber(value: string): string | null {
  if (!value.trim()) return 'Account number is required.';
  if (!ACCOUNT_NUMBER_REGEX.test(value.trim())) return 'Account number must start with 7 and be 13 characters long.';
  return null;
}

function validatePhone(value: string): string | null {
  if (!value.trim()) return 'Phone number is required.';
  if (!PHONE_REGEX.test(value.trim())) return 'Invalid Ethiopian phone format. Use 0912345678, 912345678, or +251912345678.';
  return null;
}

function validateEmail(value: string): string | null {
  if (!value.trim()) return null; // email is optional for merchants
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return 'Invalid email address.';
  return null;
}

function validateRequired(value: string, fieldName: string): string | null {
  if (!value.trim()) return `${fieldName} is required.`;
  return null;
}

export default function BranchPage() {
  useRequirePermission('branch');
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<TabKey>('merchants');
  const [merchants, setMerchants] = useState<any[]>([]);
  const [pendingMerchants, setPendingMerchants] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [merchantUsers, setMerchantUsers] = useState<any[]>([]);
  const [allMerchants, setAllMerchants] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Merchant form
  const [merchantDialogOpen, setMerchantDialogOpen] = useState(false);
  const [editingMerchant, setEditingMerchant] = useState<any>(null);
  const [merchantName, setMerchantName] = useState('');
  const [merchantAccountNumber, setMerchantAccountNumber] = useState('');
  const [merchantIconFile, setMerchantIconFile] = useState<File | null>(null);
  const [merchantIconPreview, setMerchantIconPreview] = useState('');
  const [merchantContactPersonName, setMerchantContactPersonName] = useState('');
  const [merchantContactPersonPhone, setMerchantContactPersonPhone] = useState('');
  const [merchantContactPersonEmail, setMerchantContactPersonEmail] = useState('');
  const [merchantAdditionalContact, setMerchantAdditionalContact] = useState('');
  const [merchantBnplEnabled, setMerchantBnplEnabled] = useState(true);
  const [merchantStatus, setMerchantStatus] = useState('ACTIVE');
  const [merchantErrors, setMerchantErrors] = useState<Record<string, string | null>>({});

  // Merchant user form - editing
  const [editingMerchantUser, setEditingMerchantUser] = useState<any>(null);
  const [muEditDialogOpen, setMuEditDialogOpen] = useState(false);
  const [muEditFullName, setMuEditFullName] = useState('');
  const [muEditEmail, setMuEditEmail] = useState('');
  const [muEditPhone, setMuEditPhone] = useState('');
  const [muEditStatus, setMuEditStatus] = useState('Active');
  const [muEditMerchantId, setMuEditMerchantId] = useState('');
  const [muEditErrors, setMuEditErrors] = useState<Record<string, string | null>>({});

  // Merchant user form - validation
  const [muErrors, setMuErrors] = useState<Record<string, string | null>>({});

  // Category form
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<any>(null);
  const [categoryName, setCategoryName] = useState('');

  // Merchant user form
  const [muFullName, setMuFullName] = useState('');
  const [muEmail, setMuEmail] = useState('');
  const [muPhone, setMuPhone] = useState('');
  const [muPassword, setMuPassword] = useState('');
  const [muRole, setMuRole] = useState('Merchant');
  const [muMerchantId, setMuMerchantId] = useState('');
  const [showMuPassword, setShowMuPassword] = useState(false);

  const fetchMerchants = useCallback(async () => {
    try {
      const res = await fetch('/api/merchants');
      if (res.ok) setMerchants(await res.json());
    } catch { /* ignore */ }
    // Also fetch pending merchant creations
    try {
      const res = await fetch('/api/approvals');
      if (res.ok) {
        const all = await res.json();
        const pendingCreates = all.filter((pc: any) => pc.entityType === 'Merchant' && pc.changeType === 'CREATE' && pc.status === 'PENDING');
        setPendingMerchants(pendingCreates.map((pc: any) => {
          const payload = JSON.parse(pc.payload);
          return {
            id: pc.id,
            name: payload.created?.name || 'N/A',
            accountNumber: payload.created?.accountNumber || null,
            contactPersonName: payload.created?.contactPersonName || null,
            status: 'PENDING_APPROVAL',
            iconUrl: payload.created?.iconUrl || null,
            bnplEnabled: payload.created?.bnplEnabled,
            _isPending: true,
          };
        }));
      }
    } catch { /* ignore */ }
  }, []);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/merchants/categories');
      if (res.ok) setCategories(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchMerchantUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/users');
      if (res.ok) {
        const users = await res.json();
        setMerchantUsers(users.filter((u: any) => u.role === 'Merchant'));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchMerchants();
    fetchCategories();
    fetchMerchantUsers();
  }, [fetchMerchants, fetchCategories, fetchMerchantUsers]);

  useEffect(() => {
    setAllMerchants(merchants.filter(m => m.status === 'ACTIVE'));
  }, [merchants]);

  // --- Merchants Tab ---
  const resetMerchantForm = () => {
    setEditingMerchant(null);
    setMerchantName('');
    setMerchantAccountNumber('');
    setMerchantIconFile(null);
    setMerchantIconPreview('');
    setMerchantContactPersonName('');
    setMerchantContactPersonPhone('');
    setMerchantContactPersonEmail('');
    setMerchantAdditionalContact('');
    setMerchantBnplEnabled(true);
    setMerchantStatus('ACTIVE');
    setMerchantErrors({});
  };

  const handleSaveMerchant = async () => {
    // Validate all fields
    const errors: Record<string, string | null> = {};
    errors.name = validateRequired(merchantName, 'Name');
    errors.accountNumber = validateAccountNumber(merchantAccountNumber);
    errors.contactPersonName = validateRequired(merchantContactPersonName, 'Contact Person Name');
    errors.contactPersonPhone = validatePhone(merchantContactPersonPhone);
    errors.contactPersonEmail = validateEmail(merchantContactPersonEmail);
    setMerchantErrors(errors);

    const hasErrors = Object.values(errors).some(e => e !== null);
    if (hasErrors) return;

    setLoading(true);
    try {
      let iconUrl: string | null = null;
      if (merchantIconFile) {
        const reader = new FileReader();
        iconUrl = await new Promise<string>((resolve) => {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(merchantIconFile);
        });
      } else if (editingMerchant?.iconUrl) {
        iconUrl = editingMerchant.iconUrl;
      }

      const method = editingMerchant ? 'PUT' : 'POST';
      const body = editingMerchant
        ? {
            id: editingMerchant.id,
            name: merchantName,
            status: merchantStatus,
            accountNumber: merchantAccountNumber,
            iconUrl,
            contactPersonName: merchantContactPersonName,
            contactPersonPhone: merchantContactPersonPhone,
            contactPersonEmail: merchantContactPersonEmail,
            additionalContactInfo: merchantAdditionalContact,
            bnplEnabled: merchantBnplEnabled,
          }
        : {
            name: merchantName,
            status: merchantStatus,
            accountNumber: merchantAccountNumber,
            iconUrl,
            contactPersonName: merchantContactPersonName,
            contactPersonPhone: merchantContactPersonPhone,
            contactPersonEmail: merchantContactPersonEmail,
            additionalContactInfo: merchantAdditionalContact,
            bnplEnabled: merchantBnplEnabled,
          };
      const res = await fetch('/api/merchants', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        let msg = 'An unexpected error occurred. Please try again.';
        try {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const err = await res.json();
            msg = err.error || msg;
          }
        } catch { /* ignore parse errors */ }
        throw new Error(msg);
      }
      toast({ title: editingMerchant ? 'Update submitted for approval' : 'Merchant submitted for approval' });
      setMerchantDialogOpen(false);
      resetMerchantForm();
      fetchMerchants();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  const handleDeleteMerchant = async (id: string) => {
    try {
      const res = await fetch(`/api/merchants?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Delete submitted for approval' });
      fetchMerchants();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  // --- Categories Tab ---
  const handleSaveCategory = async () => {
    setLoading(true);
    try {
      const method = editingCategory ? 'PUT' : 'POST';
      const body = editingCategory
        ? { id: editingCategory.id, name: categoryName }
        : { name: categoryName };
      const res = await fetch('/api/merchants/categories', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      toast({ title: editingCategory ? 'Category updated' : 'Category created' });
      setCategoryDialogOpen(false);
      setEditingCategory(null);
      setCategoryName('');
      fetchCategories();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  const handleDeleteCategory = async (id: string) => {
    try {
      const res = await fetch(`/api/merchants/categories?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Category deleted' });
      fetchCategories();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  // --- Merchant Users Tab ---
  const handleCreateMerchantUser = async () => {
    // Validate all fields
    const errors: Record<string, string | null> = {};
    errors.fullName = validateRequired(muFullName, 'Full Name');
    errors.email = muEmail.trim() ? validateEmail(muEmail) : 'Email is required.';
    if (!muEmail.trim()) errors.email = 'Email is required.';
    else { const emailErr = validateEmail(muEmail); if (emailErr) errors.email = emailErr; }
    errors.phone = validatePhone(muPhone);
    errors.merchantId = !muMerchantId ? 'Associate merchant is required.' : null;
    setMuErrors(errors);

    const hasErrors = Object.values(errors).some(e => e !== null);
    if (hasErrors) return;

    setLoading(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: muFullName,
          email: muEmail,
          phoneNumber: muPhone,
          password: muPassword || undefined,
          role: muRole,
          providerId: null,
          status: 'Active',
          merchantId: muMerchantId || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        const msg = err.error || 'Failed to create user';
        // Surface specific field errors inline
        if (msg.toLowerCase().includes('email already exists')) {
          setMuErrors(prev => ({ ...prev, email: msg }));
        } else if (msg.toLowerCase().includes('phone number already exists')) {
          setMuErrors(prev => ({ ...prev, phone: msg }));
        }
        throw new Error(msg);
      }
      toast({ title: 'Merchant user submitted for approval' });
      setMuFullName(''); setMuEmail(''); setMuPhone(''); setMuPassword(''); setMuMerchantId('');
      setMuErrors({});
      fetchMerchantUsers();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  const handleEditMerchantUser = async () => {
    if (!editingMerchantUser) return;
    const errors: Record<string, string | null> = {};
    errors.fullName = validateRequired(muEditFullName, 'Full Name');
    errors.email = !muEditEmail.trim() ? 'Email is required.' : validateEmail(muEditEmail);
    errors.phone = validatePhone(muEditPhone);
    setMuEditErrors(errors);
    if (Object.values(errors).some(e => e !== null)) return;

    setLoading(true);
    try {
      const res = await fetch('/api/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingMerchantUser.id,
          fullName: muEditFullName,
          email: muEditEmail,
          phoneNumber: muEditPhone,
          status: muEditStatus,
          merchantId: muEditMerchantId || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        const msg = err.error || 'Failed to update user';
        if (msg.toLowerCase().includes('email already exists')) {
          setMuEditErrors(prev => ({ ...prev, email: msg }));
        } else if (msg.toLowerCase().includes('phone number already exists')) {
          setMuEditErrors(prev => ({ ...prev, phone: msg }));
        }
        throw new Error(msg);
      }
      toast({ title: 'Merchant user updated' });
      setMuEditDialogOpen(false);
      setEditingMerchantUser(null);
      setMuEditErrors({});
      fetchMerchantUsers();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  const handleDeleteMerchantUser = async (id: string) => {
    try {
      const body = JSON.stringify({ id });
      const res = await fetch('/api/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Merchant user deleted' });
      fetchMerchantUsers();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  const handleResendMerchantSms = async (userId: string, userName: string) => {
    try {
      const res = await fetch('/api/users', {
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

  const handleResetMerchantPassword = async (userId: string, userName: string) => {
    try {
      const res = await fetch('/api/users', {
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

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'merchants', label: 'Merchants' },
    { key: 'merchant-users', label: 'Merchant Users' },
    { key: 'product-categories', label: 'Product Categories' },
  ];

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Branch</h2>
        <p className="text-muted-foreground">Create and manage merchants and product categories.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Merchants Tab */}
      {activeTab === 'merchants' && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex justify-end mb-4">
              <Dialog open={merchantDialogOpen} onOpenChange={(o) => { setMerchantDialogOpen(o); if (!o) resetMerchantForm(); }}>
                <DialogTrigger asChild>
                  <Button className="bg-orange-500 hover:bg-orange-600"><PlusCircle className="mr-2 h-4 w-4" />Add Merchant</Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                  <DialogHeader><DialogTitle>{editingMerchant ? 'Edit Merchant' : 'Add Merchant'}</DialogTitle></DialogHeader>
                  <div className="space-y-6">
                    {/* Basic Information */}
                    <div className="space-y-4">
                      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Basic Information</h3>
                      <div>
                        <Label>Name <span className="text-red-500">*</span></Label>
                        <Input value={merchantName} onChange={e => { setMerchantName(e.target.value); setMerchantErrors(prev => ({ ...prev, name: null })); }} placeholder="Merchant name" />
                        {merchantErrors.name && <p className="text-sm text-destructive mt-1">{merchantErrors.name}</p>}
                      </div>
                      <div>
                        <Label>Account Number <span className="text-red-500">*</span></Label>
                        <Input value={merchantAccountNumber} onChange={e => { const v = e.target.value.replace(/\D/g, ''); setMerchantAccountNumber(v); setMerchantErrors(prev => ({ ...prev, accountNumber: null })); }} placeholder="Account number (starts with 7, 13 digits)" maxLength={13} />
                        {merchantErrors.accountNumber && <p className="text-sm text-destructive mt-1">{merchantErrors.accountNumber}</p>}
                      </div>
                      <div>
                        <Label>Status</Label>
                        <Select value={merchantStatus} onValueChange={setMerchantStatus}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ACTIVE">Active</SelectItem>
                            <SelectItem value="INACTIVE">Inactive</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Icon</Label>
                        <div className="flex items-center gap-4">
                          {(merchantIconPreview || editingMerchant?.iconUrl) && (
                            <img
                              src={merchantIconPreview || editingMerchant?.iconUrl}
                              alt="Merchant icon preview"
                              className="h-16 w-16 rounded-lg object-cover border"
                            />
                          )}
                          <label className="flex items-center gap-2 px-4 py-2 border rounded-md cursor-pointer hover:bg-muted transition-colors text-sm">
                            <Upload className="h-4 w-4" />
                            {merchantIconFile ? merchantIconFile.name : 'Upload icon'}
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/gif,image/webp"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0] || null;
                                if (file) {
                                  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
                                  if (!ALLOWED_TYPES.includes(file.type)) {
                                    toast({ title: 'Invalid file type', description: 'Please upload a JPEG, PNG, GIF, or WebP image.', variant: 'destructive' });
                                    e.target.value = '';
                                    return;
                                  }
                                  if (file.size > 5 * 1024 * 1024) {
                                    toast({ title: 'File too large', description: 'Image must be under 5 MB.', variant: 'destructive' });
                                    e.target.value = '';
                                    return;
                                  }
                                }
                                setMerchantIconFile(file);
                                if (file) {
                                  const reader = new FileReader();
                                  reader.onload = () => setMerchantIconPreview(reader.result as string);
                                  reader.readAsDataURL(file);
                                } else {
                                  setMerchantIconPreview('');
                                }
                              }}
                            />
                          </label>
                        </div>
                      </div>
                    </div>

                    {/* BNPL Toggle */}
                    <div className="space-y-4">
                      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Payment Options</h3>
                      <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                          <Label className="text-base">Enable BNPL (Buy Now, Pay Later)</Label>
                          <p className="text-sm text-muted-foreground">Allow this merchant to support BNPL transactions</p>
                        </div>
                        <Switch checked={merchantBnplEnabled} onCheckedChange={setMerchantBnplEnabled} />
                      </div>
                    </div>

                    {/* Business Deal / Contact Person */}
                    <div className="space-y-4">
                      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Business Deal Information</h3>
                      <div>
                        <Label>Contact Person Name <span className="text-red-500">*</span></Label>
                        <Input value={merchantContactPersonName} onChange={e => { setMerchantContactPersonName(e.target.value); setMerchantErrors(prev => ({ ...prev, contactPersonName: null })); }} placeholder="Full name of contact person" />
                        {merchantErrors.contactPersonName && <p className="text-sm text-destructive mt-1">{merchantErrors.contactPersonName}</p>}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <Label>Contact Person Phone <span className="text-red-500">*</span></Label>
                          <Input value={merchantContactPersonPhone} onChange={e => { setMerchantContactPersonPhone(e.target.value); setMerchantErrors(prev => ({ ...prev, contactPersonPhone: null })); }} placeholder="e.g., 0912345678" />
                          {merchantErrors.contactPersonPhone && <p className="text-sm text-destructive mt-1">{merchantErrors.contactPersonPhone}</p>}
                        </div>
                        <div>
                          <Label>Contact Person Email</Label>
                          <Input type="email" value={merchantContactPersonEmail} onChange={e => { setMerchantContactPersonEmail(e.target.value); setMerchantErrors(prev => ({ ...prev, contactPersonEmail: null })); }} placeholder="Email address" />
                          {merchantErrors.contactPersonEmail && <p className="text-sm text-destructive mt-1">{merchantErrors.contactPersonEmail}</p>}
                        </div>
                      </div>
                    </div>

                    {/* Additional Contact Info */}
                    <div className="space-y-4">
                      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Additional Contact Information</h3>
                      <div>
                        <Label>Extra Contact Details</Label>
                        <Textarea
                          value={merchantAdditionalContact}
                          onChange={e => setMerchantAdditionalContact(e.target.value)}
                          placeholder="Any additional contact information (e.g. secondary phone, address, social media, etc.)"
                          rows={3}
                        />
                      </div>
                    </div>

                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setMerchantDialogOpen(false)}>Cancel</Button>
                      <Button onClick={handleSaveMerchant} disabled={loading}>
                        {loading ? 'Saving...' : 'Save'}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Account Number</TableHead>
                  <TableHead>Contact Person</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...merchants, ...pendingMerchants].map(m => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {m.iconUrl && <img src={m.iconUrl} alt="" className="h-8 w-8 rounded object-cover" />}
                        {m.name}
                      </div>
                    </TableCell>
                    <TableCell>{m.accountNumber || '-'}</TableCell>
                    <TableCell>{m.contactPersonName || '-'}</TableCell>
                    <TableCell>
                      <Badge variant={m.status === 'ACTIVE' ? 'default' : m.status === 'PENDING_APPROVAL' ? 'outline' : 'secondary'}>
                        {m.status === 'PENDING_APPROVAL' ? 'Pending' : m.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {!m._isPending && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => { setEditingMerchant(m); setMerchantName(m.name); setMerchantAccountNumber(m.accountNumber || ''); setMerchantIconPreview(m.iconUrl || ''); setMerchantContactPersonName(m.contactPersonName || ''); setMerchantContactPersonPhone(m.contactPersonPhone || ''); setMerchantContactPersonEmail(m.contactPersonEmail || ''); setMerchantAdditionalContact(m.additionalContactInfo || ''); setMerchantBnplEnabled(m.bnplEnabled !== false); setMerchantStatus(m.status || 'ACTIVE'); setMerchantDialogOpen(true); }}>Edit</Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild><Button size="sm" variant="destructive">Delete</Button></AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader><AlertDialogTitle>Delete {m.name}?</AlertDialogTitle><AlertDialogDescription>This action will submit a delete request for approval.</AlertDialogDescription></AlertDialogHeader>
                              <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => handleDeleteMerchant(m.id)}>Delete</AlertDialogAction></AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </>
                      )}
                      {m._isPending && <span className="text-sm text-muted-foreground">Awaiting approval</span>}
                    </TableCell>
                  </TableRow>
                ))}
                {merchants.length === 0 && pendingMerchants.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No merchants found.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Merchant Users Tab */}
      {activeTab === 'merchant-users' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Register Merchant User</CardTitle>
              <CardDescription>Create platform users with the merchant role.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Associate Merchant <span className="text-red-500">*</span></Label>
                <Select value={muMerchantId} onValueChange={(v) => { setMuMerchantId(v); setMuErrors(prev => ({ ...prev, merchantId: null })); }}>
                  <SelectTrigger><SelectValue placeholder="Select merchant" /></SelectTrigger>
                  <SelectContent>
                    {allMerchants.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {muErrors.merchantId && <p className="text-sm text-destructive mt-1">{muErrors.merchantId}</p>}
              </div>
              <div>
                <Label>Full name <span className="text-red-500">*</span></Label>
                <Input value={muFullName} onChange={e => { setMuFullName(e.target.value); setMuErrors(prev => ({ ...prev, fullName: null })); }} />
                {muErrors.fullName && <p className="text-sm text-destructive mt-1">{muErrors.fullName}</p>}
              </div>
              <div>
                <Label>Email <span className="text-red-500">*</span></Label>
                <Input type="email" value={muEmail} onChange={e => { setMuEmail(e.target.value); setMuErrors(prev => ({ ...prev, email: null })); }} />
                {muErrors.email && <p className="text-sm text-destructive mt-1">{muErrors.email}</p>}
              </div>
              <div>
                <Label>Phone <span className="text-red-500">*</span></Label>
                <Input value={muPhone} onChange={e => { setMuPhone(e.target.value); setMuErrors(prev => ({ ...prev, phone: null })); }} placeholder="e.g., 0912345678" />
                {muErrors.phone && <p className="text-sm text-destructive mt-1">{muErrors.phone}</p>}
              </div>
              <div>
                <Label>Password (optional — auto-generated if empty)</Label>
                <div className="relative">
                  <Input
                    type={showMuPassword ? 'text' : 'password'}
                    value={muPassword}
                    onChange={e => setMuPassword(e.target.value)}
                    placeholder="Leave blank to auto-generate"
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                    onClick={() => setShowMuPassword(!showMuPassword)}
                  >
                    {showMuPassword ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                </div>
              </div>
              <div>
                <Label>Role</Label>
                <Select value={muRole} onValueChange={setMuRole}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="Merchant">Merchant</SelectItem></SelectContent>
                </Select>
              </div>
              <p className="text-sm text-muted-foreground">Users created here will be submitted for approval and won&apos;t appear until approved.</p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => { setMuFullName(''); setMuEmail(''); setMuPhone(''); setMuPassword(''); setMuMerchantId(''); setMuErrors({}); }}>Cancel</Button>
                <Button className="bg-amber-500 hover:bg-amber-600" onClick={handleCreateMerchantUser} disabled={loading}>
                  Submit for Approval
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Existing Merchant Users</CardTitle>
              <CardDescription>Accounts with the merchant role.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Merchant</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {merchantUsers.map(u => (
                    <TableRow key={u.id}>
                      <TableCell>{u.fullName}</TableCell>
                      <TableCell>{u.email}</TableCell>
                      <TableCell>{u.phoneNumber}</TableCell>
                      <TableCell>{u.merchantName || u.providerName || '-'}</TableCell>
                      <TableCell>{u.role}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2"
                            title="Resend SMS"
                            onClick={() => handleResendMerchantSms(u.id, u.fullName)}
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
                                <AlertDialogAction onClick={() => handleResetMerchantPassword(u.id, u.fullName)}>
                                  Reset Password
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                          <Button size="sm" variant="outline" className="h-8" onClick={() => {
                            setEditingMerchantUser(u);
                            setMuEditFullName(u.fullName);
                            setMuEditEmail(u.email);
                            setMuEditPhone(u.phoneNumber);
                            setMuEditStatus(u.status || 'Active');
                            setMuEditMerchantId(u.merchantId || '');
                            setMuEditErrors({});
                            setMuEditDialogOpen(true);
                          }}>
                            <Pencil className="h-3 w-3 mr-1" />Edit
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button size="sm" variant="destructive" className="h-8">
                                <Trash2 className="h-3 w-3 mr-1" />Delete
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete {u.fullName}?</AlertDialogTitle>
                                <AlertDialogDescription>This action cannot be undone. The user will be permanently removed.</AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleDeleteMerchantUser(u.id)}>Delete</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {merchantUsers.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No merchant users found.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Edit Merchant User Dialog */}
          <Dialog open={muEditDialogOpen} onOpenChange={(o) => { setMuEditDialogOpen(o); if (!o) { setEditingMerchantUser(null); setMuEditErrors({}); } }}>
            <DialogContent>
              <DialogHeader><DialogTitle>Edit Merchant User</DialogTitle></DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Associate Merchant</Label>
                  <Select value={muEditMerchantId} onValueChange={setMuEditMerchantId}>
                    <SelectTrigger><SelectValue placeholder="Select merchant" /></SelectTrigger>
                    <SelectContent>
                      {allMerchants.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Full Name <span className="text-red-500">*</span></Label>
                  <Input value={muEditFullName} onChange={e => { setMuEditFullName(e.target.value); setMuEditErrors(prev => ({ ...prev, fullName: null })); }} />
                  {muEditErrors.fullName && <p className="text-sm text-destructive mt-1">{muEditErrors.fullName}</p>}
                </div>
                <div>
                  <Label>Email <span className="text-red-500">*</span></Label>
                  <Input type="email" value={muEditEmail} onChange={e => { setMuEditEmail(e.target.value); setMuEditErrors(prev => ({ ...prev, email: null })); }} />
                  {muEditErrors.email && <p className="text-sm text-destructive mt-1">{muEditErrors.email}</p>}
                </div>
                <div>
                  <Label>Phone <span className="text-red-500">*</span></Label>
                  <Input value={muEditPhone} onChange={e => { setMuEditPhone(e.target.value); setMuEditErrors(prev => ({ ...prev, phone: null })); }} placeholder="e.g., 0912345678" />
                  {muEditErrors.phone && <p className="text-sm text-destructive mt-1">{muEditErrors.phone}</p>}
                </div>
                <div>
                  <Label>Status</Label>
                  <Select value={muEditStatus} onValueChange={setMuEditStatus}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Active">Active</SelectItem>
                      <SelectItem value="Inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setMuEditDialogOpen(false)}>Cancel</Button>
                  <Button onClick={handleEditMerchantUser} disabled={loading}>
                    {loading ? 'Saving...' : 'Save Changes'}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* Product Categories Tab */}
      {activeTab === 'product-categories' && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex justify-end mb-4">
              <Dialog open={categoryDialogOpen} onOpenChange={(o) => { setCategoryDialogOpen(o); if (!o) { setEditingCategory(null); setCategoryName(''); } }}>
                <DialogTrigger asChild>
                  <Button className="bg-orange-500 hover:bg-orange-600"><PlusCircle className="mr-2 h-4 w-4" />Add Category</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>{editingCategory ? 'Edit Category' : 'Add Category'}</DialogTitle></DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label>Name</Label>
                      <Input value={categoryName} onChange={e => setCategoryName(e.target.value)} placeholder="Category name" />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setCategoryDialogOpen(false)}>Cancel</Button>
                      <Button onClick={handleSaveCategory} disabled={loading || !categoryName.trim()}>
                        {loading ? 'Saving...' : 'Save'}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map(c => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell><Badge variant="outline">{c.status}</Badge></TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button size="sm" variant="outline" onClick={() => { setEditingCategory(c); setCategoryName(c.name); setCategoryDialogOpen(true); }}>Edit</Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild><Button size="sm" variant="destructive">Delete</Button></AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader><AlertDialogTitle>Delete {c.name}?</AlertDialogTitle><AlertDialogDescription>This will permanently delete the category.</AlertDialogDescription></AlertDialogHeader>
                          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => handleDeleteCategory(c.id)}>Delete</AlertDialogAction></AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
                {categories.length === 0 && (
                  <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-8">No categories found.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
