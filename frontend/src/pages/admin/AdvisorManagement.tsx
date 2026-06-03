import React, { useEffect, useState } from 'react';
import { advisorsApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import ConfirmModal from '../../components/ConfirmModal';
import type { AdvisorWithStats } from '../../types';
import { getErrorMessage } from '../../utils/errors';

interface AddAdvisorForm {
  name: string;
  email: string;
  password: string;
  role: 'advisor' | 'admin';
}

function ScoreBadge({ score }: { score: number | null | undefined }) {
  // avg_score from the backend is already normalized to a 0–10 scale so a
  // history mixing 1–5 (new scorecard) and 1–10 (legacy) doesn't skew it.
  if (score == null) return <span className="text-slate-500 text-sm">—</span>;
  const cls =
    score >= 8 ? 'bg-green-900 text-green-300' : score >= 5 ? 'bg-yellow-900 text-yellow-300' : 'bg-red-900 text-red-300';
  return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${cls}`}>{score.toFixed(1)}/10</span>;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function generatePassword(length = 16): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%*';
  let out = '';
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  for (let i = 0; i < length; i++) out += chars[arr[i] % chars.length];
  return out;
}

export default function AdvisorManagement() {
  const toast = useToast();
  const [advisors, setAdvisors] = useState<AdvisorWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'active' | 'inactive'>('active');
  const [showAddModal, setShowAddModal] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<AdvisorWithStats | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; email: string }>({ name: '', email: '' });
  const [addForm, setAddForm] = useState<AddAdvisorForm>({ name: '', email: '', password: '', role: 'advisor' });
  const [saving, setSaving] = useState(false);

  // Password reset
  const [resetTarget, setResetTarget] = useState<AdvisorWithStats | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetVisible, setResetVisible] = useState(false);

  const loadAdvisors = () => {
    advisorsApi
      .list()
      .then(setAdvisors)
      .catch((err) => toast.error(`Failed to load advisors: ${getErrorMessage(err)}`))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadAdvisors();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = advisors.filter((a) =>
    activeTab === 'active' ? a.is_active : !a.is_active
  );

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await advisorsApi.create(addForm);
      toast.success('Advisor created successfully');
      setShowAddModal(false);
      setAddForm({ name: '', email: '', password: '', role: 'advisor' });
      loadAdvisors();
    } catch (err) {
      toast.error(`Failed to create advisor: ${getErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleEditSave = async (id: string) => {
    setSaving(true);
    try {
      await advisorsApi.update(id, editForm);
      toast.success('Advisor updated');
      setEditingId(null);
      loadAdvisors();
    } catch (err) {
      toast.error(`Failed to update advisor: ${getErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    try {
      await advisorsApi.deactivate(deactivateTarget.id);
      toast.success(`${deactivateTarget.name} deactivated`);
      setDeactivateTarget(null);
      loadAdvisors();
    } catch (err) {
      toast.error(`Failed to deactivate advisor: ${getErrorMessage(err)}`);
    }
  };

  const openResetModal = (advisor: AdvisorWithStats) => {
    setResetTarget(advisor);
    setResetPassword(generatePassword());
    setResetVisible(true);
  };

  const handleResetPassword = async () => {
    if (!resetTarget) return;
    if (resetPassword.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    setSaving(true);
    try {
      await advisorsApi.resetPassword(resetTarget.id, resetPassword);
      toast.success(`Password reset for ${resetTarget.name}`);
      // Keep modal open so admin can copy the password before closing
    } catch (err) {
      toast.error(`Failed to reset password: ${getErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(resetPassword);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed — select the text and copy manually');
    }
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Manage Advisors</h1>
          <p className="text-slate-500 mt-1">{advisors.length} total advisors</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 bg-gold-500 hover:bg-gold-400 text-navy-900 font-bold px-4 py-2 rounded-lg text-sm transition-colors"
        >
          + Add Advisor
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-navy-900 rounded-lg p-1 w-fit">
        {(['active', 'inactive'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors capitalize ${
              activeTab === t ? 'bg-navy-800 text-white shadow' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t} ({advisors.filter((a) => (t === 'active' ? a.is_active : !a.is_active)).length})
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-navy-800 border border-navy-700 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <svg className="animate-spin h-8 w-8 text-gold-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-navy-700">
                <th className="px-6 py-3 font-medium">Advisor</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Sessions</th>
                <th className="px-4 py-3 font-medium">This Month</th>
                <th className="px-4 py-3 font-medium">Avg Score</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {filtered.map((advisor) => (
                <tr key={advisor.id} className="hover:bg-navy-700/50 transition-colors">
                  <td className="px-6 py-3">
                    {editingId === advisor.id ? (
                      <div className="flex gap-2">
                        <input
                          value={editForm.name}
                          onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                          className="bg-navy-900 border border-navy-600 rounded px-2 py-1 text-white text-sm focus:outline-none focus:border-gold-500 w-32"
                        />
                        <input
                          value={editForm.email}
                          onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                          className="bg-navy-900 border border-navy-600 rounded px-2 py-1 text-white text-sm focus:outline-none focus:border-gold-500 w-44"
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center text-xs text-gold-400 font-bold flex-shrink-0">
                          {advisor.name?.[0] ?? '?'}
                        </div>
                        <div>
                          <div className="text-white text-sm font-medium">{advisor.name}</div>
                          <div className="text-slate-500 text-xs">{advisor.email}</div>
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                      advisor.role === 'admin' ? 'bg-purple-900/50 text-purple-300' : 'bg-blue-900/50 text-blue-300'
                    }`}>
                      {advisor.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-sm">{advisor.total_sessions}</td>
                  <td className="px-4 py-3 text-slate-400 text-sm">{advisor.sessions_this_month}</td>
                  <td className="px-4 py-3"><ScoreBadge score={advisor.avg_score} /></td>
                  <td className="px-4 py-3 text-slate-500 text-sm">{formatDate(advisor.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {editingId === advisor.id ? (
                        <>
                          <button
                            onClick={() => handleEditSave(advisor.id)}
                            disabled={saving}
                            className="text-green-400 hover:text-green-300 text-xs font-medium transition-colors"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="text-slate-500 hover:text-slate-300 text-xs transition-colors"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setEditingId(advisor.id);
                              setEditForm({ name: advisor.name, email: advisor.email });
                            }}
                            className="text-gold-400 hover:text-gold-300 text-xs font-medium transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => openResetModal(advisor)}
                            className="text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
                          >
                            Reset password
                          </button>
                          {advisor.is_active && (
                            <button
                              onClick={() => setDeactivateTarget(advisor)}
                              className="text-red-400 hover:text-red-300 text-xs transition-colors"
                            >
                              Deactivate
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-slate-500 py-8">
                    No {activeTab} advisors
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Advisor Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowAddModal(false)} />
          <div className="relative bg-navy-800 border border-navy-700 rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold text-white mb-5">Add New Advisor</h3>
            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={addForm.name}
                  onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  value={addForm.email}
                  onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Password</label>
                <input
                  type="password"
                  required
                  value={addForm.password}
                  onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
                  className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Role</label>
                <select
                  value={addForm.role}
                  onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value as 'advisor' | 'admin' }))}
                  className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
                >
                  <option value="advisor">Advisor</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 py-2 bg-navy-700 hover:bg-navy-600 text-slate-300 rounded-lg text-sm font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 py-2 bg-gold-500 hover:bg-gold-400 disabled:opacity-60 text-navy-900 font-bold rounded-lg text-sm transition-colors"
                >
                  {saving ? 'Creating...' : 'Create Advisor'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Deactivate Confirm */}
      <ConfirmModal
        isOpen={!!deactivateTarget}
        title={`Deactivate ${deactivateTarget?.name}?`}
        message={`This will prevent ${deactivateTarget?.name} from logging in. Their session history will be preserved. You can reactivate them later.`}
        confirmLabel="Deactivate"
        onConfirm={handleDeactivate}
        onCancel={() => setDeactivateTarget(null)}
      />

      {/* Reset Password Modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => { setResetTarget(null); setResetPassword(''); }}
          />
          <div className="relative bg-navy-800 border border-navy-700 rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold text-white mb-1">Reset password</h3>
            <p className="text-slate-400 text-sm mb-5">
              Set a new password for <span className="text-white font-medium">{resetTarget.name}</span>{' '}
              (<span className="text-slate-500">{resetTarget.email}</span>). Share it with them through a secure channel.
            </p>

            <label className="block text-xs text-slate-400 mb-1">New password</label>
            <div className="flex gap-2 mb-2">
              <input
                type={resetVisible ? 'text' : 'password'}
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                minLength={8}
                className="flex-1 bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-gold-500"
              />
              <button
                type="button"
                onClick={() => setResetVisible((v) => !v)}
                title={resetVisible ? 'Hide' : 'Show'}
                className="px-3 py-2 bg-navy-700 hover:bg-navy-600 text-slate-300 rounded-lg text-xs"
              >
                {resetVisible ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className="flex gap-2 mb-5 text-xs">
              <button
                onClick={() => setResetPassword(generatePassword())}
                className="text-slate-400 hover:text-slate-200 transition-colors"
              >
                ↻ Generate strong password
              </button>
              <span className="text-slate-600">·</span>
              <button
                onClick={copyPassword}
                className="text-slate-400 hover:text-slate-200 transition-colors"
              >
                📋 Copy
              </button>
              <span className="ml-auto text-slate-600">{resetPassword.length} chars</span>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { setResetTarget(null); setResetPassword(''); }}
                className="flex-1 py-2 bg-navy-700 hover:bg-navy-600 text-slate-300 rounded-lg text-sm font-medium transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleResetPassword}
                disabled={saving || resetPassword.length < 8}
                className="flex-1 py-2 bg-gold-500 hover:bg-gold-400 disabled:opacity-60 disabled:cursor-not-allowed text-navy-900 font-bold rounded-lg text-sm transition-colors"
              >
                {saving ? 'Saving…' : 'Save new password'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
