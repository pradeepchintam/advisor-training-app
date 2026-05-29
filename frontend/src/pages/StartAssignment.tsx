import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { assignmentsApi, sessionsApi } from '../services/api';
import { useToast } from '../components/Toast';
import type { Assignment } from '../types';
import { getErrorMessage } from '../utils/errors';

/**
 * Advisor-facing flow for starting a session that the admin assigned. The
 * persona is locked server-side — the advisor does not see (or get to edit)
 * a persona builder. We just confirm the assignment details and start.
 */
export default function StartAssignment() {
  const { assignmentId } = useParams<{ assignmentId: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!assignmentId) return;
    (async () => {
      try {
        const mine = await assignmentsApi.listMine();
        const all = [...mine.today, ...mine.upcoming, ...mine.past];
        const a = all.find((x) => x.id === assignmentId) || null;
        if (!a) {
          setError('Assignment not found, or it is not assigned to you.');
        } else {
          setAssignment(a);
        }
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [assignmentId]);

  const handleStart = async () => {
    if (!assignmentId || startedRef.current) return;
    startedRef.current = true;
    setStarting(true);
    try {
      const session = await sessionsApi.createFromAssignment(assignmentId);
      toast.success('Session created. Connecting…');
      navigate(`/sessions/${session.id}`);
    } catch (err) {
      startedRef.current = false;
      toast.error(`Failed to start session: ${getErrorMessage(err)}`);
      setStarting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <div className="text-slate-400 text-sm">Loading assignment…</div>
      </div>
    );
  }

  if (error || !assignment) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-6">
          <h2 className="text-red-300 font-semibold mb-2">Can't start session</h2>
          <p className="text-red-200/80 text-sm">{error || 'Assignment unavailable.'}</p>
          <button
            onClick={() => navigate('/dashboard')}
            className="mt-4 text-red-300 hover:text-red-200 text-sm font-medium"
          >
            ← Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  const p = assignment.persona;

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Start Assigned Session</h1>
        <p className="text-slate-500 mt-1">
          Your admin has set up this client for you. Review the brief and start when you're ready.
        </p>
      </div>

      <div className="bg-navy-800 border border-gold-500/30 rounded-xl p-6 mb-6">
        <div className="flex items-start gap-4 mb-5">
          <div className="w-16 h-16 rounded-full bg-navy-700 border-2 border-gold-500/50 flex items-center justify-center text-2xl font-bold text-gold-400">
            {(p.name || assignment.profile_name).split(' ').map((n) => n[0]).join('').slice(0, 2)}
          </div>
          <div className="flex-1">
            <div className="text-xs text-gold-400 uppercase tracking-wider font-semibold mb-0.5">
              {assignment.profile_name}
            </div>
            {assignment.profile_description && (
              <div className="text-sm text-slate-300 mb-1">{assignment.profile_description}</div>
            )}
            <div className="text-slate-500 text-xs">
              Assigned {assignment.assigned_date} · Due {assignment.target_date}
              {assignment.assigned_by_name ? ` · by ${assignment.assigned_by_name}` : ''}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5 text-sm">
          <div className="bg-navy-900 rounded-lg px-3 py-2">
            <div className="text-xs text-slate-500">Demographics</div>
            <div className="text-slate-300">
              {p.age_group?.replace('_', ' ')} · {p.gender} · {p.marital_status?.replace('_', ' ')}
            </div>
          </div>
          <div className="bg-navy-900 rounded-lg px-3 py-2">
            <div className="text-xs text-slate-500">Financial</div>
            <div className="text-slate-300 capitalize">
              {p.financial_situation} · {p.risk_tolerance?.replace('_', ' ')}
            </div>
          </div>
          <div className="bg-navy-900 rounded-lg px-3 py-2">
            <div className="text-xs text-slate-500">Personality</div>
            <div className="text-slate-300 capitalize">
              {p.personality_type} · {p.communication_style}
            </div>
          </div>
          <div className="bg-navy-900 rounded-lg px-3 py-2">
            <div className="text-xs text-slate-500">Primary Concerns</div>
            <div className="text-slate-300 truncate">
              {p.primary_concerns?.join(', ') || '—'}
            </div>
          </div>
        </div>

        {p.backstory && (
          <div className="bg-navy-900 rounded-lg p-3 text-xs text-slate-400 leading-relaxed mb-5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Backstory</div>
            {p.backstory}
          </div>
        )}

        {(() => {
          const todayStr = new Date().toISOString().slice(0, 10);
          const isFuture = assignment.target_date > todayStr;
          const blocked = isFuture || assignment.status === 'cancelled' || assignment.status === 'completed';
          return (
            <>
              <button
                onClick={handleStart}
                disabled={starting || blocked}
                className="w-full bg-gold-500 hover:bg-gold-400 disabled:opacity-60 disabled:cursor-not-allowed text-navy-900 font-bold py-3 rounded-lg transition-colors shadow-lg shadow-gold-500/20"
              >
                {starting ? 'Starting session…' : 'Start Session'}
              </button>
              {isFuture && (
                <p className="text-center text-slate-500 text-xs mt-3">
                  This session is scheduled for {assignment.target_date} and can't be started before then.
                </p>
              )}
              {(assignment.status === 'cancelled' || assignment.status === 'completed') && (
                <p className="text-center text-slate-500 text-xs mt-3">
                  This assignment is {assignment.status}.
                </p>
              )}
            </>
          );
        })()}
      </div>

      <button
        onClick={() => navigate('/dashboard')}
        className="text-slate-400 hover:text-slate-200 text-sm"
      >
        ← Back to dashboard
      </button>
    </div>
  );
}
