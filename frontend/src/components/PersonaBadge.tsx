import React from 'react';
import type { ClientPersona } from '../types';

interface PersonaBadgeProps {
  persona: ClientPersona;
  compact?: boolean;
}

const riskColors: Record<string, string> = {
  very_conservative: 'bg-blue-900 text-blue-300',
  conservative: 'bg-blue-800 text-blue-300',
  moderate: 'bg-yellow-900 text-yellow-300',
  aggressive: 'bg-orange-900 text-orange-300',
  very_aggressive: 'bg-red-900 text-red-300',
};

const financialColors: Record<string, string> = {
  struggling: 'bg-red-900 text-red-300',
  stable: 'bg-yellow-900 text-yellow-300',
  comfortable: 'bg-green-900 text-green-300',
  affluent: 'bg-teal-900 text-teal-300',
  wealthy: 'bg-blue-900 text-blue-300',
  ultra_wealthy: 'bg-purple-900 text-purple-300',
};

function Chip({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colorClass}`}>
      {label}
    </span>
  );
}

function formatLabel(val: string): string {
  return val
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function PersonaBadge({ persona, compact = false }: PersonaBadgeProps) {
  if (compact) {
    return (
      <div className="flex flex-wrap gap-1">
        <Chip
          label={formatLabel(persona.financial_situation)}
          colorClass={financialColors[persona.financial_situation] || 'bg-slate-700 text-slate-300'}
        />
        <Chip
          label={formatLabel(persona.risk_tolerance)}
          colorClass={riskColors[persona.risk_tolerance] || 'bg-slate-700 text-slate-300'}
        />
        <Chip label={formatLabel(persona.primary_concerns?.[0] ?? '')} colorClass="bg-navy-700 text-slate-300" />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Chip
        label={`${formatLabel(persona.age_group)} • ${persona.gender === 'male' ? 'M' : 'F'}`}
        colorClass="bg-navy-700 text-slate-300"
      />
      <Chip
        label={formatLabel(persona.financial_situation)}
        colorClass={financialColors[persona.financial_situation] || 'bg-slate-700 text-slate-300'}
      />
      <Chip
        label={formatLabel(persona.risk_tolerance)}
        colorClass={riskColors[persona.risk_tolerance] || 'bg-slate-700 text-slate-300'}
      />
      {(persona.primary_concerns ?? []).map((c) => (
        <Chip key={c} label={formatLabel(c)} colorClass="bg-indigo-900 text-indigo-300" />
      ))}
      <Chip
        label={formatLabel(persona.personality_type)}
        colorClass="bg-slate-700 text-slate-300"
      />
      {persona.previous_advisor && (
        <Chip label="Prior Advisor" colorClass="bg-orange-900 text-orange-300" />
      )}
    </div>
  );
}
