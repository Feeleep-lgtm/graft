// Plausible stub. Classification uses our ordered rules (internal, automated, bulk, selling to us,
// billing us, then buying signals); extraction uses simple heuristics in place of a real model.
import { env } from "../config/env";
import type { RawThread } from "../types";
import type { Classification, DealStage, ExtractedContact, Extraction, TriageProvider } from "./provider";
import { triageThread } from "./rules";

const SALES_SIGNALS =
  /\b(pric(?:e|es|ing)|budget|contract|proposal|demo|trial|renewal|purchase|procure|quote|seats?|licen[cs]es?|agreement|signed|redline)\b/i;
const AUTOMATED_SENDER =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?|calendar-notification|newsletter|news|digest|bounces?)$/i;
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com"]);
const AMOUNT = /([₦$€£])\s?(\d[\d,]*)(?:\.(\d{1,2}))?(k)?\b/i;
const CURRENCY: Record<string, string> = { "₦": "NGN", $: "USD", "€": "EUR", "£": "GBP" };

export class StubProvider implements TriageProvider {
  readonly name = "stub";

  constructor(private workspaceDomains: string[] = env.WORKSPACE_DOMAINS) {}

  async classify(thread: RawThread): Promise<Classification> {
    const { relevant, reason } = triageThread(thread, this.workspaceDomains);
    return { relevant, confidence: relevant ? 0.8 : 0.2, reason };
  }

  async extract(thread: RawThread, _classification: Classification): Promise<Extraction> {
    const isOurs = (email: string) => this.workspaceDomains.includes(domainOf(email));

    // Traceability: cite the message that actually caused it, not just messages[0].
    const source =
      thread.messages.find((m) => SALES_SIGNALS.test(m.body)) ??
      thread.messages.find((m) => !isOurs(m.from)) ??
      thread.messages[0]!;

    // First amount in any currency we know, in the smallest unit (cents, kobo).
    let amountCents: number | null = null;
    let currency: string | null = null;
    for (const m of thread.messages) {
      const match = AMOUNT.exec(m.body);
      if (!match) continue;
      const whole = Number(match[2]!.replace(/,/g, "")) * (match[4] ? 1000 : 1);
      amountCents = whole * 100 + Number((match[3] ?? "0").padEnd(2, "0"));
      currency = CURRENCY[match[1]!]!;
      break;
    }

    return {
      title: thread.subject.replace(/^(?:\s*(?:re|fwd?|fw):\s*)+/i, "").trim(),
      amountCents,
      currency,
      stage: stageOf([thread.subject, ...thread.messages.map((m) => m.body)].join("\n")),
      contacts: externalContacts(thread, isOurs),
      sourceMessageExternalId: source.id,
    };
  }
}

function stageOf(text: string): DealStage {
  if (/\bsigned\b/i.test(text)) return "closed_won";
  if (/\b(?:went with|going with another|not moving forward)\b/i.test(text)) return "closed_lost";
  if (/\b(?:contract|agreement|redline|legal)\b/i.test(text)) return "negotiation";
  if (/\b(?:pric(?:e|es|ing)|proposal|quote)\b/i.test(text) || AMOUNT.test(text)) return "proposal";
  if (/\bdemo\b/i.test(text)) return "demo";
  return "discovery";
}

// Everyone outside our domains who isn't a robot, including people only seen in from/to/cc.
function externalContacts(thread: RawThread, isOurs: (email: string) => boolean): ExtractedContact[] {
  const emails = new Set(thread.participants.map((p) => p.email.toLowerCase()));
  for (const m of thread.messages) [m.from, ...m.to, ...(m.cc ?? [])].forEach((e) => emails.add(e.toLowerCase()));

  return [...emails]
    .filter((email) => !isOurs(email) && !AUTOMATED_SENDER.test(email.split("@")[0]!))
    .map((email) => {
      const listed = thread.participants.find((p) => p.email.toLowerCase() === email)?.name;
      const domain = domainOf(email);
      return {
        email,
        name: listed ?? nameFromEmail(email),
        // A personal address says nothing about where someone works.
        company: FREE_MAIL.has(domain) ? undefined : companyFromDomain(domain),
      };
    });
}

const domainOf = (email: string) => email.trim().toLowerCase().split("@")[1] ?? "";
const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** kova.africa -> "Kova", orion-digital.ng -> "Orion Digital" */
const companyFromDomain = (domain: string) => domain.split(".")[0]!.split("-").map(titleCase).join(" ");

/** tunde.bakare@ -> "Tunde Bakare" */
const nameFromEmail = (email: string) => email.split("@")[0]!.split(/[._-]+/).filter(Boolean).map(titleCase).join(" ");
