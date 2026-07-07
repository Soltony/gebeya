'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { AlertTriangle, Clock, PlusCircle } from 'lucide-react';
import { useRequirePermission } from '@/hooks/use-require-permission';

interface PendingLocationChange {
  id: string;
  entityType: string;
  entityId: string | null;
  changeType: string;
  payload: string;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
}

interface LocationRecord {
  id: string;
  name: string;
  address?: string | null;
  contactInfo?: string | null;
  status: string;
}

function getLocationName(change: PendingLocationChange) {
  try {
    const payload = JSON.parse(change.payload);
    return payload?.created?.name || payload?.updated?.name || payload?.original?.name || '—';
  } catch {
    return '—';
  }
}

export default function MerchantLocationsPage() {
  useRequirePermission('merchants');
  const { toast } = useToast();
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingLocationChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LocationRecord | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [contactInfo, setContactInfo] = useState('');

  const fetchLocations = useCallback(async () => {
    try {
      const res = await fetch('/api/branches/locations');
      if (res.ok) setLocations(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchPendingChanges = useCallback(async () => {
    try {
      const res = await fetch('/api/merchants/pending-changes');
      if (!res.ok) return;

      const changes = await res.json();
      setPendingChanges(changes.filter((change: PendingLocationChange) => change.entityType === 'MerchantLocation'));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchLocations();
    fetchPendingChanges();
  }, [fetchLocations, fetchPendingChanges]);

  const getLocationApprovalStatus = (locationId: string) => {
    const pending = pendingChanges.find(change => change.entityId === locationId && change.status === 'PENDING');
    if (pending) return { status: 'PENDING', change: pending };

    const rejected = pendingChanges.find(change => change.entityId === locationId && change.status === 'REJECTED');
    if (rejected) return { status: 'REJECTED', change: rejected };

    return null;
  };

  const pendingCreates = pendingChanges.filter(change => change.changeType === 'CREATE' && change.status === 'PENDING');
  const rejectedCreates = pendingChanges.filter(change => change.changeType === 'CREATE' && change.status === 'REJECTED');

  const handleSave = async () => {
    setLoading(true);
    try {
      const method = editing ? 'PUT' : 'POST';
      const body = editing
        ? { id: editing.id, name, address, contactInfo }
        : { name, address, contactInfo };
      const res = await fetch('/api/branches/locations', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      toast({
        title: editing ? 'Location update submitted' : 'Location submitted for approval',
        description: 'The request is now waiting for checker approval.',
      });
      setDialogOpen(false);
      setEditing(null);
      setName(''); setAddress(''); setContactInfo('');
      fetchLocations();
      fetchPendingChanges();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/branches/locations?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({
        title: 'Location deletion submitted',
        description: 'The delete request is now waiting for checker approval.',
      });
      fetchLocations();
      fetchPendingChanges();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Locations</h2>
        <p className="text-muted-foreground">Manage stock locations used when assigning item quantities.</p>
      </div>

      {rejectedCreates.length > 0 && (
        <Card className="border-destructive/30 bg-red-50/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-destructive text-lg">
              <AlertTriangle className="h-5 w-5" /> Rejected Requests
            </CardTitle>
            <CardDescription>These location requests were rejected. Review the reason and submit again if needed.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {rejectedCreates.map(change => (
                <div key={change.id} className="rounded-lg border bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{getLocationName(change)}</span>
                    <Badge variant="destructive">Rejected</Badge>
                  </div>
                  {change.rejectionReason && (
                    <div className="mt-2 rounded bg-red-50 p-2 text-sm text-destructive">
                      <span className="font-medium">Reason: </span>
                      {change.rejectionReason}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {pendingCreates.length > 0 && (
        <Card className="border-amber-300/50 bg-amber-50/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-amber-700 text-lg">
              <Clock className="h-5 w-5" /> Pending Approval
            </CardTitle>
            <CardDescription>These new locations are waiting for checker approval.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingCreates.map(change => {
                  let created: { name?: string; address?: string | null; contactInfo?: string | null } = {};
                  try {
                    created = JSON.parse(change.payload)?.created || {};
                  } catch {
                    created = {};
                  }

                  return (
                    <TableRow key={change.id}>
                      <TableCell className="font-medium">{created.name || '—'}</TableCell>
                      <TableCell>{created.address || '—'}</TableCell>
                      <TableCell>{created.contactInfo || '—'}</TableCell>
                      <TableCell>
                        <Badge className="bg-amber-100 text-amber-800 border-amber-300">Pending Approval</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{new Date(change.createdAt).toLocaleDateString()}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          <div className="flex justify-end mb-4">
            <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) { setEditing(null); setName(''); setAddress(''); setContactInfo(''); } }}>
              <DialogTrigger asChild>
                <Button className="bg-amber-500 hover:bg-amber-600"><PlusCircle className="mr-2 h-4 w-4" />Add Location</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>{editing ? 'Edit Location' : 'Add Location'}</DialogTitle></DialogHeader>
                <div className="space-y-4">
                  <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="Location name" /></div>
                  <div><Label>Address</Label><Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Address" /></div>
                  <div><Label>Contact</Label><Input value={contactInfo} onChange={e => setContactInfo(e.target.value)} placeholder="Contact info" /></div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button className="bg-amber-500 hover:bg-amber-600" onClick={handleSave} disabled={loading || !name.trim()}>
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
                <TableHead>Address</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map(l => {
                const approval = getLocationApprovalStatus(l.id);

                return (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.name}</TableCell>
                  <TableCell>{l.address || l.name}</TableCell>
                  <TableCell><Badge variant="outline">{l.status}</Badge></TableCell>
                  <TableCell>{l.contactInfo || '-'}</TableCell>
                  <TableCell>
                    {approval?.status === 'PENDING' && (
                      <Badge className="bg-amber-100 text-amber-800 border-amber-300">Update Pending</Badge>
                    )}
                    {approval?.status === 'REJECTED' && (
                      <div>
                        <Badge variant="destructive">Update Rejected</Badge>
                        {approval.change.rejectionReason && (
                          <p className="mt-1 max-w-[220px] truncate text-xs text-destructive" title={approval.change.rejectionReason}>
                            {approval.change.rejectionReason}
                          </p>
                        )}
                      </div>
                    )}
                    {!approval && <span className="text-sm text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right space-x-2">
                    <Button size="sm" variant="outline" onClick={() => { setEditing(l); setName(l.name); setAddress(l.address || ''); setContactInfo(l.contactInfo || ''); setDialogOpen(true); }}>Edit</Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild><Button size="sm" variant="destructive">Delete</Button></AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader><AlertDialogTitle>Delete {l.name}?</AlertDialogTitle><AlertDialogDescription>This will permanently delete the location.</AlertDialogDescription></AlertDialogHeader>
                        <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => handleDelete(l.id)}>Delete</AlertDialogAction></AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              )})}
              {locations.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No locations found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
