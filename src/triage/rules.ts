import { env } from "../config/env";

export interface ThreadMessage {
  from: string;
  to: string[];
  cc?: string[];
  body: string;
}

export interface Thread {
  subject: string;
  participants: { name?: string; email: string }[];
  messages: ThreadMessage[];
}

export interface TriageResult {
  relevant: boolean;
  reason: string;
}

const AUTOMATED_SENDER =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?|calendar-notification|newsletter|news|digest|bounces?)$/i;
const BULK_MAIL = /\bunsubscribe\b/i;
const SELLING_TO_US = [/\bwe help\b/i, /\bcase study\b/i, /\bworth \d+ minutes\b/i];
const BILLING_US = [/\bour invoice\b/i, /\bVAT\b/, /\bfiling deadline\b/i];
const BUYING_SIGNALS: { label: string; pattern: RegExp }[] = [
  { label: "pricing", pattern: /\bpric(?:e|es|ing)\b/i },
  { label: "quote", pattern: /\bquote\b/i },
  { label: "seats", pattern: /\bseats?\b/i },
  { label: "demo", pattern: /\bdemo\b/i },
  { label: "proposal", pattern: /\bproposal\b/i },
  { label: "contract", pattern: /\bcontract\b/i },
  { label: "agreement", pattern: /\bagreement\b/i },
  { label: "signed", pattern: /\bsigned\b/i },
  { label: "redline", pattern: /\bredline\b/i },
  { label: "an amount", pattern: /[₦$€£]\s?\d/ },
];

/**
 * Decides whether a thread is sales-relevant using fixed rules, checked in order.
 * The first rule that applies decides; the reason says which one it was.
 */
export function triageThread(thread: Thread, workspaceDomains: string[] = env.WORKSPACE_DOMAINS): TriageResult {
  const isOurs = (email: string) => workspaceDomains.includes(domainOf(email));
  const external = allAddresses(thread).filter((email) => !isOurs(email));
  const text = [thread.subject, ...thread.messages.map((m) => m.body)].join("\n");
  const weWrote = thread.messages.some((m) => isOurs(m.from));
  const theyWrote = thread.messages.some((m) => !isOurs(m.from));

  // 1. Internal only.
  if (external.length === 0) {
    return { relevant: false, reason: "Internal: every participant is on our own domain." };
  }
  // 2. Automated sender.
  if (external.every((email) => AUTOMATED_SENDER.test(localPartOf(email)))) {
    return { relevant: false, reason: "Automated sender (bounce, notification or newsletter address)." };
  }
  // 3. Bulk mail.
  if (BULK_MAIL.test(text)) {
    return { relevant: false, reason: "Bulk mail: contains an unsubscribe link." };
  }
  // 4. Someone selling to us, and we never replied.
  if (!weWrote && SELLING_TO_US.some((pattern) => pattern.test(text))) {
    return { relevant: false, reason: "Someone selling to us, and nobody on our side has replied." };
  }
  // 5. Someone billing us. Checked before buying signals: invoices mention "signed" and amounts too.
  if (BILLING_US.some((pattern) => pattern.test(text))) {
    return { relevant: false, reason: "A supplier billing us; we are the customer here." };
  }
  // 6. Buying signals.
  const signals = BUYING_SIGNALS.filter((s) => s.pattern.test(text)).map((s) => s.label);
  if (signals.length > 0) {
    return { relevant: true, reason: `Buying signals: ${signals.join(", ")}.` };
  }
  // 7. Rep-led conversation with a reply from outside.
  if (weWrote && theyWrote) {
    return { relevant: true, reason: "Ongoing conversation between our rep and an outside contact." };
  }
  // 8. Default.
  return { relevant: false, reason: "No buying signal." };
}

const normalize = (email: string) => email.trim().toLowerCase();
const domainOf = (email: string) => normalize(email).split("@")[1] ?? "";
const localPartOf = (email: string) => normalize(email).split("@")[0] ?? "";

function allAddresses(thread: Thread): string[] {
  const addresses = new Set(thread.participants.map((p) => normalize(p.email)));
  for (const m of thread.messages) {
    [m.from, ...m.to, ...(m.cc ?? [])].forEach((email) => addresses.add(normalize(email)));
  }
  return [...addresses];
}
