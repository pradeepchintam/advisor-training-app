import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sessionsApi } from '../services/api';
import { useToast } from '../components/Toast';
import PersonaBuilder, {
  DEFAULT_PERSONA_FORM,
  buildPersonaPayload,
} from '../components/PersonaBuilder';
import type { PersonaFormValues } from '../types';
import { getErrorMessage } from '../utils/errors';

/**
 * Advisor-initiated session: builds a one-off persona and immediately starts
 * the session. This path is "self_initiated" — admins see a different badge
 * for these in the session log.
 *
 * Admins use the Session Profiles page to author *reusable* personas, which
 * they then assign to advisors with target dates.
 */
export default function NewSession() {
  const [form, setForm] = useState<PersonaFormValues>(DEFAULT_PERSONA_FORM);
  const [loading, setLoading] = useState(false);
  // Default unchecked → one-sided deck-walkthrough practice (client silent).
  const [engageClient, setEngageClient] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const isCouple = form.client_type === 'couple';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const persona = buildPersonaPayload(form);
      // Engaging the client uses Nova Sonic (native voice-to-voice) by default;
      // a one-sided walkthrough uses the standard cascade with a silent client.
      const voiceMode = engageClient ? 'nova_sonic' : 'standard';
      const session = await sessionsApi.create(persona, engageClient, voiceMode);
      toast.success('Session created! Connecting...');
      navigate(`/sessions/${session.id}`);
    } catch (err: unknown) {
      toast.error(`Failed to create session: ${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const submitButton = (
    <div>
      <label className="flex items-start gap-3 mb-4 p-3 rounded-lg border border-navy-700 bg-navy-900 cursor-pointer hover:border-navy-600 transition-colors">
        <input
          type="checkbox"
          checked={engageClient}
          onChange={(e) => setEngageClient(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-gold-500 flex-shrink-0"
        />
        <span className="min-w-0">
          <span className="text-sm font-medium text-white">Engage Client</span>
          <span className="block text-xs text-slate-500 mt-0.5">
            {engageClient
              ? 'The client responds interactively in a natural voice — a full two-way roleplay.'
              : 'Off: a one-sided practice run. You present the deck; the client stays silent. Your delivery is still recorded and scored.'}
          </span>
        </span>
      </label>
      <button
        type="submit"
        disabled={loading}
        className="w-full bg-gold-500 hover:bg-gold-400 disabled:opacity-60 disabled:cursor-not-allowed text-navy-900 font-bold py-3 rounded-lg transition-colors shadow-lg shadow-gold-500/20"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Creating Session...
          </span>
        ) : engageClient ? (
          isCouple ? 'Generate Couple & Start Interactive Session' : 'Generate Client & Start Interactive Session'
        ) : (
          isCouple ? 'Generate Couple & Start Practice' : 'Generate Client & Start Practice'
        )}
      </button>
    </div>
  );

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Configure Client Persona</h1>
        <p className="text-slate-500 mt-1">
          Build a one-off client for this self-initiated session.
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <PersonaBuilder value={form} onChange={setForm} actionSlot={submitButton} />
      </form>
    </div>
  );
}
