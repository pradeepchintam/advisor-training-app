import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { profilesApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import PersonaBuilder, {
  DEFAULT_PERSONA_FORM,
  buildPersonaPayload,
  personaToForm,
} from '../../components/PersonaBuilder';
import type { PersonaFormValues, SessionProfile } from '../../types';
import { getErrorMessage } from '../../utils/errors';

type Mode = 'list' | 'create' | 'edit';

/**
 * Admin-only: create reusable persona templates ("session profiles") that
 * can be assigned to advisors with target dates.
 */
export default function SessionProfiles() {
  const [mode, setMode] = useState<Mode>('list');
  const [profiles, setProfiles] = useState<SessionProfile[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<SessionProfile | null>(null);
  const navigate = useNavigate();
  const toast = useToast();

  // Editor form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [form, setForm] = useState<PersonaFormValues>(DEFAULT_PERSONA_FORM);
  const [submitting, setSubmitting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await profilesApi.list(includeInactive);
      setProfiles(data);
    } catch (err) {
      toast.error(`Failed to load profiles: ${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeInactive]);

  const startCreate = () => {
    setEditing(null);
    setName('');
    setDescription('');
    setForm(DEFAULT_PERSONA_FORM);
    setMode('create');
  };

  const startEdit = (p: SessionProfile) => {
    setEditing(p);
    setName(p.name);
    setDescription(p.description ?? '');
    setForm(personaToForm(p.persona));
    setMode('edit');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Profile name is required');
      return;
    }
    setSubmitting(true);
    try {
      const persona = buildPersonaPayload(form);
      if (mode === 'create') {
        await profilesApi.create({ name: name.trim(), description: description.trim() || undefined, persona });
        toast.success('Profile created');
      } else if (editing) {
        await profilesApi.update(editing.id, {
          name: name.trim(),
          description: description.trim(),
          persona,
        });
        toast.success('Profile updated');
      }
      setMode('list');
      await refresh();
    } catch (err) {
      toast.error(`Save failed: ${getErrorMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetire = async (p: SessionProfile) => {
    if (!confirm(`Retire profile "${p.name}"? It can no longer be assigned but existing assignments stay.`)) return;
    try {
      await profilesApi.remove(p.id);
      toast.success('Profile retired');
      refresh();
    } catch (err) {
      toast.error(`Failed: ${getErrorMessage(err)}`);
    }
  };

  const handleReactivate = async (p: SessionProfile) => {
    try {
      await profilesApi.update(p.id, { is_active: true });
      toast.success('Profile reactivated');
      refresh();
    } catch (err) {
      toast.error(`Failed: ${getErrorMessage(err)}`);
    }
  };

  // -------------------------------------------------------------------------
  // Editor view
  // -------------------------------------------------------------------------
  if (mode === 'create' || mode === 'edit') {
    const titleText = mode === 'create' ? 'New Session Profile' : `Edit: ${editing?.name ?? ''}`;
    const topSlot = (
      <div className="bg-navy-800 border border-navy-700 rounded-xl p-6 space-y-4">
        <div>
          <label className="block text-sm text-slate-400 mb-2">Profile Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Skeptical Retiree, High Net Worth"
            className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-gold-500"
            required
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-2">Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What advisors should focus on with this client type."
            rows={2}
            className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
          />
        </div>
      </div>
    );

    const actionSlot = (
      <div className="space-y-2">
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-gold-500 hover:bg-gold-400 disabled:opacity-60 disabled:cursor-not-allowed text-navy-900 font-bold py-3 rounded-lg transition-colors shadow-lg shadow-gold-500/20"
        >
          {submitting ? 'Saving…' : mode === 'create' ? 'Save Profile' : 'Save Changes'}
        </button>
        <button
          type="button"
          onClick={() => setMode('list')}
          className="w-full bg-navy-700 hover:bg-navy-600 text-slate-300 font-medium py-2 rounded-lg transition-colors"
        >
          Cancel
        </button>
      </div>
    );

    return (
      <div className="p-8 max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">{titleText}</h1>
          <p className="text-slate-500 mt-1">
            Build a reusable client persona that you can assign to advisors.
          </p>
        </div>
        <form onSubmit={handleSave}>
          <PersonaBuilder value={form} onChange={setForm} actionSlot={actionSlot} topSlot={topSlot} />
        </form>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // List view
  // -------------------------------------------------------------------------
  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Session Profiles</h1>
          <p className="text-slate-500 mt-1">
            Reusable persona templates you can assign to advisors.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="accent-gold-500"
            />
            Show retired
          </label>
          <button
            onClick={startCreate}
            className="bg-gold-500 hover:bg-gold-400 text-navy-900 font-bold px-4 py-2 rounded-lg transition-colors text-sm"
          >
            + New Profile
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : profiles.length === 0 ? (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-12 text-center">
          <div className="text-slate-400 mb-3">No profiles yet.</div>
          <button
            onClick={startCreate}
            className="text-gold-400 hover:text-gold-300 font-medium text-sm"
          >
            Create your first profile →
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {profiles.map((p) => (
            <div
              key={p.id}
              className={`bg-navy-800 border rounded-xl p-5 ${
                p.is_active ? 'border-navy-700' : 'border-navy-700 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-white font-semibold truncate">{p.name}</h3>
                    {!p.is_active && (
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 bg-navy-900 px-1.5 py-0.5 rounded">
                        Retired
                      </span>
                    )}
                  </div>
                  {p.description && (
                    <p className="text-slate-400 text-sm">{p.description}</p>
                  )}
                </div>
              </div>

              <div className="bg-navy-900 rounded-lg p-3 mb-4 space-y-1 text-xs">
                <div className="flex justify-between text-slate-400">
                  <span>Type</span>
                  <span className="text-slate-300 capitalize">{p.persona.client_type || 'individual'}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Persona</span>
                  <span className="text-slate-300">
                    {p.persona.age_group?.replace('_', ' ')} · {p.persona.financial_situation} ·{' '}
                    {p.persona.personality_type}
                  </span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Concerns</span>
                  <span className="text-slate-300 truncate ml-2">
                    {p.persona.primary_concerns?.slice(0, 2).join(', ') || '—'}
                  </span>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => startEdit(p)}
                  className="flex-1 bg-navy-700 hover:bg-navy-600 text-slate-200 text-sm font-medium py-2 rounded-lg transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => navigate(`/admin/assignments?profile_id=${p.id}`)}
                  disabled={!p.is_active}
                  className="flex-1 bg-gold-500/10 hover:bg-gold-500/20 disabled:opacity-40 disabled:cursor-not-allowed text-gold-400 text-sm font-medium py-2 rounded-lg transition-colors"
                >
                  Assign
                </button>
                {p.is_active ? (
                  <button
                    onClick={() => handleRetire(p)}
                    className="px-3 bg-red-900/40 hover:bg-red-900/60 text-red-300 text-sm font-medium py-2 rounded-lg transition-colors"
                    title="Retire"
                  >
                    Retire
                  </button>
                ) : (
                  <button
                    onClick={() => handleReactivate(p)}
                    className="px-3 bg-green-900/40 hover:bg-green-900/60 text-green-300 text-sm font-medium py-2 rounded-lg transition-colors"
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
