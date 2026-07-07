import {
  LayoutDashboard,
  Settings,
  FileText,
  ShieldCheck,
  FileCog,
  BadgeAlert,
  Landmark,
  Download,
  FolderArchive,
  BookUser,
  CheckSquare,
  Ban,
  MessageSquare,
  Store,
  Building2,
  ShoppingBag,
  Package,
  ClipboardList,
  ReceiptText,
  MapPin,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';

export interface MenuItem {
  path: string;
  label: string;
  icon: LucideIcon;
  roles: string[];
  children?: MenuItem[];
  /** Override the permission module key used for access control (defaults to kebab-cased label) */
  permissionKey?: string;
}

export const allMenuItems: MenuItem[] = [
  {
    path: '/admin/merchant-dashboard',
    label: 'Merchant Dashboard',
    icon: LayoutDashboard,
    roles: ['Merchant'],
  },
  {
    path: '/admin',
    label: 'Dashboard',
    icon: LayoutDashboard,
    roles: ['Super Admin', 'Loan Manager', 'Auditor', 'Loan Provider'],
  },
  {
    path: '/admin/reports',
    label: 'Reports',
    icon: FileText,
    roles: ['Super Admin', 'Loan Manager', 'Auditor', 'Loan Provider', 'Reconciliation'],
  },
   {
    path: '/admin/approvals',
    label: 'Approvals',
    icon: CheckSquare,
    roles: ['Super Admin', 'Loan Manager'],
  },
  {
    path: '/admin/reversals',
    label: 'Reversals',
    icon: FolderArchive,
    roles: ['Super Admin', 'Loan Manager'],
  },
  {
    path: '/admin/reversal-approvals',
    label: 'Reversal Approval',
    icon: CheckSquare,
    roles: ['Super Admin', 'Loan Manager'],
  },
  {
    path: '/admin/npl',
    label: 'NPL',
    icon: BadgeAlert,
    roles: ['Super Admin', 'Loan Manager', 'Auditor'],
  },
  {
    path: '/admin/sms-management',
    label: 'SMS Management',
    icon: MessageSquare,
    roles: ['Super Admin', 'Loan Manager'],
  },
  {
    path: '/admin/branch',
    label: 'Branch',
    icon: Building2,
    roles: ['Super Admin', 'Loan Manager'],
  },
  {
    path: '/admin/districts',
    label: 'Districts',
    icon: MapPin,
    roles: ['Super Admin', 'Loan Manager'],
    permissionKey: 'branch',
  },
  {
    path: '/admin/merchants',
    label: 'Merchants',
    icon: Store,
    roles: ['Super Admin', 'Loan Manager', 'Merchant'],
    children: [
      {
        path: '/admin/merchants',
        label: 'Items',
        icon: Package,
        roles: ['Super Admin', 'Loan Manager', 'Merchant'],
      },
      {
        path: '/admin/merchants/orders',
        label: 'Orders',
        icon: ClipboardList,
        roles: ['Super Admin', 'Loan Manager', 'Merchant'],
      },
      {
        path: '/admin/merchants/discount-rules',
        label: 'Discount Rules',
        icon: ReceiptText,
        roles: ['Super Admin', 'Loan Manager', 'Merchant'],
      },
      {
        path: '/admin/merchants/locations',
        label: 'Location',
        icon: MapPin,
        roles: ['Super Admin', 'Loan Manager', 'Merchant'],
      },
    ],
  },
  {
    path: '/admin/merchants-approvals',
    label: 'Merchants Approvals',
    icon: CheckSquare,
    roles: ['Super Admin', 'Loan Manager'],
  },
   {
    path: '/admin/access-control',
    label: 'Access Control',
    icon: ShieldCheck,
    roles: ['Super Admin'],
  },
  {
    path: '/admin/credit-score-engine',
    label: 'Scoring Engine',
    icon: FileCog,
    roles: ['Super Admin', 'Loan Manager'],
  },
  {
    path: '/admin/tax',
    label: 'Tax',
    icon: Landmark,
    roles: ['Super Admin', 'Loan Manager'],
  },
  {
    path: '/admin/settings',
    label: 'Settings',
    icon: Settings,
    roles: ['Super Admin', 'Loan Manager', 'Loan Provider'],
  },
  {
    path: '/admin/disbursement-control',
    label: 'Disbursement Control',
    icon: Ban,
    roles: ['Super Admin'],
  },
  {
    path: '/admin/audit-logs',
    label: 'Audit Logs',
    icon: BookUser,
    roles: ['Super Admin', 'Auditor'],
  },
];
