import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { assignmentsApi, profilesApi, advisorsApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import type { AdvisorWithStats, Assignment, AssignmentStatus, SessionProfile } from '../../types';
import { getErrorMessage } from '../../utils/errors';

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const STATUS_STYLES: Record<AssignmentStatus, string> = {
  pending: 'bg-blue-900/40 text-blue-300 border-blue-700',
  in_progress: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
  completed: 'bg-green-900/40 text-green-300 border-green-700',
  cancelled: 'bg-navy-700 text-slate-400 border-navy-600',
};

export default function AssignmentManager() {
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();

  const [profiles, setProfiles] = useState<SessionProfile[]>([]);
  const [advisors, setAdvisors] = useState<AdvisorWithStats[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(false);

  // Create form state
  const initialProfileId = searchParams.get('profile_id') || '';
  const [profileId, setProfileId] = useState(initialProfileId);
  const [advisorIds, setAdvisorIds] = useState<string[]>([]);
  const [assignedDate, setAssignedDate] = useState(todayIso());
  const [targetDate, setTargetDate] = useState(todayIso());
  const [submitting, setSubmitting] = useState(false);

  // Filter
  const [filterAdvisor, setFilterAdvisor] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<AssignmentStatus | ''>('');

  const refreshAssignments = async () => {
    setLoading(true);
    try {
      const data = await assignmentsApi.list({
        advisor_id: filterAdvisor || undefined,
        status_filter: (filterStatus || undefined) as AssignmentStatus | undefined,
      });
      setAssignments(data);
    } catch (err) {
      toast.error(`Failed to load assignments: ${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const [p, a] = await Promise.all([profilesApi.list(false), advisorsApi.list()]);
        setProfiles(p);
        setAdvisors(a.filter((u) => u.role === 'advisor' && u.is_active));
      } catch (err) {
        toast.error(`Failed to load data: ${getErrorMessage(err)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshAssignments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAdvisor, filterStatus]);

  // If profile_id came in via URL but isn't loaded yet, set it once profiles arrive.
  useEffect(() => {
    if (initialProfileId && !profileId && profiles.some((p) => p.id === initialProfileId)) {
      setProfileId(initialProfileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles]);

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === profileId),
    [profiles, profileId],
  );

  const toggleAdvisor = (id: string) => {
    setAdvisorIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const allAdvisorsSelected = advisors.length > 0 && advisorIds.length === advisors.length;
  const toggleAll = () => {
    setAdvisorIds(allAdvisorsSelected ? [] : advisors.map((a) => a.id));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileId) {
      toast.error('Pick a profile');
      return;
    }
    if (advisorIds.length === 0) {
      toast.error('Pick at least one advisor');
      return;
    }
    if (targetDate < assignedDate) {
      toast.error('Target date cannot be before the assigned date');
      return;
    }
    setSubmitting(true);
    try {
      const created = await assignmentsApi.create({
        profile_id: profileId,
        advisor_ids: advisorIds,
        assigned_date: assignedDate,
        target_date: targetDate,
      });
      toast.success(
        created.length === 1
          ? 'Assignment created'
          : `${created.length} assignments created`,
      );
      // Clear URL profile_id if it was prefilled
      if (searchParams.get('profile_id')) {
        const next = new URLSearchParams(searchParams);
        next.delete('profile_id');
        setSearchParams(next);
      }
      setAdvisorIds([]);
      await refreshAssignments();
    } catch (err) {
      toast.error(`Failed to assign: ${getErrorMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (a: Assignment) => {
    if (!confirm(`Cancel assignment for ${a.advisor_name}?`)) return;
    try {
      await assignmentsApi.cancel(a.id);
      toast.success('Assignment cancelled');
      refreshAssignments();
    } catch (err) {
      toast.error(`Failed: ${getErrorMessage(err)}`);
    }
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Assignments</h1>
        <p className="text-slate-500 mt-1">
          Assign a session profile to one or many advisors with an assigned and target date.
        </p>
      </div>

      {/* Create form */}
      <form
        onSubmit={handleCreate}
        className="bg-navy-800 border border-navy-700 rounded-xl p-6 mb-8 space-y-5"
      >
        <h2 className="text-gold-400 text-sm font-semibold uppercase tracking-wider pb-2 border-b border-navy-700">
          New Assignment
        </h2>

        {/* Profile */}
        <div>
          <label className="block text-sm text-slate-400 mb-2">Session Profile *</label>
          <select
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
            required
          >
            <option value="">— Pick a profile —</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {selectedProfile && (
            <div className="mt-2 text-xs text-slate-500 bg-navy-900 rounded-lg px-3 py-2">
              <div className="text-slate-300">{selectedProfile.description || '(no description)'}</div>
              <div className="mt-1">
                {selectedProfile.persona.age_group?.replace('_', ' ')} ·{' '}
                {selectedProfile.persona.financial_situation} ·{' '}
                {selectedProfile.persona.personality_type}
                {selectedProfile.persona.primary_concerns?.length ? ` · ${selectedProfile.persona.primary_concerns.join(', ')}` : ''}
              </div>
            </div>
          )}
        </div>

        {/* Advisors */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm text-slate-400">Advisors *</label>
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-gold-400 hover:text-gold-300"
            >
              {allAdvisorsSelected ? 'Unselect all' : 'Select all'}
            </button>
          </div>
          {advisors.length === 0 ? (
            <div className="text-slate-500 text-sm bg-navy-900 rounded-lg px-3 py-3">
              No active advisors. Create one under Manage Advisors first.
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {advisors.map((a) => {
                const checked = advisorIds.includes(a.id);
                return (
                  <button
                    type="button"
                    key={a.id}
                    onClick={() => toggleAdvisor(a.id)}
                    className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                      checked
                        ? 'bg-gold-500/10 border-gold-500 text-gold-300'
                        : 'border-navy-600 text-slate-300 hover:border-navy-500'
                    }`}
                  >
                    <div className="font-medium truncate">{a.name}</div>
                    <div className="text-xs text-slate-500 truncate">{a.email}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-400 mb-2">Assigned Date</label>
            <input
              type="date"
              value={assignedDate}
              onChange={(e) => setAssignedDate(e.target.value)}
              className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-2">Target Date</label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              min={assignedDate}
              className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
              required
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-slate-500">
            {advisorIds.length === 0
              ? 'No advisors selected'
              : `Will create ${advisorIds.length} assignment${advisorIds.length === 1 ? '' : 's'}`}
          </div>
          <button
            type="submit"
            disabled={submitting || advisorIds.length === 0 || !profileId}
            className="bg-gold-500 hover:bg-gold-400 disabled:opacity-50 disabled:cursor-not-allowed text-navy-900 font-bold px-6 py-2.5 rounded-lg transition-colors text-sm shadow-lg shadow-gold-500/20"
          >
            {submitting ? 'Assigning…' : 'Create Assignment'}
          </button>
        </div>
      </form>

      {/* Existing assignments */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-gold-400 text-sm font-semibold uppercase tracking-wider">
            Existing Assignments
          </h2>
          <div className="flex gap-2">
            <select
              value={filterAdvisor}
              onChange={(e) => setFilterAdvisor(e.target.value)}
              className="bg-navy-900 border border-navy-600 rounded-lg px-2 py-1.5 text-slate-300 text-xs focus:outline-none focus:border-gold-500"
            >
              <option value="">All advisors</option>
              {advisors.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as AssignmentStatus | '')}
              className="bg-navy-900 border border-navy-600 rounded-lg px-2 py-1.5 text-slate-300 text-xs focus:outline-none focus:border-gold-500"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="text-slate-400 text-sm">Loading…</div>
        ) : assignments.length === 0 ? (
          <div className="text-slate-500 text-sm py-6 text-center">
            No assignments match these filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 text-xs uppercase tracking-wider">
                  <th className="pb-3 pr-4">Profile</th>
                  <th className="pb-3 pr-4">Advisor</th>
                  <th className="pb-3 pr-4">Assigned</th>
                  <th className="pb-3 pr-4">Target</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3"></th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={a.id} className="border-t border-navy-700">
                    <td className="py-3 pr-4">
                      <div className="text-slate-200 font-medium">{a.profile_name}</div>
                      {a.profile_description && (
                        <div className="text-xs text-slate-500 truncate max-w-xs">
                          {a.profile_description}
                        </div>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-slate-300">{a.advisor_name}</td>
                    <td className="py-3 pr-4 text-slate-400">{a.assigned_date}</td>
                    <td className="py-3 pr-4 text-slate-400">{a.target_date}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${STATUS_STYLES[a.status]}`}
                      >
                        {a.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="py-3 text-right">
                      {(a.status === 'pending' || a.status === 'in_progress') && (
                        <button
                          onClick={() => handleCancel(a)}
                          className="text-red-300 hover:text-red-200 text-xs font-medium"
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
