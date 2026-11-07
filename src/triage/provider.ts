// The seam. Two calls, two models. Callers only know this shape.
import type { RawThread } from "../types";

export interface Classification {
  relevant: boolean;
  confidence: number;
  reason: string;
}

export interface ExtractedContact {
  email: string;
  name?: string;
  company?: string;
  role?: string;
}

export const DEAL_STAGES = ["discovery", "demo", "proposal", "negotiation", "closed_won", "closed_lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export interface Extraction {
  title: string;
  amountCents: number | null;
  currency: string | null;
  stage: DealStage;
  contacts: ExtractedContact[];
  /** external message id that caused the deal — required for traceability */
  sourceMessageExternalId: string;
}

export interface TriageProvider {
  readonly name: string;
  /** Cheap. Runs on every thread. */
  classify(thread: RawThread): Promise<Classification>;
  /** Expensive. Runs only on threads that survived classify. */
  extract(thread: RawThread, classification: Classification): Promise<Extraction>;
}
