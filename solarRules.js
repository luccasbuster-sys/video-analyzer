module.exports = {
  brandName: 'Solar Energia',

  objectivesAllowed: ['Engajamento', 'Autoridade', 'Conversão'],

  requiredBenefits: [
    'economia',
    'facilidade',
    'zero investimento'
  ],

  brandColors: {
    darkBlue: '#1800ad',
    white: '#ffffff',
    orange: '#ff3600'
  },

  mandatoryRules: {
    objectiveClear: true,
    mainMessageClearIn3Seconds: true,
    solvesRealProblem: true,
    hasStrongHook: true,
    hasCTA: true,
    followsBrandIdentity: true,
    hasReadableText: true,
    hasDynamicEditing: true,
    speaksClientLanguage: true,
    generatesImmediateInterest: true
  },

  rejectIf: [
    'no_clear_objective',
    'no_real_problem_solved',
    'no_cta',
    'no_brand_identity',
    'low_visual_legibility',
    'slow_or_dragging_video',
    'no_immediate_interest'
  ],

  adjustIf: [
    'weak_hook',
    'message_not_clear',
    'benefit_not_obvious',
    'partial_brand_alignment',
    'low_contrast',
    'excessive_visual_pollution',
    'technical_language',
    'weak_retention'
  ],

  approveIfAll: [
    'objective_clear',
    'problem_solved',
    'has_cta',
    'brand_identity_ok',
    'readable_text',
    'dynamic_editing',
    'client_friendly_language',
    'immediate_interest'
  ],

  scoreWeights: {
    strategic: 2.0,
    script: 1.5,
    visual: 1.5,
    editing: 1.5,
    communication: 1.5,
    impact: 2.0
  },

  thresholds: {
    approvedMin: 8.0,
    adjustMin: 5.0
  }
};