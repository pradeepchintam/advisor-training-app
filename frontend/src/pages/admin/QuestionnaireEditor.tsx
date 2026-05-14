import React, { useEffect, useState } from 'react';
import { questionnaireApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import ConfirmModal from '../../components/ConfirmModal';
import type { QuestionnaireContent, QuestionnaireCategory, QuestionnaireTopic } from '../../types';
import { getErrorMessage } from '../../utils/errors';

const IMPORTANCE_COLORS: Record<string, string> = {
  low: 'bg-slate-700 text-slate-300',
  medium: 'bg-blue-900 text-blue-300',
  high: 'bg-yellow-900 text-yellow-300',
  critical: 'bg-red-900 text-red-300',
};

function generateId() {
  return Math.random().toString(36).slice(2);
}

export default function QuestionnaireEditor() {
  const toast = useToast();
  const [questionnaire, setQuestionnaire] = useState<QuestionnaireContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [editingTopic, setEditingTopic] = useState<{ catId: string; topicId: string } | null>(null);
  const [editingTopicText, setEditingTopicText] = useState('');
  const [editingTopicImportance, setEditingTopicImportance] = useState<string>('medium');
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'category' | 'topic'; catId: string; topicId?: string } | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingTopicFor, setAddingTopicFor] = useState<string | null>(null);
  const [newTopicText, setNewTopicText] = useState('');
  const [newTopicImportance, setNewTopicImportance] = useState<string>('medium');
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [editingCatName, setEditingCatName] = useState('');

  useEffect(() => {
    questionnaireApi
      .get()
      .then((q) => {
        setQuestionnaire(q);
        if (q.categories.length > 0) {
          setExpandedCategories(new Set([q.categories[0].id]));
        }
      })
      .catch((err) => toast.error(`Failed to load questionnaire: ${getErrorMessage(err)}`))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCategory = (id: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (!questionnaire) return;
    setSaving(true);
    try {
      const updated = await questionnaireApi.update(questionnaire);
      setQuestionnaire(updated);
      toast.success('Questionnaire saved successfully');
    } catch (err) {
      toast.error(`Failed to save questionnaire: ${getErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const updateCategories = (cats: QuestionnaireCategory[]) => {
    if (!questionnaire) return;
    setQuestionnaire({ ...questionnaire, categories: cats });
  };

  const handleAddCategory = () => {
    if (!newCategoryName.trim() || !questionnaire) return;
    const newCat: QuestionnaireCategory = {
      id: generateId(),
      name: newCategoryName.trim(),
      topics: [],
    };
    updateCategories([...questionnaire.categories, newCat]);
    setNewCategoryName('');
    setAddingCategory(false);
    setExpandedCategories((prev) => new Set([...prev, newCat.id]));
  };

  const handleDeleteCategory = (catId: string) => {
    if (!questionnaire) return;
    updateCategories(questionnaire.categories.filter((c) => c.id !== catId));
    setDeleteTarget(null);
  };

  const handleDeleteTopic = (catId: string, topicId: string) => {
    if (!questionnaire) return;
    updateCategories(
      questionnaire.categories.map((c) =>
        c.id === catId ? { ...c, topics: c.topics.filter((t) => t.id !== topicId) } : c
      )
    );
    setDeleteTarget(null);
  };

  const handleAddTopic = (catId: string) => {
    if (!newTopicText.trim() || !questionnaire) return;
    const newTopic: QuestionnaireTopic = {
      id: generateId(),
      text: newTopicText.trim(),
      importance: newTopicImportance as QuestionnaireTopic['importance'],
    };
    updateCategories(
      questionnaire.categories.map((c) =>
        c.id === catId ? { ...c, topics: [...c.topics, newTopic] } : c
      )
    );
    setNewTopicText('');
    setNewTopicImportance('medium');
    setAddingTopicFor(null);
  };

  const handleEditTopicSave = () => {
    if (!editingTopic || !questionnaire) return;
    updateCategories(
      questionnaire.categories.map((c) =>
        c.id === editingTopic.catId
          ? {
              ...c,
              topics: c.topics.map((t) =>
                t.id === editingTopic.topicId
                  ? { ...t, text: editingTopicText, importance: editingTopicImportance as QuestionnaireTopic['importance'] }
                  : t
              ),
            }
          : c
      )
    );
    setEditingTopic(null);
  };

  const handleEditCatSave = (catId: string) => {
    if (!questionnaire || !editingCatName.trim()) return;
    updateCategories(
      questionnaire.categories.map((c) =>
        c.id === catId ? { ...c, name: editingCatName.trim() } : c
      )
    );
    setEditingCatId(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <svg className="animate-spin h-10 w-10 text-gold-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  if (!questionnaire) {
    return <div className="p-8 text-slate-500">Failed to load questionnaire</div>;
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Questionnaire Editor</h1>
          <p className="text-slate-500 mt-1">
            Version {questionnaire.version} · Last updated{' '}
            {new Date(questionnaire.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 bg-gold-500 hover:bg-gold-400 disabled:opacity-60 text-navy-900 font-bold px-5 py-2.5 rounded-lg transition-colors"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Categories */}
      <div className="space-y-3 mb-4">
        {questionnaire.categories.map((category) => (
          <div key={category.id} className="bg-navy-800 border border-navy-700 rounded-xl overflow-hidden">
            {/* Category Header */}
            <div className="flex items-center px-5 py-3.5 cursor-pointer hover:bg-navy-700/50 transition-colors"
              onClick={() => toggleCategory(category.id)}>
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`w-4 h-4 text-slate-500 mr-3 transition-transform ${expandedCategories.has(category.id) ? 'rotate-90' : ''}`}
              >
                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
              </svg>

              {editingCatId === category.id ? (
                <div className="flex items-center gap-2 flex-1" onClick={(e) => e.stopPropagation()}>
                  <input
                    value={editingCatName}
                    onChange={(e) => setEditingCatName(e.target.value)}
                    className="bg-navy-900 border border-navy-600 rounded px-2 py-1 text-white text-sm focus:outline-none focus:border-gold-500"
                    autoFocus
                  />
                  <button onClick={() => handleEditCatSave(category.id)} className="text-green-400 hover:text-green-300 text-xs font-medium">Save</button>
                  <button onClick={() => setEditingCatId(null)} className="text-slate-500 hover:text-slate-300 text-xs">Cancel</button>
                </div>
              ) : (
                <span className="font-semibold text-white flex-1">{category.name}</span>
              )}

              <span className="text-slate-500 text-xs mr-4">{category.topics.length} topics</span>

              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => { setEditingCatId(category.id); setEditingCatName(category.name); }}
                  className="text-slate-500 hover:text-gold-400 text-xs transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => setDeleteTarget({ type: 'category', catId: category.id })}
                  className="text-slate-500 hover:text-red-400 text-xs transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>

            {/* Topics */}
            {expandedCategories.has(category.id) && (
              <div className="border-t border-navy-700">
                {category.topics.map((topic) => (
                  <div key={topic.id} className="flex items-start gap-3 px-5 py-3 border-b border-navy-700/50 hover:bg-navy-700/30 transition-colors">
                    {editingTopic?.catId === category.id && editingTopic?.topicId === topic.id ? (
                      <div className="flex-1 space-y-2">
                        <textarea
                          value={editingTopicText}
                          onChange={(e) => setEditingTopicText(e.target.value)}
                          rows={2}
                          className="w-full bg-navy-900 border border-navy-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-gold-500 resize-none"
                          autoFocus
                        />
                        <div className="flex items-center gap-2">
                          <select
                            value={editingTopicImportance}
                            onChange={(e) => setEditingTopicImportance(e.target.value)}
                            className="bg-navy-900 border border-navy-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-gold-500"
                          >
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="critical">Critical</option>
                          </select>
                          <button onClick={handleEditTopicSave} className="text-green-400 hover:text-green-300 text-xs font-medium">Save</button>
                          <button onClick={() => setEditingTopic(null)} className="text-slate-500 hover:text-slate-300 text-xs">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium flex-shrink-0 mt-0.5 ${IMPORTANCE_COLORS[topic.importance]}`}>
                          {topic.importance}
                        </span>
                        <span className="flex-1 text-sm text-slate-300 leading-relaxed">{topic.text}</span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={() => {
                              setEditingTopic({ catId: category.id, topicId: topic.id });
                              setEditingTopicText(topic.text);
                              setEditingTopicImportance(topic.importance);
                            }}
                            className="text-slate-500 hover:text-gold-400 text-xs transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setDeleteTarget({ type: 'topic', catId: category.id, topicId: topic.id })}
                            className="text-slate-500 hover:text-red-400 text-xs transition-colors"
                          >
                            ×
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}

                {/* Add topic */}
                {addingTopicFor === category.id ? (
                  <div className="px-5 py-3 space-y-2">
                    <textarea
                      value={newTopicText}
                      onChange={(e) => setNewTopicText(e.target.value)}
                      placeholder="Enter topic text..."
                      rows={2}
                      className="w-full bg-navy-900 border border-navy-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500 resize-none"
                      autoFocus
                    />
                    <div className="flex items-center gap-2">
                      <select
                        value={newTopicImportance}
                        onChange={(e) => setNewTopicImportance(e.target.value)}
                        className="bg-navy-900 border border-navy-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-gold-500"
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="critical">Critical</option>
                      </select>
                      <button
                        onClick={() => handleAddTopic(category.id)}
                        className="bg-gold-500 hover:bg-gold-400 text-navy-900 font-bold px-3 py-1.5 rounded text-xs transition-colors"
                      >
                        Add Topic
                      </button>
                      <button
                        onClick={() => { setAddingTopicFor(null); setNewTopicText(''); }}
                        className="text-slate-500 hover:text-slate-300 text-xs transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingTopicFor(category.id)}
                    className="w-full px-5 py-2.5 text-left text-slate-500 hover:text-gold-400 text-sm transition-colors flex items-center gap-2"
                  >
                    <span className="text-lg leading-none">+</span>
                    Add Topic
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add Category */}
      {addingCategory ? (
        <div className="bg-navy-800 border border-navy-700 rounded-xl p-4 flex items-center gap-3">
          <input
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="Category name..."
            className="flex-1 bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddCategory(); }}
          />
          <button
            onClick={handleAddCategory}
            className="bg-gold-500 hover:bg-gold-400 text-navy-900 font-bold px-4 py-2 rounded-lg text-sm transition-colors"
          >
            Add
          </button>
          <button
            onClick={() => { setAddingCategory(false); setNewCategoryName(''); }}
            className="text-slate-500 hover:text-slate-300 text-sm transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAddingCategory(true)}
          className="w-full py-3 border-2 border-dashed border-navy-700 rounded-xl text-slate-500 hover:text-gold-400 hover:border-gold-500/30 transition-colors text-sm font-medium"
        >
          + Add Category
        </button>
      )}

      {/* Delete Confirmation */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        title={deleteTarget?.type === 'category' ? 'Delete Category?' : 'Delete Topic?'}
        message={
          deleteTarget?.type === 'category'
            ? 'This will delete the category and all its topics. This action cannot be undone.'
            : 'This will permanently delete this topic.'
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (!deleteTarget) return;
          if (deleteTarget.type === 'category') handleDeleteCategory(deleteTarget.catId);
          else if (deleteTarget.topicId) handleDeleteTopic(deleteTarget.catId, deleteTarget.topicId);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
