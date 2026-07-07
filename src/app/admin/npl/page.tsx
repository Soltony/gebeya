
'use client';

import React, { useState, useEffect } from 'react';
import { useRequirePermission } from '@/hooks/use-require-permission';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { updateNplStatus } from '@/actions/npl';
import { usePermissions } from '@/hooks/use-permissions';

interface NplBorrower {
    id: string;
    status: string;
    loans: {
        loanAmount: number;
        dueDate: string;
        repaymentStatus: string;
    }[];
}

async function getNplBorrowers(): Promise<NplBorrower[]> {
    const response = await fetch('/api/npl-borrowers');
    if (!response.ok) {
        throw new Error('Failed to fetch NPL borrowers');
    }
    return response.json();
}

export default function NplManagementPage() {
    useRequirePermission('npl');
    const { canModule } = usePermissions();
    const canRunNplUpdate = canModule('npl', 'update');
    const [borrowers, setBorrowers] = useState<NplBorrower[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isUpdating, setIsUpdating] = useState(false);
    const { toast } = useToast();

    const fetchBorrowers = async () => {
        setIsLoading(true);
        try {
            const data = await getNplBorrowers();
            setBorrowers(data);
        } catch (error) {
            toast({
                title: 'Error',
                description: 'Could not load NPL borrowers.',
                variant: 'destructive',
            });
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchBorrowers();
    }, []);

    const handleRunNplUpdate = async () => {
        if (!canRunNplUpdate) {
            toast({ title: 'Not authorized', description: 'You are not authorized to run NPL updates.', variant: 'destructive' });
            return;
        }
        setIsUpdating(true);
        try {
            const result = await updateNplStatus();
            if (result.success) {
                toast({
                    title: 'NPL Status Updated',
                    description: `${result.updatedCount} borrower(s) have been updated.`,
                });
                await fetchBorrowers(); // Refresh the list
            } else {
                throw new Error(result.message);
            }
        } catch (error: any) {
            toast({
                title: 'Error Running NPL Update',
                description: error.message,
                variant: 'destructive',
            });
        } finally {
            setIsUpdating(false);
        }
    };
    
    // Manual revert action removed: borrowers should not be reverted from NPL via UI


    return (
        <>
            <div className="flex-1 space-y-4 p-8 pt-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-3xl font-bold tracking-tight">NPL</h2>
                        <p className="text-muted-foreground">
                            View and manage borrowers with Non-Performing Loans.
                        </p>
                    </div>
                    {canRunNplUpdate && (
                        <Button onClick={handleRunNplUpdate} disabled={isUpdating}>
                            {isUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                            Run NPL Status Update
                        </Button>
                    )}
                </div>
                 <Card>
                    <CardHeader>
                        <CardTitle>NPL Borrowers</CardTitle>
                        <CardDescription>This list contains all borrowers who have been flagged due to overdue loans based on their provider's NPL threshold.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Borrower ID</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Overdue Loan Count</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {isLoading ? (
                                    <TableRow>
                                        <TableCell colSpan={3} className="h-24 text-center">
                                            <Loader2 className="h-6 w-6 animate-spin mx-auto"/>
                                        </TableCell>
                                    </TableRow>
                                ) : borrowers.length > 0 ? (
                                    borrowers.map((borrower) => (
                                        <TableRow key={borrower.id}>
                                            <TableCell className="font-mono">{borrower.id}</TableCell>
                                            <TableCell>
                                                <Badge variant="destructive">{borrower.status}</Badge>
                                            </TableCell>
                                            <TableCell>{borrower.loans.length}</TableCell>
                                        </TableRow>
                                    ))
                                ) : (
                                    <TableRow>
                                        <TableCell colSpan={3} className="h-24 text-center">
                                            No NPL borrowers found.
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            </div>
            {/* Manual revert dialog removed to prevent removing borrowers from NPL via the UI. */}
        </>
    );
}
