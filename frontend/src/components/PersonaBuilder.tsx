import React from 'react';
import type { PersonaFormValues, ClientPersona } from '../types';

// ---------------------------------------------------------------------------
// Reusable persona-builder UI. Both the advisor's "New Session" page and the
// admin's "Session Profiles" editor share this component so the persona
// picker stays consistent across the app.
// ---------------------------------------------------------------------------

export const DEFAULT_PERSONA_FORM: PersonaFormValues = {
  client_type: 'individual',
  gender: 'male',
  age_group: 'middle_aged',
  marital_status: 'married',
  has_children: false,
  num_children: 0,
  employment_types: ['employed'],
  financial_situation: 'comfortable',
  has_debt: 'manageable',
  risk_tolerance: 'moderate',
  investment_experience: 'beginner',
  primary_concerns: ['Retirement Planning'],
  personality_type: 'analytical',
  communication_style: 'direct',
  previous_advisor: false,
  urgency: 'medium',
  spouse_gender: 'female',
  spouse_age_group: 'middle_aged',
  spouse_employment_types: ['employed'],
  spouse_personality_type: 'analytical',
};

export const NET_WORTH_MAP: Record<string, string> = {
  struggling: '$0 – $50,000',
  stable: '$50,000 – $250,000',
  comfortable: '$250,000 – $1M',
  affluent: '$1M – $5M',
  wealthy: '$5M – $25M',
  ultra_wealthy: '$25M+',
};

export const INCOME_MAP: Record<string, string> = {
  struggling: '$0 – $40,000',
  stable: '$40,000 – $80,000',
  comfortable: '$80,000 – $200,000',
  affluent: '$200,000 – $500,000',
  wealthy: '$500,000 – $2M',
  ultra_wealthy: '$2M+',
};

export const FINANCIAL_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  struggling: { label: 'Struggling', color: 'text-red-400', bg: 'bg-red-900/40 border-red-700' },
  stable: { label: 'Stable', color: 'text-orange-400', bg: 'bg-orange-900/40 border-orange-700' },
  comfortable: { label: 'Comfortable', color: 'text-yellow-400', bg: 'bg-yellow-900/40 border-yellow-700' },
  affluent: { label: 'Affluent', color: 'text-lime-400', bg: 'bg-lime-900/40 border-lime-700' },
  wealthy: { label: 'Wealthy', color: 'text-green-400', bg: 'bg-green-900/40 border-green-700' },
  ultra_wealthy: { label: 'Ultra Wealthy', color: 'text-emerald-400', bg: 'bg-emerald-900/40 border-emerald-700' },
};

const RISK_OPTIONS = [
  { value: 'very_conservative', label: 'Very Conservative', color: 'bg-blue-900 border-blue-600 text-blue-300' },
  { value: 'conservative', label: 'Conservative', color: 'bg-sky-900 border-sky-600 text-sky-300' },
  { value: 'moderate', label: 'Moderate', color: 'bg-yellow-900 border-yellow-600 text-yellow-300' },
  { value: 'aggressive', label: 'Aggressive', color: 'bg-orange-900 border-orange-600 text-orange-300' },
  { value: 'very_aggressive', label: 'Very Aggressive', color: 'bg-red-900 border-red-600 text-red-300' },
];

const EMPLOYMENT_OPTIONS = [
  { value: 'employed', label: 'Employed', icon: '💼' },
  { value: 'self_employed', label: 'Self-Employed', icon: '🧑‍💻' },
  { value: 'business_owner', label: 'Business Owner', icon: '🏢' },
  { value: 'executive', label: 'Executive', icon: '👔' },
  { value: 'retired', label: 'Retired', icon: '🌅' },
  { value: 'part_time', label: 'Part-Time', icon: '⏰' },
  { value: 'unemployed', label: 'Unemployed', icon: '🔍' },
];

const CONCERN_OPTIONS = [
  'Retirement Planning',
  'Wealth Growth',
  'Estate Planning',
  'Tax Optimization',
  'College Funding',
  'Income Generation',
  'Debt Reduction',
  'Business Succession',
  'Charitable Giving',
];

const PERSONALITY_OPTIONS = [
  { value: 'anxious', label: 'Anxious', emoji: '😰' },
  { value: 'confident', label: 'Confident', emoji: '😎' },
  { value: 'skeptical', label: 'Skeptical', emoji: '🤔' },
  { value: 'analytical', label: 'Analytical', emoji: '📊' },
  { value: 'emotional', label: 'Emotional', emoji: '💭' },
  { value: 'impulsive', label: 'Impulsive', emoji: '⚡' },
  { value: 'detail_oriented', label: 'Detail-Oriented', emoji: '🔍' },
  { value: 'trusting', label: 'Trusting', emoji: '🤝' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-gold-400 uppercase tracking-wider mb-4 pb-2 border-b border-navy-700">
      {children}
    </h3>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        value ? 'bg-gold-500' : 'bg-navy-700'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          value ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
      {label && <span className="sr-only">{label}</span>}
    </button>
  );
}

export function getPreviewName(form: PersonaFormValues): string {
  const maleNames = ['James', 'Carlos', 'Marcus', 'Raj', 'Ahmed', 'Wei', 'Andre',
    'Diego', 'Ethan', 'Omar', 'Kenji', 'Isaiah', 'Vikram', 'Javier', 'Tae'];
  const femaleNames = ['Jennifer', 'Maria', 'Priya', 'Aisha', 'Mei', 'Sofia', 'Keisha',
    'Elena', 'Nadia', 'Yuki', 'Fatima', 'Angela', 'Divya', 'Lucia', 'Imani'];
  const lastNames = ['Thompson', 'Garcia', 'Patel', 'Nguyen', 'Kim', 'Robinson', 'Martinez',
    'Chen', 'Okafor', 'Singh', 'Williams', 'Ramirez', 'Ali', 'Davis', 'Yamamoto'];
  const namePool = form.gender === 'female' ? femaleNames : maleNames;
  const nameIdx = CONCERN_OPTIONS.indexOf(form.primary_concerns[0] ?? '') % namePool.length;
  const lastIdx = PERSONALITY_OPTIONS.findIndex((p) => p.value === form.personality_type) % lastNames.length;
  return `${namePool[Math.max(0, nameIdx)]} ${lastNames[Math.max(0, lastIdx)]}`;
}

export function getSpousePreviewName(form: PersonaFormValues): string {
  const maleNames = ['William', 'Robert', 'Alejandro', 'Vikram', 'Hassan', 'Kenji', 'Andre',
    'Javier', 'Daniel', 'Tariq', 'Rahul', 'Ethan', 'Miguel', 'Isaiah', 'Wei'];
  const femaleNames = ['Patricia', 'Elena', 'Priya', 'Fatima', 'Yuki', 'Sofia', 'Monique',
    'Deepa', 'Angela', 'Yasmin', 'Gabriela', 'Samantha', 'Nadia', 'Aisha', 'Lin'];
  const lastNames = ['Williams', 'Martinez', 'Singh', 'Kim', 'Hassan', 'Chen', 'Robinson',
    'Lopez', 'Patel', 'Nguyen', 'Okafor', 'Garcia', 'Rahman', 'Taylor', 'Park'];
  const namePool = form.spouse_gender === 'female' ? femaleNames : maleNames;
  const nameIdx = PERSONALITY_OPTIONS.findIndex((p) => p.value === form.spouse_personality_type) % namePool.length;
  const lastIdx = PERSONALITY_OPTIONS.findIndex((p) => p.value === form.personality_type) % lastNames.length;
  return `${namePool[Math.max(0, nameIdx)]} ${lastNames[Math.max(0, lastIdx)]}`;
}

export function getAgeRange(ag: string): string {
  const map: Record<string, string> = {
    young_adult: '25–35',
    middle_aged: '36–55',
    senior: '56–70',
    elderly: '71–85',
  };
  return map[ag] || '';
}

export function formatLabel(val: string) {
  return val.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// ---------------------------------------------------------------------------
// buildPersonaPayload — assembles the wire-format ClientPersona from form state
// ---------------------------------------------------------------------------

export function buildPersonaPayload(form: PersonaFormValues): Record<string, unknown> {
  const previewName = getPreviewName(form);
  const spousePreviewName = getSpousePreviewName(form);
  const primaryEmployment = form.employment_types[0] ?? 'employed';
  const spousePrimaryEmployment = form.spouse_employment_types[0] ?? 'employed';
  const couple = form.client_type === 'couple';

  const deriveOccupation = (et: string) =>
    et === 'employed' ? 'Professional'
    : et === 'executive' ? 'Executive'
    : et === 'retired' ? 'Retired'
    : 'Business Owner';

  const backstory = couple
    ? `${previewName} & ${spousePreviewName} are a couple attending together. ` +
      `${previewName} is a ${getAgeRange(form.age_group)}-year-old ${formatLabel(primaryEmployment).toLowerCase()}; ` +
      `${spousePreviewName} is a ${getAgeRange(form.spouse_age_group)}-year-old ${formatLabel(spousePrimaryEmployment).toLowerCase()}. ` +
      `Primary concerns: ${form.primary_concerns.join(', ')}.`
    : `${previewName} is a ${getAgeRange(form.age_group)}-year-old ${formatLabel(primaryEmployment).toLowerCase()} with ${formatLabel(form.financial_situation).toLowerCase()} finances. Primary concerns: ${form.primary_concerns.join(', ')}.`;

  return {
    ...form,
    client_type: form.client_type,
    name: previewName,
    age: parseInt(getAgeRange(form.age_group).split('–')[0]) + 5,
    occupation: deriveOccupation(primaryEmployment),
    estimated_net_worth: NET_WORTH_MAP[form.financial_situation],
    estimated_income: INCOME_MAP[form.financial_situation],
    referral_source: 'Friend/Family',
    backstory,
    employment_type: primaryEmployment,
    primary_concern: form.primary_concerns[0] ?? '',
    gender: form.gender,
    age_group: form.age_group,
    marital_status: form.marital_status,
    financial_situation: form.financial_situation,
    has_debt: form.has_debt,
    risk_tolerance: form.risk_tolerance,
    investment_experience: form.investment_experience,
    personality_type: form.personality_type,
    communication_style: form.communication_style,
    urgency: form.urgency,
    ...(couple && {
      spouse_name: spousePreviewName,
      spouse_age: parseInt(getAgeRange(form.spouse_age_group).split('–')[0]) + 5,
      spouse_age_group: form.spouse_age_group,
      spouse_gender: form.spouse_gender,
      spouse_occupation: deriveOccupation(spousePrimaryEmployment),
      spouse_employment_types: form.spouse_employment_types,
      spouse_personality_type: form.spouse_personality_type,
    }),
  };
}

// ---------------------------------------------------------------------------
// Reverse map: ClientPersona → PersonaFormValues (used when editing a profile)
// ---------------------------------------------------------------------------

export function personaToForm(p: ClientPersona): PersonaFormValues {
  return {
    client_type: p.client_type || 'individual',
    gender: p.gender,
    age_group: p.age_group,
    marital_status: p.marital_status,
    has_children: p.has_children,
    num_children: p.num_children,
    employment_types: p.employment_types?.length ? p.employment_types : ['employed'],
    financial_situation: p.financial_situation,
    has_debt: p.has_debt,
    risk_tolerance: p.risk_tolerance,
    investment_experience: p.investment_experience,
    primary_concerns: p.primary_concerns?.length ? p.primary_concerns : ['Retirement Planning'],
    personality_type: p.personality_type,
    communication_style: p.communication_style,
    previous_advisor: p.previous_advisor,
    urgency: p.urgency,
    spouse_gender: p.spouse_gender || 'female',
    spouse_age_group: p.spouse_age_group || 'middle_aged',
    spouse_employment_types: p.spouse_employment_types?.length ? p.spouse_employment_types : ['employed'],
    spouse_personality_type: p.spouse_personality_type || 'analytical',
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PersonaBuilderProps {
  value: PersonaFormValues;
  onChange: (next: PersonaFormValues) => void;
  /** Optional slot rendered inside the preview card (e.g. a submit button). */
  actionSlot?: React.ReactNode;
  /** Optional extra content rendered above the action slot, e.g. profile name field. */
  topSlot?: React.ReactNode;
}

export default function PersonaBuilder({ value: form, onChange, actionSlot, topSlot }: PersonaBuilderProps) {
  const set = <K extends keyof PersonaFormValues>(key: K, val: PersonaFormValues[K]) =>
    onChange({ ...form, [key]: val });

  const previewName = getPreviewName(form);
  const initials = previewName.split(' ').map((n) => n[0]).join('');
  const spousePreviewName = getSpousePreviewName(form);
  const spouseInitials = spousePreviewName.split(' ').map((n) => n[0]).join('');
  const isCouple = form.client_type === 'couple';

  return (
    <div className="flex gap-8">
      {/* LEFT: Form */}
      <div className="flex-1 space-y-8">
        {topSlot}

        {/* Client Type */}
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
          <SectionTitle>Client Type</SectionTitle>
          <div className="flex gap-3">
            {([
              { value: 'individual', label: 'Individual', icon: '👤', desc: 'Single client' },
              { value: 'couple', label: 'Couple', icon: '👥', desc: 'Two people attending together' },
            ] as const).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => set('client_type', opt.value)}
                className={`flex-1 flex flex-col items-center gap-1.5 py-4 rounded-xl border text-sm font-medium transition-colors ${
                  form.client_type === opt.value
                    ? 'bg-gold-500/10 border-gold-500 text-gold-400'
                    : 'border-navy-600 text-slate-400 hover:border-navy-500'
                }`}
              >
                <span className="text-2xl">{opt.icon}</span>
                <span>{opt.label}</span>
                <span className="text-xs font-normal opacity-70">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Demographics */}
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
          <SectionTitle>Demographics</SectionTitle>
          <div className="space-y-5">
            <div>
              <label className="block text-sm text-slate-400 mb-2">
                {isCouple ? 'Primary Gender' : 'Gender'}
              </label>
              <div className="flex gap-3">
                {(['male', 'female'] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => set('gender', g)}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                      form.gender === g
                        ? 'bg-gold-500/10 border-gold-500 text-gold-400'
                        : 'border-navy-600 text-slate-400 hover:border-navy-500'
                    }`}
                  >
                    <span>{g === 'male' ? '👨' : '👩'}</span>
                    <span className="capitalize">{g}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-2">Age Group</label>
              <select
                value={form.age_group}
                onChange={(e) => set('age_group', e.target.value)}
                className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
              >
                <option value="young_adult">Young Adult (25–35)</option>
                <option value="middle_aged">Middle-Aged (36–55)</option>
                <option value="senior">Senior (56–70)</option>
                <option value="elderly">Elderly (71–85)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-2">Marital Status</label>
              <select
                value={form.marital_status}
                onChange={(e) => set('marital_status', e.target.value)}
                className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
              >
                <option value="single">Single</option>
                <option value="married">Married</option>
                <option value="divorced">Divorced</option>
                <option value="widowed">Widowed</option>
                <option value="domestic_partner">Domestic Partner</option>
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-sm text-slate-400">Has Children</label>
                <Toggle value={form.has_children} onChange={(v) => set('has_children', v)} />
              </div>
              {form.has_children && (
                <div className="mt-3">
                  <label className="block text-sm text-slate-400 mb-2">Number of Children</label>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={form.num_children}
                    onChange={(e) => set('num_children', parseInt(e.target.value) || 1)}
                    className="w-24 bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Spouse / Partner */}
        {isCouple && (
          <div className="bg-navy-800 border border-gold-500/30 rounded-xl p-6">
            <SectionTitle>Spouse / Partner</SectionTitle>
            <div className="space-y-5">
              <div>
                <label className="block text-sm text-slate-400 mb-2">Gender</label>
                <div className="flex gap-3">
                  {(['male', 'female'] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => set('spouse_gender', g)}
                      className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                        form.spouse_gender === g
                          ? 'bg-gold-500/10 border-gold-500 text-gold-400'
                          : 'border-navy-600 text-slate-400 hover:border-navy-500'
                      }`}
                    >
                      <span>{g === 'male' ? '👨' : '👩'}</span>
                      <span className="capitalize">{g}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-2">Age Group</label>
                <select
                  value={form.spouse_age_group}
                  onChange={(e) => set('spouse_age_group', e.target.value)}
                  className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
                >
                  <option value="young_adult">Young Adult (25–35)</option>
                  <option value="middle_aged">Middle-Aged (36–55)</option>
                  <option value="senior">Senior (56–70)</option>
                  <option value="elderly">Elderly (71–85)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-2">Professional Background <span className="text-slate-600 font-normal">(select all that apply)</span></label>
                <div className="grid grid-cols-4 gap-2">
                  {EMPLOYMENT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        set(
                          'spouse_employment_types',
                          form.spouse_employment_types.includes(opt.value)
                            ? form.spouse_employment_types.filter((v) => v !== opt.value)
                            : [...form.spouse_employment_types, opt.value],
                        )
                      }
                      className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-lg border text-xs font-medium transition-colors ${
                        form.spouse_employment_types.includes(opt.value)
                          ? 'bg-gold-500/10 border-gold-500 text-gold-400'
                          : 'border-navy-600 text-slate-400 hover:border-navy-500'
                      }`}
                    >
                      <span className="text-xl">{opt.icon}</span>
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-2">Personality Type</label>
                <div className="grid grid-cols-4 gap-2">
                  {PERSONALITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => set('spouse_personality_type', opt.value)}
                      className={`flex flex-col items-center gap-1 py-2.5 px-2 rounded-lg border text-xs font-medium transition-colors ${
                        form.spouse_personality_type === opt.value
                          ? 'bg-gold-500/10 border-gold-500 text-gold-400'
                          : 'border-navy-600 text-slate-400 hover:border-navy-500'
                      }`}
                    >
                      <span className="text-xl">{opt.emoji}</span>
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Professional Background */}
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
          <SectionTitle>Professional Background</SectionTitle>
          <p className="text-xs text-slate-500 mb-3">Select all that apply</p>
          <div className="grid grid-cols-4 gap-2">
            {EMPLOYMENT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  set(
                    'employment_types',
                    form.employment_types.includes(opt.value)
                      ? form.employment_types.filter((v) => v !== opt.value)
                      : [...form.employment_types, opt.value],
                  )
                }
                className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-lg border text-xs font-medium transition-colors ${
                  form.employment_types.includes(opt.value)
                    ? 'bg-gold-500/10 border-gold-500 text-gold-400'
                    : 'border-navy-600 text-slate-400 hover:border-navy-500'
                }`}
              >
                <span className="text-xl">{opt.icon}</span>
                <span>{opt.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Financial Profile */}
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
          <SectionTitle>Financial Profile</SectionTitle>
          <div className="space-y-5">
            <div>
              <label className="block text-sm text-slate-400 mb-2">Financial Situation</label>
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(FINANCIAL_LABELS).map(([val, meta]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => set('financial_situation', val)}
                    className={`py-2 px-3 rounded-lg border text-xs font-medium transition-colors ${
                      form.financial_situation === val
                        ? `${meta.bg} ${meta.color}`
                        : 'border-navy-600 text-slate-500 hover:border-navy-500'
                    }`}
                  >
                    {meta.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Est. Net Worth</label>
                <div className="bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-slate-400 text-sm">
                  {NET_WORTH_MAP[form.financial_situation]}
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Est. Income</label>
                <div className="bg-navy-900 border border-navy-700 rounded-lg px-3 py-2 text-slate-400 text-sm">
                  {INCOME_MAP[form.financial_situation]}
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-2">Debt Situation</label>
              <select
                value={form.has_debt}
                onChange={(e) => set('has_debt', e.target.value)}
                className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
              >
                <option value="none">No Debt</option>
                <option value="manageable">Manageable Debt</option>
                <option value="significant">Significant Debt</option>
                <option value="overwhelming">Overwhelming Debt</option>
              </select>
            </div>
          </div>
        </div>

        {/* Investment Profile */}
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
          <SectionTitle>Investment Profile</SectionTitle>
          <div className="space-y-5">
            <div>
              <label className="block text-sm text-slate-400 mb-2">Risk Tolerance</label>
              <div className="flex gap-1.5">
                {RISK_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set('risk_tolerance', opt.value)}
                    className={`flex-1 py-2 px-1 rounded-lg border text-xs font-medium transition-colors ${
                      form.risk_tolerance === opt.value
                        ? opt.color
                        : 'border-navy-600 text-slate-500 hover:border-navy-500'
                    }`}
                  >
                    <span className="hidden sm:block text-center">{opt.label}</span>
                    <span className="sm:hidden text-center">{opt.label.split(' ')[0]}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-2">Investment Experience</label>
              <select
                value={form.investment_experience}
                onChange={(e) => set('investment_experience', e.target.value)}
                className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
              >
                <option value="none">None</option>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="experienced">Experienced</option>
                <option value="expert">Expert</option>
              </select>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm text-slate-400">Has Had a Previous Financial Advisor</label>
              <Toggle value={form.previous_advisor} onChange={(v) => set('previous_advisor', v)} />
            </div>
          </div>
        </div>

        {/* Goals & Concerns */}
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
          <SectionTitle>Goals & Concerns</SectionTitle>
          <div className="space-y-5">
            <div>
              <label className="block text-sm text-slate-400 mb-2">Primary Concern <span className="text-slate-600 font-normal">(select all that apply)</span></label>
              <div className="grid grid-cols-3 gap-2">
                {CONCERN_OPTIONS.map((concern) => (
                  <button
                    key={concern}
                    type="button"
                    onClick={() =>
                      set(
                        'primary_concerns',
                        form.primary_concerns.includes(concern)
                          ? form.primary_concerns.filter((c) => c !== concern)
                          : [...form.primary_concerns, concern],
                      )
                    }
                    className={`py-2 px-2 rounded-lg border text-xs font-medium text-center transition-colors leading-tight ${
                      form.primary_concerns.includes(concern)
                        ? 'bg-gold-500/10 border-gold-500 text-gold-400'
                        : 'border-navy-600 text-slate-400 hover:border-navy-500'
                    }`}
                  >
                    {concern}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-2">Urgency</label>
              <div className="flex gap-3">
                {(['low', 'medium', 'high'] as const).map((u) => (
                  <label key={u} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="urgency"
                      value={u}
                      checked={form.urgency === u}
                      onChange={() => set('urgency', u)}
                      className="accent-gold-500"
                    />
                    <span
                      className={`text-sm capitalize ${
                        form.urgency === u ? 'text-white font-medium' : 'text-slate-400'
                      }`}
                    >
                      {u}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Personality & Style */}
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
          <SectionTitle>Personality & Communication Style</SectionTitle>
          <div className="space-y-5">
            <div>
              <label className="block text-sm text-slate-400 mb-2">Personality Type</label>
              <div className="grid grid-cols-4 gap-2">
                {PERSONALITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set('personality_type', opt.value)}
                    className={`flex flex-col items-center gap-1 py-2.5 px-2 rounded-lg border text-xs font-medium transition-colors ${
                      form.personality_type === opt.value
                        ? 'bg-gold-500/10 border-gold-500 text-gold-400'
                        : 'border-navy-600 text-slate-400 hover:border-navy-500'
                    }`}
                  >
                    <span className="text-xl">{opt.emoji}</span>
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-2">Communication Style</label>
              <select
                value={form.communication_style}
                onChange={(e) => set('communication_style', e.target.value)}
                className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
              >
                <option value="direct">Direct</option>
                <option value="reserved">Reserved</option>
                <option value="chatty">Chatty</option>
                <option value="formal">Formal</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: Preview Card */}
      <div className="w-80 flex-shrink-0">
        <div className="sticky top-8">
          <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">
              Client Preview
            </h3>

            {isCouple ? (
              <div className="flex flex-col items-center mb-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-16 h-16 rounded-full bg-navy-700 border-2 border-gold-500/50 flex items-center justify-center text-xl font-bold text-gold-400">
                    {initials}
                  </div>
                  <span className="text-slate-500 text-lg">&</span>
                  <div className="w-16 h-16 rounded-full bg-navy-700 border-2 border-gold-500/50 flex items-center justify-center text-xl font-bold text-gold-400">
                    {spouseInitials}
                  </div>
                </div>
                <div className="text-base font-semibold text-white text-center">
                  {previewName} & {spousePreviewName}
                </div>
                <div className="text-slate-500 text-xs mt-1 text-center">
                  {getAgeRange(form.age_group)} · {getAgeRange(form.spouse_age_group)}
                  {form.has_children ? ` · ${form.num_children || 1} child${(form.num_children || 1) !== 1 ? 'ren' : ''}` : ''}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center mb-5">
                <div className="w-20 h-20 rounded-full bg-navy-700 border-2 border-navy-600 flex items-center justify-center text-2xl font-bold text-gold-400 mb-3">
                  {initials}
                </div>
                <div className="text-lg font-semibold text-white">{previewName}</div>
                <div className="text-slate-500 text-sm mt-0.5">
                  Age {getAgeRange(form.age_group)} · {form.gender === 'male' ? 'Male' : 'Female'}
                </div>
                {form.marital_status && (
                  <div className="text-slate-500 text-xs mt-0.5 capitalize">
                    {form.marital_status.replace('_', ' ')}
                    {form.has_children ? ` · ${form.num_children || 1} child${(form.num_children || 1) !== 1 ? 'ren' : ''}` : ''}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2 mb-5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Employment</span>
                <span className="text-slate-300">
                  {EMPLOYMENT_OPTIONS.filter((o) => form.employment_types.includes(o.value))
                    .map((o) => o.label)
                    .join(', ') || '—'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Net Worth</span>
                <span className="text-slate-300">{NET_WORTH_MAP[form.financial_situation]}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Risk Profile</span>
                <span className="text-slate-300">{formatLabel(form.risk_tolerance)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Experience</span>
                <span className="text-slate-300 capitalize">{form.investment_experience}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Debt</span>
                <span className="text-slate-300">{formatLabel(form.has_debt)}</span>
              </div>
            </div>

            <div className="mb-4">
              <div className="text-xs text-slate-500 mb-1.5">Primary Goals</div>
              <div className="flex flex-wrap gap-1.5">
                {form.primary_concerns.length > 0 ? form.primary_concerns.map((c) => (
                  <span key={c} className="inline-flex px-2.5 py-1 rounded-lg bg-gold-500/10 text-gold-400 text-xs font-medium border border-gold-500/30">
                    {c}
                  </span>
                )) : <span className="text-slate-600 text-xs">None selected</span>}
              </div>
            </div>

            <div className="mb-5">
              <div className="text-xs text-slate-500 mb-1.5">Personality</div>
              <div className="flex items-center gap-2">
                <span className="text-lg">
                  {PERSONALITY_OPTIONS.find((p) => p.value === form.personality_type)?.emoji}
                </span>
                <span className="text-sm text-slate-300">
                  {PERSONALITY_OPTIONS.find((p) => p.value === form.personality_type)?.label}
                </span>
                <span className="text-slate-600">·</span>
                <span className="text-sm text-slate-400 capitalize">{form.communication_style}</span>
              </div>
            </div>

            <div className="bg-navy-900 rounded-lg p-3 text-xs text-slate-400 leading-relaxed mb-5">
              {isCouple ? (
                <>
                  {previewName} & {spousePreviewName} are a couple seeking advice together.{' '}
                  {previewName} is a {getAgeRange(form.age_group)}-year-old{' '}
                  {formatLabel(form.employment_types[0] ?? 'employed').toLowerCase()};{' '}
                  {spousePreviewName} is a {getAgeRange(form.spouse_age_group)}-year-old{' '}
                  {formatLabel(form.spouse_employment_types[0] ?? 'employed').toLowerCase()}.{' '}
                  Primarily concerned with{' '}
                  {(form.primary_concerns ?? []).map((c) => c.toLowerCase()).join(' & ') || '—'}.
                </>
              ) : (
                <>
                  {previewName} is a {getAgeRange(form.age_group)}-year-old{' '}
                  {formatLabel(form.employment_types[0] ?? 'employed').toLowerCase()} with{' '}
                  {form.financial_situation} finances. They are primarily concerned with{' '}
                  {(form.primary_concerns ?? []).map((c) => c.toLowerCase()).join(' & ') || '—'}{' '}
                  and have a {formatLabel(form.risk_tolerance).toLowerCase()} risk tolerance.
                  {form.previous_advisor ? ' Has worked with a financial advisor before.' : ''}
                </>
              )}
            </div>

            <div className="flex items-center gap-2 mb-6">
              <span
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
                  form.urgency === 'high'
                    ? 'bg-red-900/50 text-red-300'
                    : form.urgency === 'medium'
                    ? 'bg-yellow-900/50 text-yellow-300'
                    : 'bg-blue-900/50 text-blue-300'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    form.urgency === 'high'
                      ? 'bg-red-400'
                      : form.urgency === 'medium'
                      ? 'bg-yellow-400'
                      : 'bg-blue-400'
                  }`}
                />
                {formatLabel(form.urgency)} Urgency
              </span>
            </div>

            {actionSlot}
          </div>
        </div>
      </div>
    </div>
  );
}
