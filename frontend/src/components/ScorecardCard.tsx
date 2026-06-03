import React, { useState } from 'react';
import type { ScorecardResult, ScorecardItemResult } from '../types';

/**
 * Renders one Trajan Wealth scorecard (1st Meeting, AUM, Annuity, or
 * Alternatives). Items are scored 1–5 with a kind badge (script vs
 * behavioral) and inline feedback. N/A items (applicable=false) show a
 * pill instead of a score bar.
 */
function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(1, score / 5));
  const color =
    pct >= 0.8 ? 'bg-green-500' : pct >= 0.5 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="h-2 bg-navy-900 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-700 ${color}`}
        style={{ width: `${pct * 100}%` }}
      />
    </div>
  );
}

function ScoreText({ score }: { score: number }) {
  const pct = score / 5;
  const textColor =
    pct >= 0.8 ? 'text-green-400' : pct >= 0.5 ? 'text-yellow-400' : 'text-red-400';
  return <span className={`text-sm font-bold ${textColor}`}>{score.toFixed(1)}/5</span>;
}

function KindBadge({ kind }: { kind: 'script' | 'behavioral' }) {
  const cls =
    kind === 'script'
      ? 'bg-blue-950 text-blue-300 border-blue-800'
      : 'bg-purple-950 text-purple-300 border-purple-800';
  return (
    <span
      className={`inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${cls}`}
    >
      {kind}
    </span>
  );
}

function ScorecardItemRow({ item }: { item: ScorecardItemResult }) {
  const naPill = (
    <span className="text-[10px] uppercase tracking-wider text-slate-500 bg-navy-900 px-2 py-1 rounded">
      N/A
    </span>
  );
  return (
    <div className="py-3 border-b border-navy-700 last:border-b-0">
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <KindBadge kind={item.kind} />
            <span className="text-sm font-medium text-slate-200">{item.label}</span>
          </div>
        </div>
        <div className="flex-shrink-0">
          {item.applicable && typeof item.score === 'number' ? (
            <ScoreText score={item.score} />
          ) : (
            naPill
          )}
        </div>
      </div>
      {item.applicable && typeof item.score === 'number' && (
        <div className="mb-2">
          <ScoreBar score={item.score} />
        </div>
      )}
      {item.feedback && (
        <p className="text-slate-500 text-xs leading-relaxed">{item.feedback}</p>
      )}
    </div>
  );
}

function SingleScorecard({ sc }: { sc: ScorecardResult }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white">{sc.title}</h3>
        {typeof sc.summary_score === 'number' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Summary</span>
            <ScoreText score={sc.summary_score} />
          </div>
        )}
      </div>
      <div>
        {sc.items.map((it) => (
          <ScorecardItemRow key={it.key} item={it} />
        ))}
      </div>
    </div>
  );
}

export default function ScorecardCard({ scorecards }: { scorecards: ScorecardResult[] }) {
  const [active, setActive] = useState(0);

  if (!scorecards?.length) return null;

  // Single scorecard — no tabs.
  if (scorecards.length === 1) {
    return (
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
        <SingleScorecard sc={scorecards[0]} />
      </div>
    );
  }

  // Multiple scorecards (3rd appt: Annuity + Alternatives) — render tabs.
  const current = scorecards[active] ?? scorecards[0];
  return (
    <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
      <div className="flex items-center gap-2 mb-5 border-b border-navy-700 -mx-6 px-6">
        {scorecards.map((sc, i) => {
          const isActive = i === active;
          return (
            <button
              key={sc.type}
              type="button"
              onClick={() => setActive(i)}
              className={`pb-3 -mb-px text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {sc.title}
              {typeof sc.summary_score === 'number' && (
                <span className="ml-2 text-xs text-slate-500">
                  ({sc.summary_score.toFixed(1)}/5)
                </span>
              )}
            </button>
          );
        })}
      </div>
      <SingleScorecard sc={current} />
    </div>
  );
}
