export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'advisor';
  is_active: boolean;
  created_at: string;
}

export interface ClientPersona {
  client_type?: string;
  name: string;
  age: number;
  age_group: 'young_adult' | 'middle_aged' | 'senior' | 'elderly';
  gender: 'male' | 'female';
  marital_status: 'single' | 'married' | 'divorced' | 'widowed' | 'domestic_partner';
  has_children: boolean;
  num_children: number;
  employment_types: string[];
  occupation: string;
  financial_situation: 'struggling' | 'stable' | 'comfortable' | 'affluent' | 'wealthy' | 'ultra_wealthy';
  estimated_net_worth: string;
  estimated_income: string;
  has_debt: 'none' | 'manageable' | 'significant' | 'overwhelming';
  risk_tolerance: 'very_conservative' | 'conservative' | 'moderate' | 'aggressive' | 'very_aggressive';
  investment_experience: 'none' | 'beginner' | 'intermediate' | 'experienced' | 'expert';
  primary_concerns: string[];
  secondary_concern?: string;
  personality_type: 'anxious' | 'confident' | 'skeptical' | 'analytical' | 'emotional' | 'impulsive' | 'detail_oriented' | 'trusting';
  communication_style: 'direct' | 'reserved' | 'chatty' | 'formal';
  previous_advisor: boolean;
  urgency: 'low' | 'medium' | 'high';
  referral_source: string;
  backstory: string;
  spouse_name?: string;
  spouse_age?: number;
  spouse_gender?: string;
  spouse_occupation?: string;
  spouse_employment_types?: string[];
  spouse_personality_type?: string;
  spouse_image_url?: string | null;
}

export interface ConversationMessage {
  role: 'client' | 'advisor';
  text: string;
  timestamp: string;
}

export interface Session {
  id: string;
  advisor_id: string;
  client_name: string;
  client_image_url: string | null;
  status: 'active' | 'completed' | 'error';
  persona: ClientPersona;
  conversation: ConversationMessage[];
  analysis: SessionAnalysis | null;
  started_at: string;
  ended_at: string | null;
}

export interface AnalysisCategory {
  score: number;
  feedback: string;
}

/** Score can be null when the underlying artifact (script/slides) is absent. */
export interface OptionalAnalysisCategory {
  score: number | null;
  feedback: string;
}

/** Objective delivery / prosody metrics computed from the ASR transcript. */
export interface DeliveryMetrics {
  duration_seconds: number;
  advisor_words: number;
  client_words: number;
  advisor_spoken_seconds: number;
  advisor_wpm: number | null;
  talk_time_ratio_advisor: number | null;
  fillers_total: number;
  fillers_per_minute: number | null;
  fillers_top: Array<[string, number]>;
  long_pauses_seconds: number[];
  long_pause_count: number;
}

/** Soft signals from sampling video frames during analysis. */
export interface VideoAnalysis {
  score: number | null;
  feedback: string;
  observations?: string[];
  concerns?: string[];
}

export type ScorecardType = 'first_meeting' | 'aum' | 'annuity' | 'alternatives';

export interface ScorecardItemResult {
  key: string;
  label: string;
  kind: 'script' | 'behavioral';
  applicable: boolean;
  score: number | null; // 1–5 when applicable
  feedback: string;
}

export interface ScorecardResult {
  type: ScorecardType;
  title: string;
  items: ScorecardItemResult[];
  summary_score: number | null;
}

export interface SessionAnalysis {
  /** 1–5 in the new scorecard shape; 1–10 in legacy sessions. */
  overall_score: number;
  /** New shape — one or two scorecards. Absent on legacy sessions. */
  scorecards?: ScorecardResult[] | null;
  /** Legacy 7-category dict — kept optional for backward-compat. */
  categories?: {
    rapport_building: AnalysisCategory;
    financial_discovery: AnalysisCategory;
    needs_analysis: AnalysisCategory;
    product_knowledge: AnalysisCategory;
    compliance_adherence: AnalysisCategory;
    communication_skills: AnalysisCategory;
    closing_skills: AnalysisCategory;
  };
  /** How closely the advisor followed the active training script. */
  script_adherence?: OptionalAnalysisCategory | null;
  /** How well the advisor walked through the presentation slides. */
  slide_walkthrough?: OptionalAnalysisCategory | null;
  /** Objective pace / filler / talk-time signal from ASR. */
  delivery_metrics?: DeliveryMetrics | null;
  /** Vision-pass read on body language / framing. */
  video_analysis?: VideoAnalysis | null;
  /** True when AWS Transcribe re-transcribed the audio for the analyzer. */
  asr_transcript_used?: boolean;
  strengths: string[];
  areas_for_improvement: string[];
  compliance_flags: string[];
  transcript_summary: string;
  recommendations: string[];
}

export interface PersonaFormValues {
  client_type: string;
  gender: string;
  age_group: string;
  marital_status: string;
  has_children: boolean;
  num_children: number;
  employment_types: string[];
  financial_situation: string;
  has_debt: string;
  risk_tolerance: string;
  investment_experience: string;
  primary_concerns: string[];
  personality_type: string;
  communication_style: string;
  previous_advisor: boolean;
  urgency: string;
  spouse_gender: string;
  spouse_age_group: string;
  spouse_employment_types: string[];
  spouse_personality_type: string;
}

export interface AdvisorWithStats extends User {
  total_sessions: number;
  avg_score: number | null;
  sessions_this_month: number;
}

export interface SessionPublic {
  id: string;
  advisor_id: string;
  advisor_name?: string;
  client_name: string;
  client_image_url: string | null;
  status: 'active' | 'completed' | 'error';
  persona: ClientPersona;
  started_at: string;
  ended_at: string | null;
  overall_score?: number | null;
  /** 5 for new scorecard sessions, 10 for legacy. Defaults to 10. */
  score_scale?: number;
  source?: 'assigned' | 'self_initiated';
  assignment_id?: string | null;
  profile_name?: string | null;
}

export interface SessionDetail extends Session {
  duration_seconds?: number;
}

export interface QuestionnaireCategory {
  id: string;
  name: string;
  topics: QuestionnaireTopic[];
}

export interface QuestionnaireTopic {
  id: string;
  text: string;
  importance: 'low' | 'medium' | 'high' | 'critical';
}

export interface QuestionnaireContent {
  version: number;
  updated_at: string;
  categories: QuestionnaireCategory[];
}

// ---------------------------------------------------------------------------
// Presentations (admin-uploaded slide decks)
// ---------------------------------------------------------------------------
export type DeckSlot = 'first' | 'second' | 'third_annuity' | 'third_private_equity';

export interface Presentation {
  id: string;
  version: number;
  title: string;
  slide_count: number;
  is_active: boolean;
  uploaded_by?: string | null;
  created_at: string;
  has_script?: boolean;
  script_filename?: string | null;
  slot?: DeckSlot;
  slot_label?: string | null;
}

// ---------------------------------------------------------------------------
// Training scripts (markdown, used for grading)
// ---------------------------------------------------------------------------
export interface TrainingScript {
  id: string;
  version: number;
  title: string;
  content: string;
  is_active: boolean;
  uploaded_by?: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Slide events captured during a session (for analysis)
// ---------------------------------------------------------------------------
export interface SlideEvent {
  slide_number: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Session profiles + assignments
// ---------------------------------------------------------------------------
export interface SessionProfile {
  id: string;
  name: string;
  description?: string | null;
  persona: ClientPersona;
  created_by?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type AssignmentStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Assignment {
  id: string;
  profile_id: string;
  profile_name: string;
  profile_description?: string | null;
  persona: ClientPersona;
  advisor_id: string;
  advisor_name?: string | null;
  assigned_by?: string | null;
  assigned_by_name?: string | null;
  assigned_date: string; // YYYY-MM-DD
  target_date: string;   // YYYY-MM-DD
  status: AssignmentStatus;
  created_at: string;
  session_id?: string | null;
}

export interface MyAssignments {
  today: Assignment[];
  upcoming: Assignment[];
  past: Assignment[];
}
