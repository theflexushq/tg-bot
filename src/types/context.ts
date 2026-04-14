// src/types/context.ts
// Custom grammY context with session data and conversation support.

import { Context, SessionFlavor } from 'grammy';
import { ConversationFlavor } from '@grammyjs/conversations';
import { ParsedIntent } from './index.js';

export interface SessionData {
  // Pending action waiting for PIN confirmation
  pendingIntent: ParsedIntent | null;
  // Pending transaction DB id
  pendingTxId: string | null;
  // Track onboarding step
  onboardingStep: 'none' | 'awaiting_pin_set' | 'awaiting_pin_confirm' | 'complete';
  // Temp PIN during set flow (not stored anywhere else)
  tempPin: string | null;
}

export function initialSession(): SessionData {
  return {
    pendingIntent: null,
    pendingTxId: null,
    onboardingStep: 'none',
    tempPin: null,
  };
}

export type BotContext = Context & SessionFlavor<SessionData> & ConversationFlavor;
