'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { PlusCircle } from 'lucide-react';
import { useRequirePermission } from '@/hooks/use-require-permission';

export default function LocationsPage() {
  useRequirePermission('branch');
  const { toast } = useToast();
  const [locations, setLocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [contactInfo, setContactInfo] = useState('');

  const fetchLocations = useCallback(async () => {
    try {
      const res = await fetch('/api/branches/locations');
      if (res.ok) setLocations(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);

  const handleSave = async () => {
    setLoading(true);
    try {
      const method = editing ? 'PUT' : 'POST';
      const body = editing
        ? { id: editing.id, name, address, contactInfo }
        : { name, address, contactInfo };
      const res = await fetch('/api/branches/locations', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      toast({ title: editing ? 'Location updated' : 'Location created' });
      setDialogOpen(false);
      setEditing(null);
      setName(''); setAddress(''); setContactInfo('');
      fetchLocations();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/branches/locations?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Location deleted' });
      fetchLocations();
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

      <Card>
        <CardContent className="pt-6">
          <div className="flex justify-end mb-4">
            <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) { setEditing(null); setName(''); setAddress(''); setContactInfo(''); } }}>
              <DialogTrigger asChild>
                <Button className="bg-orange-500 hover:bg-orange-600"><PlusCircle className="mr-2 h-4 w-4" />Add Location</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>{editing ? 'Edit Location' : 'Add Location'}</DialogTitle></DialogHeader>
                <div className="space-y-4">
                  <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="Location name" /></div>
                  <div><Label>Address</Label><Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Address" /></div>
                  <div><Label>Contact</Label><Input value={contactInfo} onChange={e => setContactInfo(e.target.value)} placeholder="Contact info" /></div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                    <Button onClick={handleSave} disabled={loading || !name.trim()}>
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
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map(l => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.name}</TableCell>
                  <TableCell>{l.address || l.name}</TableCell>
                  <TableCell><Badge variant="outline">{l.status}</Badge></TableCell>
                  <TableCell>{l.contactInfo || '-'}</TableCell>
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
              ))}
              {locations.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No locations found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
