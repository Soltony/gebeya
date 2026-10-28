'use client';

import { useEffect, useMemo, useState } from 'react';
import { addDays, format } from 'date-fns';
import { AlertCircle, Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  AFFILIATE_TYPES,
  AFFILIATE_TYPE_LABELS,
  BASES_BY_EVENT,
  BASE_LABELS,
  BENEFICIARIES,
  BENEFICIARY_LABELS,
  BLANK_CONFIG,
  BLANK_RULE,
  COMMISSION_EVENTS,
  EVENT_LABELS,
  FILTERS_BY_EVENT,
  FILTER_KEYS,
  FUNDING_LABELS,
  FUNDING_SOURCES,
  LOAN_KINDS,
  LOAN_KIND_LABELS,
  OCCURRENCE_LABELS,
  OCCURRENCE_MODES,
  PAYOUT_SCHEDULES,
  PAYOUT_SCHEDULE_LABELS,
  PROGRAM_TEMPLATES,
  REPAYMENT_BEHAVIORS,
  REPAYMENT_BEHAVIOR_LABELS,
  REWARD_TYPES,
  REWARD_TYPE_LABELS,
  commissionRuleSchema,
  describeRule,
  formatMoney,
  formatPoints,
  parseProgramConfig,
  pointsForAmount,
  programConfigSchema,
  type CommissionEvent,
  type CommissionRule,
  type LoanKind,
  type ProgramConfig,
  type RepaymentBehavior,
  type RewardType,
} from '@/lib/affiliate/config';
import { evaluateEvent, type EventFacts } from '@/lib/affiliate/engine';
import { apiRequest, lookupsFrom, MultiSelect, NumberInput, type AffiliateOptions } from './shared';

export type EditableProgram = {
  id: string;
  name: string;
  description: string | null;
  config: ProgramConfig;
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const newRuleId = () => `rule-${Math.random().toString(36).slice(2, 8)}`;
const LOAN_EVENTS: CommissionEvent[] = ['LOAN_DISBURSED', 'LOAN_REPAID'];

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <h4 className="text-sm font-semibold">{title}</h4>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function RuleEditor({
  rule,
  index,
  options,
  canRemove,
  onChange,
  onRemove,
  onDuplicate,
}: {
  rule: CommissionRule;
  index: number;
  options: AffiliateOptions;
  canRemove: boolean;
  onChange: (rule: CommissionRule) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const lookups = useMemo(() => lookupsFrom(options), [options]);
  const allowed = FILTERS_BY_EVENT[rule.event];
  const set = (patch: Partial<CommissionRule>) => onChange({ ...rule, ...patch });
  const setFilters = (patch: Partial<CommissionRule['filters']>) => onChange({ ...rule, filters: { ...rule.filters, ...patch } });

  const changeEvent = (event: CommissionEvent) => {
    const keep = FILTERS_BY_EVENT[event];
    const filters = { ...rule.filters };
    for (const key of FILTER_KEYS) {
      if (keep.includes(key)) continue;
      if (key === 'minAmount') filters.minAmount = null;
      else (filters as Record<string, unknown>)[key] = [];
    }
    let calc = rule.calc;
    if (calc.type === 'PERCENT' && !BASES_BY_EVENT[event].includes(calc.base)) {
      calc = { ...calc, base: BASES_BY_EVENT[event][0] };
    }
    onChange({ ...rule, event, filters, calc, fundedBy: event === 'DIRECT_ORDER_PAID' ? 'PLATFORM' : rule.fundedBy });
  };

  const changeCalcType = (type: string) => {
    if (type === rule.calc.type) return;
    set({
      calc:
        type === 'FIXED'
          ? { type: 'FIXED', amount: 100 }
          : { type: 'PERCENT', percent: 1, base: BASES_BY_EVENT[rule.event][0], min: null, max: null },
    });
  };

  const products = rule.filters.providerIds.length
    ? options.products.filter((p) => rule.filters.providerIds.includes(p.providerId))
    : options.products;

  return (
    <div className={cn('space-y-4 rounded-lg border p-4', !rule.enabled && 'bg-muted/40')}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold uppercase text-muted-foreground">Rule {index + 1}</span>
        <Input
          value={rule.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Rule name"
          className="h-8 max-w-xs"
        />
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={`rule-on-${rule.id}`} className="text-xs">
            {rule.enabled ? 'On' : 'Off'}
          </Label>
          <Switch id={`rule-on-${rule.id}`} checked={rule.enabled} onCheckedChange={(enabled) => set({ enabled })} />
          <Button type="button" variant="ghost" size="icon" onClick={onDuplicate} title="Duplicate rule">
            <Copy className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={onRemove} disabled={!canRemove} title="Remove rule">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="When">
          <Select value={rule.event} onValueChange={(v) => changeEvent(v as CommissionEvent)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMMISSION_EVENTS.map((e) => (
                <SelectItem key={e} value={e}>
                  {EVENT_LABELS[e]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Pay">
          <Select value={rule.beneficiary} onValueChange={(v) => set({ beneficiary: v as CommissionRule['beneficiary'] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BENEFICIARIES.map((b) => (
                <SelectItem key={b} value={b}>
                  {BENEFICIARY_LABELS[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Paid by">
          <Select value={rule.fundedBy} onValueChange={(v) => set({ fundedBy: v as CommissionRule['fundedBy'] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FUNDING_SOURCES.map((f) => (
                <SelectItem key={f} value={f} disabled={f === 'PROVIDER' && rule.event === 'DIRECT_ORDER_PAID'}>
                  {FUNDING_LABELS[f]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Amount type">
          <Select value={rule.calc.type} onValueChange={changeCalcType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="FIXED">Fixed amount</SelectItem>
              <SelectItem value="PERCENT">Percentage</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {rule.calc.type === 'FIXED' ? (
          <Field label="Amount (ETB)">
            <NumberInput
              value={rule.calc.amount}
              onChange={(v) => set({ calc: { type: 'FIXED', amount: v as number } })}
            />
          </Field>
        ) : (
          <>
            <Field label="Percentage (%)">
              <NumberInput
                value={rule.calc.percent}
                onChange={(v) => rule.calc.type === 'PERCENT' && set({ calc: { ...rule.calc, percent: v as number } })}
              />
            </Field>
            <Field label="Of the">
              <Select
                value={rule.calc.base}
                onValueChange={(v) => rule.calc.type === 'PERCENT' && set({ calc: { ...rule.calc, base: v as typeof rule.calc.base } })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BASES_BY_EVENT[rule.event].map((b) => (
                    <SelectItem key={b} value={b}>
                      {BASE_LABELS[b]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Min / max (ETB)">
              <div className="flex gap-2">
                <NumberInput
                  placeholder="Min"
                  value={rule.calc.min}
                  onChange={(v) => rule.calc.type === 'PERCENT' && set({ calc: { ...rule.calc, min: v } })}
                />
                <NumberInput
                  placeholder="Max"
                  value={rule.calc.max}
                  onChange={(v) => rule.calc.type === 'PERCENT' && set({ calc: { ...rule.calc, max: v } })}
                />
              </div>
            </Field>
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="How often (per referred customer)">
          <Select
            value={rule.occurrence.mode}
            onValueChange={(v) =>
              set({ occurrence: { mode: v as CommissionRule['occurrence']['mode'], count: v === 'FIRST_N' ? rule.occurrence.count ?? 3 : null } })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OCCURRENCE_MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {OCCURRENCE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {rule.occurrence.mode === 'FIRST_N' && (
          <Field label="Number of times">
            <NumberInput
              min={1}
              step={1}
              value={rule.occurrence.count}
              onChange={(v) => set({ occurrence: { ...rule.occurrence, count: v } })}
            />
          </Field>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium">Only count when… (leave empty for all)</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {allowed.includes('providerIds') && (
            <Field label="Loan provider">
              <MultiSelect
                options={options.providers}
                value={rule.filters.providerIds}
                onChange={(providerIds) => setFilters({ providerIds })}
                placeholder="All providers"
              />
            </Field>
          )}
          {allowed.includes('productIds') && (
            <Field label="Loan product">
              <MultiSelect
                options={products}
                value={rule.filters.productIds}
                onChange={(productIds) => setFilters({ productIds })}
                placeholder="All products"
              />
            </Field>
          )}
          {allowed.includes('loanKinds') && (
            <Field label="Loan type">
              <MultiSelect
                options={LOAN_KINDS.map((k) => ({ id: k, name: LOAN_KIND_LABELS[k] }))}
                value={rule.filters.loanKinds}
                onChange={(v) => setFilters({ loanKinds: v as LoanKind[] })}
                placeholder="Personal and BNPL"
              />
            </Field>
          )}
          {allowed.includes('merchantIds') && (
            <Field label="Merchant">
              <MultiSelect
                options={options.merchants}
                value={rule.filters.merchantIds}
                onChange={(merchantIds) => setFilters({ merchantIds })}
                placeholder="All merchants"
              />
            </Field>
          )}
          {allowed.includes('categoryIds') && (
            <Field label="Item category">
              <MultiSelect
                options={options.categories}
                value={rule.filters.categoryIds}
                onChange={(categoryIds) => setFilters({ categoryIds })}
                placeholder="All categories"
              />
            </Field>
          )}
          {allowed.includes('repaymentBehaviors') && (
            <Field label="Repaid">
              <MultiSelect
                options={REPAYMENT_BEHAVIORS.map((b) => ({ id: b, name: REPAYMENT_BEHAVIOR_LABELS[b] }))}
                value={rule.filters.repaymentBehaviors}
                onChange={(v) => setFilters({ repaymentBehaviors: v as RepaymentBehavior[] })}
                placeholder="Early, on time or late"
              />
            </Field>
          )}
          {allowed.includes('minAmount') && (
            <Field label={LOAN_EVENTS.includes(rule.event) ? 'Minimum loan amount' : 'Minimum order total'}>
              <NumberInput
                placeholder="No minimum"
                value={rule.filters.minAmount}
                onChange={(minAmount) => setFilters({ minAmount })}
              />
            </Field>
          )}
        </div>
      </div>

      <p className="rounded-md bg-muted/60 p-2 text-sm text-muted-foreground">{describeRule(rule, lookups)}</p>
    </div>
  );
}

function PreviewPanel({ config, options }: { config: ProgramConfig; options: AffiliateOptions }) {
  const [event, setEvent] = useState<CommissionEvent>('LOAN_REPAID');
  const [providerId, setProviderId] = useState('');
  const [productId, setProductId] = useState('');
  const [loanKind, setLoanKind] = useState<LoanKind>('PERSONAL');
  const [merchantId, setMerchantId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [behavior, setBehavior] = useState<RepaymentBehavior>('ON_TIME');
  const [principal, setPrincipal] = useState<number | null>(5000);
  const [serviceFee, setServiceFee] = useState<number | null>(150);
  const [feesCollected, setFeesCollected] = useState<number | null>(400);
  const [orderTotal, setOrderTotal] = useState<number | null>(8000);
  const [alreadyPaid, setAlreadyPaid] = useState<number | null>(0);

  const parsed = useMemo(() => parseProgramConfig(config), [config]);
  const isLoanEvent = LOAN_EVENTS.includes(event);
  const hasProvider = event !== 'DIRECT_ORDER_PAID';
  const hasMerchant = !isLoanEvent;
  const products = providerId ? options.products.filter((p) => p.providerId === providerId) : options.products;
  const today = new Date();

  const facts: EventFacts = {
    event,
    sourceType: isLoanEvent ? 'LOAN' : 'ORDER',
    sourceId: 'preview',
    eventDate: today,
    sourceDate: today,
    loanId: null,
    orderId: null,
    providerId: hasProvider ? providerId || null : null,
    productId: hasProvider ? productId || null : null,
    loanKind: isLoanEvent ? loanKind : event === 'BNPL_ORDER_DELIVERED' ? 'BNPL' : null,
    merchantId: hasMerchant ? merchantId || null : null,
    categoryIds: hasMerchant && categoryId ? [categoryId] : [],
    repaymentBehavior: event === 'LOAN_REPAID' ? behavior : null,
    principal: hasProvider ? principal : null,
    serviceFee: isLoanEvent ? serviceFee : null,
    feesCollected: event === 'LOAN_REPAID' ? feesCollected : null,
    orderTotal: hasMerchant ? orderTotal : null,
  };

  const lines = parsed.success
    ? evaluateEvent(parsed.config, facts, {
        priorCount: () => alreadyPaid ?? 0,
        rooms: {
          perReferral: parsed.config.caps.perReferralTotal,
          perAffiliateMonth: parsed.config.caps.perAffiliatePerMonth,
          budget: parsed.config.caps.programBudget,
        },
      }).filter((l) => l.rule.event === event)
    : [];
  const otherRules = parsed.success ? parsed.config.commissionRules.filter((r) => r.event !== event).length : 0;
  const total = (beneficiary: string) =>
    lines.filter((l) => l.status === 'PAYS' && l.beneficiary === beneficiary).reduce((s, l) => s + l.amount, 0);

  const select = (value: string, onChange: (v: string) => void, items: { id: string; name: string }[], all: string) => (
    <Select value={value || '__all'} onValueChange={(v) => onChange(v === '__all' ? '' : v)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all">{all}</SelectItem>
        {items.map((i) => (
          <SelectItem key={i.id} value={i.id}>
            {i.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Try a sample event to see exactly what this program would pay. It uses the same rules engine as the daily job.
      </p>
      <Section title="Sample event">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="What happened">
            <Select value={event} onValueChange={(v) => setEvent(v as CommissionEvent)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMISSION_EVENTS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {EVENT_LABELS[e]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {hasProvider && (
            <>
              <Field label="Loan provider">
                {select(providerId, (v) => { setProviderId(v); setProductId(''); }, options.providers, 'Any provider')}
              </Field>
              <Field label="Loan product">{select(productId, setProductId, products, 'Any product')}</Field>
            </>
          )}
          {isLoanEvent && (
            <Field label="Loan type">
              <Select value={loanKind} onValueChange={(v) => setLoanKind(v as LoanKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOAN_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {LOAN_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {hasMerchant && (
            <>
              <Field label="Merchant">{select(merchantId, setMerchantId, options.merchants, 'Any merchant')}</Field>
              <Field label="Item category">{select(categoryId, setCategoryId, options.categories, 'Any category')}</Field>
            </>
          )}
          {event === 'LOAN_REPAID' && (
            <Field label="Repaid">
              <Select value={behavior} onValueChange={(v) => setBehavior(v as RepaymentBehavior)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPAYMENT_BEHAVIORS.map((b) => (
                    <SelectItem key={b} value={b}>
                      {REPAYMENT_BEHAVIOR_LABELS[b]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {hasProvider && (
            <Field label="Loan amount (ETB)">
              <NumberInput value={principal} onChange={setPrincipal} />
            </Field>
          )}
          {isLoanEvent && (
            <Field label="Service fee (ETB)">
              <NumberInput value={serviceFee} onChange={setServiceFee} />
            </Field>
          )}
          {event === 'LOAN_REPAID' && (
            <Field label="Fees collected (ETB)" hint="Interest, service fee and penalty actually paid">
              <NumberInput value={feesCollected} onChange={setFeesCollected} />
            </Field>
          )}
          {hasMerchant && (
            <Field label="Order total (ETB)">
              <NumberInput value={orderTotal} onChange={setOrderTotal} />
            </Field>
          )}
          <Field label="Times each rule already paid for this customer">
            <NumberInput min={0} step={1} value={alreadyPaid} onChange={setAlreadyPaid} />
          </Field>
        </div>
      </Section>

      {!parsed.success ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Fix the errors in the program first; the preview needs a valid program.
        </div>
      ) : (
        <Section title="Result" description={`Commissions stay on hold for ${parsed.config.holdDays} day(s): this one would be ready to pay on ${format(addDays(today, parsed.config.holdDays), 'dd MMM yyyy')}.`}>
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rule in this program is for “{EVENT_LABELS[event]}”.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Rule</TableHead>
                    <TableHead>Pays</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow key={line.rule.id} className={cn(line.status !== 'PAYS' && 'text-muted-foreground')}>
                      <TableCell>{line.rule.name}</TableCell>
                      <TableCell>{BENEFICIARY_LABELS[line.beneficiary]}</TableCell>
                      <TableCell className="text-right font-medium">
                        {line.status === 'PAYS' ? formatMoney(line.amount) : '—'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {line.status === 'PAYS'
                          ? line.cappedBy
                            ? `Lowered from ${formatMoney(line.calculatedAmount)} by "${line.cappedBy}"`
                            : 'Pays'
                          : line.reason}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="flex flex-wrap gap-6 text-sm">
            <span>
              Affiliate gets: <strong>{formatMoney(total('AFFILIATE'))}</strong>
            </span>
            <span>
              New customer gets: <strong>{formatMoney(total('CUSTOMER'))}</strong>
            </span>
            {otherRules > 0 && <span className="text-muted-foreground">{otherRules} other rule(s) are for other events.</span>}
          </div>
        </Section>
      )}
    </div>
  );
}

export function ProgramBuilderDialog({
  open,
  onOpenChange,
  program,
  options,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null to create a new program. */
  program: EditableProgram | null;
  options: AffiliateOptions;
  onSubmitted: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [config, setConfig] = useState<ProgramConfig>(() => programConfigSchema.parse(BLANK_CONFIG));
  const [templateKey, setTemplateKey] = useState('BLANK');
  const [tab, setTab] = useState('basics');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (program) {
      setName(program.name);
      setDescription(program.description ?? '');
      setConfig(clone(program.config));
    } else {
      setName('');
      setDescription('');
      setConfig(programConfigSchema.parse(BLANK_CONFIG));
      setTemplateKey('BLANK');
    }
    setTab('basics');
  }, [open, program]);

  const applyTemplate = (key: string) => {
    const template = PROGRAM_TEMPLATES.find((t) => t.key === key);
    setConfig(programConfigSchema.parse(template ? template.config : BLANK_CONFIG));
    setName(template ? template.name : '');
    setDescription(template ? template.description : '');
    setTemplateKey(key);
  };

  const validation = useMemo(() => parseProgramConfig(config), [config]);
  const errors = [
    ...(name.trim().length < 2 ? ['Give the program a name'] : []),
    ...(validation.success ? [] : validation.errors),
  ];

  const setSection = <K extends 'attribution' | 'clawback' | 'caps' | 'payout' | 'selfJoin' | 'withdraw' | 'reward'>(
    key: K,
    patch: Partial<ProgramConfig[K]>
  ) =>
    setConfig((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const setRule = (index: number, rule: CommissionRule) =>
    setConfig((prev) => ({ ...prev, commissionRules: prev.commissionRules.map((r, i) => (i === index ? rule : r)) }));
  const addRule = () =>
    setConfig((prev) => ({
      ...prev,
      commissionRules: [
        ...prev.commissionRules,
        { ...commissionRuleSchema.parse(BLANK_RULE), id: newRuleId(), name: `Rule ${prev.commissionRules.length + 1}` },
      ],
    }));
  const duplicateRule = (index: number) =>
    setConfig((prev) => {
      const copy = { ...clone(prev.commissionRules[index]), id: newRuleId(), name: `${prev.commissionRules[index].name} (copy)` };
      const rules = [...prev.commissionRules];
      rules.splice(index + 1, 0, copy);
      return { ...prev, commissionRules: rules };
    });
  const removeRule = (index: number) =>
    setConfig((prev) => ({ ...prev, commissionRules: prev.commissionRules.filter((_, i) => i !== index) }));
  const toggleType = (type: (typeof AFFILIATE_TYPES)[number], checked: boolean) =>
    setConfig((prev) => ({
      ...prev,
      allowedAffiliateTypes: checked
        ? Array.from(new Set([...prev.allowedAffiliateTypes, type]))
        : prev.allowedAffiliateTypes.filter((t) => t !== type),
    }));

  const submit = async () => {
    if (errors.length) return;
    setSubmitting(true);
    try {
      const body = { name: name.trim(), description: description.trim() || null, config };
      if (program) {
        await apiRequest('/api/affiliates/programs', { method: 'PUT', body: JSON.stringify({ programId: program.id, ...body }) });
      } else {
        await apiRequest('/api/affiliates/programs', { method: 'POST', body: JSON.stringify(body) });
      }
      toast({
        title: 'Sent for approval',
        description: 'A checker must approve it on the Approvals page before it takes effect.',
      });
      onOpenChange(false);
      onSubmitted();
    } catch (error: any) {
      toast({ title: 'Could not submit', description: error.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const codesOn = config.attribution.channels.includes('CODE');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{program ? `Edit “${program.name}”` : 'New affiliate program'}</DialogTitle>
          <DialogDescription>
            {program
              ? 'Saving publishes a new version after approval. Customers referred before that keep the version they joined under.'
              : 'Start from a template or a blank program. Nothing takes effect until a checker approves it.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="basics">Basics &amp; referrals</TabsTrigger>
            <TabsTrigger value="rules">Commission rules ({config.commissionRules.length})</TabsTrigger>
            <TabsTrigger value="limits">Limits &amp; payouts</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>

          <TabsContent value="basics" className="space-y-4 pt-4">
            {!program && (
              <Section title="Start from">
                <div className="grid gap-2 sm:grid-cols-4">
                  {[...PROGRAM_TEMPLATES, { key: 'BLANK', name: 'Blank program', description: 'One empty rule to build on.' }].map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => applyTemplate(t.key)}
                      className={cn(
                        'rounded-md border p-3 text-left text-sm transition-colors hover:bg-muted',
                        templateKey === t.key && 'border-primary ring-1 ring-primary'
                      )}
                    >
                      <div className="font-medium">{t.name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{t.description}</div>
                    </button>
                  ))}
                </div>
              </Section>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Program name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Agent Network" />
              </Field>
              <Field label="Description (optional)">
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
              </Field>
            </div>

            <Section title="Who can join" description="Affiliates of these types can be added to this program.">
              <div className="flex flex-wrap gap-4">
                {AFFILIATE_TYPES.map((type) => (
                  <label key={type} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={config.allowedAffiliateTypes.includes(type)}
                      onCheckedChange={(checked) => toggleType(type, checked === true)}
                    />
                    {AFFILIATE_TYPE_LABELS[type]}
                  </label>
                ))}
              </div>
            </Section>

            <Section
              title="Rewards"
              description="Rules work out every reward in Birr. Choose whether it is paid out as money or added to the person's points wallet."
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Pay rewards as">
                  <Select value={config.reward.type} onValueChange={(v) => setSection('reward', { type: v as RewardType })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REWARD_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {REWARD_TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {config.reward.type === 'POINTS' && (
                  <Field label="Points per 1 ETB of reward" hint="The earning rate, for rewards recorded after approval.">
                    <NumberInput
                      step="any"
                      value={config.reward.pointsPerBirr}
                      onChange={(v) => setSection('reward', { pointsPerBirr: v ?? 0 })}
                    />
                  </Field>
                )}
              </div>
              {config.reward.type === 'POINTS' && (() => {
                const example = pointsForAmount(50, config.reward.pointsPerBirr);
                return (
                  <p className="text-xs text-muted-foreground">
                    Example: a 50 ETB reward gives {formatPoints(example)}, worth {formatMoney(example * options.pointValue)} at
                    today&apos;s point value of {options.pointValue} ETB (set in Affiliates → Points). Points programs pay no money,
                    so the payout and withdrawal settings only cover money earned before switching. Points aren&apos;t booked on
                    provider ledgers yet.
                  </p>
                );
              })()}
            </Section>

            <Section
              title="Customer sign-up"
              description="Customers get their own code on the mini-app's Earn page, with no approval for each one. Only one program can have this on."
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm">Customers can get their own code in the mini-app</div>
                  <div className="text-xs text-muted-foreground">
                    {config.allowedAffiliateTypes.includes('BORROWER')
                      ? 'They join as Borrower affiliates and are paid into the account linked to their phone.'
                      : 'Add Borrower under "Who can join" to use this.'}
                  </div>
                </div>
                <Switch
                  checked={config.selfJoin.enabled}
                  onCheckedChange={(enabled) => setSection('selfJoin', { enabled })}
                />
              </div>
              {config.selfJoin.enabled && (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Fully repaid loans needed" hint="0 lets any customer join.">
                      <NumberInput
                        min={0}
                        step={1}
                        value={config.selfJoin.minRepaidLoans}
                        onChange={(v) => setSection('selfJoin', { minRepaidLoans: v ?? 0 })}
                      />
                    </Field>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm">Not while a payment is overdue</div>
                      <div className="text-xs text-muted-foreground">Customers flagged NPL can never join.</div>
                    </div>
                    <Switch
                      checked={config.selfJoin.blockIfOverdue}
                      onCheckedChange={(blockIfOverdue) => setSection('selfJoin', { blockIfOverdue })}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm">Let customers change their code once</div>
                      <div className="text-xs text-muted-foreground">
                        4 to 12 letters or digits; words like NIB, BANK or ADMIN are blocked.
                      </div>
                    </div>
                    <Switch
                      checked={config.selfJoin.allowCustomCode}
                      onCheckedChange={(allowCustomCode) => setSection('selfJoin', { allowCustomCode })}
                    />
                  </div>
                </>
              )}
            </Section>

            <Section title="Referrals" description="How a customer becomes linked to an affiliate.">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm">Accept referral codes in the mini-app</div>
                  <div className="text-xs text-muted-foreground">Turn off to stop new referrals while still paying existing ones.</div>
                </div>
                <Switch
                  checked={codesOn}
                  onCheckedChange={(on) => setSection('attribution', { channels: on ? ['CODE'] : [] })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm">New customers only</div>
                  <div className="text-xs text-muted-foreground">Customers who already had a loan or order can't use a code.</div>
                </div>
                <Switch
                  checked={config.attribution.newCustomersOnly}
                  onCheckedChange={(newCustomersOnly) => setSection('attribution', { newCustomersOnly })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Referral valid for (days)" hint="Loans and orders started after this don't earn. Empty = no limit.">
                  <NumberInput
                    min={1}
                    step={1}
                    placeholder="No limit"
                    value={config.attribution.referralValidDays}
                    onChange={(referralValidDays) => setSection('attribution', { referralValidDays })}
                  />
                </Field>
                <Field label="Max new referrals per affiliate per day" hint="Slows down fake sign-ups. Empty = no limit.">
                  <NumberInput
                    min={1}
                    step={1}
                    placeholder="No limit"
                    value={config.attribution.maxReferralsPerAffiliatePerDay}
                    onChange={(maxReferralsPerAffiliatePerDay) => setSection('attribution', { maxReferralsPerAffiliatePerDay })}
                  />
                </Field>
              </div>
            </Section>
          </TabsContent>

          <TabsContent value="rules" className="space-y-4 pt-4">
            <p className="text-sm text-muted-foreground">
              Rules run in order. Each rule pays one person (the affiliate or the new customer); use two rules for a reward on both sides.
            </p>
            {config.commissionRules.map((rule, index) => (
              <RuleEditor
                key={rule.id + index}
                rule={rule}
                index={index}
                options={options}
                canRemove={config.commissionRules.length > 1}
                onChange={(r) => setRule(index, r)}
                onRemove={() => removeRule(index)}
                onDuplicate={() => duplicateRule(index)}
              />
            ))}
            <Button type="button" variant="outline" onClick={addRule} disabled={config.commissionRules.length >= 50}>
              <Plus className="mr-2 h-4 w-4" /> Add rule
            </Button>
          </TabsContent>

          <TabsContent value="limits" className="space-y-4 pt-4">
            <Section title="Hold and take-backs" description="Commissions wait before they can be paid, so reversals can be caught first.">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Hold period (days)">
                  <NumberInput
                    min={0}
                    step={1}
                    value={config.holdDays}
                    onChange={(v) => setConfig((prev) => ({ ...prev, holdDays: v as number }))}
                  />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                A commission is always taken back if its loan is reversed. Already-paid commissions are deducted from the next payout.
              </p>
              <div className="flex items-center justify-between gap-4">
                <div className="text-sm">Also take back when the customer becomes NPL</div>
                <Switch checked={config.clawback.onNpl} onCheckedChange={(onNpl) => setSection('clawback', { onNpl })} />
              </div>
              {config.clawback.onNpl && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="For commissions earned in the last (days)">
                    <NumberInput
                      min={1}
                      step={1}
                      value={config.clawback.nplWindowDays}
                      onChange={(v) => setSection('clawback', { nplWindowDays: v as number })}
                    />
                  </Field>
                </div>
              )}
            </Section>

            <Section title="Caps" description="Leave empty for no cap. Commissions are lowered to stay within each cap.">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Max per referred customer (ETB)" hint="What one affiliate can earn from one customer.">
                  <NumberInput
                    placeholder="No cap"
                    value={config.caps.perReferralTotal}
                    onChange={(perReferralTotal) => setSection('caps', { perReferralTotal })}
                  />
                </Field>
                <Field label="Max per affiliate per month (ETB)">
                  <NumberInput
                    placeholder="No cap"
                    value={config.caps.perAffiliatePerMonth}
                    onChange={(perAffiliatePerMonth) => setSection('caps', { perAffiliatePerMonth })}
                  />
                </Field>
                <Field label="Program budget (ETB)" hint="Total of all commissions, including welcome bonuses.">
                  <NumberInput
                    placeholder="No cap"
                    value={config.caps.programBudget}
                    onChange={(programBudget) => setSection('caps', { programBudget })}
                  />
                </Field>
              </div>
            </Section>

            <Section title="Payouts" description="Every payout batch needs approval before money is sent.">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Prepare payouts" hint="Scheduled batches are drafts until someone submits them.">
                  <Select
                    value={config.payout.schedule}
                    onValueChange={(v) => setSection('payout', { schedule: v as ProgramConfig['payout']['schedule'] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYOUT_SCHEDULES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {PAYOUT_SCHEDULE_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Minimum payout (ETB)" hint="Smaller balances wait for the next batch.">
                  <NumberInput
                    value={config.payout.minimumAmount}
                    onChange={(v) => setSection('payout', { minimumAmount: v as number })}
                  />
                </Field>
                <Field label="Withholding tax (%)">
                  <NumberInput
                    value={config.payout.withholdingTaxPercent}
                    onChange={(v) => setSection('payout', { withholdingTaxPercent: v as number })}
                  />
                </Field>
              </div>
            </Section>

            <Section
              title="Withdrawals (mini-app)"
              description="Affiliates and customers withdraw their available earnings on the Earn page themselves, always to their own account. Payout batches keep working alongside."
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm">People can withdraw their earnings in the mini-app</div>
                  <div className="text-xs text-muted-foreground">
                    Customers are paid into the account linked to their phone, other affiliates into their registered payout account. The
                    withholding tax above applies.
                  </div>
                </div>
                <Switch
                  checked={config.withdraw.enabled}
                  onCheckedChange={(enabled) => setSection('withdraw', { enabled })}
                />
              </div>
              {config.withdraw.enabled && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Minimum withdrawal (ETB)">
                    <NumberInput
                      value={config.withdraw.minimum}
                      onChange={(v) => setSection('withdraw', { minimum: v ?? 0 })}
                    />
                  </Field>
                  <Field label="Max per day (ETB)" hint="Empty = no limit.">
                    <NumberInput
                      placeholder="No limit"
                      value={config.withdraw.maxPerDay}
                      onChange={(maxPerDay) => setSection('withdraw', { maxPerDay })}
                    />
                  </Field>
                  <Field label="Max per month (ETB)" hint="Empty = no limit.">
                    <NumberInput
                      placeholder="No limit"
                      value={config.withdraw.maxPerMonth}
                      onChange={(maxPerMonth) => setSection('withdraw', { maxPerMonth })}
                    />
                  </Field>
                  <Field
                    label="Send automatically up to (ETB)"
                    hint="Larger withdrawals wait for a checker in Payouts. 0 = a checker approves every withdrawal."
                  >
                    <NumberInput
                      value={config.withdraw.autoApproveUpTo}
                      onChange={(v) => setSection('withdraw', { autoApproveUpTo: v ?? 0 })}
                    />
                  </Field>
                </div>
              )}
            </Section>
          </TabsContent>

          <TabsContent value="preview" className="pt-4">
            <PreviewPanel config={config} options={options} />
          </TabsContent>
        </Tabs>

        {errors.length > 0 && (
          <div className="space-y-1 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <div className="flex items-center gap-2 font-medium">
              <AlertCircle className="h-4 w-4" /> Fix these before submitting
            </div>
            <ul className="list-disc pl-6">
              {errors.slice(0, 8).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {errors.length > 8 && <li>…and {errors.length - 8} more</li>}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || errors.length > 0}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
