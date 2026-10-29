import {DECISION_LIMITS} from './decision.ts';

/**
 * Claude constrained outputs: root is an object; a nested anyOf enumerates
 * exact decision SHAPES without unsupported oneOf/numeric/string constraints.
 * validateDecision() remains authoritative for all value bounds.
 */
const reason={type:'string',description:`Nonempty reason, maximum ${DECISION_LIMITS.reasonMax} UTF-16 code units`};
const action=(name:'reply'|'skip'|'defer')=>({type:'string',enum:[name]});

const reply={
 type:'object',additionalProperties:false,
 required:['action','text','reason','delayMs'],
 properties:{
  action:action('reply'),
  text:{type:'string',description:`Nonempty reply, at most ${DECISION_LIMITS.replyTextMax} UTF-16 code units`},
  reason,
  delayMs:{type:'integer',description:`Integer ${DECISION_LIMITS.replyDelayMin}..${DECISION_LIMITS.replyDelayMax} inclusive`},
 },
};
const skip={
 type:'object',additionalProperties:false,
 required:['action','reason'],
 properties:{action:action('skip'),reason},
};
const defer={
 type:'object',additionalProperties:false,
 required:['action','reason','delayMs'],
 properties:{
  action:action('defer'),
  reason,
  delayMs:{type:'integer',description:`Integer ${DECISION_LIMITS.deferDelayMin}..${DECISION_LIMITS.deferDelayMax} inclusive`},
 },
};

export const claudeDecisionSchema={
 type:'object',
 additionalProperties:false,
 required:['decision'],
 properties:{
  decision:{anyOf:[reply,skip,defer]},
 },
};
