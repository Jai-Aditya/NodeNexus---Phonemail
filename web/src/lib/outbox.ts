import { createContext, useContext } from 'react';
import { mail, type Draft, type SendResult } from './api';

// Sending with "Undo" (Gmail's undo send). Pressing Send asks the mail service to send the
// draft a few seconds from now; until then "Undo" takes it back as a draft. The wait happens
// on the server, so closing the tab can't lose or half-send an email.

export type ToastAction = { label: string; run: () => void };
export type Pending = { draftId: number; seconds: number; conversationId?: number };

export type Outbox = {
  /** A short notice at the bottom, optionally with one button (Undo). */
  flash: (text: string, action?: ToastAction, ms?: number) => void;
  /** Shows "Sending… Undo" for an email waiting to go. */
  track: (p: Pending) => void;
};

export const OutboxContext = createContext<Outbox>({ flash: () => {}, track: () => {} });
export const useOutbox = () => useContext(OutboxContext);

/** Sends a saved draft: at once (undo off), or after the undo window. */
export async function deliver(draftId: number, undoSeconds: number): Promise<{ sent?: SendResult; pending?: Draft }> {
  if (undoSeconds > 0) return { pending: await mail.scheduleDraft(draftId, { delay_seconds: undoSeconds }) };
  return { sent: await mail.sendDraft(draftId) };
}

/** A draft taken back by Undo, for the screen that should show it again. */
export const DRAFT_BACK = 'phonemail:draft-back';
