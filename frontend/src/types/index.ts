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

export interface SessionAnalysis {
  overall_score: number;
  categories: {
    rapport_building: AnalysisCategory;
    financial_discovery: AnalysisCategory;
    needs_analysis: AnalysisCategory;
    product_knowledge: AnalysisCategory;
    compliance_adherence: AnalysisCategory;
    communication_skills: AnalysisCategory;
    closing_skills: AnalysisCategory;
  };
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
