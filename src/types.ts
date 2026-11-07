import { z } from "zod";

// One thread exactly as it appears in data/threads.json.
export const RawThreadSchema = z.object({
  id: z.string().min(1),
  inbox_owner: z.string().min(1),
  subject: z.string(),
  participants: z.array(z.object({ email: z.email(), name: z.string().optional() })),
  messages: z
    .array(
      z.object({
        id: z.string().min(1),
        from: z.email(),
        to: z.array(z.email()),
        cc: z.array(z.email()).optional(),
        sent_at: z.iso.datetime({ offset: true }),
        body: z.string(),
      }),
    )
    .min(1),
});

export type RawThread = z.infer<typeof RawThreadSchema>;
export type RawMessage = RawThread["messages"][number];
export type RawParticipant = RawThread["participants"][number];

export type Role = "rep" | "manager";
export interface ActingUser {
  userId: string;
  role: Role;
}
