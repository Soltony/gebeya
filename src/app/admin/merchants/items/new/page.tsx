'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { useRequirePermission } from '@/hooks/use-require-permission';
import { useAuth } from '@/hooks/use-auth';

type InventoryRow = {
  selectedValueIds: string[];
  locationId: string;
  quantity: string;
};

export default function NewItemPage() {
  useRequirePermission('merchants');
  const router = useRouter();
  const { toast } = useToast();
  const { currentUser } = useAuth();
  const isMerchantUser = !!currentUser?.merchantId;
  const [merchants, setMerchants] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const [merchantId, setMerchantId] = useState(currentUser?.merchantId || '');
  const [categoryId, setCategoryId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [sellingOption, setSellingOption] = useState('BNPL_ONLY');
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [videoUrl, setVideoUrl] = useState('');

  // Determine if the selected merchant has BNPL enabled
  const selectedMerchant = merchants.find((m: any) => String(m.id) === String(merchantId));
  const isBnplEnabled = selectedMerchant?.bnplEnabled === true;

  // When merchant changes, reset selling option appropriately
  useEffect(() => {
    if (merchantId) {
      const m = merchants.find((x: any) => String(x.id) === String(merchantId));
      setSellingOption(m?.bnplEnabled ? 'BNPL_ONLY' : 'DIRECT_ONLY');
    }
  }, [merchantId, merchants]);
  // Attributes (option groups)
  const [attributes, setAttributes] = useState<{ name: string; values: { label: string; priceDelta: string }[] }[]>([]);

  // Inventory by attribute + location
  const [locations, setLocations] = useState<any[]>([]);
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);

  // Auto-set merchantId when the logged-in user is a merchant
  useEffect(() => {
    if (currentUser?.merchantId) {
      setMerchantId(currentUser.merchantId);
    }
  }, [currentUser?.merchantId]);

  useEffect(() => {
    Promise.all([
      fetch('/api/merchants').then(r => r.json()),
      fetch('/api/merchants/categories').then(r => r.json()),
      fetch('/api/branches/locations').then(r => r.json()),
    ]).then(([m, c, l]) => {
      setMerchants(Array.isArray(m) ? m : []);
      setCategories(c.filter?.((x: any) => x.status === 'ACTIVE') || []);
      setLocations(l.filter?.((x: any) => x.status === 'ACTIVE') || []);
    });
  }, []);

  const addAttribute = () => {
    setAttributes([...attributes, { name: '', values: [{ label: '', priceDelta: '0' }] }]);
  };

  // Flatten all option values across all groups for the multi-select popover
  const allOptionValues = useMemo(() => {
    const vals: { groupName: string; groupIndex: number; label: string; valueIndex: number; tempId: string }[] = [];
    attributes.forEach((attr, ai) => {
      if (!attr.name.trim()) return;
      attr.values.forEach((v, vi) => {
        if (!v.label.trim()) return;
        vals.push({
          groupName: attr.name,
          groupIndex: ai,
          label: v.label,
          valueIndex: vi,
          tempId: `${ai}-${vi}`,
        });
      });
    });
    return vals;
  }, [attributes]);

  const hasOptionValues = allOptionValues.length > 0;
  const hasLocations = locations.length > 0;

  const addInventoryRow = useCallback(() => {
    setInventoryRows(prev => [...prev, { selectedValueIds: [], locationId: '', quantity: '0' }]);
  }, []);

  const removeInventoryRow = useCallback((idx: number) => {
    setInventoryRows(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const updateInventoryRow = useCallback((idx: number, field: keyof InventoryRow, value: any) => {
    setInventoryRows(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value };
      return copy;
    });
  }, []);

  // Toggle a value in an inventory row's multi-select.
  // Enforce: one value per group — if the user checks a value, uncheck any other from the same group.
  const toggleInventoryValue = useCallback((rowIdx: number, tempId: string) => {
    const optVal = allOptionValues.find(v => v.tempId === tempId);
    if (!optVal) return;

    setInventoryRows(prev => {
      const copy = [...prev];
      const row = { ...copy[rowIdx] };
      const currentIds = [...row.selectedValueIds];

      if (currentIds.includes(tempId)) {
        // Uncheck
        row.selectedValueIds = currentIds.filter(id => id !== tempId);
      } else {
        // Check — but first remove any other value from the same group
        const sameGroupIds = allOptionValues
          .filter(v => v.groupIndex === optVal.groupIndex)
          .map(v => v.tempId);
        row.selectedValueIds = [
          ...currentIds.filter(id => !sameGroupIds.includes(id)),
          tempId,
        ];
      }

      copy[rowIdx] = row;
      return copy;
    });
  }, [allOptionValues]);

  const getComboLabel = useCallback((selectedIds: string[]) => {
    if (selectedIds.length === 0) return 'Select attributes...';
    return selectedIds
      .map(id => {
        const v = allOptionValues.find(ov => ov.tempId === id);
        return v ? `${v.groupName}: ${v.label}` : '';
      })
      .filter(Boolean)
      .join(', ');
  }, [allOptionValues]);

  const handleSave = async () => {
    if (!merchantId || !categoryId || !name || !price) {
      toast({ title: 'Error', description: 'Merchant, Category, Name, and Price are required.', variant: 'destructive' });
      return;
    }
    setLoading(true);
    try {
      let imageUrl: string | null = null;
      if (imageFiles.length > 0) {
        const readFileAsDataUrl = (file: File): Promise<string> =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(file);
          });
        const urls = await Promise.all(imageFiles.map(readFileAsDataUrl));
        imageUrl = JSON.stringify(urls);
      }

      // Build option groups from attributes
      const optionGroups = attributes.filter(a => a.name.trim()).map(a => ({
        name: a.name,
        values: a.values.filter(v => v.label.trim()).map(v => ({
          label: v.label,
          priceDelta: v.priceDelta || '0',
        })),
      }));

      const res = await fetch('/api/merchants/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchantId,
          categoryId,
          name,
          description: description || null,
          price,
          imageUrl,
          videoUrl: videoUrl || null,
          status,
          sellingOption,
          optionGroups: optionGroups.length > 0 ? optionGroups : undefined,
        }),
      });

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
      const createdItem = await res.json();

      // Save combination inventory rows if any
      if (inventoryRows.length > 0 && createdItem.id) {
        const validRows = inventoryRows.filter(r => r.selectedValueIds.length > 0 && r.locationId);
        if (validRows.length > 0) {
          // Map tempIds to real option value IDs from the created item
          const realOptionGroups = createdItem.optionGroups || [];
          const tempToRealId: Record<string, string> = {};
          attributes.forEach((attr, ai) => {
            const realGroup = realOptionGroups.find((g: any) => g.name === attr.name);
            if (!realGroup) return;
            attr.values.forEach((v, vi) => {
              const realValue = realGroup.values?.find((rv: any) => rv.label === v.label);
              if (realValue) {
                tempToRealId[`${ai}-${vi}`] = realValue.id;
              }
            });
          });

          const bulkCombinations = validRows.map(row => {
            const realIds = row.selectedValueIds
              .map(tid => tempToRealId[tid])
              .filter(Boolean);
            const sorted = [...new Set(realIds)].sort();
            return {
              locationId: row.locationId,
              combinationKey: sorted.join('|'),
              optionValueIds: sorted,
              quantityAvailable: row.quantity,
            };
          });

          await fetch('/api/inventory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: createdItem.id, bulkCombinations }),
          });
        }
      }

      toast({ title: 'Item created' });
      router.push('/admin/merchants');
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <Card>
        <CardContent className="pt-6">
          <h2 className="text-2xl font-bold mb-1">Add Item</h2>
          <p className="text-muted-foreground mb-6">Item details used by borrowers in the shop.</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {!isMerchantUser && (
            <div>
              <Label>Merchant</Label>
              <Select value={merchantId} onValueChange={setMerchantId}>
                <SelectTrigger><SelectValue placeholder="Select merchant" /></SelectTrigger>
                <SelectContent>{merchants.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            )}
            <div>
              <Label>Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>{categories.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Item name" />
            </div>
            <div>
              <Label>Description</Label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" />
            </div>
            <div>
              <Label>Price (ETB)</Label>
              <Input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                  <SelectItem value="INACTIVE">INACTIVE</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {isBnplEnabled ? (
            <div>
              <Label>Selling Option</Label>
              <Select value={sellingOption} onValueChange={setSellingOption}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="BNPL_ONLY">BNPL Only</SelectItem>
                  <SelectItem value="DIRECT_ONLY">Direct Payment Only</SelectItem>
                  <SelectItem value="BOTH">Both (BNPL + Direct)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            ) : (
            <div>
              <Label>Selling Option</Label>
              <Input value="Direct Payment Only" disabled />
            </div>
            )}
            <div>
              <Label>Images (first image is the main display image)</Label>
              <Input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple onChange={e => {
                const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
                const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
                const rawFiles = Array.from(e.target.files || []);
                const validFiles: File[] = [];
                for (const f of rawFiles) {
                  if (!ALLOWED_TYPES.includes(f.type)) {
                    toast({ title: 'Invalid file type', description: `"${f.name}" is not an allowed image type. Use JPEG, PNG, GIF, or WebP.`, variant: 'destructive' });
                    continue;
                  }
                  if (f.size > MAX_SIZE) {
                    toast({ title: 'File too large', description: `"${f.name}" exceeds the 5 MB limit.`, variant: 'destructive' });
                    continue;
                  }
                  validFiles.push(f);
                }
                if (validFiles.length > 10) {
                  toast({ title: 'Too many images', description: 'A maximum of 10 images is allowed.', variant: 'destructive' });
                  validFiles.length = 10;
                }
                setImageFiles(validFiles);
                // Generate previews
                Promise.all(validFiles.map(f => new Promise<string>((resolve) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(reader.result as string);
                  reader.readAsDataURL(f);
                }))).then(setImagePreviews);
              }} />
              {imagePreviews.length > 0 && (
                <div className="flex flex-wrap gap-3 mt-3">
                  {imagePreviews.map((src, i) => (
                    <div key={i} className="relative">
                      <img src={src} alt={`Preview ${i + 1}`} className="h-20 w-20 rounded-lg border bg-white object-cover" />
                      {i === 0 && imagePreviews.length > 1 && (
                        <span className="absolute -top-1 -right-1 bg-orange-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium">Main</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Label>Product video URL (YouTube, TikTok, etc.)</Label>
              <Input value={videoUrl} onChange={e => setVideoUrl(e.target.value)} placeholder="https://youtube.com/..." />
            </div>
          </div>

          {/* Attributes section */}
          <div className="mt-8">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-base font-semibold">Attributes (e.g. Color, Size) with price adjustments</Label>
              <Button variant="outline" onClick={addAttribute}>Add Attribute</Button>
            </div>
            {attributes.length === 0 && <p className="text-sm text-muted-foreground">No attributes added.</p>}
            {attributes.map((attr, ai) => (
              <div key={ai} className="border rounded p-4 mb-3">
                <div className="flex gap-4 items-end mb-2">
                  <div className="flex-1">
                    <Label>Attribute name</Label>
                    <Input value={attr.name} onChange={e => {
                      const copy = [...attributes];
                      copy[ai].name = e.target.value;
                      setAttributes(copy);
                    }} placeholder="e.g. Color" />
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setAttributes(attributes.filter((_, i) => i !== ai))}>Remove</Button>
                </div>
                {attr.values.map((v, vi) => (
                  <div key={vi} className="flex gap-2 items-end ml-4 mb-1">
                    <div className="flex-1"><Label>Value</Label><Input value={v.label} onChange={e => {
                      const copy = [...attributes];
                      copy[ai].values[vi].label = e.target.value;
                      setAttributes(copy);
                    }} placeholder="e.g. Red" /></div>
                    <div className="w-32"><Label>Price +/-</Label><Input type="number" value={v.priceDelta} onChange={e => {
                      const copy = [...attributes];
                      copy[ai].values[vi].priceDelta = e.target.value;
                      setAttributes(copy);
                    }} /></div>
                    <Button variant="ghost" size="sm" onClick={() => {
                      const copy = [...attributes];
                      copy[ai].values = copy[ai].values.filter((_, i) => i !== vi);
                      setAttributes(copy);
                    }}>×</Button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" className="ml-4 mt-1" onClick={() => {
                  const copy = [...attributes];
                  copy[ai].values.push({ label: '', priceDelta: '0' });
                  setAttributes(copy);
                }}>+ Add value</Button>
              </div>
            ))}
          </div>

          {/* Inventory by attribute value + location */}
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-base font-semibold">Inventory by attribute value + location (available quantity)</Label>
              <Button
                variant="outline"
                onClick={addInventoryRow}
                disabled={!hasOptionValues || !hasLocations}
              >
                Add Location
              </Button>
            </div>
            {!hasOptionValues && (
              <p className="text-sm text-muted-foreground">Add attribute values first to assign inventory.</p>
            )}
            {hasOptionValues && !hasLocations && (
              <p className="text-sm text-muted-foreground">No stock locations available. Create locations first.</p>
            )}
            {inventoryRows.map((row, ri) => (
              <div key={ri} className="grid grid-cols-12 gap-2 mb-2 items-end">
                {/* col-span-5: Attribute values multi-select popover */}
                <div className="col-span-5">
                  {ri === 0 && <Label className="text-xs text-muted-foreground mb-1 block">Attribute values</Label>}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full justify-start font-normal text-left h-auto min-h-10 whitespace-normal"
                      >
                        <span className={row.selectedValueIds.length === 0 ? 'text-muted-foreground' : ''}>
                          {getComboLabel(row.selectedValueIds)}
                        </span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-3" align="start">
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {allOptionValues.map(ov => (
                          <label key={ov.tempId} className="flex items-center gap-2 cursor-pointer text-sm">
                            <Checkbox
                              checked={row.selectedValueIds.includes(ov.tempId)}
                              onCheckedChange={() => toggleInventoryValue(ri, ov.tempId)}
                            />
                            {ov.groupName}: {ov.label}
                          </label>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* col-span-4: Location dropdown */}
                <div className="col-span-4">
                  {ri === 0 && <Label className="text-xs text-muted-foreground mb-1 block">&nbsp;</Label>}
                  <Select value={row.locationId} onValueChange={v => updateInventoryRow(ri, 'locationId', v)}>
                    <SelectTrigger><SelectValue placeholder="Location" /></SelectTrigger>
                    <SelectContent>
                      {locations.map(loc => (
                        <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* col-span-2: Quantity */}
                <div className="col-span-2">
                  {ri === 0 && <Label className="text-xs text-muted-foreground mb-1 block">&nbsp;</Label>}
                  <Input
                    type="number"
                    min="0"
                    value={row.quantity}
                    onChange={e => updateInventoryRow(ri, 'quantity', e.target.value)}
                  />
                </div>

                {/* col-span-1: Delete */}
                <div className="col-span-1">
                  {ri === 0 && <Label className="text-xs text-muted-foreground mb-1 block">&nbsp;</Label>}
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    onClick={() => removeInventoryRow(ri)}
                  >
                    X
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3 mt-8">
            <Button variant="outline" onClick={() => router.push('/admin/merchants')}>Cancel</Button>
            <Button className="bg-amber-500 hover:bg-amber-600" onClick={handleSave} disabled={loading}>
              {loading ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
